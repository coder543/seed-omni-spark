#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <output_dir>" >&2
  exit 1
fi

OUT_DIR="$1"

HF_CLI="hf"
if [[ -x "./.venv/bin/hf" ]]; then
  HF_CLI="./.venv/bin/hf"
elif command -v hf >/dev/null 2>&1; then
  HF_CLI="hf"
elif [[ -x "./.venv/bin/huggingface-cli" ]]; then
  HF_CLI="./.venv/bin/huggingface-cli"
elif command -v huggingface-cli >/dev/null 2>&1; then
  HF_CLI="huggingface-cli"
else
  echo "hf/huggingface-cli not found. Install with: pip install huggingface_hub" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

${HF_CLI} download naver-hyperclovax/HyperCLOVAX-SEED-Omni-8B \
  --local-dir "$OUT_DIR"
