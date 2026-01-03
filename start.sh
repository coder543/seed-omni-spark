#!/usr/bin/env bash
set -euo pipefail

# One-shot launcher for DGX Spark.
# - Initializes submodule + applies patch
# - Downloads + converts model if needed
# - Builds and launches Docker Compose
# - Streams logs and waits for health

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Configurable locations
MODEL_ROOT="${MODEL_ROOT:-$ROOT_DIR/models}"
TRACK_B_DIR="$MODEL_ROOT/track_b"
TRACK_B_MODEL_SUBDIR="HyperCLOVAX-SEED-Omni-8B"

RAW_DIR="$TRACK_B_DIR/_raw"
RAW_LLM_DIR="$RAW_DIR/$TRACK_B_MODEL_SUBDIR"
LLM_DIR="$TRACK_B_DIR/llm/$TRACK_B_MODEL_SUBDIR"
VE_DIR="$TRACK_B_DIR/ve/$TRACK_B_MODEL_SUBDIR"
VD_DIR="$TRACK_B_DIR/vd/$TRACK_B_MODEL_SUBDIR"
AE_DIR="$TRACK_B_DIR/ae/$TRACK_B_MODEL_SUBDIR"
AD_DIR="$TRACK_B_DIR/ad/$TRACK_B_MODEL_SUBDIR"

# Ensure submodule
if [[ -d "$ROOT_DIR/OmniServe" ]]; then
  if [[ ! -f "$ROOT_DIR/OmniServe/.git" ]]; then
    echo "[INFO] OmniServe submodule not initialized. Initializing..."
    git submodule update --init --recursive
  fi
else
  echo "[INFO] OmniServe directory missing. Initializing submodule..."
  git submodule update --init --recursive
fi

# Ensure local venv with required tools
if [[ ! -d "$ROOT_DIR/.venv" ]]; then
  echo "[INFO] Creating .venv ..."
  python3 -m venv "$ROOT_DIR/.venv"
fi

echo "[INFO] Ensuring Python deps (huggingface_hub, torch, safetensors, openai, easydict, numpy) ..."
if ! "$ROOT_DIR/.venv/bin/python" - <<'PY' >/dev/null 2>&1
import huggingface_hub, safetensors, torch, openai, easydict, numpy
PY
then
  "$ROOT_DIR/.venv/bin/python" -m pip install --upgrade pip >/dev/null
  "$ROOT_DIR/.venv/bin/pip" install -q huggingface_hub safetensors torch openai easydict numpy
fi

# Apply patch (idempotent-ish)
if [[ -f "$ROOT_DIR/patches/omniserv.clean.patch" ]]; then
  echo "[INFO] Applying OmniServe patch..."
  "$ROOT_DIR/scripts/apply_omniserv_patch.sh"
fi

# Ensure vision decoder requirements file exists (some upstreams only ship requirements.txt).
REQ_MIN="$ROOT_DIR/OmniServe/decoder/vision/track_b/requirements.min.txt"
REQ_FULL="$ROOT_DIR/OmniServe/decoder/vision/track_b/requirements.txt"
if [[ ! -f "$REQ_MIN" ]] && [[ -f "$REQ_FULL" ]]; then
  echo "[INFO] requirements.min.txt missing; copying from requirements.txt"
  grep -v -E '^(decord|nvidia-|torch==|torchvision==|torchaudio==|deepspeed==|triton==)' "$REQ_FULL" > "$REQ_MIN"
fi

REQ_VISION_AARCH64="$ROOT_DIR/OmniServe/encoder/vision/track_b/requirements.aarch64.txt"
REQ_VISION_FULL="$ROOT_DIR/OmniServe/encoder/vision/track_b/requirements.txt"
if [[ ! -f "$REQ_VISION_AARCH64" ]] && [[ -f "$REQ_VISION_FULL" ]]; then
  echo "[INFO] requirements.aarch64.txt missing; copying from requirements.txt"
  grep -v -E '^(decord|nvidia-|torch==|torchvision==|torchaudio==|deepspeed==|triton==)' "$REQ_VISION_FULL" > "$REQ_VISION_AARCH64"
fi

# Download model if missing
if [[ ! -d "$RAW_LLM_DIR" ]]; then
  echo "[INFO] Raw model not found at $RAW_LLM_DIR"
  echo "[INFO] Downloading model to $RAW_LLM_DIR ..."
  "$ROOT_DIR/scripts/download_model.sh" "$RAW_LLM_DIR"
fi

# Convert if needed
CONVERT_MARKER="$TRACK_B_DIR/.conversion_complete"
if [[ ! -f "$CONVERT_MARKER" ]] || [[ ! -d "$VE_DIR" ]] || [[ ! -d "$VD_DIR" ]] || [[ ! -d "$AE_DIR" ]] || [[ ! -d "$AD_DIR" ]]; then
  echo "[INFO] Converted components missing. Running conversion..."
  "$ROOT_DIR/scripts/convert_model.sh" "$RAW_LLM_DIR" "$TRACK_B_DIR"
  touch "$CONVERT_MARKER"
fi

# Ensure env
if [[ ! -f "$ROOT_DIR/.env" ]]; then
  echo "[INFO] .env missing, creating from .env.example"
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
fi

# Helper: set or replace key in .env
set_env() {
  local key="$1"
  local val="$2"
  if grep -qE "^${key}=" "$ROOT_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ROOT_DIR/.env"
  else
    echo "${key}=${val}" >> "$ROOT_DIR/.env"
  fi
}

set_env OMNI_MODEL_PATH "$LLM_DIR"
set_env OMNI_ENCODER_VISION_MODEL_PATH "$VE_DIR"
set_env OMNI_DECODER_VISION_MODEL_PATH "$VD_DIR"
set_env OMNI_ENCODER_AUDIO_MODEL_PATH "$AE_DIR"
set_env OMNI_DECODER_AUDIO_TORCHSERVE_MODEL_PATH "$AD_DIR"

# Keep vLLM in eager mode by default for stability on newer GPUs.
if [[ -z "${OMNI_VLLM_EXTRA_ARGS:-}" ]]; then
  set_env OMNI_VLLM_EXTRA_ARGS "--enforce-eager"
fi

# Build + run
cd "$ROOT_DIR"

docker compose -f docker-compose.yml build

docker compose -f docker-compose.yml up -d

echo "[INFO] Streaming logs until healthy..."
(
  docker compose -f docker-compose.yml logs -f omni &
  echo $! > /tmp/seed_omni_logs.pid
)

# Wait for health
READY=0
for i in $(seq 1 360); do
  if curl -fsS http://localhost:10032/health >/dev/null 2>&1 && \
     curl -fsS http://localhost:8000/health >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 5
  if (( i % 12 == 0 )); then
    echo "[INFO] Waiting for OmniServe to become healthy..."
  fi
done

if [[ -f /tmp/seed_omni_logs.pid ]]; then
  kill "$(cat /tmp/seed_omni_logs.pid)" >/dev/null 2>&1 || true
  rm -f /tmp/seed_omni_logs.pid
fi

if [[ "$READY" -eq 1 ]]; then
  echo "[INFO] OmniServe is healthy."
  echo "[INFO] (Suggestion) Test chat: ./scripts/test_chat.sh"
else
  echo "[WARN] Timed out waiting for health. Check logs:"
  echo "  docker compose -f docker-compose.yml logs -f omni"
fi
