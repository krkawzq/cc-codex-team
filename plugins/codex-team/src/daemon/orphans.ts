import fs from "node:fs";
import path from "node:path";

import { logger } from "../logger";
import { inspectCodexAppServerProcess } from "./processes";

export function orphanPidsPath(dataDir: string): string {
  return path.join(dataDir, "codex-pids.json");
}

export function readPidFile(dataDir: string): number[] {
  const p = orphanPidsPath(dataDir);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === "number" && Number.isFinite(x));
  } catch {
    return [];
  }
}

export function writePidFile(dataDir: string, pids: number[]): void {
  const p = orphanPidsPath(dataDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(pids));
    fs.renameSync(tmp, p);
  } catch (e) {
    logger.warn("failed to persist codex pid file", { err: (e as Error).message });
  }
}

export function reapOrphans(dataDir: string): number {
  const pids = readPidFile(dataDir);
  let killed = 0;
  const retryPids: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
    } catch {
      continue; // not alive
    }
    const classification = inspectCodexAppServerProcess(pid);
    if (classification === "unknown") {
      retryPids.push(pid);
      logger.warn("unable to verify orphan codex pid; retaining for retry", { pid, platform: process.platform });
      continue;
    }
    if (classification !== "match") {
      logger.warn("skipping stale non-codex pid", { pid });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      killed++;
    } catch (e) {
      retryPids.push(pid);
      logger.warn("failed to terminate orphan codex pid; retaining for retry", {
        pid,
        err: (e as Error).message,
      });
    }
  }
  if (killed > 0) {
    logger.info("reaped orphan codex processes", { count: killed });
  }
  writePidFile(dataDir, retryPids);
  return killed;
}

export class PidTracker {
  private readonly dataDir: string;
  private readonly pids = new Set<number>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  track(pid: number): void {
    if (!Number.isFinite(pid) || pid <= 0) return;
    this.pids.add(pid);
    this.persist();
  }

  untrack(pid: number): void {
    if (this.pids.delete(pid)) this.persist();
  }

  snapshot(): number[] {
    return Array.from(this.pids);
  }

  private persist(): void {
    writePidFile(this.dataDir, Array.from(this.pids));
  }
}
