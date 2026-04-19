#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HOOK_INPUT="$(cat || true)"

if [[ -z "${CODEX_TEAM_WORKSPACE:-}" ]]; then
  eval "$(
    HOOK_INPUT="${HOOK_INPUT}" node <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
const input = (() => { try { return JSON.parse(process.env.HOOK_INPUT || "{}"); } catch { return {}; } })();
const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || input.workspace?.current_dir || process.env.CODEX_TEAM_PROJECT_DIR || "";
let workspace = process.env.CODEX_TEAM_WORKSPACE || "";
const workspaceFile = projectDir ? path.join(projectDir, ".codex-team", "workspace.env") : "";
if (!workspace && workspaceFile && fs.existsSync(workspaceFile)) {
  const raw = fs.readFileSync(workspaceFile, "utf8");
  const match = raw.match(/^\s*CODEX_TEAM_WORKSPACE\s*=\s*["']?([^"'\s#]+)["']?/m);
  if (match) workspace = match[1];
}
if (!workspace && projectDir) workspace = `proj-${crypto.createHash("sha1").update(path.resolve(projectDir)).digest("hex").slice(0, 8)}`;
if (!workspace) workspace = "default";
console.log(`export CODEX_TEAM_WORKSPACE=${quote(workspace)}`);
NODE
  )"
fi

if [[ -z "${CODEX_TEAM_CLIENT_ID:-}" ]]; then
  SESSION_ID="$(
    HOOK_INPUT="${HOOK_INPUT}" node <<'NODE'
const input = (() => { try { return JSON.parse(process.env.HOOK_INPUT || "{}"); } catch { return {}; } })();
process.stdout.write(String(input.session_id || input.sessionId || process.env.CODEX_TEAM_SESSION_ID || ""));
NODE
  )"
  if [[ -z "${SESSION_ID}" ]]; then
    exit 0
  fi
  CODEX_TEAM_NO_AUTOSTART=1 "${PLUGIN_ROOT}/bin/codex-team" --workspace "${CODEX_TEAM_WORKSPACE}" client detach --session-id "${SESSION_ID}" >/dev/null 2>&1 || true
  exit 0
fi

CODEX_TEAM_NO_AUTOSTART=1 "${PLUGIN_ROOT}/bin/codex-team" --workspace "${CODEX_TEAM_WORKSPACE}" client detach "${CODEX_TEAM_CLIENT_ID}" >/dev/null 2>&1 || true
