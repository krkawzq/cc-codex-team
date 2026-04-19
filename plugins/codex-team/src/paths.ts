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

export function sessionDir(dataDir: string, name: string): string {
  return path.join(dataDir, "sessions", name);
}
