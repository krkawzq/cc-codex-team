#!/usr/bin/env bash
# Thin wrapper: ensures daemon is running, then subscribes to events.
# Forward all args (so caller can pass -b <token>, --stream, --filter, etc.)
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
"${PLUGIN_ROOT}/bin/codex-team" daemon start >/dev/null
exec "${PLUGIN_ROOT}/bin/codex-team" monitor events "$@"
