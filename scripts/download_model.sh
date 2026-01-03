#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <output_dir>" >&2
  exit 1
fi

OUT_DIR="$1"

if ! command -v huggingface-cli >/dev/null 2>&1; then
  echo "huggingface-cli not found. Install with: pip install huggingface_hub" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

huggingface-cli download naver-hyperclovax/HyperCLOVAX-SEED-Omni-8B \
  --local-dir "$OUT_DIR"
