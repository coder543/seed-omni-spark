#!/usr/bin/env bash
set -euo pipefail

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

AUDIO_URL=$(printf '%s' "$AUDIO_B64" | base64 -d)
AUDIO_URL_LOCAL=$(echo "$AUDIO_URL" | sed 's|http://minio:9000|http://localhost:9000|')

curl -sS "$AUDIO_URL_LOCAL" -o "$OUT_DIR/$OUT_FILE"

echo "Saved audio to $OUT_DIR/$OUT_FILE"
