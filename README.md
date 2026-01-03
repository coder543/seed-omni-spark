# SEED-Omni on NVIDIA DGX Spark (Docker Compose)

Turnkey repo to run **HyperCLOVAX SEED Omni 8B (Track B)** with OmniServe on NVIDIA DGX Spark using Docker Compose and a local S3 endpoint (MinIO).

This repo treats OmniServe as a **git submodule** and applies a small patch set for DGX Spark compatibility (CUDA 13.x, torchao pin, vLLM model registry sync, and memory tuning).

---

## What You Get

- **Docker Compose** for Track‑B OMNI (text/vision/audio) + MinIO
- **Local S3** for image/audio outputs
- **Sample scripts** for chat, text‑to‑image, and text‑to‑audio
- **Patch workflow** to keep OmniServe upstream clean

---

## Prerequisites

- NVIDIA DGX Spark (CUDA 13.x + driver 580.95.05 or newer)
- Docker + Docker Compose
- NVIDIA Container Toolkit
- Enough disk for model weights (~16GB) + conversions

> This repo assumes the model weights are stored in `/path/to/models` and mounted into containers.

---

## 1) Clone + Submodule

```bash
git clone <this-repo>
cd seed-omni

git submodule update --init --recursive
```

Apply our OmniServe patch:

```bash
./scripts/apply_omniserv_patch.sh
```

### One-shot run

If you want a single command that handles submodules, patching, model download/convert, venv setup, and Compose:

```bash
./start.sh
```

You can override the model location (default is `./models`):

```bash
MODEL_ROOT=/path/to/models ./start.sh
```

---

## 2) Model Weights

We keep weights outside the repo at:

```
/path/to/models
```

Download and convert:

```bash
./scripts/download_model.sh
./scripts/convert_model.sh
```

This produces:

```
/path/to/models/track_b/llm/HyperCLOVAX-SEED-Omni-8B
/path/to/models/track_b/ve
/path/to/models/track_b/vd
/path/to/models/track_b/ae
/path/to/models/track_b/ad
```

---

## 3) Environment

Copy and edit `.env` if needed:

```bash
cp .env.example .env
```

Key variables:

```
OMNI_MODEL_PATH=/path/to/models/track_b/llm/HyperCLOVAX-SEED-Omni-8B
VISION_ENCODER_PATH=/path/to/models/track_b/ve
VISION_DECODER_PATH=/path/to/models/track_b/vd
AUDIO_ENCODER_PATH=/path/to/models/track_b/ae
AUDIO_DECODER_PATH=/path/to/models/track_b/ad

# MinIO (local S3)
NCP_S3_ENDPOINT=http://minio:9000
NCP_S3_ACCESS_KEY=minio
NCP_S3_SECRET_KEY=minio123
NCP_S3_BUCKET_NAME=omni
```

---

## 4) Build & Run

```bash
docker compose -f docker-compose.track-b.yaml build
docker compose -f docker-compose.track-b.yaml up -d
```

Follow logs during first boot (model loading can take a few minutes):

```bash
docker compose -f docker-compose.track-b.yaml logs -f omni
```

---

## 5) Health Checks

```bash
curl http://localhost:8000/health
curl http://localhost:10032/health
```

---

## 6) Sample Outputs

### Chat

```bash
./scripts/sample_chat.sh
```

### Text → Image

```bash
./scripts/sample_t2i.sh
```

Output saved to:

```
./samples/omni_image.png
```

### Text → Audio

```bash
./scripts/sample_t2a.sh
```

Output saved to:

```
./samples/omni_audio.wav
```

---

## Memory Tuning (DGX Spark)

The DGX Spark uses unified memory. vLLM still allocates GPU VRAM for KV cache, which can balloon memory usage during inference. To keep usage stable we run:

- `--gpu-memory-utilization 0.35`
- `--enforce-eager`

These are set in `docker-compose.track-b.yaml` under the `omni` service. This keeps total GPU usage in a safe range while enabling text/image/audio generation.

If you need more throughput and can tolerate higher memory usage, try:

```
--gpu-memory-utilization 0.45
```

---

## Notes on Image Generation

Image generation requires the tool call to return **discrete image tokens**. Some prompts can cause the model to refuse tool calls. The sample script uses a strict system prompt to force the tool output format required by OmniServe’s tool parser.

---

## Submodule Patch Summary

The patch includes:

- DGX Spark‑friendly Dockerfiles (CUDA 13.x base)
- torchao pin for CUDA 13 compatibility
- vLLM model registry sync (added `vllm/model_executor/models`)
- decoder requirements adjustments

If you want to regenerate the patch later:

```
# assuming you have a clean submodule and a modified OmniServe copy
# diff -ruN OmniServe OmniServe.modified > patches/omniserv.clean.patch
```

---

## Troubleshooting

- **LLM endpoint not reachable**: wait for `omni` container to finish loading (health will move to `healthy`).
- **Image generation returns no tool call**: use `scripts/sample_t2i.sh` (strict system prompt).
- **Audio generation fails**: ensure MinIO is running and reachable on `http://localhost:9000`.

---

## References

- OmniServe repository (NAVER Cloud HyperCLOVA‑X)
- HyperCLOVAX SEED Omni 8B model card (Hugging Face)
