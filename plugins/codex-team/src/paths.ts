import os from "node:os";
import path from "node:path";

const APP = "codex-team";

function homeDir(): string {
  return process.env.HOME || os.homedir() || "/";
}

export function xdgConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config"), APP);
}

export function xdgDataDir(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(homeDir(), ".local", "share"), APP);
}

export function xdgRuntimeDir(): string {
  return path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir(), APP);
}

export function defaultSocketPath(): string {
  return path.join(xdgRuntimeDir(), "daemon.sock");
}

export function defaultPidPath(): string {
  return path.join(xdgDataDir(), "daemon.pid");
}

export function defaultLogPath(): string {
  return path.join(xdgDataDir(), "daemon.log");
}

export function defaultRegistryPath(): string {
  return path.join(xdgDataDir(), "registry.json");
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
