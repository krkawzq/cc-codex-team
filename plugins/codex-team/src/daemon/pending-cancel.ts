import type { DaemonContext } from "./context";
import {
  APPROVAL_REQUEST_CANCELLED_EVENT_TYPE,
  USER_INPUT_REQUEST_CANCELLED_EVENT_TYPE,
} from "./events";
import type { PendingRequest } from "./pending";

const JSONRPC_CANCEL_ERROR_CODE = -32000;

export async function cancelPendingWithEvent(
  ctx: DaemonContext,
  user: string,
  sessionName: string,
  threadId: string,
  reason: string,
  filter?: (p: PendingRequest) => boolean,
): Promise<void> {
  if (typeof ctx.pending.listForUser !== "function" || typeof ctx.pending.remove !== "function") return;

  const matching = pendingRequestsForSession(ctx, user, sessionName, filter);
  for (const pending of matching) {
    const removed = ctx.pending.remove(pending.request_id) ?? pending;
    if (removed.responded_at) continue;

    try {
      removed.client.respondError(
        removed.jsonrpc_id,
        JSONRPC_CANCEL_ERROR_CODE,
        cancellationClientMessage(reason),
      );
    } catch {
      /* ignore */
    }

    const eventType = cancellationEventType(removed.kind);
    if (!eventType) continue;

    // Live teardown still has in-memory pending metadata, so 0.5.2 can emit one best-effort
    // cancellation event per dropped request. Restart-time fallback uses a session-scoped event instead.
    await ctx.events.append(user, {
      type: eventType,
      session: removed.session_name ?? normalizeSessionName(sessionName),
      thread_id: removed.thread_id ?? normalizeThreadId(threadId),
      payload: {
        request_id: removed.request_id,
        kind: removed.kind,
        turn_id: removed.turn_id ?? null,
        reason,
      },
    });
  }
}

export function pendingRequestsForSession(
  ctx: Pick<DaemonContext, "pending">,
  user: string,
  sessionName: string,
  filter?: (p: PendingRequest) => boolean,
): PendingRequest[] {
  if (typeof ctx.pending.listForUser !== "function") return [];
  return ctx.pending
    .listForUser(user)
    .filter((pending) => matchesSession(pending, sessionName) && (!filter || filter(pending)));
}

function matchesSession(pending: PendingRequest, sessionName: string): boolean {
  if (sessionName === "*") return true;
  return pending.session_name === sessionName;
}

function cancellationClientMessage(reason: string): string {
  switch (reason) {
    case "user_detach":
      return "session detached";
    case "idle_unload":
      return "session idle_unloaded";
    case "user_destroyed":
      return "user destroyed";
    case "session_seized":
      return "session seized by another user";
    case "session_heal_force_reset":
    case "session_crashed":
    case "app_server_crashed_on_restart":
      return "session_crashed";
    default:
      return reason;
  }
}

function cancellationEventType(kind: string): string | null {
  if (kind.startsWith("approval.")) return APPROVAL_REQUEST_CANCELLED_EVENT_TYPE;
  if (kind === "user_input.request") return USER_INPUT_REQUEST_CANCELLED_EVENT_TYPE;
  return null;
}

function normalizeSessionName(sessionName: string): string | null {
  return sessionName.length > 0 && sessionName !== "*" ? sessionName : null;
}

function normalizeThreadId(threadId: string): string | null {
  return threadId.length > 0 ? threadId : null;
}
