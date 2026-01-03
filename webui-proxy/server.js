import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Readable } from 'stream';
import os from 'os';
import { spawn } from 'child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const app = express();
const PORT = process.env.PORT || 3000;
const OMNI_BASE = process.env.OMNI_BASE || 'http://omni-chainer:8000';
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.resolve('/app/public');
const INTERNAL_BASE = process.env.PROXY_INTERNAL_BASE || 'http://seed-omni-webui:3000';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve('/app/uploads');
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'http://minio:9000';
const AUDIO_DECODER_ENDPOINT =
  process.env.AUDIO_DECODER_ENDPOINT || 'http://omni-decoder-audio-api:8000/predictions';
const AUDIO_DEFAULT_FORMAT = process.env.AUDIO_DEFAULT_FORMAT || 'wav';
const AUDIO_TORCHSERVE_ENDPOINT =
  process.env.AUDIO_TORCHSERVE_ENDPOINT ||
  'http://omni-decoder-audio-torchserve:8081/predictions/NCCosybigvganDecoder';
const AUDIO_TORCHSERVE_SPEAKER = process.env.AUDIO_TORCHSERVE_SPEAKER || 'fkms';
const AUDIO_TORCHSERVE_FORMAT = (process.env.AUDIO_TORCHSERVE_FORMAT || 'pcm').toLowerCase();
const AUDIO_PCM_SAMPLE_RATE = Number(process.env.AUDIO_PCM_SAMPLE_RATE || 24000);
const AUDIO_TOKEN_CHUNK_SIZE = Number(process.env.AUDIO_TOKEN_CHUNK_SIZE || 150);
const AUDIO_STREAMING_MAX_BASE64 = Number(process.env.AUDIO_STREAMING_MAX_BASE64 || 400000);
const AUDIO_PROGRESS_INTERVAL = Number(process.env.AUDIO_PROGRESS_INTERVAL || 10);
const AUDIO_TOKEN_LOG = process.env.AUDIO_TOKEN_LOG === '1';
const IMAGE_PROGRESS_INTERVAL = Number(process.env.IMAGE_PROGRESS_INTERVAL || 50);
const VISION_DECODER_ENDPOINT =
  process.env.VISION_DECODER_ENDPOINT || 'http://omni-decoder-vision-api:10063/decode';
const S3_ENDPOINT = process.env.NCP_S3_ENDPOINT;
const S3_REGION = process.env.NCP_S3_REGION || 'us-east-1';
const S3_ACCESS_KEY = process.env.NCP_S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.NCP_S3_SECRET_KEY;
const S3_BUCKET = process.env.NCP_S3_BUCKET_NAME;
const S3_FORCE_PATH_STYLE = (process.env.S3_FORCE_PATH_STYLE || '1') !== '0';
const MODEL_ID = 'naver-hyperclovax/HyperCLOVAX-SEED-Omni-8B';
const OMNI_MODEL_ID = 'track_b_model';
const IMAGE_DEBUG = process.env.IMAGE_DEBUG === '1';
const AUDIO_DEBUG_DIR = process.env.AUDIO_DEBUG_DIR || '';

const s3Enabled = Boolean(S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY && S3_BUCKET);
const s3 = s3Enabled
  ? new S3Client({
      endpoint: S3_ENDPOINT,
      region: S3_REGION,
      credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY
      },
      forcePathStyle: S3_FORCE_PATH_STYLE
    })
  : null;

if (!s3Enabled && !fs.existsSync(UPLOAD_DIR)) {
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
    if (IMAGE_DEBUG) {
      console.log('[image] request', {
        stream: body.stream,
        hasTools: Array.isArray(body.tools) && body.tools.length > 0,
        hasExtraBody: !!body.extra_body,
        skipReasoning: body?.extra_body?.chat_template_kwargs?.skip_reasoning === true
      });
    }
    if (body.model === MODEL_ID) {
      body.model = OMNI_MODEL_ID;
    }
    // OmniServe does not accept max_tokens=-1; omit to mean "no limit".
    if (body.max_tokens === -1 || body.max_tokens === 0) {
      delete body.max_tokens;
    }

    // Convert data: URLs / inline audio into hosted files so OmniServe can fetch them.
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            await normalizeContentPart(part);
          }
        } else if (content && typeof content === 'object') {
          await normalizeContentPart(content);
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
      await streamSseWithTransform(upstream, res, {
        audioFormat: body?.audio?.format || AUDIO_DEFAULT_FORMAT,
        speakerInfo: body?.audio || undefined
      });
      return;
    }

    const text = await upstream.text();
    if (contentType.includes('application/json')) {
      try {
        const data = JSON.parse(text);
        const transformed = await transformCompletionToBase64(data);
        res.send(JSON.stringify(transformed));
        return;
      } catch {
        // fall through
      }
    }
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

// Proxy MinIO so browser can access generated media via /s3/...
app.use(
  '/s3',
  createProxyMiddleware({
    target: MINIO_ENDPOINT,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/s3/, ''),
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

async function transformSseToBase64(raw) {
  const lines = raw.split('\n');
  let content = '';
  let reasoning = '';
  let toolCalls = [];
  let audio = undefined;
  let model = undefined;

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (!model) model = parsed.model || parsed?.choices?.[0]?.model || parsed?.choices?.[0]?.delta?.model;
      const delta = parsed?.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      if (delta?.tool_calls) toolCalls = mergeToolCalls(toolCalls, delta.tool_calls);
      if (delta?.audio) audio = delta.audio;
    } catch {
      // ignore malformed chunks
    }
  }

  const extracted = extractThinkBlocks(content);
  if (extracted) {
    content = extracted.content ?? content;
    if (extracted.reasoning) reasoning += extracted.reasoning;
  }

  const payload = {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'track_b_model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || '',
          reasoning_content: reasoning || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          audio
        }
      }
    ]
  };

  if (toolCalls?.length) {
    if (IMAGE_DEBUG) {
      console.log('[image] non-stream tool_calls collected', JSON.stringify(toolCalls));
    }
    await resolveVisionToolCalls(toolCalls);
  }
  const transformed = await transformCompletionToBase64(payload);
  return `data: ${JSON.stringify({
    id: transformed.id,
    object: 'chat.completion.chunk',
    created: transformed.created,
    model: transformed.model,
    choices: [
      {
        index: 0,
        delta: {
          content: transformed.choices[0]?.message?.content,
          reasoning_content: transformed.choices[0]?.message?.reasoning_content,
          tool_calls: transformed.choices[0]?.message?.tool_calls,
          audio: transformed.choices[0]?.message?.audio
        }
      }
    ]
  })}\n\ndata: [DONE]\n`;
}

async function streamSseWithTransform(upstream, res, options = {}) {
  const reader = upstream.body?.getReader();
  if (!reader) {
    const raw = await upstream.text();
    const transformed = await transformSseToBase64(raw);
    res.send(transformed);
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let toolCalls = [];
  let audio = undefined;
  let sentAudio = false;
  let audioTokenDetected = false;
  let doneSeen = false;
  let prefixBuffer = '';
  let fullContent = '';
  let thinkCarry = '';
  let thinkInProgress = false;
  let audioTokenBuffer = [];
  let allAudioTokens = [];
  let audioWavChunks = [];
  let audioPcmChunks = [];
  let audioProgressDecodeFailed = false;
  let audioFinalDecodeFailed = false;
  let audioDecodeQueue = Promise.resolve();
  let audioTokensReceived = 0;
  let audioTokensDecoded = 0;
  let audioProgressLastSent = 0;
  let deferFinalFlush = false;
  let imageTokensReceived = 0;
  let imageProgressLastSent = 0;
  const audioChunkSize =
    Number.isFinite(AUDIO_TOKEN_CHUNK_SIZE) && AUDIO_TOKEN_CHUNK_SIZE > 0
      ? AUDIO_TOKEN_CHUNK_SIZE
      : 150;
  const imageProgressInterval =
    Number.isFinite(IMAGE_PROGRESS_INTERVAL) && IMAGE_PROGRESS_INTERVAL > 0
      ? IMAGE_PROGRESS_INTERVAL
      : 10;

  const emitAudioProgress = () => {
    const payload = {
      id: meta.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
      object: 'chat.completion.chunk',
      created: meta.created || Math.floor(Date.now() / 1000),
      model: meta.model || 'track_b_model',
      choices: [{ index: 0, delta: {} }],
      audio_progress: {
        received: audioTokensReceived,
        decoded: audioTokensDecoded
      }
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const emitImageProgress = () => {
    if (imageTokensReceived <= 0) return;
    const payload = {
      id: meta.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
      object: 'chat.completion.chunk',
      created: meta.created || Math.floor(Date.now() / 1000),
      model: meta.model || 'track_b_model',
      choices: [{ index: 0, delta: {} }],
      image_progress: {
        received: imageTokensReceived
      }
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const countVisionTokensInToolCalls = (calls) => {
    if (!Array.isArray(calls)) return 0;
    let total = 0;
    for (const call of calls) {
      if (call?.function?.name !== 't2i_model_generation') continue;
      const args = call?.function?.arguments;
      if (typeof args !== 'string') continue;
      const matches = args.match(/<\\|vision/g);
      if (matches) total += matches.length;
    }
    return total;
  };

  const debugAudioTokens = (label, tokens) => {
    if (!AUDIO_TOKEN_LOG) return;
    if (!tokens || tokens.length === 0) return;
    const preview = tokens.slice(0, 12);
    const tail = tokens.slice(-12);
    console.log(
      `[audio-debug] ${label} count=${tokens.length} first=[${preview.join(',')}] last=[${tail.join(',')}]`
    );
  };

  const emitAudioChunkIfSafe = (wavBuf) => {
    if (!wavBuf || wavBuf.length === 0) return;
    if (AUDIO_STREAMING_MAX_BASE64 <= 0) return;
    const b64 = wavBuf.toString('base64');
    if (AUDIO_STREAMING_MAX_BASE64 > 0 && b64.length > AUDIO_STREAMING_MAX_BASE64) {
      return;
    }
    emitAudioDelta(res, meta, { format: 'audio/wav', data: b64 });
  };

  const queueAudioDecode = (chunkTokens) => {
    audioDecodeQueue = audioDecodeQueue.then(async () => {
      if (audioProgressDecodeFailed || chunkTokens.length < 3) return;
      const audioChunk = await fetchTorchserveAudio(
        chunkTokens,
        extractSpeakerId(fullContent) || AUDIO_TORCHSERVE_SPEAKER
      );
      if (!audioChunk) {
        audioProgressDecodeFailed = true;
        return;
      }
      if (audioChunk.format === 'pcm') {
        audioPcmChunks.push(audioChunk.buf);
        const wavOut = buildWavFromPcm(audioChunk.buf, AUDIO_PCM_SAMPLE_RATE, 1, 16);
        emitAudioChunkIfSafe(wavOut);
        if (shouldWriteAudioDebug()) {
          try {
            safeMkdir(AUDIO_DEBUG_DIR);
            const name = `audio-chunk-${String(audioPcmChunks.length).padStart(4, '0')}.pcm`;
            fs.writeFileSync(path.join(AUDIO_DEBUG_DIR, name), audioChunk.buf);
          } catch (err) {
            console.warn('audio-debug: failed to write chunk', err);
          }
        }
      } else {
        audioWavChunks.push(audioChunk.buf);
        emitAudioChunkIfSafe(audioChunk.buf);
        if (shouldWriteAudioDebug()) {
          try {
            safeMkdir(AUDIO_DEBUG_DIR);
            const name = `audio-chunk-${String(audioWavChunks.length).padStart(4, '0')}.wav`;
            fs.writeFileSync(path.join(AUDIO_DEBUG_DIR, name), audioChunk.buf);
          } catch (err) {
            console.warn('audio-debug: failed to write chunk', err);
          }
        }
      }
      audioTokensDecoded += chunkTokens.length;
      emitAudioProgress();
    });
  };

  const enqueueAudioTokens = (newTokens) => {
    if (!newTokens || newTokens.length === 0) return;
    debugAudioTokens('enqueue', newTokens);
    allAudioTokens.push(...newTokens);
    audioTokensReceived += newTokens.length;
    const interval = Number.isFinite(AUDIO_PROGRESS_INTERVAL) && AUDIO_PROGRESS_INTERVAL > 0
      ? AUDIO_PROGRESS_INTERVAL
      : 1;
    if (audioTokensReceived - audioProgressLastSent >= interval) {
      audioProgressLastSent = audioTokensReceived;
      emitAudioProgress();
    }
    audioTokenBuffer.push(...newTokens);
    while (audioTokenBuffer.length >= audioChunkSize) {
      const chunk = audioTokenBuffer.splice(0, audioChunkSize);
      debugAudioTokens('chunk', chunk);
      queueAudioDecode(chunk);
    }
  };
  const meta = {
    id: undefined,
    created: undefined,
    model: undefined
  };

  const startThinkTag = '<think>';
  const endThinkTag = '</think>';

  const splitThinkSegments = (input) => {
    let text = `${thinkCarry}${input}`;
    thinkCarry = '';
    const segments = [];

    while (text.length > 0) {
      if (thinkInProgress) {
        const endIdx = text.indexOf(endThinkTag);
        if (endIdx === -1) {
          const keep = endThinkTag.length - 1;
          if (text.length >= keep) {
            const emit = text.slice(0, text.length - keep);
            if (emit) segments.push({ type: 'reasoning', text: emit });
            thinkCarry = text.slice(text.length - keep);
          } else {
            thinkCarry = text;
          }
          return segments;
        }
        const emit = text.slice(0, endIdx);
        if (emit) segments.push({ type: 'reasoning', text: emit });
        text = text.slice(endIdx + endThinkTag.length);
        thinkInProgress = false;
      } else {
        const startIdx = text.indexOf(startThinkTag);
        if (startIdx === -1) {
          const keep = startThinkTag.length - 1;
          if (text.length >= keep) {
            const emit = text.slice(0, text.length - keep);
            if (emit) segments.push({ type: 'content', text: emit });
            thinkCarry = text.slice(text.length - keep);
          } else {
            thinkCarry = text;
          }
          return segments;
        }
        const emit = text.slice(0, startIdx);
        if (emit) segments.push({ type: 'content', text: emit });
        text = text.slice(startIdx + startThinkTag.length);
        thinkInProgress = true;
      }
    }
    return segments;
  };

  const emitSegments = (parsed, segments) => {
    for (const segment of segments) {
      const cloned = JSON.parse(JSON.stringify(parsed));
      if (cloned?.choices?.[0]?.delta) {
        if (segment.type === 'reasoning') {
          delete cloned.choices[0].delta.content;
          cloned.choices[0].delta.reasoning_content = segment.text;
        } else {
          cloned.choices[0].delta.content = segment.text;
        }
      }
      res.write(`data: ${JSON.stringify(cloned)}\n\n`);
    }
  };

  const flushThinkCarry = (parsed) => {
    if (!thinkCarry) return;
    const carry = thinkCarry;
    thinkCarry = '';
    const segment = {
      type: thinkInProgress ? 'reasoning' : 'content',
      text: carry
    };
    emitSegments(parsed, [segment]);
  };

  const flushExtras = async () => {
    const audioForFlush = sentAudio ? undefined : audio;
    if ((!toolCalls || toolCalls.length === 0) && !audioForFlush) return;
    if (toolCalls?.length) {
      if (IMAGE_DEBUG) {
        console.log('[image] stream tool_calls collected', JSON.stringify(toolCalls));
      }
      await resolveVisionToolCalls(toolCalls);
    }
    const payload = {
      id: meta.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
      object: 'chat.completion',
      created: meta.created || Math.floor(Date.now() / 1000),
      model: meta.model || 'track_b_model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            audio: audioForFlush
          }
        }
      ]
    };
    const transformed = await transformCompletionToBase64(payload);
    const delta = {
      tool_calls: transformed.choices[0]?.message?.tool_calls,
      audio: transformed.choices[0]?.message?.audio
    };
    if (IMAGE_DEBUG && delta.tool_calls) {
      console.log('[image] stream tool_calls final', JSON.stringify(delta.tool_calls));
    }
      if (!delta.tool_calls && !delta.audio) return;
      const chunk = {
        id: transformed.id,
        object: 'chat.completion.chunk',
        created: transformed.created,
        model: transformed.model,
      choices: [{ index: 0, delta }]
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (!data) continue;
          if (data === '[DONE]') {
            doneSeen = true;
            if (audioTokenDetected) {
              deferFinalFlush = true;
            } else {
              await flushExtras();
              res.write('data: [DONE]\n\n');
            }
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed?.id) meta.id = parsed.id;
            if (parsed?.created) meta.created = parsed.created;
            if (parsed?.model) meta.model = parsed.model;
            const delta = parsed?.choices?.[0]?.delta;
            if (delta?.content) {
              fullContent += delta.content;
              if (!audioTokenDetected) {
                const combined = prefixBuffer + delta.content;
                const audioIdx = combined.indexOf('<|audio');
                if (audioIdx !== -1) {
                  audioTokenDetected = true;
                  const before = combined.slice(0, audioIdx);
                  const after = combined.slice(audioIdx);
                  if (AUDIO_TOKEN_LOG) {
                    console.log('[audio-debug] detect audio boundary', {
                      beforeLen: before.length,
                      afterLen: after.length,
                      prefixBufferLen: prefixBuffer.length,
                      thinkCarryLen: thinkCarry.length
                    });
                  }
                  if (thinkCarry) {
                    flushThinkCarry(parsed);
                  }
                  const cleaned = stripTranscriptTags(before);
                  const emitContent = cleaned || before;
                  if (emitContent) {
                    const segments = splitThinkSegments(emitContent);
                    if (segments.length > 0) emitSegments(parsed, segments);
                    if (thinkCarry) {
                      flushThinkCarry(parsed);
                    }
                  }
                  prefixBuffer = '';
                  const tokens = extractAudioTokensFromText(after);
                  enqueueAudioTokens(tokens);
                } else {
                  const safeLength = Math.max(0, combined.length - 6);
                  const emit = combined.slice(0, safeLength);
                  prefixBuffer = combined.slice(safeLength);
                  const cleaned = stripTranscriptTags(emit);
                  if (cleaned) {
                    const segments = splitThinkSegments(cleaned);
                    if (segments.length > 0) emitSegments(parsed, segments);
                  }
                }
              } else {
                const tokens = extractAudioTokensFromText(delta.content);
                enqueueAudioTokens(tokens);
              }
            }
            if (delta?.tool_calls) {
              toolCalls = mergeToolCalls(toolCalls, delta.tool_calls);
              if (IMAGE_DEBUG) {
                console.log('[image] stream tool_call delta', JSON.stringify(delta.tool_calls));
              }
              const currentImageTokens = countVisionTokensInToolCalls(toolCalls);
              if (
                currentImageTokens > imageTokensReceived &&
                currentImageTokens - imageProgressLastSent >= imageProgressInterval
              ) {
                imageTokensReceived = currentImageTokens;
                imageProgressLastSent = currentImageTokens;
                emitImageProgress();
              }
            }
            if (delta?.audio) {
              audio = await normalizeAudioDelta(delta.audio);
              if (audio) {
                delta.audio = audio;
                sentAudio = true;
              }
            }
            if (delta?.tool_calls || delta?.audio) {
              const cloned = JSON.parse(JSON.stringify(parsed));
              const cleanedDelta = cloned?.choices?.[0]?.delta;
              if (cleanedDelta) {
                delete cleanedDelta.tool_calls;
              }
              const hasContent =
                cleanedDelta?.content ||
                cleanedDelta?.reasoning_content ||
                cleanedDelta?.role ||
                cleanedDelta?.audio;
              if (hasContent) {
                res.write(`data: ${JSON.stringify(cloned)}\n\n`);
              }
            } else if (!delta?.content) {
              res.write(`data: ${data}\n\n`);
            }
          } catch {
            res.write(`${line}\n`);
          }
        } else {
          res.write(`${line}\n`);
        }
      }
    }
  } finally {
    if (!audioTokenDetected) {
      if (thinkCarry) {
        flushThinkCarry({
          id: meta.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
          object: 'chat.completion.chunk',
          created: meta.created || Math.floor(Date.now() / 1000),
          model: meta.model || 'track_b_model',
          choices: [{ index: 0, delta: { content: '' } }]
        });
      }
      const tail = prefixBuffer;
      const cleaned = stripTranscriptTags(tail);
      if (cleaned) {
        const segments = splitThinkSegments(cleaned);
        if (segments.length > 0) {
          emitSegments(
            {
              id: meta.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
              object: 'chat.completion.chunk',
              created: meta.created || Math.floor(Date.now() / 1000),
              model: meta.model || 'track_b_model',
              choices: [{ index: 0, delta: { content: '' } }]
            },
            segments
          );
        }
      }
    }
    if (audioTokenDetected && !audio) {
      if (thinkCarry) {
        flushThinkCarry({
          id: meta.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
          object: 'chat.completion.chunk',
          created: meta.created || Math.floor(Date.now() / 1000),
          model: meta.model || 'track_b_model',
          choices: [{ index: 0, delta: { content: '' } }]
        });
      }
      if (prefixBuffer) {
        const cleaned = stripTranscriptTags(prefixBuffer);
        if (cleaned) {
          const segments = splitThinkSegments(cleaned);
          if (segments.length > 0) {
            emitSegments(
              {
                id: meta.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
                object: 'chat.completion.chunk',
                created: meta.created || Math.floor(Date.now() / 1000),
                model: meta.model || 'track_b_model',
                choices: [{ index: 0, delta: { content: '' } }]
              },
              segments
            );
          }
        }
        prefixBuffer = '';
      }
      if (audioTokenBuffer.length > 0) {
        const remaining = audioTokenBuffer.splice(0, audioTokenBuffer.length);
        debugAudioTokens('final-buffer', remaining);
        queueAudioDecode(remaining);
      }
      try {
        await audioDecodeQueue;
      } catch {
        audioProgressDecodeFailed = true;
      }
      let finalWav;
      if (!audioProgressDecodeFailed && audioPcmChunks.length > 0) {
        finalWav = buildWavFromPcm(
          Buffer.concat(audioPcmChunks),
          AUDIO_PCM_SAMPLE_RATE,
          1,
          16
        );
      } else if (!audioProgressDecodeFailed && audioWavChunks.length > 0) {
        try {
          finalWav = await concatWavBuffers(audioWavChunks);
        } catch {
          finalWav = undefined;
        }
      }
      if (!finalWav && !audioFinalDecodeFailed && allAudioTokens.length >= 3) {
        debugAudioTokens('final-all', allAudioTokens);
        const audioChunk = await fetchTorchserveAudio(
          allAudioTokens,
          extractSpeakerId(fullContent) || AUDIO_TORCHSERVE_SPEAKER
        );
        if (audioChunk) {
          if (audioChunk.format === 'pcm') {
            finalWav = buildWavFromPcm(
              audioChunk.buf,
              AUDIO_PCM_SAMPLE_RATE,
              1,
              16
            );
          } else {
            finalWav = audioChunk.buf;
          }
        } else {
          audioFinalDecodeFailed = true;
        }
      }
      if (!finalWav && audioWavChunks.length > 0) {
        try {
          finalWav = await concatWavBuffers(audioWavChunks);
        } catch {
          finalWav = undefined;
        }
      }
      if (finalWav) {
        audio = { format: 'audio/wav', data: finalWav.toString('base64') };
      }
    }
    if (!doneSeen) {
      await flushExtras();
    } else if (deferFinalFlush) {
      await flushExtras();
      res.write('data: [DONE]\n\n');
    }
    res.end();
  }
}

async function transformCompletionToBase64(data) {
  const message = data?.choices?.[0]?.message;
  if (IMAGE_DEBUG && message?.tool_calls?.length) {
    console.log('[image] non-stream tool_calls received', JSON.stringify(message.tool_calls));
  }
  if (message?.content) {
    const extracted = extractThinkBlocks(message.content);
    if (extracted) {
      if (extracted.content !== undefined) message.content = extracted.content;
      if (extracted.reasoning) {
        message.reasoning_content = message.reasoning_content
          ? `${message.reasoning_content}${extracted.reasoning}`
          : extracted.reasoning;
      }
    }
  }
  if (message?.tool_calls?.length) {
    for (const call of message.tool_calls) {
      if (call?.function?.name !== 't2i_model_generation') continue;
      const argsRaw = call?.function?.arguments;
      let args = undefined;
      try {
        args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
      } catch {
        args = undefined;
      }
      let token = args?.discrete_image_token;
      if (typeof token === 'string' && token.trim().startsWith('data:')) {
        const normalized = normalizeImageDataUrl(token);
        if (normalized && normalized !== token) {
          args.discrete_image_token = normalized;
          call.function.arguments = JSON.stringify(args);
          token = normalized;
          if (IMAGE_DEBUG) console.log('[image] normalized data url mime');
        }
      }
      if (typeof token === 'string' && !token.trim().startsWith('data:')) {
        if (looksLikeVisionTokens(token)) {
          if (IMAGE_DEBUG) {
            console.log('[image] decoding vision tokens (non-stream)', {
              length: token.length,
              preview: token.slice(0, 120)
            });
          }
          const decoded = await decodeVisionTokensToUrl(token);
          if (decoded) {
            args.discrete_image_token = decoded;
            call.function.arguments = JSON.stringify(args);
            token = decoded;
            if (IMAGE_DEBUG) console.log('[image] decoded vision tokens -> url', decoded);
          }
        }
        const dataUrl = await fetchAsDataUrl(token);
        if (dataUrl) {
          args.discrete_image_token = dataUrl;
          call.function.arguments = JSON.stringify(args);
          if (IMAGE_DEBUG) console.log('[image] fetched data url (non-stream)', dataUrl.slice(0, 80));
        }
      }
    }
  }

  if (message?.audio?.data) {
    const url = decodeBase64ToString(message.audio.data);
    if (url && !url.startsWith('data:')) {
      const dataUrl = await fetchAsDataUrl(url, message.audio.format);
      if (dataUrl) {
        message.audio.data = dataUrl.replace(/^data:[^;]+;base64,/, '');
        message.audio.format = dataUrl.split(';')[0].replace('data:', '') || message.audio.format;
      }
    }
  }

  return data;
}

async function normalizeAudioDelta(audio) {
  if (!audio?.data) return audio;
  const decoded = decodeBase64ToString(audio.data);
  if (decoded) {
    if (decoded.startsWith('data:')) {
      const parsed = parseDataUrl(decoded);
      if (parsed) {
        return { format: parsed.mime, data: parsed.data };
      }
    }
    if (
      decoded.startsWith('http://') ||
      decoded.startsWith('https://') ||
      decoded.startsWith('s3://')
    ) {
      const dataUrl = await fetchAsDataUrl(decoded, audio.format);
      if (dataUrl) {
        const parsed = parseDataUrl(dataUrl);
        if (parsed) {
          return { format: parsed.mime, data: parsed.data };
        }
      }
    }
  }
  return audio;
}

function stripTranscriptTags(content) {
  if (!content) return content;
  let result = content;
  const hasUser = /<user_transcript>.*?<\/user_transcript>/s.test(result);
  const hasAssistant = /<assistant_transcript>.*?<\/assistant_transcript>/s.test(result);
  if (hasUser && hasAssistant) {
    result = result.replace(/<user_transcript>.*?<\/user_transcript>\s*/gs, '');
  } else {
    result = result.replace(/<user_transcript>(.*?)<\/user_transcript>/gs, '$1');
  }
  result = result.replace(/<assistant_transcript>(.*?)<\/assistant_transcript>/gs, '$1');
  result = result.replace(/\s*<audio_decoder_call>\s*/gs, '');
  return result;
}

function extractAudioTokens(content) {
  const tokens = [];
  if (!content) return tokens;
  const re = /<\|audio(\d+)\|>/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const val = Number(match[1]);
    if (!Number.isNaN(val)) tokens.push(val);
  }
  return tokens;
}

async function decodeAudioTokens(tokens, format, speaker, onChunk) {
  if (!AUDIO_TORCHSERVE_ENDPOINT || tokens.length < 3) {
    console.warn('audio-decode: missing endpoint or too few tokens', {
      hasEndpoint: Boolean(AUDIO_TORCHSERVE_ENDPOINT),
      count: tokens.length
    });
    return undefined;
  }
  if (tokens.length > 2000) {
    console.warn('audio-decode: too many tokens', { count: tokens.length });
    return undefined;
  }
  const chunkSize = Number.isFinite(AUDIO_TOKEN_CHUNK_SIZE) && AUDIO_TOKEN_CHUNK_SIZE > 0
    ? AUDIO_TOKEN_CHUNK_SIZE
    : 150;

  const pcmChunks = [];
  let audioSpec = null;

  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize);
    const audioChunk = await fetchTorchserveAudio(chunk, speaker);
    if (!audioChunk) {
      console.warn('audio-decode: torchserve chunk failed', { index: i, size: chunk.length });
      return undefined;
    }
    if (audioChunk.format === 'pcm') {
      if (onChunk) {
        const wavOut = buildWavFromPcm(
          audioChunk.buf,
          AUDIO_PCM_SAMPLE_RATE,
          1,
          16
        );
        await onChunk({ format: 'audio/wav', data: wavOut.toString('base64') });
      }
      if (!audioSpec) {
        audioSpec = { sampleRate: AUDIO_PCM_SAMPLE_RATE, numChannels: 1, bitsPerSample: 16 };
      }
      pcmChunks.push(audioChunk.buf);
    } else {
      if (onChunk) {
        await onChunk({ format: 'audio/wav', data: audioChunk.buf.toString('base64') });
      }
      const parsed = parseWav(audioChunk.buf);
      if (!parsed) {
        console.warn('audio-decode: failed to parse wav chunk');
        return undefined;
      }
      if (!audioSpec) {
        audioSpec = parsed;
      }
      pcmChunks.push(parsed.data);
    }
  }

  if (!audioSpec) return undefined;
  const combined = Buffer.concat(pcmChunks);
  const wavOut = buildWavFromPcm(combined, audioSpec.sampleRate, audioSpec.numChannels, audioSpec.bitsPerSample);
  return { format: 'audio/wav', data: wavOut.toString('base64') };
}

function extractAudioTokensFromText(content) {
  const tokens = [];
  if (!content) return tokens;
  const re = /<\|audio(\d+)\|>/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const val = Number(match[1]);
    if (!Number.isNaN(val)) tokens.push(val);
  }
  return tokens;
}

function mergeToolCalls(existing, deltas) {
  const result = Array.isArray(existing) ? [...existing] : [];
  for (const delta of deltas || []) {
    const index = delta.index ?? 0;
    if (!result[index]) result[index] = {};
    result[index] = {
      ...result[index],
      ...delta,
      function: {
        ...(result[index].function || {}),
        ...(delta.function || {})
      }
    };
    if (delta?.function?.arguments) {
      const prev = result[index]?.function?.arguments || '';
      const next = delta.function.arguments;
      if (typeof next === 'string' && next.trim().startsWith('{')) {
        result[index].function.arguments = next;
      } else {
        result[index].function.arguments = `${prev}${next}`;
      }
    }
  }
  return result;
}

async function resolveVisionToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    if (call?.function?.name !== 't2i_model_generation') continue;
    const argsRaw = call?.function?.arguments;
    let args;
    try {
      args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
    } catch {
      args = undefined;
    }
    const token = args?.discrete_image_token;
    if (typeof token !== 'string') continue;
    if (token.trim().startsWith('data:')) continue;
    if (!looksLikeVisionTokens(token)) continue;
    if (IMAGE_DEBUG) {
      console.log('[image] resolve vision token', {
        length: token.length,
        preview: token.slice(0, 120)
      });
    }
    const decoded = await decodeVisionTokensToUrl(token);
    if (!decoded) {
      if (IMAGE_DEBUG) console.log('[image] vision decode failed');
      continue;
    }
    args.discrete_image_token = decoded;
    call.function.arguments = JSON.stringify(args);
    if (IMAGE_DEBUG) console.log('[image] vision decode url', decoded);
  }
}

function emitAudioDelta(res, meta, audioObj) {
  if (!audioObj?.data) return;
  const payload = {
    id: meta.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion.chunk',
    created: meta.created || Math.floor(Date.now() / 1000),
    model: meta.model || 'track_b_model',
    choices: [
      {
        index: 0,
        delta: {
          audio: audioObj
        }
      }
    ]
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function fetchAsDataUrl(url, hintFormat) {
  try {
    const resolved = resolveUrl(url);
    if (!resolved) return undefined;
    const resp = await fetch(resolved);
    if (!resp.ok) return undefined;
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = resp.headers.get('content-type') || guessMime(url, hintFormat);
    const b64 = buf.toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return undefined;
  }
}

function resolveUrl(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('s3://')) {
    const parts = url.replace('s3://', '').split('/');
    const bucket = parts.shift();
    const key = parts.join('/');
    if (!bucket || !key) return undefined;
    return `${MINIO_ENDPOINT}/${bucket}/${key}`;
  }
  return undefined;
}

function guessMime(url, hintFormat) {
  const lower = url.split('?')[0].toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.wav') || hintFormat === 'wav') return 'audio/wav';
  if (lower.endsWith('.mp3') || hintFormat === 'mp3') return 'audio/mpeg';
  if (lower.endsWith('.webm') || hintFormat === 'webm') return 'audio/webm';
  return 'application/octet-stream';
}

function decodeBase64ToString(data) {
  try {
    let normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    if (pad) normalized += '='.repeat(4 - pad);
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function looksLikeVisionTokens(token) {
  if (!token) return false;
  return (
    token.includes('<|discrete_image_start|>') ||
    token.includes('<|vision_ratio_') ||
    token.includes('<|vision')
  );
}

function extractThinkBlocks(text) {
  if (!text) return undefined;
  const startTag = '<think>';
  const endTag = '</think>';
  let content = '';
  let reasoning = '';
  let idx = 0;

  while (idx < text.length) {
    const startIdx = text.indexOf(startTag, idx);
    if (startIdx === -1) {
      content += text.slice(idx);
      break;
    }
    content += text.slice(idx, startIdx);
    const afterStart = startIdx + startTag.length;
    const endIdx = text.indexOf(endTag, afterStart);
    if (endIdx === -1) {
      reasoning += text.slice(afterStart);
      return { content, reasoning: reasoning || undefined };
    }
    reasoning += text.slice(afterStart, endIdx);
    idx = endIdx + endTag.length;
  }

  return { content, reasoning: reasoning || undefined };
}

function normalizeImageDataUrl(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return undefined;
  if (parsed.mime.startsWith('image/')) return dataUrl;
  const header = parsed.data.slice(0, 32);
  let mime = undefined;
  if (header.startsWith('iVBORw0K')) {
    mime = 'image/png';
  } else if (header.startsWith('/9j/')) {
    mime = 'image/jpeg';
  } else if (header.startsWith('UklGR')) {
    mime = 'image/webp';
  }
  if (!mime) return undefined;
  return `data:${mime};base64,${parsed.data}`;
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) return undefined;
  return { mime: match[1], data: match[2] };
}

function extractSpeakerId(content) {
  if (!content) return undefined;
  const tagMatch = /<speaker_info>(\{[^{}]+\})<\/speaker_info>/.exec(content);
  if (tagMatch) {
    try {
      const info = JSON.parse(tagMatch[1]);
      const speakerId = info?.id || info?.speaker_id;
      if (speakerId === 'fkms' || speakerId === 'mhwj') return speakerId;
      if (info?.gender === 'm') return 'mhwj';
      if (info?.gender === 'f') return 'fkms';
    } catch {
      return undefined;
    }
  }
  const jsonMatch = /\n\n(\{[^{}]+\})(?:\n\n)?$/.exec(content);
  if (jsonMatch) {
    try {
      const info = JSON.parse(jsonMatch[1]);
      const speakerId = info?.id || info?.speaker_id;
      if (speakerId === 'fkms' || speakerId === 'mhwj') return speakerId;
      if (info?.gender === 'm') return 'mhwj';
      if (info?.gender === 'f') return 'fkms';
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function decodeVisionTokensToUrl(token) {
  try {
    const resp = await fetch(VISION_DECODER_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vlm_output: token,
        height: null,
        width: null,
        num_inference_steps: 30,
        seed: null,
        upload_to_s3: true,
        s3_prefix: 'vision-decoder',
        s3_expiration: 3600
      })
    });
    if (!resp.ok) return undefined;
    const data = await resp.json();
    return data?.presigned_url || data?.s3_path || undefined;
  } catch {
    return undefined;
  }
}

async function fetchTorchserveAudio(units, speaker) {
  try {
    const resp = await fetch(AUDIO_TORCHSERVE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        unit: units,
        format: AUDIO_TORCHSERVE_FORMAT,
        speaker: speaker || AUDIO_TORCHSERVE_SPEAKER
      })
    });
    if (!resp.ok) {
      console.warn('audio-decode: torchserve response not ok', { status: resp.status });
      return undefined;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    const effectiveFormat = contentType.includes('audio/pcm')
      ? 'pcm'
      : contentType.includes('audio/wav')
        ? 'wav'
        : AUDIO_TORCHSERVE_FORMAT;
    return { buf, format: effectiveFormat };
  } catch {
    console.warn('audio-decode: torchserve exception');
    return undefined;
  }
}

async function concatWavBuffers(buffers) {
  if (!buffers || buffers.length === 0) return undefined;
  if (buffers.length === 1) return buffers[0];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-audio-'));
  try {
    const listPath = path.join(tmpDir, 'list.txt');
    const outPath = path.join(tmpDir, 'out.wav');
    const entries = [];
    buffers.forEach((buf, idx) => {
      const name = `chunk-${idx}.wav`;
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, buf);
      entries.push(`file '${name}'`);
    });
    fs.writeFileSync(listPath, entries.join('\n'));
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath], {
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      });
    });
    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseWav(buf) {
  if (!buf || buf.length < 44) return undefined;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined;
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    offset += 8;
    if (id === 'fmt ') {
      const audioFormat = buf.readUInt16LE(offset);
      const numChannels = buf.readUInt16LE(offset + 2);
      const sampleRate = buf.readUInt32LE(offset + 4);
      const bitsPerSample = buf.readUInt16LE(offset + 14);
      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      data = buf.slice(offset, offset + size);
    }
    offset += size + (size % 2);
  }
  if (!fmt || !data) return undefined;
  return {
    sampleRate: fmt.sampleRate,
    numChannels: fmt.numChannels,
    bitsPerSample: fmt.bitsPerSample,
    data
  };
}

function buildWavFromPcm(pcm, sampleRate, numChannels, bitsPerSample) {
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

async function writeDataUrl(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new Error('Invalid data URL');
  }
  return writeBase64(parsed.data, parsed.mime);
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

async function writeBase64(b64, mime) {
  const buf = Buffer.from(b64, 'base64');
  const ext = mimeToExt(mime);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const filename = `${hash}.${ext}`;

  if (s3Enabled && s3) {
    const key = `webui-uploads/${filename}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: buf,
        ContentType: mime
      })
    );
    return { url: `s3://${S3_BUCKET}/${key}`, mime };
  }

  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return { url: `${INTERNAL_BASE}/uploads/${filename}`, mime };
}

async function normalizeContentPart(part) {
  if (!part || typeof part !== 'object') return;
  if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
    const { url, mime } = await writeDataUrl(part.image_url.url);
    part.image_url.url = url;
    part.image_url.mime_type = mime;
  }
  if (part.type === 'audio_url' && part.audio_url?.url) {
    if (part.audio_url.url.startsWith('data:')) {
      const { url, mime } = await writeDataUrl(part.audio_url.url);
      part.audio_url.url = url;
      part.audio_url.mime_type = mime;
    }
    const audioUrl = part.audio_url.url;
    delete part.audio_url;
    part.type = 'input_audio';
    part.input_audio = {
      data: Buffer.from(audioUrl).toString('base64'),
      format: 'mp3'
    };
  }
  if (part.type === 'input_audio' && part.input_audio?.data) {
    const format = String(part.input_audio.format || '').toLowerCase();
    const mime = format.includes('wav') ? 'audio/wav' : 'audio/mpeg';
    const { url } = await writeBase64(part.input_audio.data, mime);
    part.input_audio.data = Buffer.from(url).toString('base64');
    part.input_audio.format = format.includes('wav') ? 'wav' : 'mp3';
  }
}

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`webui-proxy listening on :${PORT} -> ${OMNI_BASE}`);
});
function safeMkdir(dir) {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

function shouldWriteAudioDebug() {
  return Boolean(AUDIO_DEBUG_DIR);
}
