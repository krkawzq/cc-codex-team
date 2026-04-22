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

export interface ListSinceInvalid {
  ok: false;
  reason: "invalid_since";
}

export type ListSinceResult = ListSinceOk | ListSinceRotated | ListSinceInvalid;

const DELTA_SUFFIX = "_delta";
const SCHEMA_VERSION = 1;
const DEFAULT_FLUSH_DELAY_MS = 25;
const OVERFLOW_FLUSH_DELAY_MS = 250;
const FLUSH_RETRY_DELAY_MS = 250;
const MAX_PENDING_WRITE_BYTES = 1024 * 1024;

export const AUTO_APPROVED_EVENT_TYPE = "auto_approved";
export const SESSION_CLOSED_EVENT_TYPE = "session.closed";
export const SESSION_CRASHED_EVENT_TYPE = "session.crashed";

export class EventLog {
  private retention: number;
  private dataDir: string | null;
  private counters = new Map<string, number>();
  private buffers = new Map<string, TeamEvent[]>();
  private subscribers = new Map<string, Set<EventListener>>();
  private loaded = new Set<string>();
  private loadPromises = new Map<string, Promise<void>>();
  private rotatedSinceCompact = new Map<string, number>();
  private pendingLines = new Map<string, string[]>();
  private pendingBytes = new Map<string, number>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  private writeChains = new Map<string, Promise<void>>();
  private userOps = new Map<string, Promise<void>>();
  private overflowWarned = new Set<string>();

  constructor(retention = 10000, dataDir: string | null = null) {
    this.retention = Math.max(100, retention);
    this.dataDir = dataDir;
  }

  loadUser(user: string): void {
    if (this.loaded.has(user)) return;
    if (!this.dataDir) {
      this.ensureUserState(user);
      this.loaded.add(user);
      this.loadPromises.delete(user);
      return;
    }

    const filePath = userEventLogPath(user, this.dataDir);
    if (!fs.existsSync(filePath)) {
      this.ensureUserState(user);
      this.loaded.add(user);
      this.loadPromises.delete(user);
      return;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const { events, totalLines } = parsePersistedEvents(lines);
    const buf = events.slice(Math.max(0, events.length - this.retention));
    let maxSeq = 0;
    for (const ev of buf) {
      const seq = parseInt(ev.id.replace(/^evt-/, ""), 10);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
    this.buffers.set(user, buf);
    this.counters.set(user, maxSeq);
    this.loaded.add(user);
    this.loadPromises.delete(user);
    if (totalLines > this.retention * 1.5) this.compactFile(user, buf);
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

  async append(user: string, input: Omit<TeamEvent, "id" | "ts">): Promise<TeamEvent> {
    await this.ensureLoaded(user);
    return await this.withUserLock(user, async () => this.appendLoaded(user, input));
  }

  async flush(): Promise<void> {
    const users = new Set<string>([
      ...this.flushTimers.keys(),
      ...this.pendingLines.keys(),
      ...this.writeChains.keys(),
      ...this.loadPromises.keys(),
      ...this.userOps.keys(),
    ]);
    await Promise.all(Array.from(this.loadPromises.values()).map((p) => p.catch(() => undefined)));
    for (const user of users) {
      const timer = this.flushTimers.get(user);
      if (timer) {
        clearTimeout(timer);
        this.flushTimers.delete(user);
      }
      await this.flushUser(user);
    }
    await Promise.all(Array.from(this.writeChains.values()).map((p) => p.catch(() => undefined)));
  }

  async clearUser(user: string): Promise<void> {
    const timer = this.flushTimers.get(user);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(user);
    }
    await (this.loadPromises.get(user)?.catch(() => undefined) ?? Promise.resolve());
    await (this.userOps.get(user)?.catch(() => undefined) ?? Promise.resolve());
    await (this.writeChains.get(user)?.catch(() => undefined) ?? Promise.resolve());
    this.pendingLines.delete(user);
    this.pendingBytes.delete(user);
    this.writeChains.delete(user);
    this.userOps.delete(user);
    this.rotatedSinceCompact.delete(user);
    this.counters.delete(user);
    this.buffers.delete(user);
    this.subscribers.delete(user);
    this.loaded.delete(user);
    this.loadPromises.delete(user);
    this.overflowWarned.delete(user);
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

  async listSince(
    user: string,
    sinceId: string | null,
    opts: { includeDelta: boolean } = { includeDelta: false },
  ): Promise<ListSinceResult> {
    await this.ensureLoaded(user);
    return await this.withUserLock(user, async () => {
      const buf = this.buffers.get(user) ?? [];
      let slice: TeamEvent[];
      if (!sinceId) {
        slice = buf.slice();
      } else {
        const idx = buf.findIndex((e) => e.id === sinceId);
        if (idx < 0) {
          if (buf.length > 0 && compareSeq(sinceId, buf[0].id) < 0) {
            return { ok: false, reason: "id_rotated", oldest_available_id: buf[0].id } as const;
          }
          return { ok: false, reason: "invalid_since" } as const;
        }
        slice = buf.slice(idx + 1);
      }
      if (!opts.includeDelta) slice = slice.filter((e) => !e.type.endsWith(DELTA_SUFFIX));
      return { ok: true, events: slice } as const;
    });
  }

  oldestId(user: string): string | null {
    const buf = this.buffers.get(user);
    return buf && buf.length > 0 ? buf[0].id : null;
  }

  latestEvent(
    user: string,
    filter: { session?: string | null; thread_id?: string | null; types?: string[] } = {},
  ): TeamEvent | null {
    this.loadUser(user);
    const buf = this.buffers.get(user) ?? [];
    const types = filter.types ? new Set(filter.types) : null;
    for (let i = buf.length - 1; i >= 0; i--) {
      const event = buf[i]!;
      if (filter.session !== undefined && event.session !== filter.session) continue;
      if (filter.thread_id !== undefined && event.thread_id !== filter.thread_id) continue;
      if (types && !types.has(event.type)) continue;
      return event;
    }
    return null;
  }

  private async ensureLoaded(user: string): Promise<void> {
    if (this.loaded.has(user)) return;
    let promise = this.loadPromises.get(user);
    if (!promise) {
      promise = new Promise<void>((resolve, reject) => {
        queueMicrotask(() => {
          void this.loadUserFromDisk(user).then(resolve, reject);
        });
      });
      this.loadPromises.set(user, promise);
    }
    await promise;
  }

  private async loadUserFromDisk(user: string): Promise<void> {
    if (this.loaded.has(user)) return;

    let shouldMarkLoaded = false;
    try {
      if (!this.dataDir) {
        this.ensureUserState(user);
        shouldMarkLoaded = true;
        return;
      }

      const filePath = userEventLogPath(user, this.dataDir);
      const raw = await fs.promises.readFile(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const { events, totalLines } = parsePersistedEvents(lines);
      const buf = events.slice(Math.max(0, events.length - this.retention));
      let maxSeq = 0;
      for (const ev of buf) {
        const seq = parseInt(ev.id.replace(/^evt-/, ""), 10);
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
      }
      this.buffers.set(user, buf);
      this.counters.set(user, maxSeq);
      if (totalLines > this.retention * 1.5) this.compactFile(user, buf);
      shouldMarkLoaded = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.ensureUserState(user);
        shouldMarkLoaded = true;
        return;
      }
      if ((e as Error).message.toLowerCase().includes("schema_version")) {
        throw e;
      }
      logger.warn("failed to load event log", { user, err: (e as Error).message });
      this.ensureUserState(user);
      shouldMarkLoaded = true;
    } finally {
      if (shouldMarkLoaded) this.loaded.add(user);
      this.loadPromises.delete(user);
    }
  }

  private appendLoaded(
    user: string,
    input: Omit<TeamEvent, "id" | "ts">,
    opts: { persist?: boolean } = {},
  ): TeamEvent {
    this.ensureUserState(user);
    const seq = (this.counters.get(user) ?? 0) + 1;
    this.counters.set(user, seq);
    const event: TeamEvent = {
      id: `evt-${seq}`,
      ts: new Date().toISOString(),
      ...input,
    };
    const buf = this.buffers.get(user)!;
    buf.push(event);
    let rotated = false;
    while (buf.length > this.retention) {
      buf.shift();
      rotated = true;
    }
    if (rotated) this.bumpCompactionDebt(user);
    this.dispatchSubscribers(user, event);
    if (opts.persist !== false) this.appendToFile(user, event);
    return event;
  }

  private dispatchSubscribers(user: string, event: TeamEvent): void {
    const listeners = Array.from(this.subscribers.get(user) ?? []);
    if (listeners.length === 0) return;
    queueMicrotask(() => {
      for (const cb of listeners) {
        try {
          cb(event);
        } catch {
          // ignore listener errors
        }
      }
    });
  }

  private appendToFile(user: string, event: TeamEvent): void {
    if (!this.dataDir) return;
    const line = JSON.stringify(event) + "\n";
    const bytes = Buffer.byteLength(line);
    const pending = this.pendingLines.get(user) ?? [];
    pending.push(line);
    this.pendingLines.set(user, pending);
    const totalBytes = (this.pendingBytes.get(user) ?? 0) + bytes;
    this.pendingBytes.set(user, totalBytes);

    if (totalBytes > MAX_PENDING_WRITE_BYTES) {
      if (!this.overflowWarned.has(user)) {
        this.overflowWarned.add(user);
        this.appendLoaded(user, {
          type: "warning",
          session: null,
          thread_id: null,
          payload: {
            message: "event log backlog exceeded 1048576 bytes; writes are being retried more slowly",
            kind: "event_log_backpressure",
            pending_bytes: totalBytes,
          },
        }, { persist: false });
      }
      this.scheduleFlush(user, OVERFLOW_FLUSH_DELAY_MS, true);
      return;
    }

    this.scheduleFlush(user, DEFAULT_FLUSH_DELAY_MS);
  }

  private compactFile(user: string, buf: TeamEvent[]): void {
    if (!this.dataDir) return;
    const timer = this.flushTimers.get(user);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(user);
    }
    this.pendingLines.delete(user);
    this.pendingBytes.delete(user);
    const filePath = userEventLogPath(user, this.dataDir);
    void this.enqueueFsOp(user, async () => {
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.mkdir(userDir(user, this.dataDir!), { recursive: true });
        const tmp = filePath + ".tmp";
        await fs.promises.writeFile(tmp, serializeEventFile(buf));
        await fs.promises.rename(tmp, filePath);
        this.rotatedSinceCompact.set(user, 0);
      } catch (e) {
        logger.warn("event log compaction failed", { user, err: (e as Error).message });
      }
    });
  }

  private bumpCompactionDebt(user: string): void {
    const debt = (this.rotatedSinceCompact.get(user) ?? 0) + 1;
    this.rotatedSinceCompact.set(user, debt);
    if (debt >= Math.max(100, Math.floor(this.retention / 2))) {
      this.compactFile(user, this.buffers.get(user) ?? []);
    }
  }

  private scheduleFlush(user: string, delayMs: number, reset = false): void {
    if (!this.dataDir) return;
    if (this.flushTimers.has(user)) {
      if (!reset) return;
      clearTimeout(this.flushTimers.get(user)!);
    }
    const timer = setTimeout(() => {
      this.flushTimers.delete(user);
      void this.flushUser(user);
    }, delayMs);
    timer.unref();
    this.flushTimers.set(user, timer);
  }

  private async flushUser(user: string): Promise<void> {
    if (!this.dataDir) return;
    const snapshot = await this.withUserLock(user, async () => {
      const lines = this.pendingLines.get(user);
      if (!lines || lines.length === 0) return null;
      const bytes = this.pendingBytes.get(user) ?? 0;
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
      return { lines: [...lines], bytes };
    });
    if (!snapshot) return;

    const filePath = userEventLogPath(user, this.dataDir);
    const ok = await this.enqueueFsOp(user, async () => {
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.mkdir(userDir(user, this.dataDir!), { recursive: true });
        if (!fs.existsSync(filePath)) {
          await fs.promises.writeFile(filePath, serializeHeaderLine() + snapshot.lines.join(""));
        } else {
          await fs.promises.appendFile(filePath, snapshot.lines.join(""));
        }
        return true;
      } catch (e) {
        logger.warn("failed to append event log", { user, err: (e as Error).message });
        return false;
      }
    });

    if (!ok) {
      await this.withUserLock(user, async () => {
        const pending = this.pendingLines.get(user) ?? [];
        this.pendingLines.set(user, [...snapshot.lines, ...pending]);
        this.pendingBytes.set(user, (this.pendingBytes.get(user) ?? 0) + snapshot.bytes);
        this.scheduleFlush(user, FLUSH_RETRY_DELAY_MS, true);
      });
      return;
    }

    if ((this.pendingBytes.get(user) ?? 0) <= Math.floor(MAX_PENDING_WRITE_BYTES / 2)) {
      this.overflowWarned.delete(user);
    }
  }

  private ensureUserState(user: string): void {
    if (!this.buffers.has(user)) this.buffers.set(user, []);
    if (!this.counters.has(user)) this.counters.set(user, 0);
  }

  private async withUserLock<T>(user: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.userOps.get(user) ?? Promise.resolve();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = prev.catch(() => undefined).then(() => barrier);
    this.userOps.set(user, next);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.userOps.get(user) === next) this.userOps.delete(user);
    }
  }

  private enqueueFsOp<T>(user: string, op: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(user) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(op);
    const chain = next.then(() => undefined, () => undefined);
    this.writeChains.set(user, chain);
    return next.finally(() => {
      if (this.writeChains.get(user) === chain) this.writeChains.delete(user);
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

interface EventLogHeader {
  schema_version: number;
  kind: "event_log_header";
}

function parsePersistedEvents(lines: string[]): { events: TeamEvent[]; totalLines: number } {
  if (lines.length === 0) return { events: [], totalLines: 0 };
  let eventLines = lines;
  let totalLines = lines.length;
  const first = parseLine(lines[0]!);
  if (isHeader(first)) {
    if (first.schema_version > SCHEMA_VERSION) {
      throw new Error(`event log schema_version ${first.schema_version} is newer than supported ${SCHEMA_VERSION}`);
    }
    eventLines = lines.slice(1);
    totalLines = eventLines.length;
  }
  const events: TeamEvent[] = [];
  for (const line of eventLines) {
    const parsed = parseLine(line);
    if (isPersistedEvent(parsed)) {
      events.push(parsed);
    }
  }
  return { events, totalLines };
}

function parseLine(line: string): unknown | null {
  try {
    return JSON.parse(line) as unknown;
  } catch (e) {
    throw new Error(`failed to parse event log line: ${(e as Error).message}`);
  }
}

function isHeader(value: unknown): value is EventLogHeader {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return rec.kind === "event_log_header" &&
    typeof rec.schema_version === "number";
}

function isPersistedEvent(value: unknown): value is TeamEvent {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.id === "string" &&
    typeof rec.ts === "string" &&
    typeof rec.type === "string" &&
    (rec.session === null || typeof rec.session === "string") &&
    (rec.thread_id === null || typeof rec.thread_id === "string") &&
    typeof rec.payload === "object" &&
    rec.payload !== null &&
    !Array.isArray(rec.payload);
}

function serializeHeaderLine(): string {
  return JSON.stringify({ schema_version: SCHEMA_VERSION, kind: "event_log_header" } satisfies EventLogHeader) + "\n";
}

function serializeEventFile(buf: TeamEvent[]): string {
  return serializeHeaderLine() + buf.map((e) => JSON.stringify(e)).join("\n") + (buf.length ? "\n" : "");
}
