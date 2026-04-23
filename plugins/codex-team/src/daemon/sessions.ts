import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CodexTeamError, invalidParams } from "../errors";
import { userDir, userSessionsPath } from "../paths";
import { logger } from "../logger";
import { validateParsedAutoApprovePatterns } from "./auto-approve";

const NAME_RE = /^[A-Za-z0-9_\-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA_VERSION = 1;
const DEFAULT_PERSIST_DEBOUNCE_MS = 50;
const VOLATILE_SESSION_FIELDS = new Set<keyof SessionRecord>([
  "last_turn_id",
  "current_turn_id",
  "current_turn_started_at",
  "current_item_type",
  "items_in_turn",
  "pending_approvals",
  "pending_user_inputs",
  "token_usage_last_turn",
]);

export interface TokenUsageSummary {
  prompt: number;
  completion: number;
  total: number;
}

export interface SessionRecord {
  name: string;
  thread_id: string;
  state: "live" | "crashed";
  recovery_state?: "degraded" | null;
  model?: string;
  cwd?: string;
  sandbox?: string;
  approval?: string;
  effort?: string;
  profile?: string;
  base_instructions?: string;
  developer_instructions?: string;
  experimental_tools?: string[];
  autoApprovePatterns: string[];
  created_at: string;
  last_active_at: string;
  turn_count: number;
  last_turn_id?: string | null;
  current_turn_id?: string | null;
  current_turn_started_at?: string | null;
  current_item_type?: string | null;
  items_in_turn?: number;
  pending_approvals?: number;
  pending_user_inputs?: number;
  token_usage_last_turn?: TokenUsageSummary | null;
  crash_reason?: string | null;
}

interface UserBucket {
  byName: Map<string, SessionRecord>;
  byThreadId: Map<string, SessionRecord>;
}

export interface SessionLocator {
  user: string;
  record: SessionRecord;
}

interface SessionRegistryOptions {
  persistDebounceMs?: number | (() => number);
}

export class SessionRegistry {
  private readonly dataDir: string;
  private readonly resolvePersistDebounceMs: () => number;
  private readonly users = new Map<string, UserBucket>();
  private readonly globalByThreadId = new Map<string, string>();
  private readonly touchTimers = new Map<string, NodeJS.Timeout>();
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(dataDir: string, opts: SessionRegistryOptions = {}) {
    this.dataDir = dataDir;
    const configured = opts.persistDebounceMs;
    if (typeof configured === "function") {
      this.resolvePersistDebounceMs = () => clampPersistDebounceMs(configured());
    } else if (typeof configured === "number") {
      const value = clampPersistDebounceMs(configured);
      this.resolvePersistDebounceMs = () => value;
    } else {
      this.resolvePersistDebounceMs = () => DEFAULT_PERSIST_DEBOUNCE_MS;
    }
  }

  loadForUser(user: string): void {
    if (this.users.has(user)) return;
    const bucket = this.emptyBucket();
    const p = userSessionsPath(user, this.dataDir);
    if (!fs.existsSync(p)) {
      this.users.set(user, bucket);
      return;
    }
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { schema_version?: number; sessions?: SessionRecord[] };
      if (typeof parsed.schema_version === "number" && parsed.schema_version > SCHEMA_VERSION) {
        throw new Error(`sessions.json schema_version ${parsed.schema_version} is newer than supported ${SCHEMA_VERSION}`);
      }
      for (const rawRec of parsed.sessions ?? []) {
        const rec = normalizeLoadedRecord(rawRec);
        if (!rec) continue;
        bucket.byName.set(rec.name, rec);
        bucket.byThreadId.set(rec.thread_id, rec);
        this.globalByThreadId.set(rec.thread_id, user);
      }
      this.users.set(user, bucket);
    } catch (e) {
      throw new Error(`failed to load sessions.json for '${user}': ${(e as Error).message}`);
    }
  }

  loadAllUsers(userTokens: Iterable<string>): void {
    for (const u of userTokens) this.loadForUser(u);
  }

  listAll(user: string): SessionRecord[] {
    this.loadForUser(user);
    return Array.from(this.users.get(user)!.byName.values());
  }

  listLive(user: string): SessionRecord[] {
    return this.listAll(user).filter((record) => record.state === "live");
  }

  get(user: string, identifier: string): SessionRecord | null {
    this.loadForUser(user);
    const b = this.users.get(user)!;
    const byName = b.byName.get(identifier);
    if (byName) return byName;
    const byId = b.byThreadId.get(identifier);
    if (byId) return byId;
    return null;
  }

  findLiveAnywhere(identifier: string): SessionLocator | null {
    const ownerByThread = this.globalByThreadId.get(identifier);
    if (ownerByThread) {
      const rec = this.users.get(ownerByThread)?.byThreadId.get(identifier);
      if (rec?.state === "live") return { user: ownerByThread, record: rec };
    }
    return null;
  }

  findUniqueLiveByNameAnywhere(name: string): SessionLocator | "ambiguous" | null {
    let match: SessionLocator | null = null;
    for (const [user, bucket] of this.users) {
      const rec = bucket.byName.get(name);
      if (!rec || rec.state !== "live") continue;
      if (match) return "ambiguous";
      match = { user, record: rec };
    }
    return match;
  }

  add(user: string, record: SessionRecord): void {
    validateRecord(record);
    this.loadForUser(user);
    const b = this.users.get(user)!;
    if (b.byName.has(record.name)) {
      throw new CodexTeamError("invalid_params", `session '${record.name}' already exists`);
    }
    if (b.byThreadId.has(record.thread_id)) {
      throw new CodexTeamError("invalid_params", `thread_id '${record.thread_id}' already registered`);
    }
    const existingGlobal = this.globalByThreadId.get(record.thread_id);
    if (existingGlobal && existingGlobal !== user) {
      throw new CodexTeamError("session_busy", `thread '${record.thread_id}' is live under another user`);
    }
    b.byName.set(record.name, record);
    b.byThreadId.set(record.thread_id, record);
    this.globalByThreadId.set(record.thread_id, user);
    this.schedulePersist(user, this.persistDebounceMs());
  }

  update(user: string, name: string, patch: Partial<SessionRecord>): SessionRecord {
    this.loadForUser(user);
    const b = this.users.get(user)!;
    const rec = b.byName.get(name);
    if (!rec) throw new CodexTeamError("session_not_found", `session '${name}' not found`);

    let persistNeeded = false;

    if (patch.name && patch.name !== rec.name) {
      if (!NAME_RE.test(patch.name)) throw invalidParams(`invalid session name: ${patch.name}`);
      if (patch.name.startsWith("th-")) throw invalidParams("session name cannot start with 'th-'");
      if (b.byName.has(patch.name)) throw invalidParams(`session '${patch.name}' already exists`);
      b.byName.delete(rec.name);
      rec.name = patch.name;
      b.byName.set(rec.name, rec);
      persistNeeded = true;
    }
    persistNeeded = applySessionFieldUpdate(rec, "last_active_at", patch.last_active_at) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "turn_count", patch.turn_count) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "state", patch.state) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "recovery_state", patch.recovery_state ?? undefined, patch.recovery_state !== undefined) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "model", patch.model) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "cwd", patch.cwd) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "sandbox", patch.sandbox) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "approval", patch.approval) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "effort", patch.effort) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "profile", patch.profile) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "base_instructions", patch.base_instructions) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "developer_instructions", patch.developer_instructions) || persistNeeded;
    if (patch.experimental_tools !== undefined) {
      const normalized = patch.experimental_tools.length > 0 ? [...patch.experimental_tools] : undefined;
      persistNeeded = applySessionFieldUpdate(rec, "experimental_tools", normalized, true) || persistNeeded;
    }
    applySessionFieldUpdate(rec, "last_turn_id", patch.last_turn_id);
    applySessionFieldUpdate(rec, "current_turn_id", patch.current_turn_id);
    applySessionFieldUpdate(rec, "current_turn_started_at", patch.current_turn_started_at);
    applySessionFieldUpdate(rec, "current_item_type", patch.current_item_type);
    applySessionFieldUpdate(rec, "items_in_turn", patch.items_in_turn);
    applySessionFieldUpdate(rec, "pending_approvals", patch.pending_approvals);
    applySessionFieldUpdate(rec, "pending_user_inputs", patch.pending_user_inputs);
    applySessionFieldUpdate(rec, "token_usage_last_turn", patch.token_usage_last_turn);
    persistNeeded = applySessionFieldUpdate(rec, "crash_reason", patch.crash_reason) || persistNeeded;
    if (patch.autoApprovePatterns !== undefined) {
      const normalized = normalizeAutoApprovePatterns(patch.autoApprovePatterns);
      persistNeeded = applySessionFieldUpdate(rec, "autoApprovePatterns", normalized) || persistNeeded;
    }

    if (persistNeeded) {
      this.schedulePersist(user, this.persistDebounceMs());
    }
    return rec;
  }

  remove(user: string, name: string): SessionRecord | null {
    this.loadForUser(user);
    const b = this.users.get(user)!;
    const rec = b.byName.get(name);
    if (!rec) return null;
    b.byName.delete(rec.name);
    b.byThreadId.delete(rec.thread_id);
    this.globalByThreadId.delete(rec.thread_id);
    this.schedulePersist(user, this.persistDebounceMs());
    return rec;
  }

  removeAllForUser(user: string): SessionRecord[] {
    this.loadForUser(user);
    const bucket = this.users.get(user);
    if (!bucket) return [];
    const removed = Array.from(bucket.byName.values());
    for (const rec of removed) {
      this.globalByThreadId.delete(rec.thread_id);
    }
    this.users.delete(user);
    return removed;
  }

  async clearUser(user: string): Promise<SessionRecord[]> {
    const timer = this.touchTimers.get(user);
    if (timer) {
      clearTimeout(timer);
      this.touchTimers.delete(user);
    }
    await (this.writeChains.get(user)?.catch(() => undefined) ?? Promise.resolve());
    this.writeChains.delete(user);
    return this.removeAllForUser(user);
  }

  touch(user: string, name: string): void {
    this.loadForUser(user);
    const b = this.users.get(user)!;
    const rec = b.byName.get(name);
    if (!rec) return;
    rec.last_active_at = new Date().toISOString();
    this.schedulePersist(user, this.persistDebounceMs());
  }

  async flush(): Promise<void> {
    for (const [user, timer] of this.touchTimers) {
      clearTimeout(timer);
      this.touchTimers.delete(user);
      this.enqueuePersist(user);
    }
    await Promise.all(Array.from(this.writeChains.values()).map((p) => p.catch(() => undefined)));
  }

  private async persistAsync(user: string): Promise<void> {
    const dir = userDir(user, this.dataDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const p = userSessionsPath(user, this.dataDir);
    const bucket = this.users.get(user);
    const payload = {
      schema_version: SCHEMA_VERSION,
      sessions: bucket ? Array.from(bucket.byName.values()).map((record) => toPersistedRecord(record)) : [],
    };
    const tmp = p + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.promises.rename(tmp, p);
  }

  private schedulePersist(user: string, delayMs: number): void {
    const existing = this.touchTimers.get(user);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.touchTimers.delete(user);
      this.enqueuePersist(user);
    }, delayMs);
    timer.unref();
    this.touchTimers.set(user, timer);
  }

  private enqueuePersist(user: string): void {
    const prev = this.writeChains.get(user) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.persistAsync(user))
      .catch((e) => {
        logger.warn("failed to persist sessions.json", { user, err: (e as Error).message });
      });
    this.writeChains.set(user, next);
  }

  private emptyBucket(): UserBucket {
    return { byName: new Map(), byThreadId: new Map() };
  }

  private persistDebounceMs(): number {
    return this.resolvePersistDebounceMs();
  }
}

export function validateSessionName(name: string): void {
  if (!NAME_RE.test(name)) throw invalidParams(`invalid session name: ${name}`);
  if (UUID_RE.test(name)) throw invalidParams("session name must not be a UUID (reserved for thread_id)");
  if (name.startsWith("th-")) throw invalidParams("session name cannot start with 'th-' (reserved)");
}

function validateRecord(record: SessionRecord): void {
  validateSessionName(record.name);
  if (!record.thread_id) throw invalidParams("thread_id is required");
  if (record.state !== "live" && record.state !== "crashed") {
    throw invalidParams(`invalid session state: ${record.state}`);
  }
  record.autoApprovePatterns = normalizeAutoApprovePatterns(record.autoApprovePatterns);
}

export function generateSessionName(): string {
  return "s-" + crypto.randomBytes(4).toString("hex");
}

export function looksLikeThreadId(s: string): boolean {
  return UUID_RE.test(s) || s.startsWith("th-");
}

export function sessionRuntimeDefaults(): Pick<
  SessionRecord,
  | "last_turn_id"
  | "current_turn_id"
  | "current_turn_started_at"
  | "current_item_type"
  | "items_in_turn"
  | "pending_approvals"
  | "pending_user_inputs"
  | "token_usage_last_turn"
  | "crash_reason"
> {
  return {
    last_turn_id: null,
    current_turn_id: null,
    current_turn_started_at: null,
    current_item_type: null,
    items_in_turn: 0,
    pending_approvals: 0,
    pending_user_inputs: 0,
    token_usage_last_turn: null,
    crash_reason: null,
  };
}

export function normalizeTokenUsage(value: unknown): TokenUsageSummary | null {
  const usage = asObject(value);
  const prompt = asNumber(
    usage.prompt ?? usage.prompt_tokens ?? usage.promptTokens ?? usage.input ?? usage.input_tokens ?? usage.inputTokens,
  );
  const completion = asNumber(
    usage.completion
      ?? usage.completion_tokens
      ?? usage.completionTokens
      ?? usage.output
      ?? usage.output_tokens
      ?? usage.outputTokens,
  );
  const total = asNumber(usage.total ?? usage.total_tokens ?? usage.totalTokens);

  if (prompt === null && completion === null && total === null) return null;

  return {
    prompt: prompt ?? 0,
    completion: completion ?? 0,
    total: total ?? (prompt ?? 0) + (completion ?? 0),
  };
}

export function isoFromUnixSeconds(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return new Date(value * 1000).toISOString();
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeAutoApprovePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((pattern): pattern is string => typeof pattern === "string");
}

function normalizeLoadedRecord(value: unknown): SessionRecord | null {
  const rec = asObject(value);
  const name = typeof rec.name === "string" ? rec.name : null;
  const threadId = typeof rec.thread_id === "string" && rec.thread_id.length > 0 ? rec.thread_id : null;
  if (!name || !threadId) return null;

  const now = new Date().toISOString();
  const createdAt = normalizeOptionalString(rec.created_at) ?? normalizeOptionalString(rec.last_active_at) ?? now;
  const lastActiveAt = normalizeOptionalString(rec.last_active_at) ?? createdAt;
  const runtimeDefaults = sessionRuntimeDefaults();

  return {
    name,
    thread_id: threadId,
    state: rec.state === "crashed" ? "crashed" : "live",
    ...(rec.recovery_state === "degraded" ? { recovery_state: "degraded" as const } : {}),
    ...(normalizeOptionalString(rec.model) ? { model: normalizeOptionalString(rec.model)! } : {}),
    ...(normalizeOptionalString(rec.cwd) ? { cwd: normalizeOptionalString(rec.cwd)! } : {}),
    ...(normalizeOptionalString(rec.sandbox) ? { sandbox: normalizeOptionalString(rec.sandbox)! } : {}),
    ...(normalizeOptionalString(rec.approval) ? { approval: normalizeOptionalString(rec.approval)! } : {}),
    ...(normalizeOptionalString(rec.effort) ? { effort: normalizeOptionalString(rec.effort)! } : {}),
    ...(normalizeOptionalString(rec.profile) ? { profile: normalizeOptionalString(rec.profile)! } : {}),
    ...(normalizeOptionalString(rec.base_instructions)
      ? { base_instructions: normalizeOptionalString(rec.base_instructions)! }
      : {}),
    ...(normalizeOptionalString(rec.developer_instructions)
      ? { developer_instructions: normalizeOptionalString(rec.developer_instructions)! }
      : {}),
    ...(normalizeStringArray(rec.experimental_tools).length > 0
      ? { experimental_tools: normalizeStringArray(rec.experimental_tools) }
      : {}),
    autoApprovePatterns: normalizeLoadedAutoApprovePatterns(name, rec.autoApprovePatterns),
    created_at: createdAt,
    last_active_at: lastActiveAt,
    turn_count: normalizeOptionalNumber(rec.turn_count) ?? 0,
    last_turn_id: runtimeDefaults.last_turn_id,
    current_turn_id: runtimeDefaults.current_turn_id,
    current_turn_started_at: runtimeDefaults.current_turn_started_at,
    current_item_type: runtimeDefaults.current_item_type,
    items_in_turn: runtimeDefaults.items_in_turn,
    pending_approvals: runtimeDefaults.pending_approvals,
    pending_user_inputs: runtimeDefaults.pending_user_inputs,
    token_usage_last_turn: runtimeDefaults.token_usage_last_turn,
    crash_reason: normalizeOptionalString(rec.crash_reason) ?? runtimeDefaults.crash_reason,
  };
}

function normalizeLoadedAutoApprovePatterns(sessionName: string, value: unknown): string[] {
  const patterns = normalizeAutoApprovePatterns(value);
  const validPatterns: string[] = [];
  for (const pattern of patterns) {
    const validationError = validateParsedAutoApprovePatterns([pattern]);
    if (validationError) {
      logger.warn("dropping invalid persisted auto-approve pattern", {
        session: sessionName,
        pattern,
        err: validationError,
      });
      continue;
    }
    validPatterns.push(pattern);
  }
  return validPatterns;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function applySessionFieldUpdate<K extends keyof SessionRecord>(
  record: SessionRecord,
  key: K,
  nextValue: SessionRecord[K] | undefined,
  present = nextValue !== undefined,
): boolean {
  if (!present) return false;
  if (sessionFieldEquals(record[key], nextValue)) return false;
  record[key] = cloneSessionField(nextValue as SessionRecord[K]);
  return !VOLATILE_SESSION_FIELDS.has(key);
}

function cloneSessionField<K extends keyof SessionRecord>(value: SessionRecord[K]): SessionRecord[K] {
  if (Array.isArray(value)) {
    return [...value] as SessionRecord[K];
  }
  if (value && typeof value === "object") {
    return { ...value } as SessionRecord[K];
  }
  return value;
}

function sessionFieldEquals(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return arrayEquals(
      Array.isArray(left) ? left : [],
      Array.isArray(right) ? right : [],
    );
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!sessionFieldEquals(left[key], right[key])) return false;
    }
    return true;
  }
  return left === right;
}

function arrayEquals(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!sessionFieldEquals(left[i], right[i])) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPersistedRecord(record: SessionRecord): Record<string, unknown> {
  const persisted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (VOLATILE_SESSION_FIELDS.has(key as keyof SessionRecord)) continue;
    persisted[key] = clonePersistedValue(value);
  }
  return persisted;
}

function clonePersistedValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (isPlainObject(value)) return { ...value };
  return value;
}

function clampPersistDebounceMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PERSIST_DEBOUNCE_MS;
  return Math.max(0, Math.floor(value));
}

void path;
