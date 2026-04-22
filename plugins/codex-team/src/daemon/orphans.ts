import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { logger } from "../logger";
import { isLikelyCodexAppServerProcess, readProcessStartTime } from "./processes";

const SCHEMA_VERSION = 2;
const TERM_GRACE_MS = 2000;
const KILL_GRACE_MS = 500;
const POLL_MS = 100;

export interface TrackedPid {
  pid: number;
  nonce: string;
  start_time: string | null;
  tracked_at: string;
}

export function orphanPidsPath(dataDir: string): string {
  return path.join(dataDir, "codex-pids.json");
}

export function readPidFile(dataDir: string): TrackedPid[] {
  const p = orphanPidsPath(dataDir);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
        .map((pid) => ({
          pid: Math.floor(pid),
          nonce: `legacy-${pid}`,
          start_time: null,
          tracked_at: new Date(0).toISOString(),
        }));
    }
    if (!parsed || typeof parsed !== "object") return [];
    const obj = parsed as { schema_version?: unknown; processes?: unknown };
    if (typeof obj.schema_version === "number" && obj.schema_version > SCHEMA_VERSION) {
      logger.warn("unknown orphan pid schema_version", { schema_version: obj.schema_version });
      return [];
    }
    if (!Array.isArray(obj.processes)) return [];
    return obj.processes.flatMap((entry) => normalizeTrackedPid(entry));
  } catch {
    return [];
  }
}

export function writePidFile(dataDir: string, pids: TrackedPid[]): void {
  const p = orphanPidsPath(dataDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      schema_version: SCHEMA_VERSION,
      processes: pids,
    }));
    fs.renameSync(tmp, p);
  } catch (e) {
    logger.warn("failed to persist codex pid file", { err: (e as Error).message });
  }
}

export async function reapOrphans(dataDir: string): Promise<number> {
  const pids = readPidFile(dataDir);
  let killed = 0;
  for (const tracked of pids) {
    if (!isTrackedProcessAlive(tracked)) continue;
    if (!isLikelyCodexAppServerProcess(tracked.pid)) {
      logger.warn("skipping stale non-codex pid", { pid: tracked.pid });
      continue;
    }
    try {
      process.kill(tracked.pid, "SIGTERM");
      killed++;
    } catch { /* ignore */ }
    const exited = await waitForTrackedExit(tracked, TERM_GRACE_MS);
    if (!exited && isTrackedProcessAlive(tracked)) {
      try { process.kill(tracked.pid, "SIGKILL"); } catch { /* ignore */ }
      await waitForTrackedExit(tracked, KILL_GRACE_MS);
    }
  }
  if (killed > 0) {
    logger.info("reaped orphan codex processes", { count: killed });
  }
  // clear the file; new daemon will repopulate as it spawns
  writePidFile(dataDir, []);
  return killed;
}

export class PidTracker {
  private readonly dataDir: string;
  private readonly pids = new Map<number, TrackedPid>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  track(pid: number): void {
    if (!Number.isFinite(pid) || pid <= 0) return;
    this.pids.set(pid, {
      pid,
      nonce: crypto.randomBytes(8).toString("hex"),
      start_time: readProcessStartTime(pid),
      tracked_at: new Date().toISOString(),
    });
    this.persist();
  }

  untrack(pid: number): void {
    if (this.pids.delete(pid)) this.persist();
  }

  snapshot(): TrackedPid[] {
    return Array.from(this.pids.values());
  }

  private persist(): void {
    writePidFile(this.dataDir, this.snapshot());
  }
}

function normalizeTrackedPid(entry: unknown): TrackedPid[] {
  if (!entry || typeof entry !== "object") return [];
  const obj = entry as Record<string, unknown>;
  const pid = typeof obj.pid === "number" && Number.isFinite(obj.pid) ? Math.floor(obj.pid) : null;
  if (!pid || pid <= 0) return [];
  return [{
    pid,
    nonce: typeof obj.nonce === "string" && obj.nonce.length > 0 ? obj.nonce : crypto.randomBytes(8).toString("hex"),
    start_time: typeof obj.start_time === "string" ? obj.start_time : null,
    tracked_at: typeof obj.tracked_at === "string" ? obj.tracked_at : new Date(0).toISOString(),
  }];
}

function isTrackedProcessAlive(tracked: TrackedPid): boolean {
  try {
    process.kill(tracked.pid, 0);
  } catch {
    return false;
  }
  if (!tracked.start_time) return true;
  return readProcessStartTime(tracked.pid) === tracked.start_time;
}

async function waitForTrackedExit(tracked: TrackedPid, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTrackedProcessAlive(tracked)) return true;
    await sleep(POLL_MS, undefined, { ref: false });
  }
  return !isTrackedProcessAlive(tracked);
}
