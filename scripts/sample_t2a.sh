#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${1:-http://localhost:8000/b/v1}"
OUT_DIR="${2:-./samples}"
OUT_FILE="${3:-omni_audio.wav}"

mkdir -p "$OUT_DIR"

cat > /tmp/t2a_payload.json <<'JSON'
{
  "model": "track_b_model",
  "messages": [
    {"role": "user", "content": "Read this text aloud in a cheerful female voice:\nHello! How are you today?"}
  ],
  "max_tokens": 1000,
  "skip_special_tokens": false,
  "chat_template_kwargs": {"skip_reasoning": true}
}
JSON

curl -sS -m 300 "${BASE_URL}/chat/completions" \
  -H 'Content-Type: application/json' \
  -d @/tmp/t2a_payload.json > /tmp/t2a_resp.json

AUDIO_B64=$(jq -r '.choices[0].message.audio.data // empty' /tmp/t2a_resp.json)

if [[ -z "$AUDIO_B64" ]]; then
  echo "No audio data returned. Response:" >&2
  cat /tmp/t2a_resp.json >&2
  exit 1
fi

# Some responses omit base64 padding; base64 may warn but still decode.
# Use Python for robust decoding and avoid noisy stderr.
PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="python3"
fi

OUT_PATH="$OUT_DIR/$OUT_FILE"
DECODE_RESULT=$(AUDIO_B64="$AUDIO_B64" OUT_PATH="$OUT_PATH" "$PYTHON_BIN" - <<'PY'
import base64, os, sys
data = os.environ.get("AUDIO_B64", "")
out_path = os.environ.get("OUT_PATH", "")
if not data or not out_path:
    sys.exit(1)
pad = (-len(data)) % 4
data += "=" * pad
raw = base64.urlsafe_b64decode(data)
text = None
try:
    text = raw.decode("utf-8")
except Exception:
    text = None
if text and text.startswith(("http://", "https://", "s3://")):
    print(f"URL:{text}", end="")
    sys.exit(0)
with open(out_path, "wb") as f:
    f.write(raw)
print(f"FILE:{out_path}", end="")
PY
)

if [[ "$DECODE_RESULT" == URL:* ]]; then
  AUDIO_URL="${DECODE_RESULT#URL:}"
  AUDIO_URL_LOCAL=$(echo "$AUDIO_URL" | sed 's|http://minio:9000|http://localhost:9000|')
  curl -sS "$AUDIO_URL_LOCAL" -o "$OUT_PATH"
fi

echo "Saved audio to $OUT_DIR/$OUT_FILE"
