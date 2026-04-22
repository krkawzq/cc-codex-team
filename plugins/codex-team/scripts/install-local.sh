#!/usr/bin/env bash
# One-shot local install into Claude Code:
#   1. Add this repo as a marketplace
#   2. Install the codex-team plugin from it
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${HERE}/marketplace-add-local.sh"
"${HERE}/marketplace-install-local.sh"

echo "[install-local] done. Plugin 'codex-team' installed."
