#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
"${PLUGIN_ROOT}/bin/codex-team" daemon start >/dev/null
exec "${PLUGIN_ROOT}/bin/codex-team" monitor events
