import fs from "node:fs";
import path from "node:path";

import type { AppServerClient, AppServerLogLine, AppServerLogStream } from "../../codex/appServerClient";
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
  type Thread,
  threadArchive,
  threadFork,
  threadIdOf,
  threadLoadedList,
  threadList,
  threadRename,
  threadRead,
  threadResume,
  threadSetName,
  threadStart,
  threadTurnsList,
  threadUnarchive,
  threadUnsubscribe,
  turnInterrupt,
} from "../../codex/rpc";
import {
  buildExperimentalToolAppServerOptions,
  buildExperimentalToolThreadConfig,
  parseExperimentalTools,
} from "../experimentalTools";
import {
  parseAutoApprovePatterns,
  parseConfiguredAutoApprovePatterns,
  validateAutoApprovePatterns,
  validateParsedAutoApprovePatterns,
} from "../auto-approve";
import { SESSION_CLOSED_EVENT_TYPE } from "../events";
import { cancelPendingWithEvent } from "../pending-cancel";
import { renderContext } from "../../format/markdown";
import { renderTable } from "../../format/table";
import { matchesGlob } from "../../util/glob";

const attachLocks = new Map<string, Promise<void>>();
const DEFAULT_SESSION_LIST_LIMIT = 50;
const LOCAL_SESSION_LIST_CURSOR_PREFIX = "local:";
const DEFAULT_SESSION_LOG_LINE_LIMIT = 100;
const DEFAULT_SESSION_LOG_TRUNCATE_BYTES = 2048;

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
  const cwd = resolveAndValidateRequestedCwd(asString(flags["cwd"]));
  const startParams = await buildThreadStartParams(ctx, flags, experimentalTools, cwd);

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
    cwd,
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
      validateSessionAutoApprovePatterns(existing.autoApprovePatterns ?? []);
      ctx.sessions.touch(user, existing.name);
      return { session: existing, noop: true };
    }

    const anywhere = looksLikeThreadId(identifier)
      ? ctx.sessions.findLiveAnywhere(identifier)
      : ctx.sessions.findUniqueLiveByNameAnywhere(identifier);
    if (anywhere === "ambiguous") {
      throw invalidParams(`session name '${identifier}' is ambiguous across users; use a thread_id or attach within the owning user`);
    }
    const autoApprovePatterns = validateSessionAutoApprovePatterns(anywhere?.record.autoApprovePatterns ?? []);
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
        autoApprovePatterns,
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
  const flags = asFlags(req);
  const detachAll = isTrue(flags["all"]);
  const match = asString(flags["match"]);
  const graceful = isTrue(flags["graceful"]);
  if (!detachAll && match !== null) {
    throw invalidParams("--match requires --all");
  }

  if (detachAll) {
    if (asPositionals(req).length > 0) {
      throw invalidParams("session detach --all does not accept positional targets");
    }
    const live = ctx.sessions.listLive(user)
      .filter((rec) => match === null || matchesGlob(match, rec.name));
    const results = await Promise.all(live.map(async (rec) => {
      try {
        const detached = await detachSessionRecord(ctx, user, rec, graceful);
        return {
          session: detached.name,
          detached: true,
          graceful,
        };
      } catch (error) {
        return {
          session: rec.name,
          ok: false,
          error: normalizeDetachError(error),
        };
      }
    }));
    return { results };
  }

  const identifier = asPositional(req, 0, "session");

  const rec = ctx.sessions.get(user, identifier);
  if (!rec) {
    return { session: null, noop: true };
  }

  const detached = await detachSessionRecord(ctx, user, rec, graceful);
  return { session: detached, noop: false, graceful };
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
  if (typeof ctx.queues.rekey === "function") {
    ctx.queues.rekey(keyFor(user, oldName), keyFor(user, newName));
  }
  ctx.pool.rekeySession(keyFor(user, oldName), keyFor(user, newName));
  if (typeof ctx.pending.renameSession === "function") {
    ctx.pending.renameSession(user, oldName, newName);
  }
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
  const autoApprovePatterns = validateSessionAutoApprovePatterns(source.autoApprovePatterns ?? []);
  const sourceCwd = source.cwd
    ? resolveAndValidatePersistedCwd(source.cwd, {
        label: "source session's cwd",
        missing: (cwd) => `source session's cwd '${cwd}' does not exist`,
        notDirectory: (cwd) => `source session's cwd '${cwd}' is no longer a directory`,
        inaccessible: (cwd) => `source session's cwd '${cwd}' is not accessible (permission denied or similar)`,
      })
    : undefined;

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
    cwd: sourceCwd,
    sandbox: source.sandbox,
    approval: source.approval,
    effort: source.effort,
    profile: source.profile,
    experimental_tools: source.experimental_tools,
    autoApprovePatterns,
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
  const loadedOnly = isTrue(flags["loaded-only"]);
  const sortField = asString(flags["sort"]) ?? "last_active";
  const format = asString(flags["format"]) ?? "json";
  const cursor = parseSessionListCursor(flags);
  const limit = parseSessionListLimit(flags);
  const archivedMode = parseArchivedMode(flags);
  const stateFilter = parseSessionStateFilter(flags);
  const ownerFilter = parseOwnerFilter(flags);
  if (format !== "json" && format !== "table") {
    throw invalidParams(`--format must be 'json' or 'table'`);
  }

  const response: Record<string, unknown> = { all, sort: sortField, format };
  if (loadedOnly) response.loaded_only = true;

  if (!all && !loadedOnly) {
    const live = listRegistrySessions(ctx, user, ownerFilter)
      .filter((session) => matchesArchivedMode(session, archivedMode))
      .filter((session) => matchesStateFilter(session, stateFilter));
    const sorted = sortSessionRows(live, sortField);
    const page = paginateLocalSessionRows(sorted, limit, cursor);
    response.sessions = page.sessions;
    response.next_cursor = page.nextCursor;
    if (format === "table") {
      response.table = renderTable(page.sessions as Array<Record<string, unknown>>, [
        "name",
        "thread_id",
        "state",
        "model",
        "busy",
        "turn_count",
        "last_active_at",
      ]);
    }
    return response;
  }

  const client = await ctx.pool.acquireForAdhoc(user);
  if (loadedOnly) {
    const result = await threadLoadedList(client, ctx.retryOptions());
    const decorated = result.threads
      .map((thread) => decorateThreadSession(ctx, user, thread))
      .filter((session) => matchesOwnerFilter(session, ownerFilter, user))
      .filter((session) => matchesArchivedMode(session, archivedMode))
      .filter((session) => matchesStateFilter(session, stateFilter));
    const page = paginateLocalSessionRows(sortSessionRows(decorated, sortField), limit, cursor);
    const sessions = page.sessions.map(stripInternalSessionMetadata);
    response.sessions = page.sessions;
    response.next_cursor = page.nextCursor;
    response.sessions = sessions;
    if (format === "table") {
      response.table = renderTable(page.sessions as Array<Record<string, unknown>>, [
        "name",
        "thread_id",
        "state",
        "model",
        "busy",
        "updated_at",
      ]);
    }
    return response;
  }

  const result = await threadList(client, {
    cursor: cursor ?? undefined,
    pageSize: limit,
    includeArchived: archivedMode !== "exclude",
  }, ctx.retryOptions());
  const sessions = result.data
    .map((thread) => decorateThreadSession(ctx, user, thread))
    .filter((session) => matchesOwnerFilter(session, ownerFilter, user))
    .filter((session) => matchesArchivedMode(session, archivedMode))
    .filter((session) => matchesStateFilter(session, stateFilter))
    .map(stripInternalSessionMetadata);
  Object.assign(response, {
    sessions,
    next_cursor: result.nextCursor,
  });
  if (format === "table") {
    response.table = renderTable(
      sessions as Array<Record<string, unknown>>,
      ["name", "thread_id", "state", "model", "busy", "updated_at"],
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
    ? ctx.pending.listForUser(user).filter((entry) => entry.thread_id === rec.thread_id || entry.session_name === rec.name)
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
  if (rec.state !== "live" && rec.state !== "crashed") {
    throw invalidParams(`session '${rec.name}' is in unexpected state '${String(rec.state)}'`);
  }

  const sessionKey = keyFor(user, rec.name);
  const existingClient = ctx.pool.clientForSession(sessionKey);
  const appServerAlive = isClientAlive(existingClient);
  if (rec.state === "live" && appServerAlive) {
    return { ok: true, note: "already healthy", session: rec };
  }

  const sessionCwd = rec.cwd
    ? resolveAndValidatePersistedCwd(rec.cwd, {
        label: "session's cwd",
        missing: (cwd) => `session's cwd '${cwd}' does not exist`,
        notDirectory: (cwd, kind) => `session's cwd '${cwd}' is not a directory (it is a ${kind})`,
        inaccessible: (cwd) => `session's cwd '${cwd}' is not accessible (permission denied or similar)`,
      })
    : undefined;
  if (sessionCwd && sessionCwd !== rec.cwd) {
    ctx.sessions.update(user, rec.name, { cwd: sessionCwd });
  }

  if (!appServerAlive || force) {
    ctx.pool.release(sessionKey);
  }
  if (force) {
    ctx.queues.dispose(sessionKey);
    await cancelPendingWithEvent(ctx, user, rec.name, rec.thread_id, "session_heal_force_reset");
    ctx.sessions.update(user, rec.name, {
      pending_approvals: 0,
      pending_user_inputs: 0,
    });
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

function parseSessionListLimit(flags: Record<string, unknown>): number {
  if (!hasFlag(flags, "limit")) return DEFAULT_SESSION_LIST_LIMIT;
  const raw = asString(flags["limit"]);
  if (!raw) throw invalidParams("--limit requires a positive integer");
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw invalidParams("--limit must be a positive integer");
  }
  return value;
}

function parseSessionListCursor(flags: Record<string, unknown>): string | null {
  if (!hasFlag(flags, "cursor")) return null;
  const cursor = asString(flags["cursor"]);
  if (!cursor) throw invalidParams("--cursor requires a value");
  return cursor;
}

function parseArchivedMode(flags: Record<string, unknown>): "only" | "exclude" | "include" {
  if (!hasFlag(flags, "archived")) return "exclude";
  const mode = asString(flags["archived"]);
  if (mode === "only" || mode === "exclude" || mode === "include") return mode;
  throw invalidParams(`--archived must be one of: only / exclude / include`);
}

function parseSessionStateFilter(flags: Record<string, unknown>): Set<"live" | "crashed" | "closed" | "archived"> | null {
  if (!hasFlag(flags, "state")) return null;
  const raw = asString(flags["state"]);
  if (!raw) throw invalidParams("--state requires a comma-separated value");
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw invalidParams("--state requires at least one value");
  const out = new Set<"live" | "crashed" | "closed" | "archived">();
  for (const entry of entries) {
    if (entry === "live" || entry === "crashed" || entry === "closed" || entry === "archived") {
      out.add(entry);
      continue;
    }
    throw invalidParams(`--state values must be drawn from: live, crashed, closed, archived`);
  }
  return out;
}

type SessionOwnerFilter =
  | { kind: "self" }
  | { kind: "any" }
  | { kind: "token"; token: string };

function parseOwnerFilter(flags: Record<string, unknown>): SessionOwnerFilter {
  if (!hasFlag(flags, "owner")) return { kind: "self" };
  const raw = asString(flags["owner"]);
  if (!raw) throw invalidParams("--owner requires a value");
  if (raw === "self") return { kind: "self" };
  if (raw === "any") return { kind: "any" };
  return { kind: "token", token: raw };
}

function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function resolveAndValidateRequestedCwd(rawCwd: string | null): string {
  const daemonCwd = resolveDaemonProcessCwd();
  const resolved = rawCwd === null
    ? path.normalize(daemonCwd)
    : resolveAbsoluteCwd(rawCwd, daemonCwd, "cwd");
  return validateResolvedCwd(resolved, {
    missing: (cwd) => `cwd '${cwd}' does not exist`,
    notDirectory: (cwd, kind) => `cwd '${cwd}' is not a directory (it is a ${kind})`,
    inaccessible: (cwd) => `cwd '${cwd}' is not accessible (permission denied or similar)`,
  });
}

function resolveAndValidatePersistedCwd(
  rawCwd: string,
  messages: {
    label: string;
    missing: (cwd: string) => string;
    notDirectory: (cwd: string, kind: string) => string;
    inaccessible: (cwd: string) => string;
  },
): string {
  const daemonCwd = resolveDaemonProcessCwd();
  const resolved = path.isAbsolute(rawCwd)
    ? path.normalize(rawCwd)
    : resolveAbsoluteCwd(rawCwd, daemonCwd, messages.label);
  return validateResolvedCwd(resolved, messages);
}

function resolveDaemonProcessCwd(): string {
  try {
    return process.cwd();
  } catch (error) {
    throw invalidParams(`cwd could not be resolved: ${(error as Error).message}`);
  }
}

function resolveAbsoluteCwd(rawCwd: string, daemonCwd: string, label: string): string {
  try {
    return path.normalize(path.resolve(daemonCwd, rawCwd));
  } catch (error) {
    throw invalidParams(`${label} '${rawCwd}' could not be resolved: ${(error as Error).message}`);
  }
}

function validateResolvedCwd(
  cwd: string,
  messages: {
    missing: (cwd: string) => string;
    notDirectory: (cwd: string, kind: string) => string;
    inaccessible: (cwd: string) => string;
  },
): string {
  if (!fs.existsSync(cwd)) {
    throw invalidParams(messages.missing(cwd));
  }

  const stat = fs.statSync(cwd);
  if (!stat.isDirectory()) {
    throw invalidParams(messages.notDirectory(cwd, describeFilesystemEntry(cwd, stat)));
  }

  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw invalidParams(messages.inaccessible(cwd));
  }

  return cwd;
}

function describeFilesystemEntry(cwd: string, stat: fs.Stats): string {
  try {
    const entry = fs.lstatSync(cwd);
    if (entry.isSymbolicLink()) return "symlink";
  } catch {
    // Fall back to stat-based typing below.
  }

  if (stat.isFile()) return "file";
  if (stat.isBlockDevice()) return "block device";
  if (stat.isCharacterDevice()) return "character device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "other";
}

async function buildThreadStartParams(
  ctx: DaemonContext,
  flags: Record<string, unknown>,
  experimentalTools: string[],
  cwd: string,
): Promise<Record<string, JsonValue>> {
  const p: Record<string, JsonValue> = {};
  const config: Record<string, JsonValue> = {};
  const model = asString(flags["model"]) ?? resolveDefault(ctx, "codex.default_model");
  if (model) p.model = model;
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
  const validationError = validateAutoApprovePatterns(raw);
  if (validationError) throw invalidParams(validationError);
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

function validateSessionAutoApprovePatterns(patterns: string[]): string[] {
  const validationError = validateParsedAutoApprovePatterns(patterns);
  if (validationError) throw invalidParams(validationError);
  return [...patterns];
}

async function detachSessionRecord(
  ctx: DaemonContext,
  user: string,
  rec: SessionRecord,
  graceful: boolean,
): Promise<SessionRecord> {
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
  await cancelPendingWithEvent(ctx, user, rec.name, rec.thread_id, "user_detach");
  ctx.sessions.remove(user, rec.name);
  ctx.queues.finalDispose(sessionKey);
  await appendSessionClosed(ctx, user, rec, "user_detach");
  return rec;
}

function normalizeDetachError(error: unknown): Record<string, unknown> {
  if (error instanceof CodexTeamError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
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
  await cancelPendingWithEvent(ctx, fromUser, rec.name, rec.thread_id, "session_seized");
  ctx.sessions.remove(fromUser, rec.name);
  ctx.queues.finalDispose(sessionKey);

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

function sortSessionRows(rows: Array<Record<string, unknown>>, field: string): Array<Record<string, unknown>> {
  const canonical = new Set(["name", "last_active", "turn_count", "created_at"]).has(field) ? field : "last_active";
  const key = canonical === "last_active"
    ? "last_active_at"
    : canonical === "created_at"
      ? "created_at"
      : canonical;
  const copy = [...rows];
  copy.sort((a, b) => compareSessionListValues(b[key], a[key]));
  return copy;
}

function compareSessionListValues(left: unknown, right: unknown): number {
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right);
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (left === undefined && right !== undefined) return -1;
  if (left !== undefined && right === undefined) return 1;
  return 0;
}

function listRegistrySessions(
  ctx: DaemonContext,
  currentUser: string,
  ownerFilter: SessionOwnerFilter,
): Array<Record<string, unknown>> {
  const users = resolveRegistryUsers(ctx, currentUser, ownerFilter);
  const rows: Array<Record<string, unknown>> = [];
  for (const user of users) {
    for (const rec of ctx.sessions.listLive(user)) {
      rows.push(decorateLiveSession(ctx, user, rec));
    }
  }
  return rows;
}

function resolveRegistryUsers(
  ctx: DaemonContext,
  currentUser: string,
  ownerFilter: SessionOwnerFilter,
): string[] {
  if (ownerFilter.kind === "self") return [currentUser];
  if (ownerFilter.kind === "token") return [ownerFilter.token];
  if (typeof ctx.users.list === "function") {
    return ctx.users.list().map((entry) => entry.token);
  }
  return [currentUser];
}

function decorateLiveSession(ctx: DaemonContext, owner: string, rec: SessionRecord): Record<string, unknown> {
  const busyInfo = deriveBusyInfo(ctx, owner, rec);
  return {
    ...rec,
    busy: busyInfo.busy,
    current_turn_id: busyInfo.currentTurnId,
    model: rec.model ?? null,
  };
}

function decorateThreadSession(ctx: DaemonContext, currentUser: string, thread: Thread): Record<string, unknown> {
  const threadId = typeof thread.id === "string" ? thread.id : null;
  const live = threadId ? ctx.sessions.findLiveAnywhere(threadId) : null;
  const rec = live?.record ?? null;
  const owner = live?.user ?? null;
  const busyInfo = rec && owner ? deriveBusyInfo(ctx, owner, rec) : { busy: false, currentTurnId: null };
  const state = deriveThreadState(rec, thread);
  const name = rec?.name ?? (typeof thread.name === "string" && thread.name.length > 0 ? thread.name : threadId ?? "unknown");
  const model = rec?.model
    ?? (typeof (thread as Record<string, unknown>).model === "string" ? (thread as Record<string, unknown>).model as string : null)
    ?? (typeof thread.model_provider === "string" ? thread.model_provider : null);
  const out: Record<string, unknown> = {
    ...thread,
    name,
    thread_id: threadId,
    state,
    model,
    busy: busyInfo.busy,
  };
  if (rec) {
    out.turn_count = rec.turn_count;
    out.current_turn_id = busyInfo.currentTurnId;
    out.last_active_at = rec.last_active_at;
    out.created_at = out.created_at ?? rec.created_at;
    out.sandbox = out.sandbox ?? rec.sandbox;
    out.approval = out.approval ?? rec.approval;
    out.effort = out.effort ?? rec.effort;
    out.profile = out.profile ?? rec.profile;
    out.crash_reason = out.crash_reason ?? rec.crash_reason;
  } else {
    out.current_turn_id = null;
  }
  if (owner) out.owner = owner;
  return out;
}

function deriveBusyInfo(
  ctx: DaemonContext,
  owner: string,
  rec: Pick<SessionRecord, "name" | "state" | "current_turn_id">,
): { busy: boolean; currentTurnId: string | null } {
  const sessionKey = keyFor(owner, rec.name);
  const currentTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
  const busy = rec.state === "live" && isClientAlive(ctx.pool.clientForSession(sessionKey)) && currentTurnId !== null;
  return { busy, currentTurnId };
}

function deriveThreadState(rec: SessionRecord | null, thread: Thread): "live" | "crashed" | "closed" | "archived" {
  if (isArchivedThread(thread)) return "archived";
  if (rec?.state === "crashed") return "crashed";
  if (rec?.state === "live") return "live";
  return "closed";
}

function isArchivedThread(thread: Thread): boolean {
  const record = thread as Record<string, unknown>;
  if (record.archived === true || record.isArchived === true) return true;
  const status = record.status;
  if (typeof status === "string") return status === "archived";
  if (status && typeof status === "object" && !Array.isArray(status)) {
    const type = (status as { type?: unknown }).type;
    return typeof type === "string" && type === "archived";
  }
  return false;
}

function matchesStateFilter(
  session: Record<string, unknown>,
  filter: Set<"live" | "crashed" | "closed" | "archived"> | null,
): boolean {
  if (!filter) return true;
  const state = session.state;
  return typeof state === "string" && filter.has(state as "live" | "crashed" | "closed" | "archived");
}

function matchesArchivedMode(
  session: Record<string, unknown>,
  archivedMode: "only" | "exclude" | "include",
): boolean {
  const archived = session.state === "archived";
  if (archivedMode === "include") return true;
  if (archivedMode === "only") return archived;
  return !archived;
}

function matchesOwnerFilter(
  session: Record<string, unknown>,
  ownerFilter: SessionOwnerFilter,
  currentUser: string,
): boolean {
  const owner = typeof session.owner === "string" ? session.owner : null;
  if (ownerFilter.kind === "any") return true;
  if (ownerFilter.kind === "self") {
    return owner === null || owner === currentUser;
  }
  return ownerFilter.token === currentUser
    ? owner === null || owner === currentUser
    : owner === ownerFilter.token;
}

function paginateLocalSessionRows(
  rows: Array<Record<string, unknown>>,
  limit: number,
  cursor: string | null,
): { sessions: Array<Record<string, unknown>>; nextCursor: string | null } {
  const start = decodeLocalSessionListCursor(cursor);
  const sessions = rows.slice(start, start + limit);
  const nextOffset = start + sessions.length;
  return {
    sessions,
    nextCursor: nextOffset < rows.length ? encodeLocalSessionListCursor(nextOffset) : null,
  };
}

function decodeLocalSessionListCursor(cursor: string | null): number {
  if (!cursor) return 0;
  if (!cursor.startsWith(LOCAL_SESSION_LIST_CURSOR_PREFIX)) {
    throw invalidParams("invalid --cursor for local session list");
  }
  const raw = cursor.slice(LOCAL_SESSION_LIST_CURSOR_PREFIX.length);
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw invalidParams("invalid --cursor for local session list");
  }
  return value;
}

function encodeLocalSessionListCursor(offset: number): string {
  return `${LOCAL_SESSION_LIST_CURSOR_PREFIX}${offset}`;
}

function stripInternalSessionMetadata(session: Record<string, unknown>): Record<string, unknown> {
  const { owner: _owner, ...rest } = session;
  return rest;
}

interface ResolvedDetachedThreadTarget {
  kind: "detached";
  thread: Thread;
  threadId: string;
  name: string | null;
}

interface ResolvedLiveSessionTarget {
  kind: "live";
  session: SessionRecord;
  threadId: string;
  name: string;
}

type ResolvedSessionTarget = ResolvedDetachedThreadTarget | ResolvedLiveSessionTarget;

export const sessionArchive: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const andDetach = isTrue(flags["and-detach"]);
  const live = ctx.sessions.get(user, identifier);

  if (live) {
    if (!andDetach) {
      throw invalidParams("session is live; pass --and-detach or run `session detach` first");
    }
    await detachLiveSessionHard(ctx, req, live);
    const archivedAt = new Date().toISOString();
    const client = await ctx.pool.acquireForAdhoc(user);
    await threadArchive(client, live.thread_id, ctx.retryOptions());
    return {
      thread_id: live.thread_id,
      archived: true,
      detached: true,
      archived_at: archivedAt,
    };
  }

  const target = await resolveSessionTarget(ctx, user, identifier);
  if (target.kind === "live") {
    if (target.session.name !== identifier && target.threadId !== identifier) {
      throw new CodexTeamError("session_busy", `session '${identifier}' is live under user '${user}'`);
    }
    if (!andDetach) {
      throw invalidParams("session is live; pass --and-detach or run `session detach` first");
    }
    await detachLiveSessionHard(ctx, req, target.session);
    const archivedAt = new Date().toISOString();
    const client = await ctx.pool.acquireForAdhoc(user);
    await threadArchive(client, target.threadId, ctx.retryOptions());
    return {
      thread_id: target.threadId,
      archived: true,
      detached: true,
      archived_at: archivedAt,
    };
  }

  const archivedAt = new Date().toISOString();
  const client = await ctx.pool.acquireForAdhoc(user);
  await threadArchive(client, target.threadId, ctx.retryOptions());
  return {
    thread_id: target.threadId,
    archived: true,
    archived_at: archivedAt,
  };
};

export const sessionUnarchive: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const threadId = asPositional(req, 0, "thread_id");
  const live = ctx.sessions.findLiveAnywhere(threadId);
  if (live) {
    throw invalidParams("thread is live; unarchive applies only to detached archived threads");
  }

  await readDetachedThreadById(ctx, user, threadId);
  const unarchivedAt = new Date().toISOString();
  const client = await ctx.pool.acquireForAdhoc(user);
  await threadUnarchive(client, threadId, ctx.retryOptions());
  return {
    thread_id: threadId,
    unarchived: true,
    unarchived_at: unarchivedAt,
  };
};

export const sessionRenameExtended: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const flags = asFlags(req);
  if (!isTrue(flags["detached-ok"])) {
    return await sessionRename(ctx, req);
  }

  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const newName = asPositional(req, 1, "new_name");
  validateSessionName(newName);

  const live = ctx.sessions.get(user, identifier);
  if (live) {
    return await sessionRename(ctx, req);
  }

  const target = await resolveSessionTarget(ctx, user, identifier);
  if (target.kind === "live") {
    return await sessionRename(ctx, req);
  }

  const renamedAt = new Date().toISOString();
  const client = await ctx.pool.acquireForAdhoc(user);
  await threadRename(client, target.threadId, newName, ctx.retryOptions());
  return {
    session: { name: newName },
    thread_id: target.threadId,
    detached: true,
    renamed_at: renamedAt,
  };
};

export const sessionRollback: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const toTurnId = asString(flags["to-turn"]);
  const detachAfter = isTrue(flags["detach-after"]);
  if (!toTurnId) {
    throw invalidParams("--to-turn requires a value");
  }

  const source = await resolveSessionTarget(ctx, user, identifier);
  const sourceName = resolveRollbackSessionName(source, ctx, user);
  const sourceRecord = source.kind === "live" ? source.session : null;
  const sourceThread = source.kind === "live"
    ? { id: source.threadId, name: source.name, cwd: source.session.cwd }
    : source.thread;
  const sourceDefaults = resolveRollbackDefaults(ctx, sourceRecord, sourceThread);

  if (!detachAfter) {
    validateSessionName(sourceName);
    const existing = ctx.sessions.get(user, sourceName);
    if (existing && (source.kind !== "live" || existing.thread_id !== source.threadId)) {
      throw invalidParams(`session '${sourceName}' already exists`);
    }
  }

  const sourceClient = await clientForThreadTarget(ctx, user, source);
  await ensureRollbackTurnExists(ctx, sourceClient, source.threadId, toTurnId);

  const forkResult = await threadFork(sourceClient, source.threadId, toTurnId, ctx.retryOptions());
  const newThreadId = threadIdOf(forkResult);

  if (source.kind === "live") {
    await detachLiveSessionHard(ctx, req, source.session);
  }

  const archivedSourceName = `${sourceName}-pre-rollback-${new Date().toISOString()}`;
  const lifecycleClient = await ctx.pool.acquireForAdhoc(user);
  await threadRename(lifecycleClient, source.threadId, archivedSourceName, ctx.retryOptions());
  await threadArchive(lifecycleClient, source.threadId, ctx.retryOptions());
  await threadRename(lifecycleClient, newThreadId, sourceName, ctx.retryOptions());

  if (!detachAfter) {
    await attachRollbackThread(ctx, user, sourceName, newThreadId, sourceDefaults);
  }

  return {
    name: sourceName,
    old_thread_id: source.threadId,
    new_thread_id: newThreadId,
    forked_at_turn: toTurnId,
    archived_source_name: archivedSourceName,
    detach_after: detachAfter,
  };
};

function resolveRollbackSessionName(
  source: ResolvedSessionTarget,
  ctx: DaemonContext,
  user: string,
): string {
  if (source.kind === "live") return source.session.name;
  return source.name ?? deriveNameFromThreadId(source.threadId, ctx, user);
}

function resolveRollbackDefaults(
  ctx: DaemonContext,
  sourceRecord: SessionRecord | null,
  sourceThread: Thread,
): {
  model?: string;
  cwd?: string;
  sandbox?: string;
  approval?: string;
  effort?: string;
  profile?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  experimentalTools: string[];
  autoApprovePatterns: string[];
} {
  const experimentalTools = sourceRecord?.experimental_tools
    ? [...sourceRecord.experimental_tools]
    : parseExperimentalTools(resolveDefault(ctx, "experimental.default_tools"));
  const autoApprovePatterns = sourceRecord
    ? validateSessionAutoApprovePatterns(sourceRecord.autoApprovePatterns ?? [])
    : validateSessionAutoApprovePatterns(
        parseConfiguredAutoApprovePatterns(ctx.config.getEffective("session.auto_approve_command_patterns")),
      );

  return {
    model: sourceRecord?.model ?? undefined,
    cwd: sourceRecord?.cwd ?? asString(sourceThread.cwd) ?? process.cwd(),
    sandbox: sourceRecord?.sandbox ?? resolveDefault(ctx, "codex.default_sandbox") ?? undefined,
    approval: sourceRecord?.approval ?? resolveDefault(ctx, "codex.default_approval") ?? undefined,
    effort: sourceRecord?.effort ?? resolveDefault(ctx, "codex.default_effort") ?? undefined,
    profile: sourceRecord?.profile ?? undefined,
    baseInstructions: sourceRecord?.base_instructions ?? undefined,
    developerInstructions: sourceRecord?.developer_instructions ?? undefined,
    experimentalTools,
    autoApprovePatterns,
  };
}

async function attachRollbackThread(
  ctx: DaemonContext,
  user: string,
  name: string,
  threadId: string,
  defaults: {
    model?: string;
    cwd?: string;
    sandbox?: string;
    approval?: string;
    effort?: string;
    profile?: string;
    baseInstructions?: string;
    developerInstructions?: string;
    experimentalTools: string[];
    autoApprovePatterns: string[];
  },
): Promise<SessionRecord> {
  const sessionKey = keyFor(user, name);
  const client = await ctx.pool.acquire(
    user,
    sessionKey,
    buildExperimentalToolAppServerOptions(defaults.experimentalTools),
  );
  let result;
  try {
    result = await threadResume(client, threadId, ctx.retryOptions());
  } catch (e) {
    ctx.pool.release(sessionKey);
    throw e;
  }

  const now = new Date().toISOString();
  const record: SessionRecord = {
    name,
    thread_id: threadId,
    state: "live",
    model: defaults.model ?? asString(result.model) ?? undefined,
    cwd: defaults.cwd ?? asString(result.cwd) ?? asString(result.thread.cwd) ?? process.cwd(),
    sandbox: defaults.sandbox,
    approval: defaults.approval ?? asString(result.approvalPolicy) ?? undefined,
    effort: defaults.effort,
    profile: defaults.profile,
    base_instructions: defaults.baseInstructions,
    developer_instructions: defaults.developerInstructions,
    experimental_tools: defaults.experimentalTools.length > 0 ? defaults.experimentalTools : undefined,
    autoApprovePatterns: defaults.autoApprovePatterns,
    created_at: now,
    last_active_at: now,
    turn_count: 0,
    ...sessionRuntimeDefaults(),
  };
  ctx.sessions.add(user, record);
  ctx.users.touch(user);
  return record;
}

async function ensureRollbackTurnExists(
  ctx: DaemonContext,
  client: AppServerClient,
  threadId: string,
  turnId: string,
): Promise<void> {
  let cursor: string | undefined;
  let hasCompletedTurn = false;
  do {
    const page = await threadTurnsList(client, threadId, {
      limit: 100,
      ...(cursor ? { cursor } : {}),
      sortDirection: "desc",
    }, ctx.retryOptions());
    for (const turn of page.data) {
      if (turn.status === "completed") hasCompletedTurn = true;
      if (turn.id === turnId) return;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  if (!hasCompletedTurn) {
    throw invalidParams("session has no completed turns yet; rollback requires a completed turn from `message history`");
  }
  throw invalidParams(`turn '${turnId}' not found in thread '${threadId}'`);
}

async function clientForThreadTarget(
  ctx: DaemonContext,
  user: string,
  target: ResolvedSessionTarget,
): Promise<AppServerClient> {
  if (target.kind === "live") {
    const client = ctx.pool.clientForSession(keyFor(user, target.session.name));
    if (client) return client;
  }
  return await ctx.pool.acquireForAdhoc(user);
}

async function detachLiveSessionHard(
  ctx: DaemonContext,
  req: IpcRequest,
  rec: SessionRecord,
): Promise<void> {
  await sessionDetach(ctx, {
    ...req,
    method: "session:detach",
    params: {
      positionals: [rec.name],
      flags: {},
    },
  });
}

async function resolveSessionTarget(
  ctx: DaemonContext,
  user: string,
  identifier: string,
): Promise<ResolvedSessionTarget> {
  const live = ctx.sessions.get(user, identifier);
  if (live) {
    return {
      kind: "live",
      session: live,
      threadId: live.thread_id,
      name: live.name,
    };
  }

  if (looksLikeThreadId(identifier)) {
    const owner = ctx.sessions.findLiveAnywhere(identifier);
    if (owner) {
      if (owner.user !== user) {
        throw new CodexTeamError("session_busy", `thread '${identifier}' is live under user '${owner.user}'`);
      }
      return {
        kind: "live",
        session: owner.record,
        threadId: owner.record.thread_id,
        name: owner.record.name,
      };
    }
    const thread = await readDetachedThreadById(ctx, user, identifier);
    return {
      kind: "detached",
      thread,
      threadId: thread.id,
      name: asString(thread.name),
    };
  }

  const liveByName = ctx.sessions.findUniqueLiveByNameAnywhere(identifier);
  if (liveByName === "ambiguous") {
    throw invalidParams(`session name '${identifier}' is ambiguous across users; use a thread_id`);
  }
  if (liveByName) {
    if (liveByName.user !== user) {
      throw new CodexTeamError("session_busy", `session '${identifier}' is live under user '${liveByName.user}'`);
    }
    return {
      kind: "live",
      session: liveByName.record,
      threadId: liveByName.record.thread_id,
      name: liveByName.record.name,
    };
  }

  const detached = await findDetachedThreadByName(ctx, user, identifier);
  if (detached === "ambiguous") {
    throw invalidParams(`session name '${identifier}' is ambiguous across detached threads; use a thread_id`);
  }
  if (!detached) {
    throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);
  }
  return {
    kind: "detached",
    thread: detached,
    threadId: detached.id,
    name: asString(detached.name),
  };
}

async function readDetachedThreadById(
  ctx: DaemonContext,
  user: string,
  threadId: string,
): Promise<Thread> {
  try {
    const client = await ctx.pool.acquireForAdhoc(user);
    const result = await threadRead(client, threadId, ctx.retryOptions());
    return result.thread;
  } catch (e) {
    throw new CodexTeamError("session_not_found", `session '${threadId}' not found: ${(e as Error).message}`);
  }
}

async function findDetachedThreadByName(
  ctx: DaemonContext,
  user: string,
  name: string,
): Promise<Thread | "ambiguous" | null> {
  const client = await ctx.pool.acquireForAdhoc(user);
  let cursor: string | undefined;
  let match: Thread | null = null;
  do {
    const page = await threadList(client, {
      pageSize: 200,
      includeArchived: true,
      ...(cursor ? { cursor } : {}),
    }, ctx.retryOptions());
    for (const thread of page.data) {
      if (asString(thread.name) !== name) continue;
      if (match) return "ambiguous";
      match = thread;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return match;
}

export const sessionHealthAll: HandlerFn = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const flags = asFlags(req);
  const positionals = asPositionals(req);
  if (positionals.length > 0) {
    throw invalidParams("session health --all does not take a session positional");
  }

  const onlyUnhealthy = isTrue(flags["only-unhealthy"]);
  const stateFilter = parseSessionHealthStates(asString(flags["state"]));
  const sessions = ctx.sessions.listLive(user)
    .map((record) => buildSessionHealthSnapshot(ctx, user, record))
    .filter((snapshot) => matchesSessionHealthState(snapshot, stateFilter))
    .filter((snapshot) => !onlyUnhealthy || !isQuietHealthySession(snapshot));

  return {
    summary: summarizeSessionHealthSnapshots(sessions),
    sessions,
  };
};

export const sessionEvents: HandlerFn = async (ctx, req, stream) => {
  if (!stream) throw new CodexTeamError("internal", "session events requires streaming");
  requireUser(ctx, req);
  const user = req.bearer!;
  const target = asPositional(req, 0, "name|thread_id");
  const flags = asFlags(req);
  const follow = isTrue(flags["follow"]);
  const summaryMode = isTrue(flags["summary"]);
  const byTool = isTrue(flags["by-tool"]);
  const byItemKind = isTrue(flags["by-item-kind"]);
  if (byTool && byItemKind) throw invalidParams("--by-tool and --by-item-kind are mutually exclusive");
  if (follow && (byTool || byItemKind)) throw invalidParams("--follow cannot be used with --by-tool or --by-item-kind");
  if (summaryMode && (byTool || byItemKind)) throw invalidParams("--summary cannot be used with --by-tool or --by-item-kind");

  const typeFilter = parseCsvFlag(flags["type"]);
  const turnFilter = asString(flags["turn"]);
  const sinceId = asString(flags["since"]);
  const limit = parseSessionEventsLimit(flags["limit"], 50);
  const matchesTarget = buildSessionEventMatcher(ctx, user, target);

  const listed = await ctx.events.listSince(user, sinceId, { includeDelta: true });
  if (!listed.ok) {
    if (listed.reason === "id_rotated") {
      stream.end(new CodexTeamError("id_rotated", `event '${sinceId}' has been rotated out`, {
        oldest_available_id: listed.oldest_available_id,
      }));
    } else {
      stream.end(invalidParams(`event '${sinceId}' not found`));
    }
    return { streaming: true };
  }

  const accept = (event: import("../../types").TeamEvent): boolean => {
    if (isSessionEventDeltaType(event.type)) return false;
    if (!matchesTarget(event)) return false;
    if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(event.type)) return false;
    if (turnFilter && !eventMatchesTurn(event, turnFilter)) return false;
    return true;
  };

  const initialMatching = listed.events.filter(accept);
  const initialWindow = sinceId
    ? initialMatching.slice(0, limit)
    : initialMatching.slice(Math.max(0, initialMatching.length - limit));

  if (byTool || byItemKind) {
    const grouping = byTool ? "tool" : "item_kind";
    const counts = tallySessionEvents(initialWindow, grouping);
    stream.chunk({
      target,
      group_by: grouping,
      summary: formatSessionEventTally(counts),
      counts,
      item_completed_events: Object.values(counts).reduce((sum, count) => sum + count, 0),
    });
    stream.end();
    return { streaming: true };
  }

  for (const event of initialWindow) {
    stream.chunk(summaryMode ? summarizeSessionEvent(event) : event);
  }

  if (!follow) {
    stream.end();
    return { streaming: true };
  }

  const sub = ctx.events.subscribe(user, (event) => {
    if (!accept(event)) return;
    stream.chunk(summaryMode ? summarizeSessionEvent(event) : event);
  });
  stream.onClose(() => sub.dispose());
  return { streaming: true };
};

export const sessionLogs: HandlerFn = async (ctx, req, stream) => {
  requireUser(ctx, req);
  const user = req.bearer!;
  const identifier = asPositional(req, 0, "name|thread_id");
  const flags = asFlags(req);
  const follow = isTrue(flags["follow"]) || isTrue(flags["f"]);
  const lineLimit = parseSessionLogsIntFlag(flags["n"], DEFAULT_SESSION_LOG_LINE_LIMIT, "-n", { minimum: 1 });
  const truncateBytes = parseSessionLogsIntFlag(
    flags["truncate"],
    DEFAULT_SESSION_LOG_TRUNCATE_BYTES,
    "--truncate",
    { minimum: 0 },
  );
  const selectedStream = parseSessionLogsStream(flags["stream"]);
  const target = await resolveSessionLogsTarget(ctx, user, identifier);
  const initial = buildSessionLogsResponse(ctx, user, target.rec, selectedStream, lineLimit, truncateBytes);

  if (!follow || !stream || target.rec.state === "crashed") {
    if (follow && stream) {
      stream.chunk(initial);
      stream.end();
      return { streaming: true };
    }
    return initial;
  }

  const client = target.client;
  if (!client) {
    throw new CodexTeamError("session_not_live", `session '${target.rec.name}' is unhealthy; run 'codex-team -b ${user} session heal ${target.rec.name}'`);
  }

  const emitLiveLine = (entry: AppServerLogLine) => {
    if (!matchesSessionLogStream(selectedStream, entry.stream)) return;
    stream.chunk(buildSessionLogsIncrement(ctx, user, target.rec, truncateBytes, entry));
  };
  const onClose = () => stream.end();

  if (selectedStream === "stderr" || selectedStream === "all") client.on("stderr_line", emitLiveLine);
  if (selectedStream === "stdout" || selectedStream === "all") client.on("stdout_line", emitLiveLine);
  client.on("close", onClose);
  stream.chunk(initial);
  stream.onClose(() => {
    client.off("stderr_line", emitLiveLine);
    client.off("stdout_line", emitLiveLine);
    client.off("close", onClose);
  });
  return { streaming: true };
};

function buildSessionHealthSnapshot(
  ctx: DaemonContext,
  user: string,
  rec: SessionRecord,
): Record<string, unknown> {
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
}

function parseSessionHealthStates(value: string | null): Set<string> | null {
  if (!value) return null;
  const states = new Set<string>();
  for (const raw of value.split(",")) {
    const state = raw.trim();
    if (!state) continue;
    if (state !== "live" && state !== "crashed" && state !== "closed") {
      throw invalidParams(`--state must be a comma-separated list of live, crashed, or closed`);
    }
    states.add(state);
  }
  return states.size > 0 ? states : null;
}

function matchesSessionHealthState(snapshot: Record<string, unknown>, states: Set<string> | null): boolean {
  if (!states) return true;
  const state = asString(snapshot.state);
  return state !== null && states.has(state);
}

function isQuietHealthySession(snapshot: Record<string, unknown>): boolean {
  return snapshot.state === "live" && snapshot.busy === false && snapshot.app_server_alive === true;
}

function isHealthySession(snapshot: Record<string, unknown>): boolean {
  return snapshot.state === "live" && snapshot.app_server_alive === true;
}

function summarizeSessionHealthSnapshots(
  snapshots: Record<string, unknown>[],
): {
  total: number;
  healthy: number;
  crashed: number;
  closed: number;
  busy: number;
  pending_total: number;
} {
  return {
    total: snapshots.length,
    healthy: snapshots.filter((snapshot) => isHealthySession(snapshot)).length,
    crashed: snapshots.filter((snapshot) => snapshot.state === "crashed").length,
    closed: snapshots.filter((snapshot) => snapshot.state === "closed").length,
    busy: snapshots.filter((snapshot) => snapshot.busy === true).length,
    pending_total: snapshots.reduce((sum, snapshot) => (
      sum + numericValue(snapshot.pending_approval_requests) + numericValue(snapshot.pending_user_input_requests)
    ), 0),
  };
}

function parseSessionEventsLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw < 0) throw invalidParams("--limit must be a non-negative integer");
  return Math.floor(raw);
}

function parseCsvFlag(value: unknown): string[] | null {
  const raw = asString(value);
  if (!raw) return null;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function buildSessionEventMatcher(
  ctx: DaemonContext,
  user: string,
  target: string,
): (event: import("../../types").TeamEvent) => boolean {
  const aliases = new Set<string>([target]);
  const rec = ctx.sessions.get(user, target);
  if (rec) {
    aliases.add(rec.name);
    aliases.add(rec.thread_id);
  }

  return (event) => {
    if (event.session && aliases.has(event.session)) return true;
    if (event.thread_id && aliases.has(event.thread_id)) return true;
    return false;
  };
}

function eventMatchesTurn(event: { payload: Record<string, unknown> }, turnId: string): boolean {
  return scalarString(event.payload.turn_id) === turnId || scalarString(event.payload.last_turn_id) === turnId;
}

function summarizeSessionEvent(event: import("../../types").TeamEvent): {
  id: string;
  ts: string;
  type: string;
  session: string | null;
  key: string | null;
} {
  return {
    id: event.id,
    ts: event.ts,
    type: event.type,
    session: event.session,
    key: summarizeSessionEventKey(event),
  };
}

function summarizeSessionEventKey(event: { type: string; thread_id: string | null; payload: Record<string, unknown> }): string | null {
  const payload = event.payload;
  if (event.type.startsWith("turn.")) return scalarString(payload.turn_id);
  if (event.type === "session.crashed" || event.type === "session.closed") {
    return labeledSessionEventValue("reason", payload.reason ?? payload.crash_reason ?? payload.why);
  }
  if (event.type === "auto_approved") {
    return labeledSessionEventValue("matched_pattern", payload.matched_pattern ?? payload.matchedPattern)
      ?? scalarString(payload.request_id);
  }
  if (event.type.startsWith("approval.") || event.type === "user_input.request" || event.type === "server_request_resolved") {
    return scalarString(payload.request_id);
  }
  if (event.type.startsWith("item.")) {
    return scalarString(payload.type) ?? scalarString(payload.item_type) ?? scalarString(payload.item_id);
  }
  if (event.type.startsWith("thread.")) return scalarString(payload.thread_id) ?? event.thread_id;
  if (event.type.startsWith("hook.")) return scalarString(payload.hook_id);
  if (event.type.startsWith("mcp_server.")) return scalarString(payload.name);
  if (event.type.startsWith("fuzzy_file_search.")) return scalarString(payload.search_session_id);
  if (event.type === "monitor.overflow") return scalarString(payload.dropped_count);

  return scalarString(payload.turn_id)
    ?? scalarString(payload.request_id)
    ?? scalarString(payload.type)
    ?? scalarString(payload.item_id)
    ?? scalarString(payload.thread_id)
    ?? scalarString(payload.name)
    ?? event.thread_id;
}

function labeledSessionEventValue(label: string, value: unknown): string | null {
  const rendered = scalarString(value);
  return rendered ? `${label}=${rendered}` : null;
}

function tallySessionEvents(
  events: import("../../types").TeamEvent[],
  grouping: "tool" | "item_kind",
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const itemKind = normalizeSessionEventItemKind(event.payload.type ?? event.payload.item_type ?? event.payload.item_id);
    const bucket = grouping === "tool" ? sessionEventToolBucket(itemKind) : itemKind;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

function formatSessionEventTally(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "(no item.completed events)";
  return entries.map(([key, value]) => `${key}=${value}`).join(" ");
}

function normalizeSessionEventItemKind(value: unknown): string {
  const raw = scalarString(value);
  if (!raw) return "unknown";
  const normalized = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s./-]+/g, "_")
    .toLowerCase();
  switch (normalized) {
    case "agentmessage":
      return "agent_message";
    case "autoapprovalreview":
      return "auto_approval_review";
    case "commandexecution":
      return "command_execution";
    case "filechange":
      return "file_change";
    case "mcptoolcall":
      return "mcp_tool_call";
    case "usermessage":
      return "user_message";
    default:
      return normalized;
  }
}

function sessionEventToolBucket(itemKind: string): string {
  switch (itemKind) {
    case "command_execution":
      return "shell";
    case "file_patch":
      return "file_change";
    default:
      return itemKind;
  }
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isSessionEventDeltaType(type: string): boolean {
  return type.endsWith("_delta");
}

async function resolveSessionLogsTarget(
  ctx: DaemonContext,
  user: string,
  identifier: string,
): Promise<{ rec: SessionRecord; client: AppServerClient | null }> {
  const rec = ctx.sessions.get(user, identifier);
  if (rec) {
    const client = rec.state === "live" ? ctx.pool.clientForSession(keyFor(user, rec.name)) : null;
    if (rec.state === "live" && !isClientAlive(client)) {
      throw new CodexTeamError("session_not_live", `session '${rec.name}' is unhealthy; run 'codex-team -b ${user} session heal ${rec.name}'`);
    }
    return { rec, client };
  }

  const target = await resolveSessionTarget(ctx, user, identifier);
  if (target.kind === "detached") {
    const attachTarget = target.name ?? target.threadId;
    throw new CodexTeamError(
      "session_not_live",
      `session '${attachTarget}' is detached; re-attach the session with 'codex-team -b ${user} session attach ${attachTarget}' first`,
    );
  }

  const client = ctx.pool.clientForSession(keyFor(user, target.session.name));
  if (!isClientAlive(client)) {
    throw new CodexTeamError("session_not_live", `session '${target.session.name}' is unhealthy; run 'codex-team -b ${user} session heal ${target.session.name}'`);
  }
  return { rec: target.session, client };
}

function buildSessionLogsResponse(
  ctx: DaemonContext,
  user: string,
  rec: SessionRecord,
  selectedStream: AppServerLogStream | "all",
  lineLimit: number,
  truncateBytes: number,
): Record<string, unknown> {
  const sessionKey = keyFor(user, rec.name);
  const binding = rec.state === "live" ? ctx.pool.sessionBinding(sessionKey) : null;
  const client = rec.state === "live" ? ctx.pool.clientForSession(sessionKey) : null;
  const closed = rec.state === "crashed" ? ctx.pool.closedLogsForSession(sessionKey) : null;
  const sourceLines = rec.state === "crashed"
    ? selectStoredSessionLogLines(closed, selectedStream)
    : selectLiveSessionLogLines(client, selectedStream);
  const rendered = projectSessionLogLines(sourceLines, lineLimit, truncateBytes);

  const response: Record<string, unknown> = {
    session: rec.name,
    thread_id: rec.thread_id,
    app_server_id: binding?.appServerId ?? closed?.appServerId ?? null,
    pid: binding?.pid ?? closed?.pid ?? null,
    lines: rendered.lines,
    truncated_from: rendered.truncatedFrom,
  };
  if (rec.state === "crashed") response.state = "crashed";
  return response;
}

function buildSessionLogsIncrement(
  ctx: DaemonContext,
  user: string,
  rec: SessionRecord,
  truncateBytes: number,
  entry: AppServerLogLine,
): Record<string, unknown> {
  const binding = ctx.pool.sessionBinding(keyFor(user, rec.name));
  return {
    session: rec.name,
    thread_id: rec.thread_id,
    app_server_id: binding?.appServerId ?? null,
    pid: binding?.pid ?? null,
    lines: [truncateSessionLogLine(entry, truncateBytes)],
    truncated_from: null,
  };
}

function parseSessionLogsIntFlag(
  value: unknown,
  fallback: number,
  label: string,
  options: { minimum: number },
): number {
  if (value === undefined) return fallback;
  const raw = asString(value);
  if (!raw) throw invalidParams(`${label} requires a value`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < options.minimum) {
    const expectation = options.minimum === 0 ? "a non-negative integer" : "a positive integer";
    throw invalidParams(`${label} must be ${expectation}`);
  }
  return parsed;
}

function parseSessionLogsStream(value: unknown): AppServerLogStream | "all" {
  if (value === undefined) return "stderr";
  const raw = asString(value);
  if (!raw) throw invalidParams("--stream requires a value");
  if (raw === "stderr" || raw === "stdout" || raw === "all") return raw;
  throw invalidParams("--stream must be one of stderr, stdout, or all");
}

function selectLiveSessionLogLines(
  client: AppServerClient | null,
  selectedStream: AppServerLogStream | "all",
): AppServerLogLine[] {
  if (!client) return [];
  if (selectedStream === "stderr") return client.stderrTail(Number.MAX_SAFE_INTEGER);
  if (selectedStream === "stdout") return client.stdoutTail(Number.MAX_SAFE_INTEGER);
  return client.logTail("all", Number.MAX_SAFE_INTEGER);
}

function selectStoredSessionLogLines(
  snapshot: ReturnType<DaemonContext["pool"]["closedLogsForSession"]>,
  selectedStream: AppServerLogStream | "all",
): AppServerLogLine[] {
  if (!snapshot) return [];
  if (selectedStream === "stderr") return snapshot.stderrTail;
  if (selectedStream === "stdout") return snapshot.stdoutTail;
  return [...snapshot.stderrTail, ...snapshot.stdoutTail]
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
}

function projectSessionLogLines(
  lines: AppServerLogLine[],
  lineLimit: number,
  truncateBytes: number,
): { lines: AppServerLogLine[]; truncatedFrom: number | null } {
  const truncatedFrom = lines.length > lineLimit ? lines.length : null;
  return {
    lines: lines
      .slice(Math.max(0, lines.length - lineLimit))
      .map((entry) => truncateSessionLogLine(entry, truncateBytes)),
    truncatedFrom,
  };
}

function matchesSessionLogStream(
  selectedStream: AppServerLogStream | "all",
  stream: AppServerLogStream,
): boolean {
  return selectedStream === "all" || selectedStream === stream;
}

function truncateSessionLogLine(entry: AppServerLogLine, truncateBytes: number): AppServerLogLine {
  return {
    ...entry,
    line: truncateTextByBytes(entry.line, truncateBytes),
  };
}

function truncateTextByBytes(value: string, truncateBytes: number): string {
  if (truncateBytes <= 0 || Buffer.byteLength(value, "utf8") <= truncateBytes) return value;
  const suffix = truncateBytes >= 3 ? "..." : "";
  const budget = Math.max(0, truncateBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= budget) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}
