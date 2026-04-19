import fs from "node:fs";
import path from "node:path";

import { clientEnvFile } from "./paths";

export interface HookEnvEntries {
  CODEX_TEAM_WORKSPACE: string;
  CODEX_TEAM_CLIENT_ID: string;
  CODEX_TEAM_SESSION_ID: string;
  CODEX_TEAM_PROJECT_DIR: string;
}

const HOOK_KEYS = [
  "CODEX_TEAM_WORKSPACE",
  "CODEX_TEAM_CLIENT_ID",
  "CODEX_TEAM_SESSION_ID",
  "CODEX_TEAM_PROJECT_DIR",
] as const;

export function writeHookEnvExports(entries: HookEnvEntries, projectDir: string | null): void {
  const envFile = process.env.CLAUDE_ENV_FILE || "";
  if (envFile) {
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.appendFileSync(
      envFile,
      HOOK_KEYS.map((key) => `export ${key}=${quotePosix(entries[key])}\n`).join(""),
      "utf8",
    );
  }
  if (projectDir) {
    const filePath = clientEnvFile(projectDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, HOOK_KEYS.map((key) => `${key}=${sanitizeEnvValue(entries[key])}\n`).join(""), "utf8");
  }
}

export function readFallbackClientEnv(projectDir: string | null | undefined): Partial<HookEnvEntries> {
  if (!projectDir) {
    return {};
  }
  const filePath = clientEnvFile(projectDir);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const out: Partial<HookEnvEntries> = {};
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || !HOOK_KEYS.includes(match[1] as (typeof HOOK_KEYS)[number])) {
        continue;
      }
      out[match[1] as keyof HookEnvEntries] = match[2];
    }
    return out;
  } catch {
    return {};
  }
}

export function removeFallbackClientEnv(projectDir: string | null | undefined): void {
  if (!projectDir) {
    return;
  }
  const filePath = clientEnvFile(projectDir);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function quotePosix(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sanitizeEnvValue(value: string): string {
  return String(value).replace(/[\r\n]/g, "");
}
