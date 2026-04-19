import { ChildProcessWithoutNullStreams, spawn, SpawnOptions } from "node:child_process";
import path from "node:path";

import { isWindows } from "./os";

export type ManagedChild = ChildProcessWithoutNullStreams & {
  killTree(graceMs?: number): Promise<void>;
};

export interface ManagedSpawnOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  detached?: boolean;
  stdio?: ["pipe", "pipe", "pipe"] | ["ignore", "ignore", "ignore"] | ["ignore", "ignore", number];
}

export function spawnManaged(opts: ManagedSpawnOptions): ManagedChild {
  const stdio = opts.stdio || ["pipe", "pipe", "pipe"];
  const spawnOptions: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env,
    detached: opts.detached,
    stdio,
    windowsHide: true,
  };
  const commandExt = path.extname(opts.command).toLowerCase();
  const isCmdShim = isWindows && (commandExt === ".cmd" || commandExt === ".bat");
  const child = isCmdShim
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", quoteCmdLine([opts.command, ...opts.args])], spawnOptions)
    : spawn(opts.command, opts.args, spawnOptions);
  const managed = child as ManagedChild;
  managed.killTree = async (graceMs = 1500) => {
    if (managed.pid != null) {
      await killProcessTree(managed.pid, graceMs);
    }
  };
  return managed;
}

export async function killProcessTree(pid: number, graceMs = 1500): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (isWindows) {
    await runTaskkill(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await delay(graceMs);
  if (!isPidAlive(pid)) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

function quoteCmdLine(parts: string[]): string {
  return parts.map(quoteCmdArg).join(" ");
}

function quoteCmdArg(value: string): string {
  if (!value) {
    return "\"\"";
  }
  return `"${value.replace(/(["^&|<>()%!])/g, "^$1")}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
