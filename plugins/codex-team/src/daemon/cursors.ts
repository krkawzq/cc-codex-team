import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { invalidParams } from "../errors";
import { logger } from "../logger";
import { userDir } from "../paths";

const CURSOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCHEMA_VERSION = 1;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 5 * 60 * 1000;

export interface CursorRecord {
  name: string;
  event_id: string | null;
  updated_at: string;
  auto_update: boolean;
}

interface CursorEnvelope {
  schema_version?: number;
  cursors?: CursorRecord[];
}

interface CursorLockRecord {
  pid: number;
  started_at: string;
  host: string;
  nonce?: string;
}

type OwnedCursorLockRecord = CursorLockRecord & { nonce: string };

type PersistOp =
  | { type: "upsert"; cursor: CursorRecord }
  | { type: "delete"; name: string };

interface PendingPersistState {
  timer: NodeJS.Timeout | null;
  ops: Map<string, PersistOp>;
  flushing: Promise<void> | null;
}

export interface CursorLockLease {
  lockPath: string;
  record: OwnedCursorLockRecord;
  release(): Promise<void>;
}

export class CursorStore {
  private readonly dataDir: string;
  private readonly users = new Map<string, Map<string, CursorRecord>>();
  private readonly loaded = new Set<string>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly pendingPersists = new Map<string, PendingPersistState>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  list(user: string): CursorRecord[] {
    const bucket = this.bucket(user);
    return sorted(bucket).map(cloneCursorRecord);
  }

  get(user: string, name: string): CursorRecord | null {
    validateCursorName(name);
    return cloneCursor(this.bucket(user).get(name) ?? null);
  }

  async ensure(user: string, input: { name: string; event_id?: string | null; auto_update?: boolean }): Promise<CursorRecord> {
    validateCursorName(input.name);
    const existing = this.bucket(user).get(input.name);
    if (existing) return cloneCursor(existing)!;
    return await this.save(user, input);
  }

  async save(user: string, input: { name: string; event_id?: string | null; auto_update?: boolean }): Promise<CursorRecord> {
    validateCursorName(input.name);
    const bucket = this.bucket(user);
    const existing = bucket.get(input.name);
    const cursor: CursorRecord = {
      name: input.name,
      event_id: input.event_id ?? null,
      updated_at: new Date().toISOString(),
      auto_update: input.auto_update ?? existing?.auto_update ?? true,
    };
    bucket.set(cursor.name, cursor);
    this.discardPendingPersist(user, cursor.name);
    try {
      await this.enqueuePersist(user, { type: "upsert", cursor: cloneCursorRecord(cursor) });
    } catch (error) {
      if (existing) {
        bucket.set(existing.name, existing);
      } else {
        bucket.delete(cursor.name);
      }
      throw error;
    }
    return cloneCursor(cursor)!;
  }

  async saveBestEffort(user: string, input: { name: string; event_id?: string | null; auto_update?: boolean }): Promise<CursorRecord> {
    validateCursorName(input.name);
    const bucket = this.bucket(user);
    const existing = bucket.get(input.name);
    const cursor: CursorRecord = {
      name: input.name,
      event_id: input.event_id ?? null,
      updated_at: new Date().toISOString(),
      auto_update: input.auto_update ?? existing?.auto_update ?? true,
    };
    bucket.set(cursor.name, cursor);
    this.discardPendingPersist(user, cursor.name);
    try {
      await this.enqueuePersist(user, { type: "upsert", cursor: cloneCursorRecord(cursor) });
    } catch (error) {
      logger.warn("failed to persist cursors.json", { user, err: (error as Error).message });
    }
    return cloneCursor(cursor)!;
  }

  saveBestEffortDebounced(
    user: string,
    input: { name: string; event_id?: string | null; auto_update?: boolean },
    debounceMs: number,
  ): CursorRecord {
    validateCursorName(input.name);
    const bucket = this.bucket(user);
    const existing = bucket.get(input.name);
    const cursor: CursorRecord = {
      name: input.name,
      event_id: input.event_id ?? null,
      updated_at: new Date().toISOString(),
      auto_update: input.auto_update ?? existing?.auto_update ?? true,
    };
    bucket.set(cursor.name, cursor);
    this.scheduleBestEffortPersist(user, { type: "upsert", cursor: cloneCursorRecord(cursor) }, debounceMs);
    return cloneCursor(cursor)!;
  }

  async delete(user: string, name: string): Promise<boolean> {
    validateCursorName(name);
    const bucket = this.bucket(user);
    const existing = bucket.get(name);
    const deleted = bucket.delete(name);
    if (!deleted) return false;
    this.discardPendingPersist(user, name);
    try {
      await this.enqueuePersist(user, { type: "delete", name });
    } catch (error) {
      if (existing) bucket.set(name, existing);
      throw error;
    }
    return true;
  }

  async clearUser(user: string): Promise<void> {
    await this.flushUser(user);
    await (this.writeChains.get(user)?.catch(() => undefined) ?? Promise.resolve());
    this.writeChains.delete(user);
    this.clearPendingPersistState(user);
    this.users.delete(user);
    this.loaded.delete(user);
  }

  async flushUser(user: string): Promise<void> {
    while (true) {
      const state = this.pendingPersists.get(user);
      if (!state) {
        await (this.writeChains.get(user)?.catch(() => undefined) ?? Promise.resolve());
        return;
      }
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.flushing) {
        await state.flushing;
        continue;
      }
      if (state.ops.size === 0) {
        this.clearPendingPersistState(user);
        await (this.writeChains.get(user)?.catch(() => undefined) ?? Promise.resolve());
        return;
      }

      const ops = Array.from(state.ops.values(), clonePersistOp);
      state.ops.clear();
      const flushPromise = this.enqueuePersist(user, ops)
        .catch((error) => {
          logger.warn("failed to persist cursors.json", { user, err: (error as Error).message });
        })
        .finally(() => {
          if (this.pendingPersists.get(user) !== state) return;
          state.flushing = null;
          if (!state.timer && state.ops.size === 0) {
            this.pendingPersists.delete(user);
          }
        });
      state.flushing = flushPromise;
      await flushPromise;
    }
  }

  async flush(): Promise<void> {
    const users = new Set<string>([
      ...this.pendingPersists.keys(),
      ...this.writeChains.keys(),
    ]);
    for (const user of users) {
      await this.flushUser(user);
    }
  }

  private bucket(user: string): Map<string, CursorRecord> {
    this.loadForUser(user);
    let bucket = this.users.get(user);
    if (!bucket) {
      bucket = new Map<string, CursorRecord>();
      this.users.set(user, bucket);
    }
    return bucket;
  }

  private loadForUser(user: string): void {
    if (this.loaded.has(user)) return;
    const bucket = new Map<string, CursorRecord>();
    const filePath = cursorFilePath(user, this.dataDir);
    if (fs.existsSync(filePath)) {
      try {
        for (const cursor of loadEnvelopeFromText(fs.readFileSync(filePath, "utf8")).cursors.values()) {
          bucket.set(cursor.name, cloneCursor(cursor)!);
        }
      } catch (error) {
        throw new Error(`failed to load cursors.json for '${user}': ${(error as Error).message}`);
      }
    }
    this.users.set(user, bucket);
    this.loaded.add(user);
  }

  private enqueuePersist(user: string, op: PersistOp | PersistOp[]): Promise<void> {
    const ops = Array.isArray(op) ? op.map(clonePersistOp) : [clonePersistOp(op)];
    const previous = this.writeChains.get(user) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.persistAsync(user, ops));
    this.writeChains.set(user, next);
    return next;
  }

  private async persistAsync(user: string, ops: PersistOp[]): Promise<void> {
    const dir = userDir(user, this.dataDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = cursorFilePath(user, this.dataDir);
    const lock = await acquireCursorLock(filePath);
    const tmpPath = makeTempPath(filePath);
    try {
      const persisted = await loadEnvelopeFromFile(filePath);
      for (const op of ops) applyPersistOp(persisted, op);
      const payload = {
        schema_version: SCHEMA_VERSION,
        cursors: sorted(persisted),
      };
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2));
      await fs.promises.rename(tmpPath, filePath);
    } finally {
      await fs.promises.unlink(tmpPath).catch(() => undefined);
      await lock.release();
    }
  }

  private scheduleBestEffortPersist(user: string, op: PersistOp, debounceMs: number): void {
    const state = this.getPendingPersistState(user);
    state.ops.set(persistKey(op), clonePersistOp(op));
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flushUser(user);
    }, Math.max(0, debounceMs));
    state.timer.unref();
  }

  private discardPendingPersist(user: string, cursorName: string): void {
    const state = this.pendingPersists.get(user);
    if (!state) return;
    state.ops.delete(cursorName);
    if (!state.timer && !state.flushing && state.ops.size === 0) {
      this.pendingPersists.delete(user);
    }
  }

  private getPendingPersistState(user: string): PendingPersistState {
    let state = this.pendingPersists.get(user);
    if (!state) {
      state = {
        timer: null,
        ops: new Map<string, PersistOp>(),
        flushing: null,
      };
      this.pendingPersists.set(user, state);
    }
    return state;
  }

  private clearPendingPersistState(user: string): void {
    const state = this.pendingPersists.get(user);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.pendingPersists.delete(user);
  }
}

function cursorFilePath(user: string, dataDir: string): string {
  return path.join(userDir(user, dataDir), "cursors.json");
}

export async function acquireCursorLock(filePath: string): Promise<CursorLockLease> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const created = await tryCreateCursorLock(lockPath);
      if (created) return created;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw error;
      const reclaimed = await reclaimStaleCursorLock(lockPath);
      if (reclaimed) return reclaimed;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for cursor lock '${lockPath}'`);
    }
    await sleep(LOCK_RETRY_MS);
  }
}

export async function reclaimStaleCursorLock(lockPath: string): Promise<CursorLockLease | null> {
  const lock = await readCursorLock(lockPath);
  if (!lock || !isStaleCursorLock(lock)) return null;

  try {
    await fs.promises.unlink(lockPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw error;
  }
  try {
    return await tryCreateCursorLock(lockPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST") return null;
    throw error;
  }
}

function makeTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
}

function makeCursorLockRecord(): OwnedCursorLockRecord {
  return {
    pid: process.pid,
    started_at: new Date().toISOString(),
    host: os.hostname(),
    nonce: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
  };
}

async function loadEnvelopeFromFile(filePath: string): Promise<Map<string, CursorRecord>> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return loadEnvelopeFromText(raw).cursors;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return new Map<string, CursorRecord>();
    throw error;
  }
}

function loadEnvelopeFromText(raw: string): { cursors: Map<string, CursorRecord> } {
  const parsed = JSON.parse(raw) as CursorEnvelope;
  if (typeof parsed.schema_version === "number" && parsed.schema_version > SCHEMA_VERSION) {
    throw new Error(`cursors.json schema_version ${parsed.schema_version} is newer than supported ${SCHEMA_VERSION}`);
  }

  const bucket = new Map<string, CursorRecord>();
  for (const cursor of parsed.cursors ?? []) {
    if (!isPersistedCursor(cursor)) continue;
    bucket.set(cursor.name, cloneCursor(cursor)!);
  }
  return { cursors: bucket };
}

export async function readCursorLock(lockPath: string): Promise<CursorLockRecord | null> {
  try {
    const raw = await fs.promises.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CursorLockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isFinite(parsed.pid) ||
      typeof parsed.started_at !== "string" ||
      typeof parsed.host !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      started_at: parsed.started_at,
      host: parsed.host,
      ...(typeof parsed.nonce === "string" && parsed.nonce.length > 0 ? { nonce: parsed.nonce } : {}),
    };
  } catch {
    return null;
  }
}

export async function verifyCursorLockOwnership(lockPath: string, expected: OwnedCursorLockRecord): Promise<boolean> {
  const current = await readCursorLock(lockPath);
  return current?.pid === expected.pid &&
    current.started_at === expected.started_at &&
    current.host === expected.host &&
    current.nonce === expected.nonce;
}

function isStaleCursorLock(lock: CursorLockRecord): boolean {
  if (!isPidAlive(lock.pid)) return true;
  if (lock.pid === process.pid) return false;
  const startedAt = Date.parse(lock.started_at);
  return Number.isFinite(startedAt) && (Date.now() - startedAt) > LOCK_STALE_MS;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function applyPersistOp(bucket: Map<string, CursorRecord>, op: PersistOp): void {
  if (op.type === "delete") {
    bucket.delete(op.name);
    return;
  }
  bucket.set(op.cursor.name, cloneCursorRecord(op.cursor));
}

function clonePersistOp(op: PersistOp): PersistOp {
  if (op.type === "delete") return { type: "delete", name: op.name };
  return { type: "upsert", cursor: cloneCursorRecord(op.cursor) };
}

function persistKey(op: PersistOp): string {
  return op.type === "delete" ? op.name : op.cursor.name;
}

function validateCursorName(name: string): void {
  if (!CURSOR_NAME_RE.test(name)) {
    throw invalidParams("cursor name must match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/");
  }
}

function sorted(bucket: Map<string, CursorRecord>): CursorRecord[] {
  return Array.from(bucket.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function cloneCursor(cursor: CursorRecord | null): CursorRecord | null {
  if (!cursor) return null;
  return cloneCursorRecord(cursor);
}

function cloneCursorRecord(cursor: CursorRecord): CursorRecord {
  return {
    name: cursor.name,
    event_id: cursor.event_id,
    updated_at: cursor.updated_at,
    auto_update: cursor.auto_update,
  };
}

async function tryCreateCursorLock(lockPath: string): Promise<CursorLockLease | null> {
  const handle = await fs.promises.open(lockPath, "wx");
  const record = makeCursorLockRecord();
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
    if (!await verifyCursorLockOwnership(lockPath, record)) {
      await handle.close().catch(() => undefined);
      return null;
    }
    return {
      lockPath,
      record,
      release: async () => {
        const owned = await verifyCursorLockOwnership(lockPath, record);
        await handle.close().catch(() => undefined);
        if (owned) {
          await fs.promises.unlink(lockPath).catch(() => undefined);
        }
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function isPersistedCursor(value: unknown): value is CursorRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Partial<CursorRecord>;
  return typeof cursor.name === "string" &&
    (typeof cursor.event_id === "string" || cursor.event_id === null || cursor.event_id === undefined) &&
    typeof cursor.updated_at === "string" &&
    typeof cursor.auto_update === "boolean";
}
