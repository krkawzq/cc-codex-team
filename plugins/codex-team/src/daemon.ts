import fs from "node:fs";
import path from "node:path";

import { Config, loadConfig, resolveDataDir, resolveSocketPath } from "./config";
import { DaemonAlreadyRunning } from "./errors";
import { DaemonServer } from "./server";
import { xdgConfigDir } from "./paths";

function appendLogLine(logPath: string, message: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquirePidLock(pidPath: string): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  if (fs.existsSync(pidPath)) {
    const raw = fs.readFileSync(pidPath, "utf8").trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
      throw new DaemonAlreadyRunning(
        `another daemon is already running (pid=${pid}, pid_file=${pidPath}).`,
      );
    }
    fs.unlinkSync(pidPath);
  }
  fs.writeFileSync(pidPath, String(process.pid), "utf8");
}

export function releasePidLock(pidPath: string): void {
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }
}

export async function runDaemon(configPath?: string): Promise<number> {
  const cfg = loadConfig(configPath || path.join(xdgConfigDir(), "config.toml"));
  const dataDir = resolveDataDir(cfg);
  const socketPath = resolveSocketPath(cfg);
  cfg.daemon.dataDir = dataDir;
  cfg.daemon.socketPath = socketPath;
  fs.mkdirSync(dataDir, { recursive: true });
  const pidPath = path.join(dataDir, "daemon.pid");
  const logPath = path.join(dataDir, "daemon.log");
  acquirePidLock(pidPath);
  appendLogLine(logPath, "daemon starting");
  let stopResolve!: () => void;
  const stopPromise = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  const server = new DaemonServer(cfg, socketPath, () => stopResolve());
  const signalHandler = () => stopResolve();
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    await server.start();
    if (cfg.defaults.autoResumeOnDaemonStart) {
      for (const entry of server.registry.list(null, true)) {
        if (!["idle", "running", "errored", "compacting"].includes(entry.status)) {
          continue;
        }
        if (entry.ephemeral) {
          appendLogLine(logPath, `skipping auto-resume for ephemeral session ${entry.name}`);
          server.registry.update(entry.name, {
            status: "closed",
            appServerPid: null,
            errorMessage: "ephemeral session expired when daemon stopped",
          }, entry.workspace);
          continue;
        }
        try {
          const session = await server.factory.resume(entry.name, entry.workspace);
          server.sessions.set(`${entry.workspace}\u0000${entry.name}`, session);
        } catch (error) {
          server.registry.update(entry.name, {
            status: "errored",
            appServerPid: null,
            errorMessage: (error as Error).message,
          }, entry.workspace);
          appendLogLine(logPath, `failed to auto-resume ${entry.name}: ${(error as Error).message}`);
        }
      }
    }
    await stopPromise;
    appendLogLine(logPath, "daemon stopping");
    await server.stop();
    appendLogLine(logPath, "daemon stopped");
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    releasePidLock(pidPath);
  }
  return 0;
}
