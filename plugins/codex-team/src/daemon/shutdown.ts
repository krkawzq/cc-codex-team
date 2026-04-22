import fs from "node:fs";

import { logger } from "../logger";
import type { DaemonContext } from "./context";
import { pidFilePath } from "../paths";
import { unlinkSockIfStale } from "../ipc/sock";

let shuttingDown = false;

export async function shutdownDaemon(ctx: DaemonContext, reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown initiated", { reason });

  try {
    await ctx.pool.shutdown();
  } catch (e) {
    logger.error("pool shutdown error", { err: (e as Error).message });
  }

  try {
    await ctx.sessions.flush();
  } catch (e) {
    logger.error("session registry flush error", { err: (e as Error).message });
  }

  try {
    await ctx.events.flush();
  } catch (e) {
    logger.error("event log flush error", { err: (e as Error).message });
  }

  unlinkSockIfStale(ctx.sockPath);
  try { fs.unlinkSync(pidFilePath(ctx.dataDir)); } catch { /* ignore */ }

  setTimeout(() => process.exit(exitCode), 10);
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
