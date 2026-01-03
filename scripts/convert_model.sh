#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <input_model_dir> <output_dir>" >&2
  exit 1
fi

IN_DIR="$1"
OUT_DIR="$2"

PYTHON_BIN="python3"
if [[ -x "./.venv/bin/python" ]]; then
  PYTHON_BIN="./.venv/bin/python"
fi

$PYTHON_BIN ./OmniServe/convert_model.py \
  --input "$IN_DIR" \
  --output "$OUT_DIR" \
  --track b
