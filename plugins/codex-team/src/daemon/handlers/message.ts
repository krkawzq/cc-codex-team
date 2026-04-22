import fs from "node:fs";

import type { HandlerFn } from "../dispatch";
import type { DaemonContext } from "../context";
import type { IpcRequest } from "../../ipc/protocol";
import type { JsonValue } from "../../codex/errors";
import { CodexTeamError, invalidParams } from "../../errors";
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

  const response = await buildResponse(req, pending, shortcut);
  pending.client.respond(pending.jsonrpc_id, response as JsonValue);
  ctx.pending.remove(requestId);
  return {
    session: rec.name,
    request_id: requestId,
    kind: pending.kind,
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

  const response = await buildAnswerResponse(req, pending, inline);
  pending.client.respond(pending.jsonrpc_id, response as JsonValue);
  ctx.pending.remove(requestId);
  return { session: rec.name, request_id: requestId, responded: true, response };
};

export const messageHistory: HandlerFn = async (ctx, req) => {
  const { rec, client } = await resolveLive(ctx, req);
  const limitRaw = getFlag(req, "limit");
  const limit = typeof limitRaw === "string" ? parseInt(limitRaw, 10) : typeof limitRaw === "number" ? limitRaw : 50;
  const sinceRaw = asString(getFlag(req, "since"));
  const format = asString(getFlag(req, "format")) ?? "json";
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
    });
  }
  return response;
};

export const messageTail: HandlerFn = async (ctx, req, stream) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const nRaw = getFlag(req, "n");
  const n = typeof nRaw === "string" ? parseInt(nRaw, 10) : typeof nRaw === "number" ? nRaw : 3;
  const format = asString(getFlag(req, "format")) ?? "json";
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
      });
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
  const client = ctx.pool.clientForSession(keyFor(user, rec.name));
  if (!client) {
    // lazy re-spawn: acquire again
    const fresh = await ctx.pool.acquire(user, keyFor(user, rec.name));
    return { user, rec, client: fresh };
  }
  return { user, rec, client };
}

function requirePending(ctx: DaemonContext, user: string, requestId: string): PendingRequest {
  const p = ctx.pending.get(requestId);
  if (!p) throw new CodexTeamError("invalid_params", `no pending request '${requestId}'`);
  if (p.user !== user) throw new CodexTeamError("invalid_params", `pending request '${requestId}' belongs to another user`);
  return p;
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

  switch (pending.kind) {
    case "approval.command_execution":
    case "approval.file_change":
      return { decision: commandOrFileShortcut(shortcut, pending.kind) };
    case "approval.permissions":
      return permissionsShortcut(shortcut, pending.raw);
    case "approval.mcp_elicitation":
      return mcpElicitationShortcut(shortcut, pending.raw);
    default:
      throw new CodexTeamError("invalid_decision", `unknown approval kind '${pending.kind}'`);
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

function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
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
