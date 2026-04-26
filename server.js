const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Runway Gen-3 image-to-video
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
      {
        model: 'gen3a_turbo',
        promptImage: imageBase64,
        promptText: prompt || '',
        ratio,
        duration: parseInt(duration),
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-Runway-Version': '2024-11-06',
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    res.json({ taskId: response.data.id, provider: 'runway' });
  } catch (err) {
    const msg = err.response?.data?.error || err.response?.data?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

// Runway task status
app.get('/api/status/runway/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { apiKey } = req.query;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });

    const response = await axios.get(
      `https://api.dev.runwayml.com/v1/tasks/${taskId}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-Runway-Version': '2024-11-06',
        },
        timeout: 15000,
      }
    );

    const task = response.data;
    res.json({
      status: task.status,
      progress: task.progress || 0,
      videoUrl: task.output?.[0] || null,
      error: task.failure || null,
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    res.status(500).json({ error: msg });
  }
});

// Kling AI image-to-video
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
      {
        model_name: 'kling-v1',
        image: imageBase64,
        prompt: prompt || '',
        cfg_scale: 0.5,
        mode: 'std',
        duration: String(duration),
        aspect_ratio: ratio,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const taskId = response.data.data?.task_id;
    res.json({ taskId, provider: 'kling' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

// Kling task status
app.get('/api/status/kling/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { apiKey } = req.query;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });

    const response = await axios.get(
      `https://api.klingai.com/v1/videos/image2video/${taskId}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
      }
    );

    const task = response.data.data;
    const statusMap = { submitted: 'PENDING', processing: 'RUNNING', succeed: 'SUCCEEDED', failed: 'FAILED' };
    const videoUrl = task?.task_result?.videos?.[0]?.url || null;

    res.json({
      status: statusMap[task?.task_status] || task?.task_status,
      progress: task?.task_status === 'processing' ? 50 : (task?.task_status === 'succeed' ? 100 : 0),
      videoUrl,
      error: task?.task_status_msg || null,
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Generator: http://localhost:${PORT}`));
