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

if command -v git >/dev/null 2>&1 && [[ -d "$SUBMODULE_DIR/.git" ]]; then
  # Prefer git apply for clean, non-interactive behavior.
  if git -C "$SUBMODULE_DIR" apply --check "$PATCH_FILE" >/dev/null 2>&1; then
    git -C "$SUBMODULE_DIR" apply "$PATCH_FILE"
    echo "Applied patch to $SUBMODULE_DIR"
  else
    echo "Patch already applied or not clean; skipping."
  fi
else
  # Fallback to patch if git is unavailable.
  patch -p1 -N --batch -d "$SUBMODULE_DIR" < "$PATCH_FILE"
  echo "Applied patch to $SUBMODULE_DIR"
fi
