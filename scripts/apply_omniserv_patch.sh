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
  else
    echo "Patch did not apply cleanly. Resolve conflicts in $SUBMODULE_DIR." >&2
    exit 1
  fi
else
  # Fallback to patch if git is unavailable.
  patch -p1 -N --batch -d "$SUBMODULE_DIR" < "$PATCH_FILE"
  echo "Applied patch to $SUBMODULE_DIR"
fi
