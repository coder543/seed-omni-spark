#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBMODULE_DIR="$ROOT_DIR/OmniServe"
PATCH_DIR="$ROOT_DIR/patches"
PATCH_FILE="$PATCH_DIR/omniserv.clean.patch"

if ! git -C "$SUBMODULE_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "OmniServe submodule not found at $SUBMODULE_DIR" >&2
  exit 1
fi

mkdir -p "$PATCH_DIR"

tmp_patch="$(mktemp)"
trap 'rm -f "$tmp_patch"' EXIT

git -C "$SUBMODULE_DIR" diff --binary > "$tmp_patch"

if [[ -f "$PATCH_FILE" ]]; then
  if cmp -s "$tmp_patch" "$PATCH_FILE"; then
    echo "Patch is identical to existing $PATCH_FILE"
    exit 0
  fi
  cp "$tmp_patch" "$PATCH_FILE"
  echo "Patch updated at $PATCH_FILE"
else
  cp "$tmp_patch" "$PATCH_FILE"
  echo "Patch created at $PATCH_FILE"
fi
