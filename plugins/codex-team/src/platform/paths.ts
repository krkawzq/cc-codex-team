import os from "node:os";
import path from "node:path";

import { isWindows } from "./os";

const APP = "codex-team";

function homeDir(): string {
  return process.env.HOME || os.homedir() || (isWindows ? process.env.USERPROFILE || "C:\\" : "/");
}

export function resolveConfigDir(): string {
  if (process.env.CODEX_TEAM_CONFIG_DIR) {
    return path.resolve(process.env.CODEX_TEAM_CONFIG_DIR);
  }
  if (isWindows) {
    return path.join(process.env.APPDATA || path.join(homeDir(), "AppData", "Roaming"), APP);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config"), APP);
}

export function resolveDataDir(configured = ""): string {
  if (configured) {
    return path.resolve(configured);
  }
  if (process.env.CODEX_TEAM_DAEMON_DATA_DIR) {
    return path.resolve(process.env.CODEX_TEAM_DAEMON_DATA_DIR);
  }
  if (
    process.env.CLAUDE_PLUGIN_DATA &&
    (process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_DATA.includes(APP))
  ) {
    return path.join(path.resolve(process.env.CLAUDE_PLUGIN_DATA), "data");
  }
  if (isWindows) {
    return path.join(process.env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local"), APP);
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(homeDir(), ".local", "share"), APP);
}

export function resolveRuntimeDir(configuredDataDir = ""): string | null {
  if (isWindows) {
    return null;
  }
  if (process.env.CODEX_TEAM_DAEMON_RUNTIME_DIR) {
    return path.resolve(process.env.CODEX_TEAM_DAEMON_RUNTIME_DIR);
  }
  if (process.env.CLAUDE_PLUGIN_DATA) {
    return path.join(path.resolve(process.env.CLAUDE_PLUGIN_DATA), "runtime");
  }
  void configuredDataDir;
  return path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir(), APP);
}

export function resolvePidPath(dataDir: string, configured = ""): string {
  return path.resolve(configured || process.env.CODEX_TEAM_DAEMON_PID_PATH || path.join(dataDir, "daemon.pid"));
}

export function resolveLogPath(dataDir: string): string {
  return path.join(dataDir, "daemon.log");
}

export function resolveRegistryPath(dataDir: string): string {
  return path.join(dataDir, "registry.json");
}

export function sessionDir(dataDir: string, workspace: string, name: string): string {
  return path.join(dataDir, "sessions", workspace, name);
}

export function clientsDir(dataDir: string): string {
  return path.join(dataDir, "clients");
}

export function alarmsDir(dataDir: string): string {
  return path.join(dataDir, "alarms");
}

export function workspaceAlarmsDir(dataDir: string, workspace: string): string {
  return path.join(alarmsDir(dataDir), workspace);
}

export function workspaceEnvFile(projectDir: string): string {
  return path.join(projectDir, ".codex-team", "workspace.env");
}

export function clientEnvFile(projectDir: string): string {
  return path.join(projectDir, ".codex-team", "client.env");
}
