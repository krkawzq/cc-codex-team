import fs from "node:fs";

import type { HandlerFn } from "../dispatch";
import type { DaemonContext } from "../context";
import type { IpcRequest } from "../../ipc/protocol";
import type { JsonValue } from "../../codex/errors";
import { CodexTeamError, invalidParams } from "../../errors";
import {
  SessionRecord,
  generateSessionName,
  looksLikeThreadId,
  sessionRuntimeDefaults,
  validateSessionName,
} from "../sessions";
import {
  threadFork,
  threadIdOf,
  threadList,
  threadRead,
  threadResume,
  threadSetName,
  threadStart,
  threadUnsubscribe,
  turnInterrupt,
} from "../../codex/rpc";
import {
  buildExperimentalToolAppServerOptions,
  buildExperimentalToolThreadConfig,
  parseExperimentalTools,
} from "../experimentalTools";
import { parseAutoApprovePatterns, parseConfiguredAutoApprovePatterns } from "../auto-approve";
import { SESSION_CLOSED_EVENT_TYPE } from "../events";
import { renderContext } from "../../format/markdown";
import { renderTable } from "../../format/table";

const attachLocks = new Map<string, Promise<void>>();

export const sessionNew: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const positionals = asPositionals(req);
  const flags = asFlags(req);

  const provided = positionals[0];
  if (provided) validateSessionName(provided);
  let name = provided ?? generateSessionName();
  // avoid collision if auto-generated
  if (!provided) {
    while (ctx.sessions.get(user, name)) name = generateSessionName();
  } else if (ctx.sessions.get(user, name)) {
    throw invalidParams(`session '${name}' already exists`);
  }

  const experimentalTools = resolveExperimentalToolsForCreate(ctx, flags);
  const autoApprovePatterns = resolveAutoApprovePatternsForCreate(ctx, flags);
  const startParams = await buildThreadStartParams(ctx, flags, experimentalTools);

  const client = await ctx.pool.acquire(user, keyFor(user, name), buildExperimentalToolAppServerOptions(experimentalTools));
  let result;
  try {
    result = await threadStart(client, startParams, ctx.retryOptions());
  } catch (e) {
    ctx.pool.release(keyFor(user, name));
    throw e;
  }
  const threadId = threadIdOf(result);

  // Tell codex the name (best effort, non-fatal)
  try { await threadSetName(client, threadId, name, ctx.retryOptions()); } catch { /* ignore */ }

  const now = new Date().toISOString();
  const record: SessionRecord = {
    name,
    thread_id: threadId,
    state: "live",
    model: asString(flags["model"]) ?? resolveDefault(ctx, "codex.default_model") ?? undefined,
    cwd: asString(flags["cwd"]) ?? process.cwd(),
    sandbox: asString(flags["sandbox"]) ?? resolveDefault(ctx, "codex.default_sandbox") ?? undefined,
    approval: asString(flags["approval"]) ?? resolveDefault(ctx, "codex.default_approval") ?? undefined,
    effort: asString(flags["effort"]) ?? resolveDefault(ctx, "codex.default_effort") ?? undefined,
    profile: asString(flags["profile"]) ?? undefined,
    base_instructions: asString(flags["base-instructions"]) ?? undefined,
    developer_instructions: asString(flags["developer-instructions"]) ?? undefined,
    experimental_tools: experimentalTools.length > 0 ? experimentalTools : undefined,
    autoApprovePatterns,
    created_at: now,
    last_active_at: now,
    turn_count: 0,
    ...sessionRuntimeDefaults(),
  };
  ctx.sessions.add(user, record);
  ctx.users.touch(user);
  return { session: record };
};

export const sessionAttach: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const takeover = isTrue(flags["takeover"]);

  const lockThreadId = resolveAttachLockThreadId(ctx, identifier);
  const attach = async () => {
    const existing = ctx.sessions.get(user, identifier);
    if (existing) {
      ctx.sessions.touch(user, existing.name);
      return { session: existing, noop: true };
    }

    const anywhere = looksLikeThreadId(identifier)
      ? ctx.sessions.findLiveAnywhere(identifier)
      : ctx.sessions.findUniqueLiveByNameAnywhere(identifier);
    if (anywhere === "ambiguous") {
      throw invalidParams(`session name '${identifier}' is ambiguous across users; use a thread_id or attach within the owning user`);
    }
    if (anywhere && anywhere.user !== user) {
      if (!takeover) {
        throw new CodexTeamError("session_busy", `session is live under user '${anywhere.user}'. Pass --takeover to seize.`);
      }
      await seizeFromOtherUser(ctx, anywhere.user, user, anywhere.record);
    }

    const threadId = looksLikeThreadId(identifier) ? identifier : (anywhere?.record.thread_id ?? null);
    if (!threadId) {
      throw new CodexTeamError("session_not_found", `no session matches '${identifier}' in this user`);
    }
    ensureAttachOwnership(ctx, user, threadId);

    const name = anywhere?.record.name ?? deriveNameFromThreadId(threadId, ctx, user);
    const experimentalTools = resolveExperimentalToolsForAttach(ctx, flags, anywhere?.record.experimental_tools);
    const sessionKey = keyFor(user, name);
    const client = await ctx.pool.acquire(user, sessionKey, buildExperimentalToolAppServerOptions(experimentalTools));
    let added = false;
    try {
      ensureAttachOwnership(ctx, user, threadId);
      await threadResume(client, threadId, ctx.retryOptions());
      ensureAttachOwnership(ctx, user, threadId);

      const now = new Date().toISOString();
      const record: SessionRecord = {
        name,
        thread_id: threadId,
        state: "live",
        autoApprovePatterns: anywhere?.record?.autoApprovePatterns ?? [],
        created_at: now,
        last_active_at: now,
        turn_count: 0,
        ...sessionRuntimeDefaults(),
        ...(anywhere?.record ? {
          model: anywhere.record.model,
          cwd: anywhere.record.cwd,
          sandbox: anywhere.record.sandbox,
          approval: anywhere.record.approval,
          effort: anywhere.record.effort,
          profile: anywhere.record.profile,
          experimental_tools: anywhere.record.experimental_tools,
        } : {}),
        ...(experimentalTools.length > 0 ? { experimental_tools: experimentalTools } : {}),
      };
      ctx.sessions.add(user, record);
      added = true;
      ctx.users.touch(user);
      return { session: record };
    } catch (e) {
      if (!added) ctx.pool.release(sessionKey);
      throw e;
    }
  };

  return lockThreadId ? await withAttachLock(lockThreadId, attach) : await attach();
};

export const sessionDetach: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const graceful = isTrue(flags["graceful"]);

  const rec = ctx.sessions.get(user, identifier);
  if (!rec) {
    return { session: null, noop: true };
  }

  const sessionKey = keyFor(user, rec.name);
  const teardown = await ctx.queues.beginTeardown(sessionKey);
  const client = ctx.pool.clientForSession(sessionKey);
  const turnId = teardown.currentTurnId;

  if (client && !graceful && turnId) {
    try { await turnInterrupt(client, rec.thread_id, turnId, ctx.retryOptions()); } catch { /* ignore if no turn */ }
  }

  if (graceful) {
    await ctx.queues.waitForIdle(sessionKey);
  }

  if (client) {
    try { await threadUnsubscribe(client, rec.thread_id, ctx.retryOptions()); } catch { /* ignore */ }
  }

  ctx.pool.release(sessionKey);
  ctx.queues.dispose(sessionKey);
  ctx.sessions.remove(user, rec.name);
  for (const p of ctx.pending.removeForSession(user, rec.name)) {
    try { p.client.respondError(p.jsonrpc_id, -32000, "session detached"); } catch { /* ignore */ }
  }
  await appendSessionClosed(ctx, user, rec, "user_detach");
  return { session: rec, noop: false, graceful };
};

export const sessionRename: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const newName = asPositional(req, 1, "new_name");
  validateSessionName(newName);

  const rec = ctx.sessions.get(user, identifier);
  if (!rec) throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);

  const oldName = rec.name;
  const client = ctx.pool.clientForSession(keyFor(user, oldName));
  if (client) {
    try { await threadSetName(client, rec.thread_id, newName, ctx.retryOptions()); } catch { /* best effort */ }
  }

  // Update registry; also need to rekey in the pool
  const updated = ctx.sessions.update(user, oldName, { name: newName });
  ctx.pool.rekeySession(keyFor(user, oldName), keyFor(user, newName));
  return { session: updated };
};

export const sessionFork: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const newNameRaw = asPositionalOptional(req, 1);
  const flags = asFlags(req);
  const atTurn = asString(flags["at-turn"]);

  const source = ctx.sessions.get(user, identifier);
  if (!source) throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);

  let newName = newNameRaw ?? generateSessionName();
  if (newNameRaw) validateSessionName(newNameRaw);
  while (ctx.sessions.get(user, newName)) newName = generateSessionName();

  const client = await ctx.pool.acquire(
    user,
    keyFor(user, newName),
    buildExperimentalToolAppServerOptions(source.experimental_tools ?? []),
  );
  let forkResult;
  try {
    forkResult = await threadFork(client, source.thread_id, atTurn ?? undefined, ctx.retryOptions());
  } catch (e) {
    ctx.pool.release(keyFor(user, newName));
    throw e;
  }
  const newThreadId = threadIdOf(forkResult);

  try { await threadSetName(client, newThreadId, newName, ctx.retryOptions()); } catch { /* ignore */ }

  const now = new Date().toISOString();
  const record: SessionRecord = {
    name: newName,
    thread_id: newThreadId,
    state: "live",
    model: source.model,
    cwd: source.cwd,
    sandbox: source.sandbox,
    approval: source.approval,
    effort: source.effort,
    profile: source.profile,
    experimental_tools: source.experimental_tools,
    autoApprovePatterns: source.autoApprovePatterns ?? [],
    created_at: now,
    last_active_at: now,
    turn_count: 0,
    ...sessionRuntimeDefaults(),
  };
  ctx.sessions.add(user, record);
  return { session: record, forked_from: source.name, at_turn: atTurn };
};

export const sessionInfo: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");

  const rec = ctx.sessions.get(user, identifier);
  if (rec) {
    return { session: rec };
  }

  // Not live here: try codex-side thread/read for metadata-only view
  try {
    const client = await ctx.pool.acquireForAdhoc(user);
    const result = await threadRead(client, identifier, ctx.retryOptions());
    return { session: null, thread: result.thread, live: false };
  } catch (e) {
    throw new CodexTeamError("session_not_found", `session '${identifier}' not found: ${(e as Error).message}`);
  }
};

export const sessionContext: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const format = asString(flags["format"]) ?? "json";
  if (format !== "json" && format !== "markdown") {
    throw invalidParams(`--format must be 'json' or 'markdown'`);
  }

  const rec = ctx.sessions.get(user, identifier);
  let threadId: string;
  let client;
  if (rec) {
    threadId = rec.thread_id;
    client = ctx.pool.clientForSession(keyFor(user, rec.name));
    if (!client) client = await ctx.pool.acquireForAdhoc(user);
  } else {
    if (!looksLikeThreadId(identifier)) {
      throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);
    }
    threadId = identifier;
    client = await ctx.pool.acquireForAdhoc(user);
  }

  const result = await threadRead(client, threadId, ctx.retryOptions());
  if (format === "json") {
    return { thread_id: threadId, thread: result.thread };
  }
  const markdown = renderContext({
    session: rec?.name ?? null,
    thread_id: threadId,
    thread: result.thread,
  });
  return {
    thread_id: threadId,
    format: "markdown",
    markdown,
    thread: result.thread,
  };
};

export const sessionList: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const flags = asFlags(req);
  const all = isTrue(flags["all"]);
  const sortField = asString(flags["sort"]) ?? "last_active";
  const format = asString(flags["format"]) ?? "json";
  if (format !== "json" && format !== "table") {
    throw invalidParams(`--format must be 'json' or 'table'`);
  }

  if (!all) {
    const live = ctx.sessions.listLive(user);
    const sorted = sortSessions(live, sortField);
    const response: Record<string, unknown> = { sessions: sorted, all: false, sort: sortField, format };
    if (format === "table") {
      response.table = renderTable(
        sorted as unknown as Array<Record<string, unknown>>,
        ["name", "thread_id", "state", "model", "turn_count", "last_active_at"],
      );
    }
    return response;
  }

  const client = await ctx.pool.acquireForAdhoc(user);
  const result = await threadList(client, {}, ctx.retryOptions());
  const response: Record<string, unknown> = {
    sessions: result.data,
    next_cursor: result.nextCursor,
    all: true,
    sort: sortField,
    format,
  };
  if (format === "table") {
    response.table = renderTable(
      result.data as unknown as Array<Record<string, unknown>>,
      ["id", "status", "preview", "cwd", "updated_at"],
    );
  }
  return response;
};

export const sessionHealth: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);

  const sessionKey = keyFor(user, rec.name);
  const busyTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
  const client = ctx.pool.clientForSession(sessionKey);
  const appServerAlive = isClientAlive(client);
  const currentTurnStartedAt = rec.current_turn_started_at ?? null;
  const pending = typeof ctx.pending.listForUser === "function"
    ? ctx.pending.listForUser(user).filter((entry) => entry.session_name === rec.name)
    : null;
  const pendingApprovals = pending
    ? pending.filter((entry) => entry.kind.startsWith("approval.")).length
    : rec.pending_approvals ?? 0;
  const pendingUserInputs = pending
    ? pending.filter((entry) => entry.kind === "user_input.request").length
    : rec.pending_user_inputs ?? 0;

  return {
    session: rec.name,
    thread_id: rec.thread_id,
    state: rec.state,
    busy: rec.state === "live" && appServerAlive && busyTurnId !== null,
    current_turn_id: busyTurnId,
    current_turn_started_at: currentTurnStartedAt,
    current_turn_elapsed_ms: currentTurnStartedAt ? Math.max(0, Date.now() - Date.parse(currentTurnStartedAt)) : null,
    current_item_type: rec.current_item_type ?? null,
    items_done_in_turn: rec.items_in_turn ?? 0,
    pending_approval_requests: pendingApprovals,
    pending_user_input_requests: pendingUserInputs,
    token_usage_last_turn: rec.token_usage_last_turn ?? null,
    app_server_alive: appServerAlive,
    last_event_id: ctx.events.latestEvent(user, { session: rec.name, thread_id: rec.thread_id })?.id ?? null,
  };
};

export const sessionHeal: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const force = isTrue(flags["force"]);
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);

  const sessionKey = keyFor(user, rec.name);
  const existingClient = ctx.pool.clientForSession(sessionKey);
  const appServerAlive = isClientAlive(existingClient);
  if (rec.state === "live" && appServerAlive) {
    return { ok: true, note: "already healthy", session: rec };
  }

  if (!appServerAlive || force) {
    ctx.pool.release(sessionKey);
  }
  if (force) {
    ctx.queues.dispose(sessionKey);
    if (ctx.pending && typeof ctx.pending.abortForSession === "function") {
      ctx.pending.abortForSession(user, rec.name, "session_crashed", {
        reason: "session_heal_force_reset",
        session: rec.name,
        thread_id: rec.thread_id,
      });
    }
  }

  const client = await ctx.pool.acquire(
    user,
    sessionKey,
    buildExperimentalToolAppServerOptions(rec.experimental_tools ?? []),
  );
  await threadResume(client, rec.thread_id, ctx.retryOptions());

  const updated = ctx.sessions.update(user, rec.name, {
    state: "live",
    recovery_state: null,
    ...sessionRuntimeDefaults(),
  });
  ctx.users.touch(user);
  return { ok: true, healed: true, forced: force, session: updated };
};

// --- helpers ---

function requireUser(ctx: DaemonContext, req: IpcRequest): void {
  const bearer = req.bearer;
  if (!bearer) throw invalidParams("bearer token required");
  if (!ctx.users.has(bearer)) {
    throw new CodexTeamError("user_not_found", `user '${bearer}' not found — run 'codex-team daemon user create ${bearer}'`);
  }
}

function asFlags(req: IpcRequest): Record<string, unknown> {
  const flags = (req.params as Record<string, unknown>).flags;
  if (flags && typeof flags === "object") return flags as Record<string, unknown>;
  return {};
}

function asPositionals(req: IpcRequest): string[] {
  const p = (req.params as Record<string, unknown>).positionals;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
}

function asPositional(req: IpcRequest, idx: number, name: string): string {
  const positionals = asPositionals(req);
  const v = positionals[idx];
  if (typeof v !== "string" || v.length === 0) {
    throw invalidParams(`missing positional '${name}'`);
  }
  return v;
}

function asPositionalOptional(req: IpcRequest, idx: number): string | null {
  const positionals = asPositionals(req);
  const v = positionals[idx];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asString(v: unknown): string | null {
  if (Array.isArray(v)) return v[v.length - 1] ?? null;
  return typeof v === "string" ? v : null;
}

function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

async function buildThreadStartParams(
  ctx: DaemonContext,
  flags: Record<string, unknown>,
  experimentalTools: string[],
): Promise<Record<string, JsonValue>> {
  const p: Record<string, JsonValue> = {};
  const config: Record<string, JsonValue> = {};
  const model = asString(flags["model"]) ?? resolveDefault(ctx, "codex.default_model");
  if (model) p.model = model;
  const cwd = asString(flags["cwd"]) ?? process.cwd();
  if (cwd) p.cwd = cwd;
  const sandbox = asString(flags["sandbox"]) ?? resolveDefault(ctx, "codex.default_sandbox");
  if (sandbox) p.sandbox = sandbox;
  const approval = asString(flags["approval"]) ?? resolveDefault(ctx, "codex.default_approval");
  if (approval) p.approvalPolicy = approval;
  const effort = asString(flags["effort"]) ?? resolveDefault(ctx, "codex.default_effort");
  if (effort) config.model_reasoning_effort = effort;
  const profile = asString(flags["profile"]);
  if (profile) config.profile = profile;
  const baseInstr = await readInstructionFile(flags["base-instructions"], "--base-instructions");
  if (baseInstr) p.baseInstructions = baseInstr;
  const devInstr = await readInstructionFile(flags["developer-instructions"], "--developer-instructions");
  if (devInstr) p.developerInstructions = devInstr;
  const personality = asString(flags["personality"]);
  if (personality) p.personality = personality;
  const experimentalConfig = buildExperimentalToolThreadConfig(experimentalTools);
  if (experimentalConfig) Object.assign(config, experimentalConfig);
  if (Object.keys(config).length > 0) p.config = config;
  return p;
}

function resolveDefault(ctx: DaemonContext, key: string): string | null {
  const v = ctx.config.getEffective(key);
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function resolveExperimentalToolsForCreate(ctx: DaemonContext, flags: Record<string, unknown>): string[] {
  if (hasFlag(flags, "experimental-tools")) return parseExperimentalTools(flags["experimental-tools"]);
  return parseExperimentalTools(resolveDefault(ctx, "experimental.default_tools"));
}

function resolveAutoApprovePatternsForCreate(ctx: DaemonContext, flags: Record<string, unknown>): string[] {
  if (!hasFlag(flags, "auto-approve")) {
    return parseConfiguredAutoApprovePatterns(ctx.config.getEffective("session.auto_approve_command_patterns"));
  }
  const raw = asString(flags["auto-approve"]);
  if (raw === null) throw invalidParams("--auto-approve requires a comma-separated value");
  return parseAutoApprovePatterns(raw);
}

function resolveExperimentalToolsForAttach(
  ctx: DaemonContext,
  flags: Record<string, unknown>,
  inherited: string[] | undefined,
): string[] {
  if (hasFlag(flags, "experimental-tools")) return parseExperimentalTools(flags["experimental-tools"]);
  if (inherited && inherited.length > 0) return [...inherited];
  return parseExperimentalTools(resolveDefault(ctx, "experimental.default_tools"));
}

function keyFor(user: string, name: string): string {
  return `${user}::${name}`;
}

function isClientAlive(client: unknown): boolean {
  if (!client) return false;
  const maybe = client as { isAlive?: () => boolean };
  if (typeof maybe.isAlive === "function") return maybe.isAlive();
  return true;
}

function hasFlag(flags: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key);
}


function deriveNameFromThreadId(threadId: string, ctx: DaemonContext, user: string): string {
  const existing = ctx.sessions.get(user, threadId);
  if (existing) return existing.name;
  const tail = threadId.replace(/^th-/, "").replace(/-/g, "").slice(0, 8) || "x";
  let candidate = `s-${tail}`;
  while (ctx.sessions.get(user, candidate)) candidate = generateSessionName();
  return candidate;
}

function resolveAttachLockThreadId(ctx: DaemonContext, identifier: string): string | null {
  if (looksLikeThreadId(identifier)) return identifier;
  const anywhere = ctx.sessions.findUniqueLiveByNameAnywhere(identifier);
  if (anywhere === "ambiguous") {
    throw invalidParams(`session name '${identifier}' is ambiguous across users; use a thread_id or attach within the owning user`);
  }
  return anywhere?.record.thread_id ?? null;
}

function ensureAttachOwnership(ctx: DaemonContext, user: string, threadId: string): void {
  const owner = ctx.sessions.findLiveAnywhere(threadId);
  if (owner && owner.user !== user) {
    throw new CodexTeamError("session_busy", `thread '${threadId}' is live under user '${owner.user}'`);
  }
}

async function withAttachLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = attachLocks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => next);
  attachLocks.set(threadId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (attachLocks.get(threadId) === tail) attachLocks.delete(threadId);
  }
}

async function readInstructionFile(value: unknown, flag: string): Promise<string | null> {
  const filePath = asString(value);
  if (!filePath) return null;
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (e) {
    throw invalidParams(`${flag} not readable: ${(e as Error).message}`);
  }
}

async function seizeFromOtherUser(
  ctx: DaemonContext,
  fromUser: string,
  toUser: string,
  rec: SessionRecord,
): Promise<void> {
  const sessionKey = keyFor(fromUser, rec.name);
  const teardown = await ctx.queues.beginTeardown(sessionKey);
  const client = ctx.pool.clientForSession(sessionKey);
  const turnId = teardown.currentTurnId;
  if (client) {
    if (turnId) {
      try { await turnInterrupt(client, rec.thread_id, turnId, ctx.retryOptions()); } catch { /* ignore */ }
    }
    try { await threadUnsubscribe(client, rec.thread_id, ctx.retryOptions()); } catch { /* ignore */ }
  }
  ctx.pool.release(sessionKey);
  ctx.queues.dispose(sessionKey);
  ctx.sessions.remove(fromUser, rec.name);

  // Cancel any pending approval/user_input for the session (best-effort).
  for (const p of ctx.pending.removeForSession(fromUser, rec.name)) {
    try { p.client.respondError(p.jsonrpc_id, -32000, "session seized by another user"); } catch { /* ignore */ }
  }

  await ctx.events.append(fromUser, {
    type: "session.seized",
    session: rec.name,
    thread_id: rec.thread_id,
    payload: { seized_by: toUser },
  });
}

async function appendSessionClosed(
  ctx: DaemonContext,
  user: string,
  rec: SessionRecord,
  reason: "user_detach" | "daemon_shutdown" | "app_server_crashed" | "idle_unload" | "user_destroyed",
): Promise<void> {
  await ctx.events.append(user, {
    type: SESSION_CLOSED_EVENT_TYPE,
    session: rec.name,
    thread_id: rec.thread_id,
    payload: {
      session: rec.name,
      thread_id: rec.thread_id,
      reason,
      ts: new Date().toISOString(),
    },
  });
}

function sortSessions(rows: SessionRecord[], field: string): SessionRecord[] {
  const f = new Set(["name", "last_active", "turn_count", "created_at"]).has(field) ? field : "last_active";
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[
      f === "last_active" ? "last_active_at" : f === "created_at" ? "created_at" : f
    ];
    const bv = (b as unknown as Record<string, unknown>)[
      f === "last_active" ? "last_active_at" : f === "created_at" ? "created_at" : f
    ];
    if (typeof av === "string" && typeof bv === "string") return bv.localeCompare(av);
    if (typeof av === "number" && typeof bv === "number") return bv - av;
    return 0;
  });
  return copy;
}
