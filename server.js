const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Replicate (無料クレジットあり) ───────────────────────────────────
// Stable Video Diffusion img2vid
app.post('/api/generate/replicate', async (req, res) => {
  try {
    const { apiKey: rawKey, imageBase64, motionBucket = 127 } = req.body;
    const apiKey = (rawKey || '').trim();
    if (!apiKey) return res.status(400).json({ error: 'APIトークンが必要です' });
    if (!imageBase64) return res.status(400).json({ error: '画像が必要です' });

    const response = await axios.post(
      'https://api.replicate.com/v1/predictions',
      {
        version: '3f0457e4619daac51203dedb472816fd4af51f3149fa7a9e0b5ffcf1b8172438',
        input: { input_image: imageBase64, motion_bucket_id: parseInt(motionBucket), fps: 7 },
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
        validateStatus: () => true,
      }
    );
    console.log('Replicate response status:', response.status, JSON.stringify(response.data).slice(0, 300));
    if (response.status >= 400) {
      const detail = response.data?.detail || response.data?.error || JSON.stringify(response.data);
      return res.status(500).json({ error: `Replicate (${response.status}): ${detail}` });
    }
    const pred = response.data;
    if (pred.status === 'succeeded' && pred.output?.[0]) {
      return res.json({ taskId: pred.id, provider: 'replicate', videoUrl: pred.output[0] });
    }
    res.json({ taskId: pred.id, provider: 'replicate' });
  } catch (err) {
    console.error('Replicate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status/replicate/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { apiKey } = req.query;
    if (!apiKey) return res.status(400).json({ error: 'APIトークンが必要です' });

    const response = await axios.get(
      `https://api.replicate.com/v1/predictions/${taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 }
    );
    const pred = response.data;
    const statusMap = { starting: 'PENDING', processing: 'RUNNING', succeeded: 'SUCCEEDED', failed: 'FAILED', canceled: 'FAILED' };
    res.json({
      status: statusMap[pred.status] || 'PENDING',
      progress: pred.status === 'succeeded' ? 100 : pred.status === 'processing' ? 50 : 5,
      videoUrl: pred.output?.[0] || null,
      error: pred.error || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── fal.ai (無料クレジットあり) ──────────────────────────────────────
// fast-svd-lcm: Stable Video Diffusion の高速版
app.post('/api/generate/fal', async (req, res) => {
  try {
    const { apiKey, imageBase64, motionBucket = 100 } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'APIキーが必要です' });
    if (!imageBase64) return res.status(400).json({ error: '画像が必要です' });

    const response = await axios.post(
      'https://queue.fal.run/fal-ai/fast-svd-lcm',
      {
        image_url: imageBase64,
        motion_bucket_id: parseInt(motionBucket),
        fps: 7,
        num_frames: 25,
        cond_aug: 0.02,
      },
      {
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const requestId = response.data?.request_id;
    if (!requestId) throw new Error('タスクIDが取得できませんでした');
    res.json({ taskId: requestId, provider: 'fal' });
  } catch (err) {
    const detail = err.response?.data?.detail || err.response?.data?.error || err.message;
    res.status(500).json({ error: String(detail) });
  }
});

app.get('/api/status/fal/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { apiKey, model = 'fal-ai/fast-svd-lcm' } = req.query;
    if (!apiKey) return res.status(400).json({ error: 'APIキーが必要です' });

    // まずステータス確認
    const statusRes = await axios.get(
      `https://queue.fal.run/${model}/requests/${taskId}/status`,
      {
        headers: { Authorization: `Key ${apiKey}` },
        timeout: 15000,
        validateStatus: () => true,
      }
    );

    const statusData = statusRes.data;
    // IN_QUEUE, IN_PROGRESS, COMPLETED
    if (statusData.status === 'COMPLETED') {
      // 結果を取得
      const resultRes = await axios.get(
        `https://queue.fal.run/${model}/requests/${taskId}`,
        { headers: { Authorization: `Key ${apiKey}` }, timeout: 15000 }
      );
      const videoUrl = resultRes.data?.video?.url || resultRes.data?.videos?.[0]?.url || null;
      return res.json({ status: 'SUCCEEDED', progress: 100, videoUrl });
    } else if (statusData.status === 'IN_PROGRESS') {
      const pct = statusData.progress_percentage || 50;
      return res.json({ status: 'RUNNING', progress: pct, videoUrl: null });
    } else if (statusData.status === 'IN_QUEUE') {
      const pos = statusData.queue_position ?? '?';
      return res.json({ status: 'PENDING', progress: 5, videoUrl: null, queuePos: pos });
    } else {
      const errMsg = statusData.error || statusData.detail || JSON.stringify(statusData);
      return res.json({ status: 'FAILED', error: errMsg });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Runway Gen-3 ────────────────────────────────────────────────────
app.post('/api/generate/runway', async (req, res) => {
  try {
    const { prompt, apiKey, ratio = '1280:768', duration = 10, imageBase64 } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });
    if (!imageBase64) return res.status(400).json({ error: 'Image required' });

    const response = await axios.post(
      'https://api.dev.runwayml.com/v1/image_to_video',
      { model: 'gen3a_turbo', promptImage: imageBase64, promptText: prompt || '', ratio, duration: parseInt(duration) },
      { headers: { Authorization: `Bearer ${apiKey}`, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    res.json({ taskId: response.data.id, provider: 'runway' });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.response?.data?.message || err.message });
  }
});

app.get('/api/status/runway/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { apiKey } = req.query;
    const response = await axios.get(
      `https://api.dev.runwayml.com/v1/tasks/${taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}`, 'X-Runway-Version': '2024-11-06' }, timeout: 15000 }
    );
    const task = response.data;
    res.json({ status: task.status, progress: task.progress || 0, videoUrl: task.output?.[0] || null, error: task.failure || null });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// ── Kling AI ────────────────────────────────────────────────────────
app.post('/api/generate/kling', async (req, res) => {
  try {
    const { prompt, apiKey, ratio = '16:9', duration = 10, imageBase64 } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });
    if (!imageBase64) return res.status(400).json({ error: 'Image required' });

    const image = imageBase64.replace(/^data:[^;]+;base64,/, '');
    const response = await axios.post(
      'https://api.klingai.com/v1/videos/image2video',
      { model_name: 'kling-v1', image, prompt: prompt || '', cfg_scale: 0.5, mode: 'std', duration: String(duration), aspect_ratio: ratio },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    res.json({ taskId: response.data.data?.task_id, provider: 'kling' });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.get('/api/status/kling/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { apiKey } = req.query;
    const response = await axios.get(
      `https://api.klingai.com/v1/videos/image2video/${taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 }
    );
    const task = response.data.data;
    const statusMap = { submitted: 'PENDING', processing: 'RUNNING', succeed: 'SUCCEEDED', failed: 'FAILED' };
    res.json({
      status: statusMap[task?.task_status] || task?.task_status,
      progress: task?.task_status === 'processing' ? 50 : (task?.task_status === 'succeed' ? 100 : 0),
      videoUrl: task?.task_result?.videos?.[0]?.url || null,
      error: task?.task_status_msg || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Generator: http://localhost:${PORT}`));
