#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
"${PLUGIN_ROOT}/bin/codex-team" daemon stop >/dev/null 2>&1 || true
