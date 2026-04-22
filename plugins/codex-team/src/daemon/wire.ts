import type { DaemonContext } from "./context";
import { normalizeNotification, normalizeServerRequest } from "./normalize";
import type { PoolClientClose, PoolNotification, PoolServerRequest } from "../codex/pool";
import { logger } from "../logger";

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

  await ctx.events.append(e.user, {
    type: norm.type,
    session: sessionName,
    thread_id: norm.threadId,
    payload: norm.payload,
  });

  if (norm.type === "turn.started" && sessionName) {
    ctx.queues.setCurrentTurn(keyFor(e.user, sessionName), (norm.payload.turn_id as string | null) ?? null);
  }

  if (norm.type === "turn.completed" && sessionName && norm.threadId) {
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
      const key = keyFor(e.user, sessionName);
      ctx.pool.release(key);
      ctx.queues.dispose(key);
      ctx.sessions.remove(e.user, sessionName);
      for (const p of ctx.pending.removeForSession(e.user, sessionName)) {
        try { p.client.respondError(p.jsonrpc_id, -32000, "session detached"); } catch { /* ignore */ }
      }
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
        ctx.pending.removeByJsonrpcId(client, jsonrpcId);
      } else {
        for (const p of ctx.pending.listForUser(e.user)) {
          if (String(p.jsonrpc_id) === String(jsonrpcId)) {
            ctx.pending.remove(p.request_id);
            break;
          }
        }
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
  const effectiveClient = ctx.pool.clientById(e.clientId);
  if (!effectiveClient) {
    logger.warn("server_request: no client to track", { user: e.user, kind: norm.kind });
    e.respondError(-32000, "no client available");
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
  await ctx.events.append(e.user, {
    type: norm.type,
    session: sessionName,
    thread_id: norm.threadId,
    payload,
  });
}

async function handleClientClose(
  ctx: DaemonContext,
  e: Pick<PoolClientClose, "sessions" | "exitCode">,
): Promise<void> {
  for (const sessionKey of e.sessions) {
    const [user, sessionName] = parseKey(sessionKey);
    if (!user || !sessionName) continue;
    const rec = ctx.sessions.get(user, sessionName);
    if (!rec) continue;
    await ctx.events.append(user, {
      type: "turn.error",
      session: sessionName,
      thread_id: rec.thread_id,
      payload: {
        will_retry: false,
        error: {
          message: "app-server process exited unexpectedly",
          codex_error_info: "internal_server_error",
          additional_details: `exit_code=${e.exitCode ?? "null"}`,
        },
      },
    });
    ctx.queues.dispose(sessionKey);
    for (const p of ctx.pending.removeForSession(user, sessionName)) {
      void p;
    }
  }
}

function resolveSession(ctx: DaemonContext, user: string, threadId: string | null): string | null {
  if (!threadId) return null;
  const rec = ctx.sessions.get(user, threadId);
  return rec ? rec.name : null;
}

function keyFor(user: string, name: string): string {
  return `${user}::${name}`;
}

function parseKey(sessionKey: string): [string | null, string | null] {
  const idx = sessionKey.indexOf("::");
  if (idx < 0) return [null, null];
  return [sessionKey.slice(0, idx), sessionKey.slice(idx + 2)];
}
