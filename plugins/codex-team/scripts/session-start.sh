#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HOOK_INPUT="$(cat || true)"

"${PLUGIN_ROOT}/bin/codex-team" daemon start >/dev/null

eval "$(
  HOOK_INPUT="${HOOK_INPUT}" node <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const input = (() => {
  try { return JSON.parse(process.env.HOOK_INPUT || "{}"); } catch { return {}; }
})();
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || input.workspace?.current_dir || "";
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function valid(value) {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(value) && value !== "*";
}
let workspace = process.env.CODEX_TEAM_WORKSPACE || "";
const workspaceFile = projectDir ? path.join(projectDir, ".codex-team", "workspace.env") : "";
if (!workspace && workspaceFile && fs.existsSync(workspaceFile)) {
  const raw = fs.readFileSync(workspaceFile, "utf8");
  const match = raw.match(/^\s*CODEX_TEAM_WORKSPACE\s*=\s*["']?([^"'\s#]+)["']?/m);
  if (match) workspace = match[1];
}
if (!workspace && projectDir) {
  workspace = `proj-${crypto.createHash("sha1").update(path.resolve(projectDir)).digest("hex").slice(0, 8)}`;
}
if (!workspace) workspace = "default";
if (!valid(workspace)) {
  console.error(`invalid CODEX_TEAM_WORKSPACE: ${workspace}`);
  process.exit(2);
}
if (workspaceFile && process.env.CODEX_TEAM_PIN_WORKSPACE === "1" && !fs.existsSync(workspaceFile)) {
  fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
  fs.writeFileSync(workspaceFile, `CODEX_TEAM_WORKSPACE=${workspace}\n`, "utf8");
}
const sessionId = input.session_id || input.sessionId || "";
const clientId = `c-${crypto.randomBytes(6).toString("hex")}`;
console.log(`export CODEX_TEAM_WORKSPACE=${quote(workspace)}`);
console.log(`export CODEX_TEAM_CLIENT_ID=${quote(clientId)}`);
console.log(`export CODEX_TEAM_SESSION_ID=${quote(sessionId)}`);
console.log(`export CODEX_TEAM_PROJECT_DIR=${quote(projectDir)}`);
NODE
)"

if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  append_export() {
    printf 'export %s=%q\n' "$1" "$2" >> "${CLAUDE_ENV_FILE}"
  }
  {
    append_export CODEX_TEAM_WORKSPACE "${CODEX_TEAM_WORKSPACE}"
    append_export CODEX_TEAM_CLIENT_ID "${CODEX_TEAM_CLIENT_ID}"
    append_export CODEX_TEAM_SESSION_ID "${CODEX_TEAM_SESSION_ID:-}"
    append_export CODEX_TEAM_PROJECT_DIR "${CODEX_TEAM_PROJECT_DIR:-}"
  }
fi

"${PLUGIN_ROOT}/bin/codex-team" --workspace "${CODEX_TEAM_WORKSPACE}" client register \
  --client-id "${CODEX_TEAM_CLIENT_ID}" \
  --session-id "${CODEX_TEAM_SESSION_ID:-}" \
  --hostname "$(hostname)" \
  --pid "${PPID}" \
  --project-dir "${CODEX_TEAM_PROJECT_DIR:-}" \
  --started-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null || true
