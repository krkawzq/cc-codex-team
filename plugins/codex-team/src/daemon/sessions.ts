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

export class SessionRegistry {
  private readonly dataDir: string;
  private readonly users = new Map<string, UserBucket>();
  private readonly globalByThreadId = new Map<string, string>();
  private readonly touchTimers = new Map<string, NodeJS.Timeout>();
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
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

  listLive(user: string): SessionRecord[] {
    this.loadForUser(user);
    return Array.from(this.users.get(user)!.byName.values());
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
      if (rec) return { user: ownerByThread, record: rec };
    }
    return null;
  }

  findUniqueLiveByNameAnywhere(name: string): SessionLocator | "ambiguous" | null {
    let match: SessionLocator | null = null;
    for (const [user, bucket] of this.users) {
      const rec = bucket.byName.get(name);
      if (!rec) continue;
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
    this.schedulePersist(user, 0);
  }

  update(user: string, name: string, patch: Partial<SessionRecord>): SessionRecord {
    this.loadForUser(user);
    const b = this.users.get(user)!;
    const rec = b.byName.get(name);
    if (!rec) throw new CodexTeamError("session_not_found", `session '${name}' not found`);

    if (patch.name && patch.name !== rec.name) {
      if (!NAME_RE.test(patch.name)) throw invalidParams(`invalid session name: ${patch.name}`);
      if (patch.name.startsWith("th-")) throw invalidParams("session name cannot start with 'th-'");
      if (b.byName.has(patch.name)) throw invalidParams(`session '${patch.name}' already exists`);
      b.byName.delete(rec.name);
      rec.name = patch.name;
      b.byName.set(rec.name, rec);
    }
    if (patch.last_active_at !== undefined) rec.last_active_at = patch.last_active_at;
    if (patch.turn_count !== undefined) rec.turn_count = patch.turn_count;
    if (patch.state !== undefined) rec.state = patch.state;
    if (patch.recovery_state !== undefined) rec.recovery_state = patch.recovery_state ?? undefined;
    if (patch.model !== undefined) rec.model = patch.model;
    if (patch.cwd !== undefined) rec.cwd = patch.cwd;
    if (patch.sandbox !== undefined) rec.sandbox = patch.sandbox;
    if (patch.approval !== undefined) rec.approval = patch.approval;
    if (patch.effort !== undefined) rec.effort = patch.effort;
    if (patch.profile !== undefined) rec.profile = patch.profile;
    if (patch.experimental_tools !== undefined) {
      rec.experimental_tools = patch.experimental_tools.length > 0 ? [...patch.experimental_tools] : undefined;
    }
    if (patch.last_turn_id !== undefined) rec.last_turn_id = patch.last_turn_id;
    if (patch.current_turn_id !== undefined) rec.current_turn_id = patch.current_turn_id;
    if (patch.current_turn_started_at !== undefined) rec.current_turn_started_at = patch.current_turn_started_at;
    if (patch.current_item_type !== undefined) rec.current_item_type = patch.current_item_type;
    if (patch.items_in_turn !== undefined) rec.items_in_turn = patch.items_in_turn;
    if (patch.pending_approvals !== undefined) rec.pending_approvals = patch.pending_approvals;
    if (patch.pending_user_inputs !== undefined) rec.pending_user_inputs = patch.pending_user_inputs;
    if (patch.token_usage_last_turn !== undefined) rec.token_usage_last_turn = patch.token_usage_last_turn;
    if (patch.crash_reason !== undefined) rec.crash_reason = patch.crash_reason;
    if (patch.autoApprovePatterns !== undefined) rec.autoApprovePatterns = normalizeAutoApprovePatterns(patch.autoApprovePatterns);

    this.schedulePersist(user, 0);
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
    this.schedulePersist(user, 0);
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
    this.schedulePersist(user, 250);
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
      sessions: bucket ? Array.from(bucket.byName.values()) : [],
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
    last_turn_id: normalizeOptionalString(rec.last_turn_id) ?? runtimeDefaults.last_turn_id,
    current_turn_id: normalizeOptionalString(rec.current_turn_id) ?? runtimeDefaults.current_turn_id,
    current_turn_started_at:
      normalizeOptionalString(rec.current_turn_started_at) ?? runtimeDefaults.current_turn_started_at,
    current_item_type: normalizeOptionalString(rec.current_item_type) ?? runtimeDefaults.current_item_type,
    items_in_turn: normalizeOptionalNumber(rec.items_in_turn) ?? runtimeDefaults.items_in_turn,
    pending_approvals: normalizeOptionalNumber(rec.pending_approvals) ?? runtimeDefaults.pending_approvals,
    pending_user_inputs: normalizeOptionalNumber(rec.pending_user_inputs) ?? runtimeDefaults.pending_user_inputs,
    token_usage_last_turn: normalizeTokenUsage(rec.token_usage_last_turn) ?? runtimeDefaults.token_usage_last_turn,
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

void path;
