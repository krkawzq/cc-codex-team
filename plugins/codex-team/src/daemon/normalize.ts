import type { JsonValue } from "../codex/errors";
import type { ServerNotification, ServerRequest } from "../codex/appServerClient";

const NOTIF_MAP: Record<string, string> = {
  "turn/started": "turn.started",
  "turn/completed": "turn.completed",
  "error": "turn.error",

  "item/started": "item.started",
  "item/completed": "item.completed",
  "item/mcpToolCall/progress": "item.mcp_tool_call_progress",
  "item/fileChange/patchUpdated": "item.file_change_patch_updated",
  "item/commandExecution/terminalInteraction": "item.command_exec_terminal_interaction",
  "item/autoApprovalReview/started": "item.auto_approval_review_started",
  "item/autoApprovalReview/completed": "item.auto_approval_review_completed",

  // High-frequency deltas — will be marked as delta category
  "item/agentMessage/delta": "item.agent_message_delta",
  "item/commandExecution/outputDelta": "item.command_exec_output_delta",
  "item/fileChange/outputDelta": "item.file_change_output_delta",
  "item/reasoning/textDelta": "item.reasoning_text_delta",
  "item/reasoning/summaryTextDelta": "item.reasoning_summary_text_delta",
  "item/reasoning/summaryPartAdded": "item.reasoning_summary_part_added",
  "item/plan/delta": "item.plan_delta",

  "thread/started": "thread.started",
  "thread/closed": "thread.closed",
  "thread/status/changed": "thread.status_changed",
  "thread/tokenUsage/updated": "thread.token_usage_updated",
  "thread/name/updated": "thread.name_updated",
  "thread/archived": "thread.archived",
  "thread/unarchived": "thread.unarchived",
  "thread/compacted": "context_compacted",

  "model/rerouted": "model_rerouted",
  "serverRequest/resolved": "server_request_resolved",
  "fuzzyFileSearch/sessionUpdated": "fuzzy_file_search.session_updated",
  "fuzzyFileSearch/sessionCompleted": "fuzzy_file_search.session_completed",
  "hook/started": "hook.started",
  "hook/completed": "hook.completed",

  "warning": "warning",
  "configWarning": "config_warning",
  "deprecationNotice": "deprecation_notice",
  "account/updated": "account.updated",
  "account/rateLimits/updated": "account.rate_limits_updated",
  "account/login/completed": "account.login_completed",
  "mcpServer/startupStatus/updated": "mcp_server.status_updated",
  "mcpServer/oauthLogin/completed": "mcp_server.oauth_login_completed",
  "app/list/updated": "app.list_updated",
  "skills/changed": "skills.changed",
  "fs/changed": "fs.changed",
};

const REQUEST_MAP: Record<string, string> = {
  "item/commandExecution/requestApproval": "approval.command_execution",
  "item/fileChange/requestApproval": "approval.file_change",
  "item/permissions/requestApproval": "approval.permissions",
  "mcpServer/elicitation/request": "approval.mcp_elicitation",
  "item/tool/requestUserInput": "user_input.request",
};

export interface NormalizedEvent {
  type: string;
  threadId: string | null;
  payload: Record<string, unknown>;
  isDelta: boolean;
}

export interface NormalizedRequest {
  type: string;
  threadId: string | null;
  payload: Record<string, unknown>;
  kind: string;
}

export function normalizeNotification(n: ServerNotification): NormalizedEvent {
  const type = NOTIF_MAP[n.method] ?? fallbackType(n.method);
  const params = asObject(n.params);
  const threadId = extractThreadId(params);
  const payload = buildNotificationPayload(type, params);
  return { type, threadId, payload, isDelta: type.endsWith("_delta") };
}

export function normalizeServerRequest(r: ServerRequest): NormalizedRequest {
  const kind = REQUEST_MAP[r.method] ?? fallbackType(r.method);
  const params = asObject(r.params);
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  const payload: Record<string, unknown> = {
    kind,
    turn_id: typeof params.turnId === "string" ? params.turnId : null,
    item_id: typeof params.itemId === "string" ? params.itemId : null,
    raw: params,
  };
  // Bubble frequently-used fields to top level for convenience
  if (kind === "approval.command_execution") {
    if (params.command !== undefined) payload.command = params.command;
    if (params.cwd !== undefined) payload.cwd = params.cwd;
    if (params.reason !== undefined) payload.reason = params.reason;
  } else if (kind === "approval.file_change") {
    if (params.reason !== undefined) payload.reason = params.reason;
    if (params.grantRoot !== undefined) payload.grant_root = params.grantRoot;
  } else if (kind === "approval.permissions") {
    if (params.reason !== undefined) payload.reason = params.reason;
    if (params.cwd !== undefined) payload.cwd = params.cwd;
    if (params.permissions !== undefined) payload.permissions = params.permissions;
  } else if (kind === "approval.mcp_elicitation") {
    if (params.serverName !== undefined) payload.server_name = params.serverName;
    if (params.mode !== undefined) payload.mode = params.mode;
    if (params.message !== undefined) payload.message = params.message;
    if (params.requestedSchema !== undefined) payload.requested_schema = params.requestedSchema;
    if (params.url !== undefined) payload.url = params.url;
  } else if (kind === "user_input.request") {
    if (Array.isArray(params.questions)) payload.questions = params.questions;
  }
  return { type: kind, threadId, payload, kind };
}

function buildNotificationPayload(type: string, params: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case "turn.started":
    case "turn.completed": {
      const turn = asObject(params.turn as JsonValue);
      const items = Array.isArray(turn.items) ? (turn.items as unknown[]) : [];
      if (type === "turn.completed") {
        // 0.5.2 event-digest change: keep turn.completed payloads lean and
        // source detailed turn/items data via message history or message tail.
        return {
          turn_id: (turn.id as string) ?? null,
          status: normalizeTurnCompletedStatus(turn.status),
          duration_ms: deriveDurationMs(turn),
          items_count: items.length,
          token_usage: deriveTurnTokenUsage(turn),
          ended_at: deriveTurnEndedAt(turn),
          turn_items_included: false,
        };
      }
      return {
        turn_id: (turn.id as string) ?? null,
        status: (turn.status as string) ?? null,
        started_at: asNumber(turn.startedAt),
        completed_at: asNumber(turn.completedAt),
        duration_ms: deriveDurationMs(turn),
        item_count: items.length,
        turn,
      };
    }
    case "turn.error": {
      const err = asObject(params.error as JsonValue);
      return {
        turn_id: (params.turnId as string) ?? null,
        will_retry: Boolean(params.willRetry),
        error: {
          message: err.message ?? null,
          codex_error_info: err.codexErrorInfo ?? null,
          additional_details: err.additionalDetails ?? null,
        },
      };
    }
    case "item.started":
    case "item.completed": {
      const item = asObject(params.item as JsonValue);
      return {
        item_id: (params.itemId as string) ?? (item.id as string) ?? null,
        turn_id: (params.turnId as string) ?? null,
        type: (item.type as string) ?? null,
        status: (item.status as string) ?? null,
      };
    }
    case "thread.started": {
      const thread = asObject(params.thread as JsonValue);
      return {
        thread_id: (thread.id as string) ?? null,
        source: (thread.source as string) ?? null,
        cwd: (thread.cwd as string) ?? null,
        thread,
      };
    }
    case "thread.closed":
    case "thread.archived":
    case "thread.unarchived":
      return {};
    case "thread.token_usage_updated":
      return {
        turn_id: (params.turnId as string) ?? null,
        token_usage: params.tokenUsage ?? null,
      };
    case "thread.name_updated":
      return { name: (params.threadName as string) ?? null };
    case "thread.status_changed":
      return { status: (params.status as string) ?? null };
    case "server_request_resolved":
      return {
        request_id: params.requestId ?? null,
      };
    case "model_rerouted":
      return { reason: params.reason ?? null };
    case "mcp_server.status_updated":
      return {
        name: (params.name as string) ?? null,
        status: (params.status as string) ?? null,
        error: (params.error as unknown) ?? null,
      };
    case "mcp_server.oauth_login_completed":
      return {
        name: (params.name as string) ?? null,
        success: Boolean(params.success),
        error: (params.error as unknown) ?? null,
      };
    case "warning":
    case "error":
      return {
        message: (params.message as string) ?? null,
        thread_id: (params.threadId as string) ?? null,
      };
    case "config_warning":
      return {
        summary: (params.summary as string) ?? null,
        details: (params.details as string) ?? null,
        path: (params.path as string) ?? null,
      };
    case "deprecation_notice":
      return {
        summary: (params.summary as string) ?? null,
        details: (params.details as string) ?? null,
      };
    case "hook.started":
    case "hook.completed": {
      const run = asObject(params.run as JsonValue);
      return {
        turn_id: (params.turnId as string) ?? null,
        hook_id: (run.id as string) ?? null,
        status: (run.status as string) ?? null,
        run,
      };
    }
    case "context_compacted":
      return {
        turn_id: (params.turnId as string) ?? null,
      };
    case "fuzzy_file_search.session_updated":
    case "fuzzy_file_search.session_completed":
      return {
        search_session_id: (params.searchSessionId as string) ?? null,
      };
    default:
      if (type.endsWith("_delta")) {
        return {
          item_id: (params.itemId as string) ?? null,
          turn_id: (params.turnId as string) ?? null,
          delta: (params.delta as string) ?? "",
        };
      }
      return { raw: params };
  }
}

function deriveDurationMs(turn: Record<string, unknown>): number | null {
  const durationMs = asNumber(turn.durationMs);
  if (durationMs !== null) return durationMs;
  const startedAt = asNumber(turn.startedAt);
  const completedAt = asNumber(turn.completedAt);
  if (startedAt !== null && completedAt !== null) {
    const deltaMs = (completedAt - startedAt) * 1000;
    if (Number.isFinite(deltaMs)) return Math.max(0, Math.round(deltaMs));
  }
  return null;
}

function deriveTurnEndedAt(turn: Record<string, unknown>): number | null {
  return asNumber(turn.endedAt) ?? asNumber(turn.completedAt);
}

function normalizeTurnCompletedStatus(value: unknown): "completed" | "errored" | "cancelled" | null {
  if (typeof value !== "string") return null;
  if (value === "completed") return "completed";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "errored" || value === "error" || value === "failed") return "errored";
  return null;
}

function deriveTurnTokenUsage(turn: Record<string, unknown>): {
  prompt: number | null;
  completion: number | null;
  total: number | null;
} {
  const usageSource = turn.tokenUsage ?? turn.token_usage ?? turn.usage;
  const usage = asObject(usageSource);
  const prompt =
    asNumber(usage.prompt) ??
    asNumber(usage.promptTokens) ??
    asNumber(usage.prompt_tokens) ??
    asNumber(usage.input) ??
    asNumber(usage.inputTokens) ??
    asNumber(usage.input_tokens);
  const completion =
    asNumber(usage.completion) ??
    asNumber(usage.completionTokens) ??
    asNumber(usage.completion_tokens) ??
    asNumber(usage.output) ??
    asNumber(usage.outputTokens) ??
    asNumber(usage.output_tokens);
  const total =
    asNumber(usage.total) ??
    asNumber(usage.totalTokens) ??
    asNumber(usage.total_tokens);

  return { prompt, completion, total };
}

function fallbackType(method: string): string {
  return method.replace(/\//g, ".").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function asObject(value: JsonValue | unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractThreadId(params: Record<string, unknown>): string | null {
  if (typeof params.threadId === "string") return params.threadId;
  const thread = asObject(params.thread as JsonValue);
  return typeof thread.id === "string" ? thread.id : null;
}
