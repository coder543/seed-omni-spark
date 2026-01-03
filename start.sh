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

LLM_DIR="$TRACK_B_DIR/llm/HyperCLOVAX-SEED-Omni-8B"
VE_DIR="$TRACK_B_DIR/ve"
VD_DIR="$TRACK_B_DIR/vd"
AE_DIR="$TRACK_B_DIR/ae"
AD_DIR="$TRACK_B_DIR/ad"

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

echo "[INFO] Ensuring Python deps (huggingface_hub, torch, safetensors, openai, easydict) ..."
if ! "$ROOT_DIR/.venv/bin/python" - <<'PY' >/dev/null 2>&1
import huggingface_hub, safetensors, torch, openai, easydict
PY
then
  "$ROOT_DIR/.venv/bin/python" -m pip install --upgrade pip >/dev/null
  "$ROOT_DIR/.venv/bin/pip" install -q huggingface_hub safetensors torch openai easydict
fi

# Apply patch (idempotent-ish)
if [[ -f "$ROOT_DIR/patches/omniserv.clean.patch" ]]; then
  echo "[INFO] Applying OmniServe patch..."
  "$ROOT_DIR/scripts/apply_omniserv_patch.sh" || true
fi

# Download model if missing
if [[ ! -d "$LLM_DIR" ]]; then
  echo "[INFO] Model not found at $LLM_DIR"
  echo "[INFO] Downloading model to $TRACK_B_DIR/llm ..."
  "$ROOT_DIR/scripts/download_model.sh" "$TRACK_B_DIR/llm"
fi

# Convert if needed
if [[ ! -d "$VE_DIR" ]] || [[ ! -d "$VD_DIR" ]] || [[ ! -d "$AE_DIR" ]] || [[ ! -d "$AD_DIR" ]]; then
  echo "[INFO] Converted components missing. Running conversion..."
  "$ROOT_DIR/scripts/convert_model.sh" "$TRACK_B_DIR"
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
