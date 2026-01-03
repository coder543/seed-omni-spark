import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const OMNI_BASE = process.env.OMNI_BASE || 'http://omni-chainer:8000';
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.resolve('/app/public');

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
        max_tokens: 256,
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
app.use(
  '/v1',
  createProxyMiddleware({
    target: OMNI_BASE,
    changeOrigin: true,
    pathRewrite: {
      '^/v1': '/b/v1'
    },
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
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`webui-proxy listening on :${PORT} -> ${OMNI_BASE}`);
});
