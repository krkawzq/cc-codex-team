import crypto from "node:crypto";

import type { DaemonContext } from "./context";
import { normalizeNotification, normalizeServerRequest } from "./normalize";
import { AUTO_APPROVED_EVENT_TYPE } from "./events";
import type { PoolClientClose, PoolNotification, PoolServerRequest } from "../codex/pool";
import type { JsonValue } from "../codex/errors";
import { threadResume, threadUnsubscribe } from "../codex/rpc";
import { isoFromUnixSeconds, normalizeTokenUsage } from "./sessions";
import { logger } from "../logger";
import { matchAutoApprovePattern } from "./auto-approve";
import { buildExperimentalToolAppServerOptions } from "./experimentalTools";
import { buildApprovalShortcutResponse, preferredAutoApprovalShortcut } from "./handlers/message";

export function wireDaemonEvents(ctx: DaemonContext): void {
  ctx.pool.on("notification", (e) => {
    void handleNotification(ctx, e).catch((err) => {
      logger.warn("notification handling failed", { err: (err as Error).message });
    });
  });

  ctx.pool.on("server_request", (e) => {
    void handleServerRequest(ctx, e).catch((err) => {
      logger.warn("server request handling failed", { err: (err as Error).message });
    });
  });

  ctx.pool.on("client_close", (e) => {
    void handleClientClose(ctx, e).catch((err) => {
      logger.warn("client close handling failed", { err: (err as Error).message });
    });
  });
}

async function handleNotification(
  ctx: DaemonContext,
  e: PoolNotification,
): Promise<void> {
  const norm = normalizeNotification(e.notification);
  const sessionName = resolveSession(ctx, e.user, norm.threadId);
  const rec = sessionName ? ctx.sessions.get(e.user, sessionName) : null;

  const logged = await ctx.events.append(e.user, {
    type: norm.type,
    session: sessionName,
    thread_id: norm.threadId,
    payload: norm.payload,
  });

  if (norm.type === "turn.started" && sessionName && rec) {
    const turnId = (norm.payload.turn_id as string | null) ?? null;
    ctx.queues.setCurrentTurn(keyFor(e.user, sessionName), turnId);
    ctx.sessions.update(e.user, sessionName, {
      state: "live",
      crash_reason: null,
      last_turn_id: turnId,
      current_turn_id: turnId,
      current_turn_started_at: isoFromUnixSeconds(norm.payload.started_at, logged.ts),
      current_item_type: null,
      items_in_turn: 0,
    });
  }

  if (norm.type === "item.started" && sessionName && rec) {
    ctx.sessions.update(e.user, sessionName, {
      current_item_type: (norm.payload.type as string | null) ?? null,
      last_turn_id: (norm.payload.turn_id as string | null) ?? rec.last_turn_id ?? null,
    });
  }

  if (norm.type === "item.completed" && sessionName && rec) {
    ctx.sessions.update(e.user, sessionName, {
      current_item_type: null,
      items_in_turn: (rec.items_in_turn ?? 0) + 1,
      last_turn_id: (norm.payload.turn_id as string | null) ?? rec.last_turn_id ?? null,
    });
  }

  if (norm.type === "thread.token_usage_updated" && sessionName && rec) {
    const tokenUsage = normalizeTokenUsage(norm.payload.token_usage);
    if (tokenUsage) {
      ctx.sessions.update(e.user, sessionName, {
        token_usage_last_turn: tokenUsage,
        last_turn_id: (norm.payload.turn_id as string | null) ?? rec.last_turn_id ?? null,
      });
    }
  }

  if (norm.type === "turn.error" && sessionName && rec) {
    ctx.sessions.update(e.user, sessionName, {
      last_turn_id: (norm.payload.turn_id as string | null) ?? rec.last_turn_id ?? null,
      current_turn_id: null,
      current_turn_started_at: null,
      current_item_type: null,
      items_in_turn: 0,
    });
  }

  if (norm.type === "turn.completed" && sessionName && norm.threadId) {
    if (rec) {
      ctx.sessions.update(e.user, sessionName, {
        last_turn_id: (norm.payload.turn_id as string | null) ?? rec.last_turn_id ?? null,
        current_turn_id: null,
        current_turn_started_at: null,
        current_item_type: null,
        items_in_turn: 0,
        turn_count: (rec.turn_count ?? 0) + 1,
      });
    }
    const client = ctx.pool.clientForSession(keyFor(e.user, sessionName));
    void ctx.queues.onTurnCompleted(keyFor(e.user, sessionName), client, norm.threadId, ctx.retryOptions()).then(async (next) => {
      if (next.turn_id) {
        logger.debug("drained queued turn", { session: sessionName, turn_id: next.turn_id, queue_id: next.queue_id });
        await ctx.events.append(e.user, {
          type: "turn.queued_started",
          session: sessionName,
          thread_id: norm.threadId,
          payload: {
            turn_id: next.turn_id,
            queue_id: next.queue_id,
          },
        });
        return;
      }

      if (next.failed && next.queue_id) {
        logger.warn("queued turn remains enqueued after dispatch failure", {
          session: sessionName,
          queue_id: next.queue_id,
          err: next.error_message,
        });
        await ctx.events.append(e.user, {
          type: "turn.queued_failed",
          session: sessionName,
          thread_id: norm.threadId,
          payload: {
            queue_id: next.queue_id,
            error: {
              message: next.error_message,
            },
          },
        });
      }
    }).catch((err) => {
      logger.warn("turn completion queue drain failed", {
        session: sessionName,
        err: (err as Error).message,
      });
    });
  }

  if (norm.type === "thread.closed" && sessionName) {
    try {
      await closeSession(ctx, e.user, sessionName, "user_detach", "session detached", false);
    } catch (err) {
      logger.warn("thread closed cleanup failed", { session: sessionName, err: (err as Error).message });
    }
  }

  if (norm.type === "server_request_resolved") {
    const reqId = norm.payload.request_id;
    if (reqId !== null && reqId !== undefined) {
      const jsonrpcId = reqId as string | number;
      const client = ctx.pool.clientById(e.clientId);
      if (client) {
        const removed = ctx.pending.removeByJsonrpcId(client, jsonrpcId);
        if (removed?.session_name) {
          adjustPendingCounts(ctx, removed.user, removed.session_name, removed.kind, -1);
        }
      } else {
        for (const p of ctx.pending.listForUser(e.user)) {
          if (String(p.jsonrpc_id) === String(jsonrpcId)) {
            const removed = ctx.pending.remove(p.request_id);
            if (removed?.session_name) {
              adjustPendingCounts(ctx, removed.user, removed.session_name, removed.kind, -1);
            }
            break;
          }
        }
      }
    }
  }

  if (norm.type === "client_close" && sessionName && norm.threadId) {
    if (isSessionIdle(ctx, e.user, sessionName)) {
      try {
        await closeSession(ctx, e.user, sessionName, "idle_unload", "session idle_unloaded", true);
      } catch (err) {
        logger.warn("idle unload cleanup failed", { session: sessionName, err: (err as Error).message });
      }
    }
  }
}

async function handleServerRequest(
  ctx: DaemonContext,
  e: Pick<PoolServerRequest, "user" | "clientId" | "request" | "respondError">,
): Promise<void> {
  const norm = normalizeServerRequest(e.request);
  const sessionName = resolveSession(ctx, e.user, norm.threadId);
  if (!sessionName) {
    e.respondError(-32000, "session detached");
    return;
  }

  if (ctx.queues.isTeardown(keyFor(e.user, sessionName))) {
    e.respondError(-32000, "session detached");
    return;
  }

  const effectiveClient = ctx.pool.clientById(e.clientId);
  if (!effectiveClient) {
    logger.warn("server_request: no client to track", { user: e.user, kind: norm.kind });
    e.respondError(-32000, "no client available");
    return;
  }

  if (await maybeAutoApproveRequest(ctx, e.user, sessionName, norm, effectiveClient, e.request.id)) {
    return;
  }

  const pending = ctx.pending.add({
    client: effectiveClient,
    jsonrpc_id: e.request.id,
    kind: norm.kind,
    user: e.user,
    session_name: sessionName,
    thread_id: norm.threadId,
    turn_id: (norm.payload.turn_id as string) ?? null,
    raw: norm.payload.raw as Record<string, unknown>,
  });

  const payload = { ...norm.payload, request_id: pending.request_id };
  adjustPendingCounts(ctx, e.user, sessionName, norm.kind, 1);
  await ctx.events.append(e.user, {
    type: norm.type,
    session: sessionName,
    thread_id: norm.threadId,
    payload,
  });
}

async function handleClientClose(
  ctx: DaemonContext,
  e: PoolClientClose,
): Promise<void> {
  if (e.reason !== "unexpected") return;

  for (const sessionKey of e.sessions) {
    const [user, sessionName] = parseKey(sessionKey);
    if (!user || !sessionName) continue;
    const rec = ctx.sessions.get(user, sessionName);
    if (!rec) continue;

    const currentTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
    const reason = `app-server process exited unexpectedly (exit_code=${e.exitCode ?? "null"})`;
    ctx.sessions.update(user, sessionName, {
      state: "crashed",
      recovery_state: "degraded",
      crash_reason: reason,
      pending_approvals: 0,
      pending_user_inputs: 0,
      current_item_type: null,
    });
    await appendSessionCrashed(ctx, user, rec.name, rec.thread_id, reason, currentTurnId ?? rec.last_turn_id ?? null);
    if (currentTurnId) {
      await ctx.events.append(user, {
        type: "turn.error",
        session: sessionName,
        thread_id: rec.thread_id,
        payload: {
          turn_id: currentTurnId,
          will_retry: false,
          error: {
            message: "app-server process exited unexpectedly",
            codex_error_info: "internal_server_error",
            additional_details: `exit_code=${e.exitCode ?? "null"}`,
          },
        },
      });
    }
    await appendSessionClosed(ctx, user, rec.name, rec.thread_id, "app_server_crashed");
    ctx.queues.onClientClosed(sessionKey);
    ctx.pending.abortForSession(user, sessionName, "session_crashed", {
      reason: "session_crashed",
      session: rec.name,
      thread_id: rec.thread_id,
    });
  }
}

function resolveSession(ctx: DaemonContext, user: string, threadId: string | null): string | null {
  if (!threadId) return null;
  const rec = ctx.sessions.get(user, threadId);
  return rec ? rec.name : null;
}

async function maybeAutoApproveRequest(
  ctx: DaemonContext,
  user: string,
  sessionName: string,
  norm: ReturnType<typeof normalizeServerRequest>,
  client: NonNullable<ReturnType<DaemonContext["pool"]["clientById"]>>,
  jsonrpcId: string | number,
): Promise<boolean> {
  if (!norm.kind.startsWith("approval.")) return false;
  const rec = ctx.sessions.get(user, sessionName);
  const patterns = rec?.autoApprovePatterns ?? [];
  if (patterns.length === 0) return false;

  const shortcut = preferredAutoApprovalShortcut(norm.kind);
  if (!shortcut) return false;

  const match = matchAutoApprovePattern(patterns, norm.autoApproveTarget);
  if (!match) return false;

  const requestId = `req-${crypto.randomBytes(4).toString("hex")}`;
  const response = buildApprovalShortcutResponse(norm.kind, norm.payload.raw as Record<string, unknown>, shortcut);

  let ack: { backpressured: boolean };
  try {
    ack = await client.respondAck(jsonrpcId, response as JsonValue);
  } catch (err) {
    await emitWarning(ctx, user, sessionName, norm.threadId, {
      message: `auto-approval reply delivery failed: ${(err as Error).message}`,
      kind: "auto_approval_reply_delivery_failed",
      request_id: requestId,
    });
    return false;
  }

  await ctx.events.append(user, {
    type: AUTO_APPROVED_EVENT_TYPE,
    session: sessionName,
    thread_id: norm.threadId,
    payload: {
      request_id: requestId,
      kind: norm.kind,
      matched_pattern: match.matchedPattern,
      command_preview: match.commandPreview,
    },
  }).catch(() => undefined);

  if (ack.backpressured) {
    await emitWarning(ctx, user, sessionName, norm.threadId, {
      message: "auto-approval reply is delayed by app-server stdin backpressure",
      kind: "auto_approval_reply_backpressured",
      request_id: requestId,
    });
  }

  return true;
}

async function emitWarning(
  ctx: DaemonContext,
  user: string,
  session: string | null,
  threadId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.events.append(user, {
    type: "warning",
    session,
    thread_id: threadId,
    payload,
  }).catch(() => undefined);
}

function keyFor(user: string, name: string): string {
  return `${user}::${name}`;
}

function parseKey(sessionKey: string): [string | null, string | null] {
  const idx = sessionKey.indexOf("::");
  if (idx < 0) return [null, null];
  return [sessionKey.slice(0, idx), sessionKey.slice(idx + 2)];
}

function adjustPendingCounts(
  ctx: DaemonContext,
  user: string,
  sessionName: string,
  kind: string,
  delta: number,
): void {
  const rec = ctx.sessions.get(user, sessionName);
  if (!rec) return;
  if (kind.startsWith("approval.")) {
    ctx.sessions.update(user, sessionName, {
      pending_approvals: Math.max(0, (rec.pending_approvals ?? 0) + delta),
    });
    return;
  }
  if (kind === "user_input.request") {
    ctx.sessions.update(user, sessionName, {
      pending_user_inputs: Math.max(0, (rec.pending_user_inputs ?? 0) + delta),
    });
  }
}

function isSessionIdle(ctx: DaemonContext, user: string, sessionName: string): boolean {
  const sessionKey = keyFor(user, sessionName);
  const rec = ctx.sessions.get(user, sessionName);
  return Boolean(rec)
    && (rec?.state ?? "live") === "live"
    && (rec?.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey)) === null
    && ctx.queues.depth(sessionKey) === 0
    && (rec?.pending_approvals ?? 0) === 0
    && (rec?.pending_user_inputs ?? 0) === 0;
}

async function closeSession(
  ctx: DaemonContext,
  user: string,
  sessionName: string,
  reason: "user_detach" | "daemon_shutdown" | "app_server_crashed" | "idle_unload" | "user_destroyed",
  pendingMessage: string,
  unsubscribe: boolean,
): Promise<void> {
  const rec = ctx.sessions.get(user, sessionName);
  if (!rec) return;
  const sessionKey = keyFor(user, sessionName);
  const client = ctx.pool.clientForSession(sessionKey);
  if (unsubscribe && client) {
    try { await threadUnsubscribe(client, rec.thread_id, ctx.retryOptions()); } catch { /* ignore */ }
  }
  ctx.pool.release(sessionKey);
  ctx.queues.dispose(sessionKey);
  ctx.sessions.remove(user, sessionName);
  for (const p of ctx.pending.removeForSession(user, sessionName)) {
    try { p.client.respondError(p.jsonrpc_id, -32000, pendingMessage); } catch { /* ignore */ }
  }
  await appendSessionClosed(ctx, user, rec.name, rec.thread_id, reason);
}

async function appendSessionClosed(
  ctx: DaemonContext,
  user: string,
  session: string,
  threadId: string,
  reason: "user_detach" | "daemon_shutdown" | "app_server_crashed" | "idle_unload" | "user_destroyed",
): Promise<void> {
  await ctx.events.append(user, {
    type: "session.closed",
    session,
    thread_id: threadId,
    payload: {
      session,
      thread_id: threadId,
      reason,
      ts: new Date().toISOString(),
    },
  });
}

async function appendSessionCrashed(
  ctx: DaemonContext,
  user: string,
  session: string,
  threadId: string,
  reason: string,
  lastTurnId: string | null,
): Promise<void> {
  await ctx.events.append(user, {
    type: "session.crashed",
    session,
    thread_id: threadId,
    payload: {
      session,
      thread_id: threadId,
      reason,
      last_turn_id: lastTurnId,
    },
  });
}
