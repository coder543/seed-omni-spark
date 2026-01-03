#!/usr/bin/env bash
set -euo pipefail

PATCH_FILE="${1:-./patches/omniserv.clean.patch}"
SUBMODULE_DIR="${2:-./OmniServe}"

if [[ ! -f "$PATCH_FILE" ]]; then
  echo "Patch not found: $PATCH_FILE" >&2
  exit 1
fi

if [[ ! -d "$SUBMODULE_DIR" ]]; then
  echo "Submodule dir not found: $SUBMODULE_DIR" >&2
  exit 1
fi

if command -v git >/dev/null 2>&1 && [[ -e "$SUBMODULE_DIR/.git" ]]; then
  # Use an absolute path so git -C can find the patch file.
  PATCH_ABS="$PATCH_FILE"
  if command -v realpath >/dev/null 2>&1; then
    PATCH_ABS="$(realpath "$PATCH_FILE")"
  else
    PATCH_ABS="$(cd "$(dirname "$PATCH_FILE")" && pwd)/$(basename "$PATCH_FILE")"
  fi

  # Prefer git apply for clean, non-interactive behavior.
  if git -C "$SUBMODULE_DIR" apply --check "$PATCH_ABS" >/dev/null 2>&1; then
    git -C "$SUBMODULE_DIR" apply "$PATCH_ABS"
    echo "Applied patch to $SUBMODULE_DIR"
  elif git -C "$SUBMODULE_DIR" apply --reverse --check "$PATCH_ABS" >/dev/null 2>&1; then
    echo "Patch already applied; skipping."
  elif \
    rg -q "FROM nvcr.io/nvidia/pytorch:25.10-py3" "$SUBMODULE_DIR/decoder/audio/codec/Dockerfile" 2>/dev/null && \
    rg -q "max_response_size=104857600" "$SUBMODULE_DIR/decoder/audio/codec/config.properties" 2>/dev/null && \
    rg -q "audio_sample_rate" "$SUBMODULE_DIR/decoder/audio/track_b/app/configs.py" 2>/dev/null; then
    echo "Patch appears applied (marker check); skipping."
  else
    echo "Patch did not apply cleanly. Resolve conflicts in $SUBMODULE_DIR." >&2
    exit 1
  fi
else
  # Fallback to patch if git is unavailable.
  patch -p1 -N --batch -d "$SUBMODULE_DIR" < "$PATCH_FILE"
  echo "Applied patch to $SUBMODULE_DIR"
fi
