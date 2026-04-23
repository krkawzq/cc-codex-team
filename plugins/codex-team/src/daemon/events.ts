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
const MAX_PENDING_BACKLOG_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_LINE_MULTIPLIER = 10;
const EVENT_ID_SOFT_LIMIT = 2 ** 52;

export const AUTO_APPROVED_EVENT_TYPE = "auto_approved";
export const APPROVAL_REQUEST_CANCELLED_EVENT_TYPE = "approval.request_cancelled";
export const SESSION_CLOSED_EVENT_TYPE = "session.closed";
export const SESSION_CRASHED_EVENT_TYPE = "session.crashed";
export const SESSION_PENDING_DROPPED_EVENT_TYPE = "session.pending_dropped";
export const USER_INPUT_REQUEST_CANCELLED_EVENT_TYPE = "user_input.request_cancelled";

interface ScheduledFlush {
  dueAt: number;
  timer: NodeJS.Timeout;
}

export class EventRingBuffer {
  private capacity: number;
  private items: Array<TeamEvent | undefined>;
  private start = 0;
  private count = 0;
  private slotsById = new Map<string, number>();

  constructor(capacity: number, initial: TeamEvent[] = []) {
    this.capacity = Math.max(1, capacity);
    this.items = new Array(this.capacity);
    for (const event of initial) this.push(event);
  }

  get length(): number {
    return this.count;
  }

  setCapacity(capacity: number): number {
    const nextCapacity = Math.max(1, capacity);
    if (nextCapacity === this.capacity) return 0;

    const events = this.toArray();
    const dropped = Math.max(0, events.length - nextCapacity);
    this.capacity = nextCapacity;
    this.items = new Array(this.capacity);
    this.start = 0;
    this.count = 0;
    this.slotsById.clear();
    for (const event of events.slice(-nextCapacity)) this.push(event);
    return dropped;
  }

  push(event: TeamEvent): TeamEvent | null {
    if (this.count === this.capacity) {
      const slot = this.start;
      const evicted = this.items[slot] ?? null;
      if (evicted) this.slotsById.delete(evicted.id);
      this.items[slot] = event;
      this.slotsById.set(event.id, slot);
      this.start = (this.start + 1) % this.capacity;
      return evicted;
    }

    const slot = (this.start + this.count) % this.capacity;
    this.items[slot] = event;
    this.slotsById.set(event.id, slot);
    this.count += 1;
    return null;
  }

  oldestId(): string | null {
    return this.count === 0 ? null : this.items[this.start]?.id ?? null;
  }

  toArray(): TeamEvent[] {
    const events: TeamEvent[] = [];
    for (let offset = 0; offset < this.count; offset++) {
      const event = this.at(offset);
      if (event) events.push(event);
    }
    return events;
  }

  listSince(sinceId: string | null): ListSinceResult {
    if (!sinceId) return { ok: true, events: this.toArray() };

    const slot = this.slotsById.get(sinceId);
    if (slot === undefined) {
      const oldest = this.oldestId();
      if (oldest && compareSeq(sinceId, oldest) < 0) {
        return { ok: false, reason: "id_rotated", oldest_available_id: oldest };
      }
      return { ok: false, reason: "invalid_since" };
    }

    const events: TeamEvent[] = [];
    for (let offset = this.relativeIndex(slot) + 1; offset < this.count; offset++) {
      const event = this.at(offset);
      if (event) events.push(event);
    }
    return { ok: true, events };
  }

  findLast(predicate: (event: TeamEvent) => boolean): TeamEvent | null {
    for (let offset = this.count - 1; offset >= 0; offset--) {
      const event = this.at(offset);
      if (event && predicate(event)) return event;
    }
    return null;
  }

  private at(offset: number): TeamEvent | null {
    if (offset < 0 || offset >= this.count) return null;
    const slot = (this.start + offset) % this.capacity;
    return this.items[slot] ?? null;
  }

  private relativeIndex(slot: number): number {
    return slot >= this.start ? slot - this.start : this.capacity - this.start + slot;
  }
}

export class EventLog {
  private retention: number;
  private dataDir: string | null;
  private counters = new Map<string, number>();
  private buffers = new Map<string, EventRingBuffer>();
  private subscribers = new Map<string, Set<EventListener>>();
  private loaded = new Set<string>();
  private loadPromises = new Map<string, Promise<void>>();
  private rotatedSinceCompact = new Map<string, number>();
  private pendingLines = new Map<string, string[]>();
  private pendingBytes = new Map<string, number>();
  private flushTimers = new Map<string, ScheduledFlush>();
  private writeChains = new Map<string, Promise<void>>();
  private userOps = new Map<string, Promise<void>>();
  private overflowWarned = new Set<string>();
  private backlogOverflowWarned = new Set<string>();
  private eventIdOverflowWarned = new Set<string>();
  private compacting = new Set<string>();

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
    this.hydrateLoadedUser(user, events, totalLines);
    this.loaded.add(user);
    this.loadPromises.delete(user);
  }

  setRetention(n: number): void {
    this.retention = Math.max(100, n);
    for (const [user, buf] of this.buffers) {
      const dropped = buf.setCapacity(this.retention);
      if (dropped > 0) this.bumpCompactionDebt(user, dropped);
    }
  }

  retainedCount(user: string): number {
    return this.buffers.get(user)?.length ?? 0;
  }

  async append(user: string, input: Omit<TeamEvent, "id" | "ts">): Promise<TeamEvent> {
    await this.ensureLoaded(user);
    return await this.withUserLock(user, async () => {
      const overflowError = this.guardEventIdOverflow(user, input);
      if (overflowError) throw overflowError;
      return this.appendLoaded(user, input);
    });
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
      const scheduled = this.flushTimers.get(user);
      if (scheduled) {
        clearTimeout(scheduled.timer);
        this.flushTimers.delete(user);
      }
      await this.flushUser(user);
    }
    await Promise.all(Array.from(this.writeChains.values()).map((p) => p.catch(() => undefined)));
  }

  async clearUser(user: string): Promise<void> {
    const scheduled = this.flushTimers.get(user);
    if (scheduled) {
      clearTimeout(scheduled.timer);
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
    this.backlogOverflowWarned.delete(user);
    this.eventIdOverflowWarned.delete(user);
    this.compacting.delete(user);
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
      const buf = this.buffers.get(user);
      if (!buf) return { ok: true, events: [] } as const;
      const listed = buf.listSince(sinceId);
      if (!listed.ok) return listed;
      let slice = listed.events;
      if (!opts.includeDelta) slice = slice.filter((e) => !e.type.endsWith(DELTA_SUFFIX));
      return { ok: true, events: slice } as const;
    });
  }

  oldestId(user: string): string | null {
    return this.buffers.get(user)?.oldestId() ?? null;
  }

  latestEvent(
    user: string,
    filter: { session?: string | null; thread_id?: string | null; types?: string[] } = {},
  ): TeamEvent | null {
    this.loadUser(user);
    const buf = this.buffers.get(user);
    if (!buf) return null;
    const types = filter.types ? new Set(filter.types) : null;
    return buf.findLast((event) => {
      if (filter.session !== undefined && event.session !== filter.session) return false;
      if (filter.thread_id !== undefined && event.thread_id !== filter.thread_id) return false;
      if (types && !types.has(event.type)) return false;
      return true;
    });
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
      this.hydrateLoadedUser(user, events, totalLines);
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
    const evicted = buf.push(event);
    if (evicted) this.bumpCompactionDebt(user);
    this.dispatchSubscribers(user, event);
    if (opts.persist !== false) this.appendToFile(user, event);
    return event;
  }

  private guardEventIdOverflow(user: string, input: Omit<TeamEvent, "id" | "ts">): Error | null {
    this.ensureUserState(user);
    const nextId = (this.counters.get(user) ?? 0) + 1;
    if (nextId <= EVENT_ID_SOFT_LIMIT) return null;

    const message = `event id counter exceeded safe limit (${EVENT_ID_SOFT_LIMIT}); refusing to append new events`;
    if (!this.eventIdOverflowWarned.has(user)) {
      this.eventIdOverflowWarned.add(user);
      logger.error("event id counter exceeded safe limit", {
        user,
        next_event_id: nextId,
        limit: EVENT_ID_SOFT_LIMIT,
        dropped_event_type: input.type,
      });
      this.appendLoaded(user, {
        type: "warning",
        session: null,
        thread_id: null,
        payload: {
          message,
          kind: "event_id_overflow",
          limit: EVENT_ID_SOFT_LIMIT,
          next_event_id: nextId,
          dropped_event_type: input.type,
        },
      });
    }

    return new Error(message);
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
    this.enforcePendingBacklogCap(user);
    const currentBytes = this.pendingBytes.get(user) ?? 0;

    if (currentBytes > MAX_PENDING_WRITE_BYTES) {
      if (!this.overflowWarned.has(user)) {
        this.overflowWarned.add(user);
        this.appendLoaded(user, {
          type: "warning",
          session: null,
          thread_id: null,
          payload: {
            message: "event log backlog exceeded 1048576 bytes; writes are being retried more slowly",
            kind: "event_log_backpressure",
            pending_bytes: currentBytes,
          },
        }, { persist: false });
      }
      this.scheduleFlush(user, OVERFLOW_FLUSH_DELAY_MS, true);
      return;
    }

    this.scheduleFlush(user, DEFAULT_FLUSH_DELAY_MS);
  }

  private requestCompaction(user: string): void {
    if (!this.dataDir || this.compacting.has(user)) return;
    this.compacting.add(user);
    void this.compactFile(user).finally(() => {
      this.compacting.delete(user);
      if ((this.rotatedSinceCompact.get(user) ?? 0) >= this.compactionThreshold()) {
        this.requestCompaction(user);
      }
    });
  }

  private async compactFile(user: string): Promise<void> {
    if (!this.dataDir) return;
    const filePath = userEventLogPath(user, this.dataDir);
    let pendingLines: string[] = [];
    let pendingBytes = 0;
    let debtSnapshot = 0;
    let writePromise: Promise<boolean> | null = null;

    await this.withUserLock(user, async () => {
      const scheduled = this.flushTimers.get(user);
      if (scheduled) {
        clearTimeout(scheduled.timer);
        this.flushTimers.delete(user);
      }

      pendingLines = [...(this.pendingLines.get(user) ?? [])];
      pendingBytes = this.pendingBytes.get(user) ?? 0;
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
      debtSnapshot = this.rotatedSinceCompact.get(user) ?? 0;

      const contents = serializeEventFile(this.buffers.get(user)?.toArray() ?? []);
      writePromise = this.enqueueFsOp(user, async () => {
        try {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.mkdir(userDir(user, this.dataDir!), { recursive: true });
          const tmp = filePath + ".tmp";
          await fs.promises.writeFile(tmp, contents);
          await fs.promises.rename(tmp, filePath);
          return true;
        } catch (e) {
          logger.warn("event log compaction failed", { user, err: (e as Error).message });
          return false;
        }
      });
    });

    if (!writePromise) return;
    const ok = await writePromise;
    if (!ok) {
      await this.withUserLock(user, async () => {
        this.restorePendingLines(user, pendingLines, pendingBytes);
        this.scheduleFlush(user, FLUSH_RETRY_DELAY_MS, true);
      });
      return;
    }

    await this.withUserLock(user, async () => {
      const currentDebt = this.rotatedSinceCompact.get(user) ?? 0;
      this.rotatedSinceCompact.set(user, Math.max(0, currentDebt - debtSnapshot));
    });
  }

  private bumpCompactionDebt(user: string, amount = 1): void {
    const debt = (this.rotatedSinceCompact.get(user) ?? 0) + amount;
    this.rotatedSinceCompact.set(user, debt);
    if (debt >= this.compactionThreshold()) this.requestCompaction(user);
  }

  private scheduleFlush(user: string, delayMs: number, reset = false): void {
    if (!this.dataDir) return;
    const dueAt = Date.now() + delayMs;
    const existing = this.flushTimers.get(user);
    if (existing) {
      if (!reset || existing.dueAt <= dueAt) return;
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      const scheduled = this.flushTimers.get(user);
      if (!scheduled || scheduled.timer !== timer) return;
      this.flushTimers.delete(user);
      void this.flushUser(user);
    }, delayMs);
    timer.unref?.();
    this.flushTimers.set(user, { dueAt, timer });
  }

  private async flushUser(user: string): Promise<void> {
    if (!this.dataDir) return;
    const filePath = userEventLogPath(user, this.dataDir);
    let snapshotLines: string[] | null = null;
    let snapshotBytes = 0;
    let writePromise: Promise<boolean> | null = null;

    await this.withUserLock(user, async () => {
      const lines = this.pendingLines.get(user);
      if (!lines || lines.length === 0) return;
      snapshotLines = [...lines];
      snapshotBytes = this.pendingBytes.get(user) ?? 0;
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
      writePromise = this.enqueueFsOp(user, async () => {
        try {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.mkdir(userDir(user, this.dataDir!), { recursive: true });
          if (!fs.existsSync(filePath)) {
            await fs.promises.writeFile(filePath, serializeHeaderLine() + snapshotLines!.join(""));
          } else {
            await fs.promises.appendFile(filePath, snapshotLines!.join(""));
          }
          return true;
        } catch (e) {
          logger.warn("failed to append event log", { user, err: (e as Error).message });
          return false;
        }
      });
    });

    if (!snapshotLines || !writePromise) return;
    const ok = await writePromise;

    if (!ok) {
      await this.withUserLock(user, async () => {
        this.restorePendingLines(user, snapshotLines!, snapshotBytes);
        this.scheduleFlush(user, FLUSH_RETRY_DELAY_MS, true);
      });
      return;
    }

    if ((this.pendingBytes.get(user) ?? 0) <= Math.floor(MAX_PENDING_WRITE_BYTES / 2)) {
      this.overflowWarned.delete(user);
    }
    if (this.pendingBacklogRecovered(user)) this.backlogOverflowWarned.delete(user);
  }

  private ensureUserState(user: string): void {
    if (!this.buffers.has(user)) this.buffers.set(user, new EventRingBuffer(this.retention));
    if (!this.counters.has(user)) this.counters.set(user, 0);
  }

  private hydrateLoadedUser(user: string, events: TeamEvent[], totalLines: number): void {
    const buf = new EventRingBuffer(this.retention, events);
    let maxSeq = 0;
    for (const ev of buf.toArray()) {
      const seq = parseInt(ev.id.replace(/^evt-/, ""), 10);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
    this.buffers.set(user, buf);
    this.counters.set(user, maxSeq);
    if (totalLines > this.retention * 1.5) this.requestCompaction(user);
  }

  private compactionThreshold(): number {
    return Math.max(100, Math.floor(this.retention / 2));
  }

  private maxPendingLineCount(): number {
    return Math.max(1, this.retention * MAX_PENDING_LINE_MULTIPLIER);
  }

  private restorePendingLines(user: string, lines: string[], bytes: number): void {
    if (lines.length === 0 || bytes <= 0) return;
    const pending = this.pendingLines.get(user) ?? [];
    this.pendingLines.set(user, [...lines, ...pending]);
    this.pendingBytes.set(user, bytes + (this.pendingBytes.get(user) ?? 0));
    this.enforcePendingBacklogCap(user);
  }

  private enforcePendingBacklogCap(user: string): void {
    const pending = this.pendingLines.get(user);
    if (!pending || pending.length === 0) {
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
      return;
    }

    const maxLines = this.maxPendingLineCount();
    let totalBytes = this.pendingBytes.get(user) ?? 0;
    let droppedLines = 0;
    let droppedBytes = 0;

    while (pending.length > maxLines || totalBytes > MAX_PENDING_BACKLOG_BYTES) {
      const dropped = pending.shift();
      if (!dropped) break;
      const lineBytes = Buffer.byteLength(dropped);
      totalBytes -= lineBytes;
      droppedLines += 1;
      droppedBytes += lineBytes;
    }

    if (pending.length === 0) {
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
    } else {
      this.pendingBytes.set(user, totalBytes);
    }

    if (droppedLines > 0 && !this.backlogOverflowWarned.has(user)) {
      this.backlogOverflowWarned.add(user);
      this.appendLoaded(user, {
        type: "warning",
        session: null,
        thread_id: null,
        payload: {
          message: `event log backlog exceeded ${maxLines} lines or ${MAX_PENDING_BACKLOG_BYTES} bytes; dropping oldest pending persisted entries`,
          kind: "event_log_backlog_overflow",
          dropped_lines: droppedLines,
          dropped_bytes: droppedBytes,
          max_pending_lines: maxLines,
          max_pending_bytes: MAX_PENDING_BACKLOG_BYTES,
          pending_lines: pending.length,
          pending_bytes: Math.max(totalBytes, 0),
        },
      }, { persist: false });
    }
  }

  private pendingBacklogRecovered(user: string): boolean {
    const pendingLines = this.pendingLines.get(user)?.length ?? 0;
    const pendingBytes = this.pendingBytes.get(user) ?? 0;
    return pendingLines <= Math.floor(this.maxPendingLineCount() / 2) &&
      pendingBytes <= Math.floor(MAX_PENDING_BACKLOG_BYTES / 2);
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
