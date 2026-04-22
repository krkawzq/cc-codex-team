import fs from "node:fs";
import path from "node:path";

import type { TeamEvent } from "../types";
import { userDir, userEventLogPath } from "../paths";
import { logger } from "../logger";

export interface EventSubscription {
  dispose(): void;
}

export type EventListener = (event: TeamEvent) => void;

export interface ListSinceOk {
  ok: true;
  events: TeamEvent[];
}

export interface ListSinceRotated {
  ok: false;
  reason: "id_rotated";
  oldest_available_id: string | null;
}

export type ListSinceResult = ListSinceOk | ListSinceRotated;

const DELTA_SUFFIX = "_delta";

export class EventLog {
  private retention: number;
  private dataDir: string | null;
  private counters = new Map<string, number>();
  private buffers = new Map<string, TeamEvent[]>();
  private subscribers = new Map<string, Set<EventListener>>();
  private loaded = new Set<string>();
  private rotatedSinceCompact = new Map<string, number>();
  private pendingLines = new Map<string, string[]>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  private writeChains = new Map<string, Promise<void>>();

  constructor(retention = 10000, dataDir: string | null = null) {
    this.retention = Math.max(100, retention);
    this.dataDir = dataDir;
  }

  /** Load user's persisted events from disk (idempotent). */
  loadUser(user: string): void {
    if (this.loaded.has(user)) return;
    this.loaded.add(user);
    if (!this.dataDir) return;
    const filePath = userEventLogPath(user, this.dataDir);
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const tail = lines.slice(Math.max(0, lines.length - this.retention));
      const buf: TeamEvent[] = [];
      let maxSeq = 0;
      for (const line of tail) {
        try {
          const ev = JSON.parse(line) as TeamEvent;
          if (ev && typeof ev.id === "string") {
            buf.push(ev);
            const seq = parseInt(ev.id.replace(/^evt-/, ""), 10);
            if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
          }
        } catch {
          // skip malformed line
        }
      }
      this.buffers.set(user, buf);
      this.counters.set(user, maxSeq);
      // If file contains way more than retention, compact it on load.
      if (lines.length > this.retention * 1.5) this.compactFile(user, buf);
    } catch (e) {
      logger.warn("failed to load event log", { user, err: (e as Error).message });
    }
  }

  setRetention(n: number): void {
    this.retention = Math.max(100, n);
    for (const [user, buf] of this.buffers) {
      let rotated = false;
      while (buf.length > this.retention) {
        buf.shift();
        rotated = true;
      }
      if (rotated) this.bumpCompactionDebt(user);
    }
  }

  retainedCount(user: string): number {
    return this.buffers.get(user)?.length ?? 0;
  }

  append(user: string, input: Omit<TeamEvent, "id" | "ts">): TeamEvent {
    this.loadUser(user);
    const seq = (this.counters.get(user) ?? 0) + 1;
    this.counters.set(user, seq);
    const event: TeamEvent = {
      id: `evt-${seq}`,
      ts: new Date().toISOString(),
      ...input,
    };
    const buf = this.buffers.get(user) ?? [];
    buf.push(event);
    let rotated = false;
    while (buf.length > this.retention) {
      buf.shift();
      rotated = true;
    }
    this.buffers.set(user, buf);
    this.appendToFile(user, event);
    if (rotated) this.bumpCompactionDebt(user);
    for (const cb of this.subscribers.get(user) ?? []) {
      try { cb(event); } catch { /* ignore listener errors */ }
    }
    return event;
  }

  async flush(): Promise<void> {
    const users = new Set<string>([
      ...this.flushTimers.keys(),
      ...this.pendingLines.keys(),
      ...this.writeChains.keys(),
    ]);
    for (const user of users) {
      const timer = this.flushTimers.get(user);
      if (timer) {
        clearTimeout(timer);
        this.flushTimers.delete(user);
      }
      void this.flushUser(user);
    }
    await Promise.all(Array.from(this.writeChains.values()).map((p) => p.catch(() => undefined)));
  }

  async clearUser(user: string): Promise<void> {
    const timer = this.flushTimers.get(user);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(user);
    }
    this.pendingLines.delete(user);
    await (this.writeChains.get(user)?.catch(() => undefined) ?? Promise.resolve());
    this.writeChains.delete(user);
    this.rotatedSinceCompact.delete(user);
    this.counters.delete(user);
    this.buffers.delete(user);
    this.subscribers.delete(user);
    this.loaded.delete(user);
  }

  private appendToFile(user: string, event: TeamEvent): void {
    if (!this.dataDir) return;
    const pending = this.pendingLines.get(user) ?? [];
    pending.push(JSON.stringify(event) + "\n");
    this.pendingLines.set(user, pending);
    this.scheduleFlush(user, 25);
  }

  private compactFile(user: string, buf: TeamEvent[]): void {
    if (!this.dataDir) return;
    const timer = this.flushTimers.get(user);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(user);
    }
    this.pendingLines.delete(user);
    const filePath = userEventLogPath(user, this.dataDir);
    void this.enqueueFsOp(user, async () => {
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.mkdir(userDir(user, this.dataDir!), { recursive: true });
        const tmp = filePath + ".tmp";
        await fs.promises.writeFile(tmp, buf.map((e) => JSON.stringify(e)).join("\n") + (buf.length ? "\n" : ""));
        await fs.promises.rename(tmp, filePath);
        this.rotatedSinceCompact.set(user, 0);
      } catch (e) {
        logger.warn("event log compaction failed", { user, err: (e as Error).message });
      }
    });
  }

  subscribe(user: string, cb: EventListener): EventSubscription {
    let set = this.subscribers.get(user);
    if (!set) {
      set = new Set();
      this.subscribers.set(user, set);
    }
    set.add(cb);
    return {
      dispose: () => {
        const s = this.subscribers.get(user);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) this.subscribers.delete(user);
      },
    };
  }

  pendingCount(user: string): number {
    return this.buffers.get(user)?.length ?? 0;
  }

  listSince(user: string, sinceId: string | null, opts: { includeDelta: boolean } = { includeDelta: false }): ListSinceResult {
    this.loadUser(user);
    const buf = this.buffers.get(user) ?? [];
    let slice: TeamEvent[];
    if (!sinceId) {
      slice = buf.slice();
    } else {
      const idx = buf.findIndex((e) => e.id === sinceId);
      if (idx < 0) {
        if (buf.length > 0 && compareSeq(sinceId, buf[0].id) < 0) {
          return { ok: false, reason: "id_rotated", oldest_available_id: buf[0].id };
        }
        slice = [];
      } else {
        slice = buf.slice(idx + 1);
      }
    }
    if (!opts.includeDelta) slice = slice.filter((e) => !e.type.endsWith(DELTA_SUFFIX));
    return { ok: true, events: slice };
  }

  oldestId(user: string): string | null {
    const buf = this.buffers.get(user);
    return buf && buf.length > 0 ? buf[0].id : null;
  }

  private bumpCompactionDebt(user: string): void {
    const debt = (this.rotatedSinceCompact.get(user) ?? 0) + 1;
    this.rotatedSinceCompact.set(user, debt);
    if (debt >= Math.max(100, Math.floor(this.retention / 2))) {
      this.compactFile(user, this.buffers.get(user) ?? []);
    }
  }

  private scheduleFlush(user: string, delayMs: number): void {
    if (!this.dataDir) return;
    if (this.flushTimers.has(user)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(user);
      void this.flushUser(user);
    }, delayMs);
    timer.unref();
    this.flushTimers.set(user, timer);
  }

  private flushUser(user: string): Promise<void> {
    if (!this.dataDir) return Promise.resolve();
    const lines = this.pendingLines.get(user);
    if (!lines || lines.length === 0) return Promise.resolve();
    this.pendingLines.delete(user);
    const filePath = userEventLogPath(user, this.dataDir);
    return this.enqueueFsOp(user, async () => {
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.mkdir(userDir(user, this.dataDir!), { recursive: true });
        await fs.promises.appendFile(filePath, lines.join(""));
      } catch (e) {
        logger.warn("failed to append event log", { user, err: (e as Error).message });
      }
    });
  }

  private enqueueFsOp(user: string, op: () => Promise<void>): Promise<void> {
    const prev = this.writeChains.get(user) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(op);
    this.writeChains.set(user, next);
    return next.finally(() => {
      if (this.writeChains.get(user) === next) this.writeChains.delete(user);
    });
  }
}

function compareSeq(a: string, b: string): number {
  const na = parseInt(a.replace(/^evt-/, ""), 10);
  const nb = parseInt(b.replace(/^evt-/, ""), 10);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

export function isDeltaType(type: string): boolean {
  return type.endsWith(DELTA_SUFFIX);
}
