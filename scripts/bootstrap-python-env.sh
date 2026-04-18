#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_ROOT="${CLAUDE_PLUGIN_DATA:-${XDG_DATA_HOME:-${HOME}/.local/share}/cc-codex-team-plugin}"
VENV="${CODEX_TEAM_PLUGIN_VENV:-${DATA_ROOT}/venv}"
STAMP="${VENV}/.codex-team-0.1.0"

# Fast path: already bootstrapped, skip everything.
if [[ -x "${VENV}/bin/python" && -f "${STAMP}" ]]; then
  exit 0
fi

mkdir -p "${DATA_ROOT}"

# Serialize concurrent bootstrap attempts (SessionStart hook + two plugin
# monitors can race on first activation).
LOCK_FILE="${DATA_ROOT}/bootstrap.lock"
exec 9>"${LOCK_FILE}"
if command -v flock >/dev/null 2>&1; then
  flock 9
fi

# Re-check stamp after acquiring the lock.
if [[ -x "${VENV}/bin/python" && -f "${STAMP}" ]]; then
  exit 0
fi

log() { echo "[codex-team bootstrap] $*" >&2; }

# --- 1. Pick a Python interpreter -----------------------------------------

PY="${PYTHON:-python3}"
if ! "${PY}" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
  log "codex-team requires Python >=3.10; '${PY}' is older or missing."
  log "Install a newer python3 and set PYTHON=/path/to/python3 before re-running."
  exit 1
fi

# --- 2. Create the venv ---------------------------------------------------

if [[ ! -x "${VENV}/bin/python" ]]; then
  log "creating venv at ${VENV}"
  "${PY}" -m venv "${VENV}"
fi

VPY="${VENV}/bin/python"

if ! "${VPY}" -m pip --version >/dev/null 2>&1; then
  "${VPY}" -m ensurepip --upgrade >/dev/null
fi

"${VPY}" -m pip install --upgrade pip >/dev/null

# --- 3. Install the plugin package itself ---------------------------------

log "installing plugin package (editable) from ${PLUGIN_ROOT}"
if ! "${VPY}" -m pip install -e "${PLUGIN_ROOT}"; then
  log "pip install -e ${PLUGIN_ROOT} failed; see output above."
  exit 1
fi

# --- 4. Ensure `codex-app-server-sdk` is really importable -----------------
#
# The SDK dep is declared in pyproject.toml, but when the PyPI build is
# missing (experimental / offline / version mismatch) the editable install
# may still succeed without actually installing it. Re-check and fall back
# to a local source tree when present.

ensure_sdk() {
  "${VPY}" -c 'import codex_app_server' >/dev/null 2>&1
}

if ! ensure_sdk; then
  log "codex-app-server-sdk not importable after plugin install; trying local source fallback."

  # Candidate paths, in priority order:
  #   1. explicit env var (for user-chosen location)
  #   2. sibling of plugin under forks/ (common dev layout)
  #   3. two levels up (plugin in forks/plugins/x, sdk in forks/codex/sdk/python)
  #   4. plugin-vendored copy (for fully-sealed installs)
  CANDIDATES=()
  [[ -n "${CODEX_TEAM_SDK_PATH:-}" ]] && CANDIDATES+=("${CODEX_TEAM_SDK_PATH}")
  CANDIDATES+=(
    "${PLUGIN_ROOT}/../codex/sdk/python"
    "${PLUGIN_ROOT}/../../codex/sdk/python"
    "${PLUGIN_ROOT}/vendor/codex-sdk/python"
  )

  FOUND=""
  for candidate in "${CANDIDATES[@]}"; do
    if [[ -f "${candidate}/pyproject.toml" ]]; then
      FOUND="${candidate}"
      break
    fi
  done

  if [[ -z "${FOUND}" ]]; then
    log "no local codex SDK source found. Tried:"
    for c in "${CANDIDATES[@]}"; do
      log "  - ${c}"
    done
    log "Options to fix:"
    log "  A. Install from PyPI (when published):   ${VPY} -m pip install codex-app-server-sdk"
    log "  B. Point at a local checkout via env:    export CODEX_TEAM_SDK_PATH=/abs/path/to/codex/sdk/python"
    log "  C. Vendor it under the plugin:           git clone/copy the codex SDK to ${PLUGIN_ROOT}/vendor/codex-sdk"
    log "Then re-run ${PLUGIN_ROOT}/scripts/bootstrap-python-env.sh"
    exit 1
  fi

  log "installing codex-app-server-sdk (editable) from ${FOUND}"
  if ! "${VPY}" -m pip install -e "${FOUND}"; then
    log "pip install -e ${FOUND} failed; see output above."
    exit 1
  fi
fi

# --- 5. Final verification ------------------------------------------------

if ! ensure_sdk; then
  log "bootstrap finished but 'import codex_app_server' still fails; inspect the venv with:"
  log "  ${VPY} -m pip list"
  log "  ${VPY} -c 'import codex_app_server'"
  exit 1
fi

log "bootstrap ok (plugin + SDK importable in ${VENV})"
touch "${STAMP}"
