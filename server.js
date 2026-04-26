const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Hugging Face (無料) ──────────────────────────────────────────────
// Stable Video Diffusion img2vid-xt: 25フレーム、約3〜4秒の動画を生成
app.post('/api/generate/huggingface', upload.single('image'), async (req, res) => {
  try {
    const { apiKey, motionBucket = 100 } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'APIトークンが必要です' });

    let imageBuffer;
    if (req.file) {
      imageBuffer = req.file.buffer;
    } else if (req.body.imageBase64) {
      const b64 = req.body.imageBase64.replace(/^data:[^;]+;base64,/, '');
      imageBuffer = Buffer.from(b64, 'base64');
    } else {
      return res.status(400).json({ error: '画像が必要です' });
    }

    // HF Inference API: モデルロード中は503が返るのでリトライ
    const HF_MODEL = 'https://api-inference.huggingface.co/models/stabilityai/stable-video-diffusion-img2vid-xt';
    let videoBuffer = null;
    const maxRetries = 20;

    for (let i = 0; i < maxRetries; i++) {
      const resp = await axios.post(HF_MODEL, imageBuffer, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/octet-stream',
          'x-use-cache': 'false',
        },
        params: { motion_bucket_id: parseInt(motionBucket) },
        responseType: 'arraybuffer',
        timeout: 300000,
        validateStatus: s => s < 600,
      });

      if (resp.status === 200) {
        videoBuffer = Buffer.from(resp.data);
        break;
      } else if (resp.status === 503) {
        // モデルロード中 → estimated_time待つ
        let wait = 20000;
        try {
          const errData = JSON.parse(Buffer.from(resp.data).toString());
          if (errData.estimated_time) wait = Math.min(errData.estimated_time * 1000, 60000);
        } catch (_) {}
        await new Promise(r => setTimeout(r, wait));
      } else {
        let errMsg = '生成に失敗しました';
        try { errMsg = JSON.parse(Buffer.from(resp.data).toString()).error || errMsg; } catch (_) {}
        return res.status(500).json({ error: errMsg });
      }
    }

    if (!videoBuffer) return res.status(500).json({ error: 'タイムアウト：モデルが起動しませんでした。しばらくしてから再試行してください' });

    const videoBase64 = videoBuffer.toString('base64');
    res.json({ videoBase64, mimeType: 'video/mp4' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Runway Gen-3 ────────────────────────────────────────────────────
app.post('/api/generate/runway', upload.single('image'), async (req, res) => {
  try {
    const { prompt, apiKey, ratio = '1280:768', duration = 10 } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });

    let imageBase64;
    if (req.file) {
      imageBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    } else if (req.body.imageBase64) {
      imageBase64 = req.body.imageBase64;
    } else {
      return res.status(400).json({ error: 'Image required' });
    }

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
app.post('/api/generate/kling', upload.single('image'), async (req, res) => {
  try {
    const { prompt, apiKey, ratio = '16:9', duration = 10 } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });

    let imageBase64;
    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64');
    } else if (req.body.imageBase64) {
      imageBase64 = req.body.imageBase64.replace(/^data:[^;]+;base64,/, '');
    } else {
      return res.status(400).json({ error: 'Image required' });
    }

    const response = await axios.post(
      'https://api.klingai.com/v1/videos/image2video',
      { model_name: 'kling-v1', image: imageBase64, prompt: prompt || '', cfg_scale: 0.5, mode: 'std', duration: String(duration), aspect_ratio: ratio },
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
