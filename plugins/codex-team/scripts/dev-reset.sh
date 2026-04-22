#!/usr/bin/env bash
# Dev helper: stop daemon, wipe persistent state, rebuild, restart daemon.
# Intended for development only — it will drop every session and user.
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CODEX_TEAM_BIN="${PLUGIN_ROOT}/bin/codex-team"
DATA_DIR="${CODEX_TEAM_DATA_DIR:-$HOME/.codex-team}"

echo "[dev-reset] stopping daemon if running..."
"${CODEX_TEAM_BIN}" daemon stop --force >/dev/null 2>&1 || true

echo "[dev-reset] wiping ${DATA_DIR}"
rm -rf "${DATA_DIR}"

echo "[dev-reset] rebuild"
(cd "${PLUGIN_ROOT}" && npm run build)

echo "[dev-reset] done."
