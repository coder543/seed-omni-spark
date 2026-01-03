#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:8000/b/v1}"
OUT_DIR="${2:-./samples}"

mkdir -p "$OUT_DIR"

RESP=$(curl -sS "${BASE_URL}/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "track_b_model",
    "messages": [
      {"role": "user", "content": "Say hello from OmniServe."}
    ],
    "max_tokens": 64,
    "chat_template_kwargs": {"skip_reasoning": true}
  }')

if command -v jq >/dev/null 2>&1; then
  echo "$RESP" | jq .
else
  echo "$RESP"
fi
