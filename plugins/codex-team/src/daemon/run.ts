import fs from "node:fs";
import path from "node:path";

import { buildContext } from "./context";
import { startServer } from "./server";
import { probeSock, unlinkSockIfStale } from "../ipc/sock";
import { logger } from "../logger";
import { APP, homeDir, pidFilePath, warnLegacyWindowsDataDir } from "../paths";
import { shutdownDaemon } from "./shutdown";
import { wireDaemonEvents } from "./wire";
import { reapOrphans } from "./orphans";
import { isLikelyCodexTeamDaemonProcess } from "./processes";

export async function runDaemon(): Promise<number> {
  const ctx = buildContext();
  warnLegacyWindowsDataDir((warning) => {
    logger.warn(warning.message);
  });
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
    // audit-async N1: keep idle semantics simple and conservative: any live session counts as activity.
    if (liveSessions > 0) return;
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
  const legacyPidPath = legacyWindowsPidFilePath(pidPath);
  for (;;) {
    const sockReachable = await probeSock(sockPath, 200);
    const pidRecord = readPidFile(pidPath);
    const pid = pidRecord?.pid ?? null;
    const pidAlive = pid !== null && isDaemonPidAlive(pid);
    const legacyPidRecord = legacyPidPath ? readPidFile(legacyPidPath) : null;
    const legacyPid = legacyPidRecord?.pid ?? null;
    const legacyPidAlive = legacyPid !== null && isDaemonPidAlive(legacyPid);

    if (sockReachable) {
      if (Date.now() - waitStart > 3000) {
        return {
          ok: false,
          message: "another daemon already owns the sock",
          details: {
            sock: sockPath,
            pidfile_pid: pid,
            pidfile_live: pidAlive,
            legacy_pidfile_pid: legacyPid,
            legacy_pidfile_live: legacyPidAlive,
          },
        };
      }
      await sleep(150);
      continue;
    }

    if (pidAlive || legacyPidAlive) {
      const livePid = pidAlive ? pid : legacyPid;
      const livePidPath = pidAlive ? pidPath : legacyPidPath;
      if (Date.now() - waitStart > 3000) {
        return {
          ok: false,
          message: "another daemon pidfile is live; aborting",
          details: {
            pid_path: livePidPath,
            pid: livePid,
          },
        };
      }
      await sleep(150);
      continue;
    }

    if (pid !== null && !pidAlive) {
      try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
    }
    if (legacyPidPath && legacyPid !== null && !legacyPidAlive) {
      try { fs.unlinkSync(legacyPidPath); } catch { /* ignore */ }
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

function isDaemonPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return isLikelyCodexTeamDaemonProcess(pid);
}

function legacyWindowsPidFilePath(currentPidPath: string): string | null {
  if (process.platform !== "win32") return null;
  const legacyHome = process.env.HOME;
  if (!legacyHome) return null;
  const legacyPath = path.join(legacyHome, `.${APP}`, "daemon.pid");
  if (legacyPath === currentPidPath) return null;
  if (legacyHome === homeDir()) return null;
  return legacyPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
