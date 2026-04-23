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
}

type PersistOp =
  | { type: "upsert"; cursor: CursorRecord }
  | { type: "delete"; name: string };

export class CursorStore {
  private readonly dataDir: string;
  private readonly users = new Map<string, Map<string, CursorRecord>>();
  private readonly loaded = new Set<string>();
  private readonly writeChains = new Map<string, Promise<void>>();

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
    try {
      await this.enqueuePersist(user, { type: "upsert", cursor: cloneCursorRecord(cursor) });
    } catch (error) {
      logger.warn("failed to persist cursors.json", { user, err: (error as Error).message });
    }
    return cloneCursor(cursor)!;
  }

  async delete(user: string, name: string): Promise<boolean> {
    validateCursorName(name);
    const bucket = this.bucket(user);
    const existing = bucket.get(name);
    const deleted = bucket.delete(name);
    if (!deleted) return false;
    try {
      await this.enqueuePersist(user, { type: "delete", name });
    } catch (error) {
      if (existing) bucket.set(name, existing);
      throw error;
    }
    return true;
  }

  async clearUser(user: string): Promise<void> {
    await (this.writeChains.get(user)?.catch(() => undefined) ?? Promise.resolve());
    this.writeChains.delete(user);
    this.users.delete(user);
    this.loaded.delete(user);
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

  private enqueuePersist(user: string, op: PersistOp): Promise<void> {
    const previous = this.writeChains.get(user) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.persistAsync(user, op));
    this.writeChains.set(user, next);
    return next;
  }

  private async persistAsync(user: string, op: PersistOp): Promise<void> {
    const dir = userDir(user, this.dataDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = cursorFilePath(user, this.dataDir);
    const releaseLock = await acquireCursorLock(filePath);
    const tmpPath = makeTempPath(filePath);
    try {
      const persisted = await loadEnvelopeFromFile(filePath);
      applyPersistOp(persisted, op);
      const payload = {
        schema_version: SCHEMA_VERSION,
        cursors: sorted(persisted),
      };
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2));
      await fs.promises.rename(tmpPath, filePath);
    } finally {
      await fs.promises.unlink(tmpPath).catch(() => undefined);
      await releaseLock();
    }
  }
}

function cursorFilePath(user: string, dataDir: string): string {
  return path.join(userDir(user, dataDir), "cursors.json");
}

async function acquireCursorLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(makeCursorLockRecord()));
      } finally {
        await handle.close();
      }
      return async () => {
        await fs.promises.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw error;
      if (await reclaimStaleCursorLock(lockPath)) {
        return async () => {
          await fs.promises.unlink(lockPath).catch(() => undefined);
        };
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for cursor lock '${lockPath}'`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function reclaimStaleCursorLock(lockPath: string): Promise<boolean> {
  const lock = await readCursorLock(lockPath);
  if (!lock || !isStaleCursorLock(lock)) return false;

  const tmpPath = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(makeCursorLockRecord()));
  try {
    await fs.promises.rename(tmpPath, lockPath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST" || err.code === "EPERM") {
      await fs.promises.unlink(lockPath).catch(() => undefined);
      await fs.promises.rename(tmpPath, lockPath);
      return true;
    }
    return false;
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
  }
}

function makeTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
}

function makeCursorLockRecord(): CursorLockRecord {
  return {
    pid: process.pid,
    started_at: new Date().toISOString(),
    host: os.hostname(),
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

async function readCursorLock(lockPath: string): Promise<CursorLockRecord | null> {
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
    };
  } catch {
    return null;
  }
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

function isPersistedCursor(value: unknown): value is CursorRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Partial<CursorRecord>;
  return typeof cursor.name === "string" &&
    (typeof cursor.event_id === "string" || cursor.event_id === null || cursor.event_id === undefined) &&
    typeof cursor.updated_at === "string" &&
    typeof cursor.auto_update === "boolean";
}
