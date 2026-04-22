import fs from "node:fs";
import path from "node:path";

import { buildContext } from "./context";
import { startServer } from "./server";
import { probeSock, unlinkSockIfStale } from "../ipc/sock";
import { logger } from "../logger";
import { pidFilePath } from "../paths";
import { shutdownDaemon } from "./shutdown";
import { wireDaemonEvents } from "./wire";
import { reapOrphans } from "./orphans";

const PIDFILE_STALE_MS = 5000;

export async function runDaemon(): Promise<number> {
  const ctx = buildContext();

  // Wait up to 3s for an incumbent daemon (being restarted) to vacate the sock.
  const waitStart = Date.now();
  while (await probeSock(ctx.sockPath, 200)) {
    if (Date.now() - waitStart > 3000) {
      logger.info("another daemon already owns the sock", { sock: ctx.sockPath });
      return 1;
    }
    await new Promise<void>((r) => setTimeout(r, 150));
  }
  const pidPath = pidFilePath(ctx.dataDir);
  const acquireStart = Date.now();
  while (!acquirePid(pidPath)) {
    if (Date.now() - acquireStart > 3000) {
      logger.warn("another daemon pidfile is live; aborting", { pid_path: pidPath });
      return 1;
    }
    await new Promise<void>((r) => setTimeout(r, 150));
  }
  unlinkSockIfStale(ctx.sockPath);

  // Kill any leftover codex app-server processes spawned by a previous daemon.
  reapOrphans(ctx.dataDir);

  const cleanup = (): void => {
    unlinkSockIfStale(ctx.sockPath);
    try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
  };
  process.on("exit", cleanup);

  registerShutdownSignal("SIGINT", ctx);
  registerShutdownSignal("SIGTERM", ctx);
  if (process.platform === "win32") registerShutdownSignal("SIGBREAK", ctx);
  else registerShutdownSignal("SIGHUP", ctx);

  wireDaemonEvents(ctx);

  try {
    await startServer(ctx);
    logger.info("daemon started", {
      pid: process.pid,
      sock: ctx.sockPath,
      data_dir: ctx.dataDir,
    });
  } catch (e) {
    logger.error("failed to start server", { err: (e as Error).message });
    try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
    return 1;
  }

  scheduleIdleShutdown(ctx);

  return await new Promise<number>(() => { /* run forever */ });
}

function acquirePid(pidPath: string): boolean {
  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    const fd = fs.openSync(pidPath, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      }));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
      try {
        const ageMs = Date.now() - fs.statSync(pidPath).mtimeMs;
        if (ageMs >= PIDFILE_STALE_MS) {
          fs.unlinkSync(pidPath);
        }
      } catch {
        // ignore and retry later
      }
      return false;
    }
    return false;
  }
}

function scheduleIdleShutdown(ctx: import("./context").DaemonContext): void {
  const check = () => {
    const hours = ctx.config.getEffective("daemon.idle_shutdown_hours");
    const threshold = typeof hours === "number" ? hours : 6;
    const ms = threshold * 3600 * 1000;
    const liveSessions = Array.from(ctx.users.list()).reduce(
      (n, u) => n + ctx.sessions.listLive(u.token).length,
      0,
    );
    if (liveSessions > 0) return; // treat any live session as activity
    const idleMs = Date.now() - ctx.activity.lastActivityAt.getTime();
    if (idleMs >= ms) {
      logger.info("idle threshold exceeded, shutting down", {
        idle_ms: idleMs,
        threshold_ms: ms,
      });
      void shutdownDaemon(ctx, "idle timeout");
    }
  };
  setInterval(check, 60 * 1000).unref();
}

function registerShutdownSignal(signal: NodeJS.Signals, ctx: import("./context").DaemonContext): void {
  process.on(signal, () => void shutdownDaemon(ctx, signal));
}
