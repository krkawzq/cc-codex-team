import fs from "node:fs";
import path from "node:path";

import { invalidParams } from "../errors";
import { logger } from "../logger";
import { userDir } from "../paths";

const CURSOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCHEMA_VERSION = 1;

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
    await this.enqueuePersist(user);
    return cloneCursor(cursor)!;
  }

  async delete(user: string, name: string): Promise<boolean> {
    validateCursorName(name);
    const bucket = this.bucket(user);
    const deleted = bucket.delete(name);
    if (!deleted) return false;
    await this.enqueuePersist(user);
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
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as CursorEnvelope;
        if (typeof parsed.schema_version === "number" && parsed.schema_version > SCHEMA_VERSION) {
          throw new Error(`cursors.json schema_version ${parsed.schema_version} is newer than supported ${SCHEMA_VERSION}`);
        }
        for (const cursor of parsed.cursors ?? []) {
          if (!isPersistedCursor(cursor)) continue;
          bucket.set(cursor.name, cloneCursor(cursor)!);
        }
      } catch (error) {
        throw new Error(`failed to load cursors.json for '${user}': ${(error as Error).message}`);
      }
    }
    this.users.set(user, bucket);
    this.loaded.add(user);
  }

  private async enqueuePersist(user: string): Promise<void> {
    const previous = this.writeChains.get(user) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.persistAsync(user))
      .catch((error) => {
        logger.warn("failed to persist cursors.json", { user, err: (error as Error).message });
      });
    this.writeChains.set(user, next);
    await next;
  }

  private async persistAsync(user: string): Promise<void> {
    const dir = userDir(user, this.dataDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = cursorFilePath(user, this.dataDir);
    const payload = {
      schema_version: SCHEMA_VERSION,
      cursors: sorted(this.bucket(user)),
    };
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2));
    await fs.promises.rename(tmpPath, filePath);
  }
}

function cursorFilePath(user: string, dataDir: string): string {
  return path.join(userDir(user, dataDir), "cursors.json");
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
