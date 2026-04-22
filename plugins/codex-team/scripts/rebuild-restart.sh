#!/usr/bin/env bash
# Dev helper: rebuild TS, then restart the daemon so it picks up the new code.
# Safe to run while sessions exist — daemon restart preserves user/session state.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

echo "[rebuild-restart] building..."
(cd "${PLUGIN_ROOT}" && npm run build)

echo "[rebuild-restart] restarting daemon..."
"${PLUGIN_ROOT}/bin/codex-team" daemon restart

echo "[rebuild-restart] done."
