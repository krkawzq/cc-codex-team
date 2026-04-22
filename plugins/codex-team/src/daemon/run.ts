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

export async function runDaemon(): Promise<number> {
  const ctx = buildContext();
  const pidPath = pidFilePath(ctx.dataDir);

  const acquired = await acquireDaemonOwnership(ctx.sockPath, pidPath);
  if (!acquired.ok) {
    logger.info(acquired.message, acquired.details);
    return 1;
  }

  // Kill any leftover codex app-server processes spawned by a previous daemon.
  await reapOrphans(ctx.dataDir);

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
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
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

interface AcquireResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

async function acquireDaemonOwnership(sockPath: string, pidPath: string): Promise<AcquireResult> {
  const waitStart = Date.now();
  for (;;) {
    const sockReachable = await probeSock(sockPath, 200);
    const pidRecord = readPidFile(pidPath);
    const pid = pidRecord?.pid ?? null;
    const pidAlive = pid !== null && isPidAlive(pid);

    if (sockReachable) {
      if (Date.now() - waitStart > 3000) {
        return {
          ok: false,
          message: "another daemon already owns the sock",
          details: {
            sock: sockPath,
            pidfile_pid: pid,
            pidfile_live: pidAlive,
          },
        };
      }
      await sleep(150);
      continue;
    }

    if (pid !== null && pidAlive) {
      if (Date.now() - waitStart > 3000) {
        return {
          ok: false,
          message: "another daemon pidfile is live; aborting",
          details: {
            pid_path: pidPath,
            pid,
          },
        };
      }
      await sleep(150);
      continue;
    }

    if (pid !== null && !pidAlive) {
      try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
    }

    unlinkSockIfStale(sockPath);
    if (acquirePid(pidPath)) {
      return { ok: true, message: "daemon ownership acquired" };
    }

    if (Date.now() - waitStart > 3000) {
      return {
        ok: false,
        message: "failed to acquire daemon pidfile",
        details: { pid_path: pidPath },
      };
    }
    await sleep(150);
  }
}

function readPidFile(pidPath: string): { pid: number; created_at?: string } | null {
  try {
    const raw = fs.readFileSync(pidPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; created_at?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    return {
      pid: Math.floor(parsed.pid),
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
