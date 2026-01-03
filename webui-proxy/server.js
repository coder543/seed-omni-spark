import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Readable } from 'stream';

const app = express();
const PORT = process.env.PORT || 3000;
const OMNI_BASE = process.env.OMNI_BASE || 'http://omni-chainer:8000';
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.resolve('/app/public');
const INTERNAL_BASE = process.env.PROXY_INTERNAL_BASE || 'http://seed-omni-webui:3000';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve('/app/uploads');
const MODEL_ID = 'naver-hyperclovax/HyperCLOVAX-SEED-Omni-8B';
const OMNI_MODEL_ID = 'track_b_model';

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Minimal /props response to satisfy webui
app.get('/props', (_req, res) => {
  res.json({
    default_generation_settings: {
      id: 0,
      id_task: 0,
      n_ctx: 8192,
      speculative: false,
      is_processing: false,
      params: {
        n_predict: 256,
        seed: 0,
        temperature: 0.7,
        dynatemp_range: 0,
        dynatemp_exponent: 0,
        top_k: 40,
        top_p: 0.95,
        min_p: 0.05,
        top_n_sigma: 0,
        xtc_probability: 0,
        xtc_threshold: 0,
        typ_p: 1,
        repeat_last_n: 64,
        repeat_penalty: 1.1,
        presence_penalty: 0,
        frequency_penalty: 0,
        dry_multiplier: 0,
        dry_base: 0,
        dry_allowed_length: 0,
        dry_penalty_last_n: 0,
        dry_sequence_breakers: [],
        mirostat: 0,
        mirostat_tau: 0,
        mirostat_eta: 0,
        stop: [],
        max_tokens: -1,
        n_keep: 0,
        n_discard: 0,
        ignore_eos: false,
        stream: true,
        logit_bias: [],
        n_probs: 0,
        min_keep: 0,
        grammar: "",
        grammar_lazy: false,
        grammar_triggers: [],
        preserved_tokens: [],
        chat_format: "",
        reasoning_format: "",
        reasoning_in_content: false,
        thinking_forced_open: false,
        samplers: [],
        "speculative.n_max": 0,
        "speculative.n_min": 0,
        "speculative.p_min": 0,
        timings_per_token: false,
        post_sampling_probs: false,
        lora: []
      },
      prompt: "",
      next_token: {
        has_next_token: false,
        has_new_line: false,
        n_remain: 0,
        n_decoded: 0,
        stopping_word: ""
      }
    },
    total_slots: 1,
    model_path: "track_b_model",
    role: "MODEL",
    modalities: { vision: true, audio: true },
    chat_template: "",
    bos_token: "",
    eos_token: "",
    build_info: "omni-webui-proxy",
    webui_settings: {}
  });
});

// Proxy OpenAI-compatible endpoints to OmniServe Track B
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: MODEL_ID,
        object: 'model',
        owned_by: 'omniserv',
        permission: [],
        modalities: { vision: true, audio: true }
      }
    ]
  });
});

// Handle chat completions directly to avoid proxy body issues.
app.post('/v1/chat/completions', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    if (body.model === MODEL_ID) {
      body.model = OMNI_MODEL_ID;
    }
    // OmniServe does not accept max_tokens=-1; omit to mean "no limit".
    if (body.max_tokens === -1 || body.max_tokens === 0) {
      delete body.max_tokens;
    }

    // Convert data: URLs into hosted files so OmniServe can fetch them.
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!Array.isArray(msg?.content)) continue;
        for (const part of msg.content) {
          if (part?.type === 'image_url' && part?.image_url?.url?.startsWith('data:')) {
            const { url, mime } = writeDataUrl(part.image_url.url);
            part.image_url.url = url;
            part.image_url.mime_type = mime;
          }
          if (part?.type === 'audio_url' && part?.audio_url?.url?.startsWith('data:')) {
            const { url, mime } = writeDataUrl(part.audio_url.url);
            part.audio_url.url = url;
            part.audio_url.mime_type = mime;
          }
        }
      }
    }
    const upstream = await fetch(`${OMNI_BASE}/b/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.set('content-type', contentType);
    if (contentType.includes('text/event-stream')) {
      res.set('cache-control', 'no-cache');
      res.set('connection', 'keep-alive');
      res.flushHeaders();
      const stream = Readable.fromWeb(upstream.body);
      stream.pipe(res);
      stream.on('error', () => res.end());
      return;
    }
    const text = await upstream.text();
    res.send(text);
  } catch (err) {
    res.status(502);
    res.set('content-type', 'application/json');
    res.send(JSON.stringify({ error: 'Upstream chat completion failed', detail: String(err) }));
  }
});

app.use(
  '/v1',
  createProxyMiddleware({
    target: OMNI_BASE,
    changeOrigin: true,
    pathRewrite: (path) => `/b/v1${path}`,
    logLevel: 'warn'
  })
);

// Basic health passthrough
app.use(
  '/health',
  createProxyMiddleware({
    target: OMNI_BASE,
    changeOrigin: true,
    logLevel: 'warn'
  })
);

// Serve static UI
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function writeDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) {
    throw new Error('Invalid data URL');
  }
  const mime = match[1];
  const b64 = match[2];
  const buf = Buffer.from(b64, 'base64');
  const ext = mimeToExt(mime);
  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return { url: `${INTERNAL_BASE}/uploads/${filename}`, mime };
}

function mimeToExt(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'audio/wav') return 'wav';
  if (mime === 'audio/mpeg') return 'mp3';
  if (mime === 'audio/webm') return 'webm';
  return 'bin';
}

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`webui-proxy listening on :${PORT} -> ${OMNI_BASE}`);
});
