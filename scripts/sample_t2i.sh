#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:8000/b/v1}"
OUT_DIR="${2:-./samples}"
OUT_FILE="${3:-omni_image.png}"
DECODER_URL="${4:-http://localhost:10063/decode}"

mkdir -p "$OUT_DIR"

cat > /tmp/t2i_payload.json <<'JSON'
{
  "model": "track_b_model",
  "messages": [
    {"role": "system", "content": "Return ONLY the discrete image token string. It must start with <|discrete_image_start|> and end with <|discrete_image_end|>. Do not include any other text."},
    {"role": "user", "content": "Draw a picture of a sunset over mountains"}
  ],
  "max_tokens": 7000,
  "temperature": 0.7,
  "skip_special_tokens": false,
  "chat_template_kwargs": {"skip_reasoning": true}
}
JSON

curl -sS -m 300 "${BASE_URL}/chat/completions" \
  -H 'Content-Type: application/json' \
  -d @/tmp/t2i_payload.json > /tmp/t2i_resp.json

RAW_CONTENT=$(jq -r '.choices[0].message.content // empty' /tmp/t2i_resp.json)
IMG_URL="$RAW_CONTENT"

if [[ -z "$IMG_URL" ]]; then
  echo "No image tokens returned. Response:" >&2
  cat /tmp/t2i_resp.json >&2
  exit 1
fi

IMG_TOKENS=$(
  IMG_URL="$IMG_URL" python3 - <<'PY'
import os, re, sys
content = os.environ.get("IMG_URL", "")
match = re.search(r"<\\|discrete_image_start\\|>.*?<\\|discrete_image_end\\|>", content, re.S)
if not match:
    sys.exit(1)
print(match.group(0), end="")
PY
)

if [[ -z "$IMG_TOKENS" ]]; then
  echo "No discrete image token block found. Response:" >&2
  cat /tmp/t2i_resp.json >&2
  exit 1
fi

DECODE_PAYLOAD=$(jq -n --arg vlm_output "$IMG_TOKENS" '{vlm_output: $vlm_output, num_inference_steps: 1, height: 256, width: 256}')
curl -sS -m 600 "$DECODER_URL" \
  -H 'Content-Type: application/json' \
  -d "$DECODE_PAYLOAD" > /tmp/t2i_decode.json

IMG_URL=$(jq -r '.presigned_url // empty' /tmp/t2i_decode.json)
if [[ -z "$IMG_URL" ]]; then
  echo "Vision decoder did not return a URL. Response:" >&2
  cat /tmp/t2i_decode.json >&2
  exit 1
fi

IMG_URL_LOCAL=$(echo "$IMG_URL" | sed 's|http://minio:9000|http://localhost:9000|')

curl -sS "$IMG_URL_LOCAL" -o "$OUT_DIR/$OUT_FILE"

echo "Saved image to $OUT_DIR/$OUT_FILE"
