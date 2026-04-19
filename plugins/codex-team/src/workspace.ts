import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { InvalidName, InvalidRequest } from "./errors";

export const DEFAULT_WORKSPACE = "default";
const WORKSPACE_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const SESSION_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_value, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_value, index) => `LPT${index + 1}`),
]);

export function validateWorkspace(value: string): string {
  const workspace = value.trim();
  if (!workspace || workspace === "*" || !WORKSPACE_RE.test(workspace)) {
    throw new InvalidRequest(
      `invalid workspace ${JSON.stringify(value)}; expected ${WORKSPACE_RE.source} and not "*"`,
    );
  }
  return workspace;
}

export function safeWorkspace(value: string | null | undefined): string {
  return validateWorkspace(value || DEFAULT_WORKSPACE);
}

export function validateSessionName(value: string): string {
  const name = String(value);
  const upper = name.toUpperCase();
  if (
    name !== name.trim() ||
    !SESSION_NAME_RE.test(name) ||
    WINDOWS_RESERVED_NAMES.has(upper) ||
    name.endsWith(".") ||
    name.endsWith(" ") ||
    /[\\/:*?"<>|\u0000]/.test(name)
  ) {
    throw new InvalidName(
      `invalid session name ${JSON.stringify(value)}; use 1-64 chars matching ${SESSION_NAME_RE.source}, not a Windows reserved name`,
    );
  }
  return name;
}

export function deriveProjectWorkspace(projectDir: string): string {
  const digest = crypto.createHash("sha1").update(path.resolve(projectDir)).digest("hex").slice(0, 8);
  return `proj-${digest}`;
}

export function workspaceEnvPath(projectDir: string): string {
  return path.join(projectDir, ".codex-team", "workspace.env");
}

export function readWorkspaceEnvFile(projectDir: string | null | undefined): string | null {
  if (!projectDir) {
    return null;
  }
  const filePath = workspaceEnvPath(projectDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*CODEX_TEAM_WORKSPACE\s*=\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/);
    if (match) {
      return validateWorkspace(match[1]);
    }
  }
  return null;
}

export function resolveWorkspace(input: {
  explicit?: string | null;
  env?: NodeJS.ProcessEnv;
  projectDir?: string | null;
} = {}): string {
  const env = input.env || process.env;
  if (input.explicit) {
    return validateWorkspace(input.explicit);
  }
  if (env.CODEX_TEAM_WORKSPACE) {
    return validateWorkspace(env.CODEX_TEAM_WORKSPACE);
  }
  const projectDir = input.projectDir || env.CLAUDE_PROJECT_DIR || "";
  const fromFile = readWorkspaceEnvFile(projectDir);
  if (fromFile) {
    return fromFile;
  }
  if (projectDir) {
    return deriveProjectWorkspace(projectDir);
  }
  return DEFAULT_WORKSPACE;
}

export function workspaceSessionKey(workspace: string, name: string): string {
  return `${workspace}\u0000${name}`;
}

export function workspaceDisplayName(workspace: string, name: string): string {
  return `${workspace}/${name}`;
}

export function makeClientId(input: {
  workspace: string;
  sessionId?: string | null;
  hostname?: string | null;
  pid?: number | null;
  startedAtMs?: number | null;
}): string {
  const seed = [
    input.workspace,
    input.sessionId || "",
    input.hostname || os.hostname(),
    String(input.pid || process.pid),
    String(input.startedAtMs || Date.now()),
  ].join("|");
  return `c-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}
