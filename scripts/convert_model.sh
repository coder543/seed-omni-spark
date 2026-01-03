#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <input_model_dir> <output_dir>" >&2
  exit 1
fi

IN_DIR="$1"
OUT_DIR="$2"

python3 ./OmniServe/convert_model.py \
  --input "$IN_DIR" \
  --output "$OUT_DIR" \
  --track b
