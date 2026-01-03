#!/usr/bin/env bash
set -euo pipefail

PATCH_FILE="${1:-./patches/omniserv.patch}"
SUBMODULE_DIR="${2:-./OmniServe}"

if [[ ! -f "$PATCH_FILE" ]]; then
  echo "Patch not found: $PATCH_FILE" >&2
  exit 1
fi

if [[ ! -d "$SUBMODULE_DIR" ]]; then
  echo "Submodule dir not found: $SUBMODULE_DIR" >&2
  exit 1
fi

# Apply patch from repo root
patch -p1 -d "$SUBMODULE_DIR" < "$PATCH_FILE"

echo "Applied patch to $SUBMODULE_DIR"
