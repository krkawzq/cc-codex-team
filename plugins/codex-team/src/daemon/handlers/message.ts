import fs from "node:fs";

import type { HandlerFn } from "../dispatch";
import type { DaemonContext } from "../context";
import type { IpcRequest } from "../../ipc/protocol";
import type { JsonValue } from "../../codex/errors";
import { CodexTeamError, invalidParams } from "../../errors";
import { SESSION_CLOSED_EVENT_TYPE, SESSION_CRASHED_EVENT_TYPE } from "../events";
import {
  threadRead,
  threadTurnsList,
  turnInterrupt,
  turnSteer,
  type ThreadTurnsListResponse,
  type TurnListItem,
} from "../../codex/rpc";
import { renderHistory, renderTail } from "../../format/markdown";
import type { PendingRequest } from "../pending";
import type { RetryOptions } from "../../codex/retry";
import { buildExperimentalToolAppServerOptions } from "../experimentalTools";

export const messageSend: HandlerFn = async (ctx, req) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const prompt = await readPromptInput(req);
  const attachments = asStringArray(getFlag(req, "attach"));
  const input = await buildUserInput(prompt, attachments);
  const sessionKey = keyFor(user, rec.name);
  const result = await ctx.queues.sendOrQueue(sessionKey, client, rec.thread_id, input, ctx.retryOptions());
  ctx.sessions.touch(user, rec.name);
  return {
    session: rec.name,
    thread_id: rec.thread_id,
    turn_id: result.turn_id,
    started: result.started,
    queue_id: result.queue_id,
    queued_depth: result.queued_depth,
  };
};

export const messagePeer: HandlerFn = async (ctx, req) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const prompt = await readPromptInput(req);
  const attachments = asStringArray(getFlag(req, "attach"));
  const input = await buildUserInput(prompt, attachments);
  const sessionKey = keyFor(user, rec.name);
  const turnId = ctx.queues.getCurrentTurn(sessionKey);
  if (!turnId) {
    throw new CodexTeamError("invalid_params", "no active turn to peer into; use 'message send' instead");
  }
  await turnSteer(client, rec.thread_id, turnId, input, ctx.retryOptions());
  ctx.sessions.touch(user, rec.name);
  return { session: rec.name, turn_id: turnId, peered: true };
};

export const messageInterrupt: HandlerFn = async (ctx, req) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const sessionKey = keyFor(user, rec.name);
  const turnId = ctx.queues.getCurrentTurn(sessionKey);
  if (!turnId) {
    return { session: rec.name, turn_id: null, interrupted: false, noop: true };
  }
  await turnInterrupt(client, rec.thread_id, turnId, ctx.retryOptions());
  ctx.queues.setCurrentTurn(sessionKey, null);
  ctx.sessions.touch(user, rec.name);
  return { session: rec.name, turn_id: turnId, interrupted: true };
};

export const messageApproval: HandlerFn = async (ctx, req) => {
  const { user, rec } = await resolveLive(ctx, req);
  const requestId = asPositional(req, 1, "request_id");
  const shortcut = asPositionalOptional(req, 2);
  const pending = requirePending(ctx, user, requestId);

  if (!pending.kind.startsWith("approval.")) {
    throw new CodexTeamError("invalid_decision", `request '${requestId}' is not an approval (kind=${pending.kind})`);
  }

  const claimed = claimPending(ctx, user, requestId);
  let response: unknown;
  try {
    response = await buildResponse(req, claimed, shortcut);
  } catch (e) {
    ctx.pending.releaseClaim(requestId);
    throw e;
  }
  try {
    const ack = await claimed.client.respondAck(claimed.jsonrpc_id, response as JsonValue);
    ctx.pending.markResponded(requestId);
    if (ack.backpressured) {
      emitPendingWarning(ctx, user, rec.name, rec.thread_id, {
        message: "approval reply is delayed by app-server stdin backpressure",
        kind: "approval_reply_backpressured",
        request_id: requestId,
      });
    }
  } catch (err) {
    ctx.pending.remove(requestId);
    emitPendingWarning(ctx, user, rec.name, rec.thread_id, {
      message: `approval reply delivery failed: ${(err as Error).message}`,
      kind: "approval_reply_delivery_failed",
      request_id: requestId,
    });
    throw err;
  }
  return {
    session: rec.name,
    request_id: requestId,
    kind: claimed.kind,
    responded: true,
    response,
  };
};

export const messageAnswer: HandlerFn = async (ctx, req) => {
  const { user, rec } = await resolveLive(ctx, req);
  const requestId = asPositional(req, 1, "request_id");
  const inline = asPositionalOptional(req, 2);
  const pending = requirePending(ctx, user, requestId);

  if (pending.kind !== "user_input.request") {
    throw new CodexTeamError("invalid_decision", `request '${requestId}' is not a user_input request (kind=${pending.kind})`);
  }

  const claimed = claimPending(ctx, user, requestId);
  let response: unknown;
  try {
    response = await buildAnswerResponse(req, claimed, inline);
  } catch (e) {
    ctx.pending.releaseClaim(requestId);
    throw e;
  }
  try {
    const ack = await claimed.client.respondAck(claimed.jsonrpc_id, response as JsonValue);
    ctx.pending.markResponded(requestId);
    if (ack.backpressured) {
      emitPendingWarning(ctx, user, rec.name, rec.thread_id, {
        message: "user_input reply is delayed by app-server stdin backpressure",
        kind: "user_input_reply_backpressured",
        request_id: requestId,
      });
    }
  } catch (err) {
    ctx.pending.remove(requestId);
    emitPendingWarning(ctx, user, rec.name, rec.thread_id, {
      message: `user_input reply delivery failed: ${(err as Error).message}`,
      kind: "user_input_reply_delivery_failed",
      request_id: requestId,
    });
    throw err;
  }
  return { session: rec.name, request_id: requestId, responded: true, response };
};

export const messageHistory: HandlerFn = async (ctx, req) => {
  const { rec, client } = await resolveLive(ctx, req);
  const limitRaw = getFlag(req, "limit");
  const limit = typeof limitRaw === "string" ? parseInt(limitRaw, 10) : typeof limitRaw === "number" ? limitRaw : 50;
  const sinceRaw = asString(getFlag(req, "since"));
  const format = asString(getFlag(req, "format")) ?? "json";
  const truncate = parseTruncateFlag(getFlag(req, "truncate"));
  if (format !== "json" && format !== "markdown") throw invalidParams("--format must be json or markdown");

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit as number)) : 50;
  const relativeSince = sinceRaw && /^-\d+$/.test(sinceRaw) ? Math.max(1, Math.floor(Math.abs(Number(sinceRaw)))) : null;
  const result = relativeSince
    ? await listTurnsFromRelativeOffset(client, rec.thread_id, relativeSince, safeLimit, ctx.retryOptions())
    : await threadTurnsList(client, rec.thread_id, {
        limit: safeLimit,
        cursor: sinceRaw ?? undefined,
        sortDirection: "desc",
      }, ctx.retryOptions());

  const response: Record<string, unknown> = {
    session: rec.name,
    thread_id: rec.thread_id,
    turns: result.data,
    next_cursor: result.nextCursor,
    format,
    note: "Turn items are not included in turnsList responses (protocol limitation). Use 'session context' for per-thread metadata.",
  };
  if (relativeSince) response.relative_since = relativeSince;
  if (format === "markdown") {
    response.markdown = renderHistory({
      session: rec.name,
      thread_id: rec.thread_id,
      turns: result.data,
      nextCursor: result.nextCursor,
    }, { truncate });
  }
  return response;
};

export const messageTail: HandlerFn = async (ctx, req, stream) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const nRaw = getFlag(req, "n");
  const n = typeof nRaw === "string" ? parseInt(nRaw, 10) : typeof nRaw === "number" ? nRaw : 3;
  const format = asString(getFlag(req, "format")) ?? "json";
  const truncate = parseTruncateFlag(getFlag(req, "truncate"));
  if (format !== "json" && format !== "markdown") throw invalidParams("--format must be json or markdown");
  const follow = isTrue(getFlag(req, "follow")) || isTrue(getFlag(req, "f"));

  const snapshot = async () => {
    const result = await threadTurnsList(client, rec.thread_id, {
      limit: Number.isFinite(n) ? Math.max(1, Math.floor(n as number)) : 3,
      sortDirection: "desc",
    }, ctx.retryOptions());
    const thread = await threadRead(client, rec.thread_id, ctx.retryOptions()).catch(() => null);
    const response: Record<string, unknown> = {
      session: rec.name,
      turns: result.data,
      format,
      follow,
      thread: thread?.thread ?? null,
    };
    if (format === "markdown") {
      response.markdown = renderTail({
        session: rec.name,
        thread_id: rec.thread_id,
        turns: result.data,
        thread: thread?.thread ?? null,
        follow,
      }, { truncate });
    }
    return response;
  };

  if (!follow || !stream) {
    return await snapshot();
  }

  // Streaming follow: initial snapshot, then emit a fresh snapshot on each turn.completed.
  stream.chunk(await snapshot());

  const sub = ctx.events.subscribe(user, (e) => {
    if (e.session !== rec.name) return;
    if (e.type !== "turn.completed") return;
    void snapshot().then((snap) => stream.chunk(snap)).catch(() => { /* ignore */ });
  });
  stream.onClose(() => sub.dispose());
  return { streaming: true };
};

export const messageWait: HandlerFn = async (ctx, req) => {
  const { user, rec } = await resolveSessionRecord(ctx, req);
  if (rec.state !== "live") {
    return {
      session: rec.name,
      thread_id: rec.thread_id,
      turn_id: rec.current_turn_id ?? rec.last_turn_id ?? null,
      outcome: "error",
      event_type: SESSION_CRASHED_EVENT_TYPE,
      error: {
        reason: rec.crash_reason ?? "session_crashed",
      },
    };
  }
  const requestedTurnId = asString(getFlag(req, "for"));
  const timeoutSeconds = parseTimeoutSeconds(getFlag(req, "timeout"));
  const sessionKey = keyFor(user, rec.name);
  const initialTurnId = requestedTurnId ?? rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);

  if (requestedTurnId) {
    const historical = await findTerminalEvent(ctx, user, rec.name, requestedTurnId);
    if (historical) return terminalWaitResult(rec.name, rec.thread_id, requestedTurnId, historical);
  } else if (initialTurnId) {
    const historical = await findTerminalEvent(ctx, user, rec.name, initialTurnId);
    if (historical) return terminalWaitResult(rec.name, rec.thread_id, initialTurnId, historical);
  }

  return await new Promise((resolve) => {
    let settled = false;
    let targetTurnId = requestedTurnId;
    let timer: NodeJS.Timeout | null = null;

    const settle = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sub.dispose();
      resolve(result);
    };

    const sub = ctx.events.subscribe(user, (event) => {
      if (event.session !== rec.name) return;
      if (event.thread_id !== rec.thread_id) return;

      if (!targetTurnId) {
        targetTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
      }

      if (!targetTurnId) {
        if (event.type === "turn.started") {
          const turnId = eventTurnId(event);
          if (!turnId) return;
          targetTurnId = turnId;
        } else if (event.type === SESSION_CRASHED_EVENT_TYPE || event.type === SESSION_CLOSED_EVENT_TYPE) {
          settle({
            session: rec.name,
            thread_id: rec.thread_id,
            turn_id: null,
            outcome: "error",
            event_type: event.type,
            event_id: event.id,
            error: event.payload,
          });
        }
        return;
      }

      if (event.type === "turn.completed" && eventTurnId(event) === targetTurnId) {
        settle(terminalWaitResult(rec.name, rec.thread_id, targetTurnId, event));
        return;
      }
      if (event.type === "turn.error" && eventTurnId(event) === targetTurnId) {
        settle(terminalWaitResult(rec.name, rec.thread_id, targetTurnId, event));
        return;
      }
      if (event.type === SESSION_CRASHED_EVENT_TYPE && eventCrashTurnId(event) === targetTurnId) {
        settle({
          session: rec.name,
          thread_id: rec.thread_id,
          turn_id: targetTurnId,
          outcome: "error",
          event_type: event.type,
          event_id: event.id,
          error: event.payload,
        });
        return;
      }
      if (event.type === SESSION_CLOSED_EVENT_TYPE) {
        settle({
          session: rec.name,
          thread_id: rec.thread_id,
          turn_id: targetTurnId,
          outcome: "error",
          event_type: event.type,
          event_id: event.id,
          error: event.payload,
        });
      }
    });

    if (!targetTurnId && !requestedTurnId) {
      targetTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
    }

    if (timeoutSeconds > 0) {
      timer = setTimeout(() => {
        settle({
          session: rec.name,
          thread_id: rec.thread_id,
          turn_id: targetTurnId ?? null,
          outcome: "timeout",
          timeout_s: timeoutSeconds,
        });
      }, timeoutSeconds * 1000);
      timer.unref();
    }
  });
};

// ----- helpers -----

async function resolveLive(
  ctx: DaemonContext,
  req: IpcRequest,
): Promise<{ user: string; rec: import("../sessions").SessionRecord; client: import("../../codex/appServerClient").AppServerClient }> {
  const user = req.bearer;
  if (!user) throw invalidParams("bearer token required");
  if (!ctx.users.has(user)) {
    throw new CodexTeamError("user_not_found", `user '${user}' not found`);
  }
  const identifier = asPositional(req, 0, "session");
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) {
    throw new CodexTeamError("session_not_found", `session '${identifier}' not live in this user`);
  }
  if (rec.state === "crashed") {
    throw new CodexTeamError("session_not_live", `session '${rec.name}' is crashed; run 'codex-team -b ${user} session heal ${rec.name}'`);
  }
  const client = ctx.pool.clientForSession(keyFor(user, rec.name));
  if (!isClientAlive(client)) {
    throw new CodexTeamError("session_not_live", `session '${rec.name}' is unhealthy; run 'codex-team -b ${user} session heal ${rec.name}'`);
  }
  return { user, rec, client };
}

async function resolveSessionRecord(
  ctx: DaemonContext,
  req: IpcRequest,
): Promise<{ user: string; rec: import("../sessions").SessionRecord }> {
  const user = req.bearer;
  if (!user) throw invalidParams("bearer token required");
  if (!ctx.users.has(user)) {
    throw new CodexTeamError("user_not_found", `user '${user}' not found`);
  }
  const identifier = asPositional(req, 0, "session");
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) {
    throw new CodexTeamError("session_not_found", `session '${identifier}' not live in this user`);
  }
  return { user, rec };
}

function requirePending(ctx: DaemonContext, user: string, requestId: string): PendingRequest {
  const p = ctx.pending.get(requestId);
  if (!p) throw new CodexTeamError("invalid_params", `no pending request '${requestId}'`);
  if (p.user !== user) throw new CodexTeamError("invalid_params", `pending request '${requestId}' belongs to another user`);
  return p;
}

function claimPending(ctx: DaemonContext, user: string, requestId: string): PendingRequest {
  const claimed = ctx.pending.claim(requestId, user);
  if (!claimed) throw new CodexTeamError("invalid_params", `no pending request '${requestId}'`);
  return claimed;
}

function emitPendingWarning(
  ctx: DaemonContext,
  user: string,
  session: string | null,
  threadId: string | null,
  payload: Record<string, unknown>,
): void {
  setImmediate(() => {
    void ctx.events.append(user, {
      type: "warning",
      session,
      thread_id: threadId,
      payload,
    }).catch(() => undefined);
  });
}

async function readPromptInput(req: IpcRequest): Promise<string> {
  const positional = asPositionalOptional(req, 1);
  const fromFile = asString(getFlag(req, "file"));
  const fromStdin = isTrue(getFlag(req, "stdin"));
  const sources = [positional, fromFile, fromStdin].filter((v) => v !== null && v !== false).length;
  if (sources === 0) {
    throw invalidParams("prompt is required: positional text, --file <path>, or --stdin");
  }
  if (sources > 1) {
    throw invalidParams("prompt is ambiguous: supply exactly one of positional, --file, --stdin");
  }
  if (positional) return positional;
  if (fromFile) {
    try { return await fs.promises.readFile(fromFile, "utf8"); }
    catch (e) { throw invalidParams(`--file not readable: ${(e as Error).message}`); }
  }
  // stdin — cli forwards stdin contents into a flag? For phase 4 we expect cli to have
  // materialized stdin into a `stdin_content` param (placeholder).
  const stdinContent = asString((req.params as Record<string, unknown>).stdin_content);
  if (stdinContent === null) throw invalidParams("--stdin requested but no content forwarded from cli");
  return stdinContent;
}

async function readJsonInput(req: IpcRequest): Promise<JsonValue | null> {
  const jsonRaw = asString(getFlag(req, "json"));
  const fromFile = asString(getFlag(req, "file"));
  const fromStdin = isTrue(getFlag(req, "stdin"));
  const sources = [jsonRaw, fromFile, fromStdin].filter((v) => v !== null && v !== false).length;
  if (sources === 0) return null;
  if (sources > 1) throw invalidParams("json payload ambiguous: supply exactly one of --json, --file, --stdin");
  let raw: string;
  if (jsonRaw) raw = jsonRaw;
  else if (fromFile) {
    try { raw = await fs.promises.readFile(fromFile, "utf8"); }
    catch (e) { throw invalidParams(`--file not readable: ${(e as Error).message}`); }
  } else {
    const stdinContent = asString((req.params as Record<string, unknown>).stdin_content);
    if (stdinContent === null) throw invalidParams("--stdin requested but no content forwarded from cli");
    raw = stdinContent;
  }
  try { return JSON.parse(raw) as JsonValue; }
  catch (e) { throw invalidParams(`invalid JSON payload: ${(e as Error).message}`); }
}

async function buildUserInput(text: string, attachments: string[]): Promise<JsonValue> {
  const items: JsonValue[] = [{ type: "text", text } as unknown as JsonValue];
  for (const path of attachments) {
    await assertAttachable(path);
    items.push({ type: "localImage", path } as unknown as JsonValue);
  }
  return items as unknown as JsonValue;
}

async function buildResponse(req: IpcRequest, pending: PendingRequest, shortcut: string | null): Promise<unknown> {
  const explicit = await readJsonInput(req);
  if (explicit) {
    if (shortcut) throw invalidParams("cannot combine shortcut and --json/--file/--stdin");
    return explicit;
  }
  if (!shortcut) throw invalidParams("supply a shortcut (accept|accept-session|decline|cancel) or --json/--file/--stdin");
  return buildApprovalShortcutResponse(pending.kind, pending.raw, shortcut);
}

export function buildApprovalShortcutResponse(kind: string, raw: Record<string, unknown>, shortcut: string): unknown {
  switch (kind) {
    case "approval.command_execution":
    case "approval.file_change":
      return { decision: commandOrFileShortcut(shortcut, kind) };
    case "approval.permissions":
      return permissionsShortcut(shortcut, raw);
    case "approval.mcp_elicitation":
      return mcpElicitationShortcut(shortcut, raw);
    default:
      throw new CodexTeamError("invalid_decision", `unknown approval kind '${kind}'`);
  }
}

export function preferredAutoApprovalShortcut(kind: string): "accept" | "accept-session" | null {
  switch (kind) {
    case "approval.command_execution":
    case "approval.file_change":
    case "approval.permissions":
      return "accept-session";
    case "approval.mcp_elicitation":
      return "accept";
    default:
      return null;
  }
}

function commandOrFileShortcut(shortcut: string, kind: string): string {
  if (shortcut === "accept") return "accept";
  if (shortcut === "accept-session") return "acceptForSession";
  if (shortcut === "decline") return "decline";
  if (shortcut === "cancel") return "cancel";
  throw new CodexTeamError("invalid_decision", `shortcut '${shortcut}' not allowed for ${kind}`);
}

function permissionsShortcut(shortcut: string, raw: Record<string, unknown>): Record<string, unknown> {
  const requested = raw.permissions ?? {};
  if (shortcut === "accept") return { permissions: requested, scope: "turn" };
  if (shortcut === "accept-session") return { permissions: requested, scope: "session" };
  if (shortcut === "decline") return { permissions: {}, scope: "turn" };
  throw new CodexTeamError("invalid_decision", `shortcut '${shortcut}' not allowed for approval.permissions (cancel not supported)`);
}

function mcpElicitationShortcut(shortcut: string, raw: Record<string, unknown>): Record<string, unknown> {
  const mode = raw.mode;
  if (shortcut === "accept") {
    if (mode === "form") {
      throw new CodexTeamError("invalid_decision", "mcp_elicitation form mode requires --json with content");
    }
    return { action: "accept", content: null, _meta: null };
  }
  if (shortcut === "decline") return { action: "decline", content: null, _meta: null };
  if (shortcut === "cancel") return { action: "cancel", content: null, _meta: null };
  throw new CodexTeamError("invalid_decision", `shortcut '${shortcut}' not allowed for approval.mcp_elicitation`);
}

async function buildAnswerResponse(req: IpcRequest, pending: PendingRequest, inline: string | null): Promise<unknown> {
  const explicit = await readJsonInput(req);
  if (explicit) {
    if (inline) throw invalidParams("cannot combine positional answer and --json/--file/--stdin");
    return explicit;
  }
  if (!inline) throw invalidParams("supply inline answer, --json, --file, or --stdin");
  // Build { answers: { <only_qid>: { answers: [inline] } } }
  const questions = Array.isArray(pending.raw.questions) ? pending.raw.questions : [];
  if (questions.length !== 1) {
    throw invalidParams(`inline answer only supported when request has exactly one question (got ${questions.length})`);
  }
  const q = questions[0] as { id?: string };
  if (!q.id) throw new CodexTeamError("internal", "pending question missing id");
  return { answers: { [q.id]: { answers: [inline] } } };
}

// ----- util -----

function keyFor(user: string, name: string): string {
  return `${user}::${name}`;
}

function getFlag(req: IpcRequest, key: string): unknown {
  const flags = (req.params as Record<string, unknown>).flags;
  if (flags && typeof flags === "object") return (flags as Record<string, unknown>)[key];
  return undefined;
}

function asPositional(req: IpcRequest, idx: number, name: string): string {
  const positionals = (req.params as Record<string, unknown>).positionals;
  const list = Array.isArray(positionals) ? positionals : [];
  const v = list[idx];
  if (typeof v !== "string" || v.length === 0) throw invalidParams(`missing positional '${name}'`);
  return v;
}

function asPositionalOptional(req: IpcRequest, idx: number): string | null {
  const positionals = (req.params as Record<string, unknown>).positionals;
  const list = Array.isArray(positionals) ? positionals : [];
  const v = list[idx];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asString(v: unknown): string | null {
  if (Array.isArray(v)) {
    const last = v[v.length - 1];
    return typeof last === "string" ? last : null;
  }
  return typeof v === "string" ? v : null;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}

function isClientAlive(client: unknown): client is import("../../codex/appServerClient").AppServerClient {
  if (!client) return false;
  const maybe = client as { isAlive?: () => boolean };
  if (typeof maybe.isAlive === "function") return maybe.isAlive();
  return true;
}

function parseTimeoutSeconds(value: unknown): number {
  if (value === undefined) return 600;
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw < 0) throw invalidParams("--timeout must be a non-negative number of seconds");
  return Math.floor(raw);
}

function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function eventTurnId(event: { payload: Record<string, unknown> }): string | null {
  const turnId = event.payload.turn_id;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}

function eventCrashTurnId(event: { payload: Record<string, unknown> }): string | null {
  const turnId = event.payload.last_turn_id;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}

function terminalWaitResult(
  session: string,
  threadId: string,
  turnId: string,
  event: { id: string; type: string; payload: Record<string, unknown> },
): Record<string, unknown> {
  const completedStatus = event.type === "turn.completed" ? event.payload.status : null;
  const completedFields = event.type === "turn.completed"
    ? pickDefined(event.payload, [
        "status",
        "duration_ms",
        "items_count",
        "token_usage",
        "ended_at",
        "turn_items_included",
      ])
    : {};
  return {
    session,
    thread_id: threadId,
    turn_id: turnId,
    outcome: event.type === "turn.completed" && completedStatus === "completed" ? "completed" : "error",
    event_type: event.type,
    event_id: event.id,
    ...completedFields,
    ...(event.type === "turn.error" ? { error: event.payload.error ?? event.payload } : {}),
  };
}

async function findTerminalEvent(
  ctx: DaemonContext,
  user: string,
  session: string,
  turnId: string,
): Promise<import("../../types").TeamEvent | null> {
  const listed = await ctx.events.listSince(user, null, { includeDelta: true });
  if (!listed.ok) return null;
  for (let i = listed.events.length - 1; i >= 0; i--) {
    const event = listed.events[i]!;
    if (event.session !== session) continue;
    if (event.type !== "turn.completed" && event.type !== "turn.error") continue;
    if (eventTurnId(event) !== turnId) continue;
    return event;
  }
  return null;
}

function parseTruncateFlag(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    if (normalized >= 0) return normalized;
    throw invalidParams("--truncate must be a non-negative integer");
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  throw invalidParams("--truncate must be a non-negative integer");
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

async function assertAttachable(filePath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    throw invalidParams(`--attach not readable: ${filePath}: ${(e as Error).message}`);
  }
  if (!stat.isFile()) {
    throw invalidParams(`--attach must point to a file: ${filePath}`);
  }
  if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath)) {
    throw invalidParams(`--attach currently supports image files only: ${filePath}`);
  }
}

async function listTurnsFromRelativeOffset(
  client: import("../../codex/appServerClient").AppServerClient,
  threadId: string,
  relativeSince: number,
  limit: number,
  retry: RetryOptions,
): Promise<ThreadTurnsListResponse> {
  const skip = Math.max(0, relativeSince - 1);
  let remainingSkip = skip;
  let cursor: string | undefined;
  const data: TurnListItem[] = [];
  let nextCursor: string | null = null;

  while (data.length < limit) {
    const pageSize = Math.max(limit - data.length, Math.min(100, remainingSkip + limit - data.length));
    const page = await threadTurnsList(client, threadId, {
      limit: Math.max(1, pageSize),
      cursor,
      sortDirection: "desc",
    }, retry);
    if (page.data.length === 0) {
      nextCursor = null;
      break;
    }
    if (remainingSkip >= page.data.length) {
      remainingSkip -= page.data.length;
      cursor = page.nextCursor ?? undefined;
      nextCursor = page.nextCursor ?? null;
      if (!cursor) break;
      continue;
    }

    const visible = page.data.slice(remainingSkip);
    remainingSkip = 0;
    const take = visible.slice(0, limit - data.length);
    data.push(...take);
    if (take.length < visible.length) {
      nextCursor = null;
      break;
    }
    nextCursor = page.nextCursor ?? null;
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
  }

  return { data, nextCursor };
}
