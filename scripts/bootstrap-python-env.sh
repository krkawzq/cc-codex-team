#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_ROOT="${CLAUDE_PLUGIN_DATA:-${XDG_DATA_HOME:-${HOME}/.local/share}/cc-codex-team-plugin}"
VENV="${CODEX_TEAM_PLUGIN_VENV:-${DATA_ROOT}/venv}"
STAMP="${VENV}/.codex-team-0.1.0"

if [[ -x "${VENV}/bin/python" && -f "${STAMP}" ]]; then
  exit 0
fi

PY="${PYTHON:-python3}"
mkdir -p "${DATA_ROOT}"
"${PY}" -m venv "${VENV}"

if ! "${VENV}/bin/python" -m pip --version >/dev/null 2>&1; then
  "${VENV}/bin/python" -m ensurepip --upgrade >/dev/null
fi

"${VENV}/bin/python" -m pip install --upgrade pip >/dev/null
"${VENV}/bin/python" -m pip install -e "${PLUGIN_ROOT}" >/dev/null
touch "${STAMP}"
