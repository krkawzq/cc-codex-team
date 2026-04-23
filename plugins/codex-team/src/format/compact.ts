export function formatCompact(method: string, data: unknown): Record<string, unknown> {
  switch (method) {
    case "version":
      return pickFields(data, ["daemon_version"]);
    case "profiles:list":
      return compactProfilesList(data);
    case "profiles:show":
      return compactProfileShow(data);
    case "status":
      return pickFields(data, [
        "token",
        "live_sessions",
        "retained_events",
        "retained_limit",
        "pending_requests",
        "app_server_count",
      ]);
    case "daemon:fleet:status":
      return compactDaemonFleetStatus(data);
    case "daemon:status":
      return pickFields(data, [
        "pid",
        "version",
        "uptime_s",
        "sock",
        "session_count",
        "user_count",
        "app_server_count",
        "dist_age_seconds",
        "source_newer_than_dist",
      ]);
    case "daemon:start":
      return pickFields(data, ["already_running"]);
    case "daemon:stop":
      return pickFields(data, ["stopping", "force"]);
    case "daemon:restart":
      return pickFields(data, ["restarting"]);
    case "daemon:logs":
      return asObject(data);
    case "daemon:user:create":
      return pickFields(data, ["token"]);
    case "daemon:user:destroy":
      return pickFields(data, ["destroyed"]);
    case "daemon:user:list":
      return compactDaemonUserList(data);
    case "daemon:config:get":
      return pickFields(data, ["key", "value", "default", "source", "needs_restart"]);
    case "daemon:config:set":
      return pickFields(data, ["key", "value", "needs_restart"]);
    case "daemon:config:unset":
      return pickFields(data, ["key", "needs_restart"]);
    case "daemon:config:list":
      return compactDaemonConfigList(data);
    case "daemon:config:reset":
      return pickFields(data, ["reset"]);
    case "session:new":
      return compactSessionWithFlags(data, {
        sessionOptions: { includeCreatedAt: true },
      });
    case "session:attach":
      return compactSessionWithFlags(data, {
        sessionOptions: {},
        extraKeys: ["noop"],
      });
    case "session:detach":
      return compactSessionDetach(data);
    case "session:archive":
      return pickFields(data, ["thread_id", "archived"]);
    case "session:unarchive":
      return pickFields(data, ["thread_id", "unarchived"]);
    case "session:fork":
      return compactSessionWithFlags(data, {
        sessionOptions: {},
      });
    case "session:rename":
      return compactSessionWithFlags(data, {
        sessionOptions: { nameOnly: true },
      });
    case "session:rollback":
      return pickFields(data, ["name", "forked_at_turn", "old_thread_id", "new_thread_id"]);
    case "session:info":
      return compactSessionInfo(data);
    case "session:context":
      return compactSessionContext(data);
    case "session:list":
      return compactSessionList(data);
    case "session:health":
      return pickFields(data, [
        "session",
        "thread_id",
        "state",
        "busy",
        "current_turn_id",
        "current_turn_elapsed_ms",
        "current_item_type",
        "items_done_in_turn",
        "pending_approval_requests",
        "pending_user_input_requests",
        "app_server_alive",
        "last_event_id",
      ]);
    case "session:health:all":
      return compactSessionHealthAll(data);
    case "session:events":
      return asObject(data);
    case "session:logs":
      return compactSessionLogs(data);
    case "session:heal":
      return compactSessionHeal(data);
    case "message:send":
      return pickFields(data, ["turn_id", "started", "queue_id", "queued_depth"]);
    case "message:send-many":
      return compactBatchResults(data, ["turn_id", "started", "queue_id", "queued_depth"]);
    case "message:peer":
      return pickFields(data, ["turn_id", "peered"]);
    case "message:interrupt":
      return pickFields(data, ["turn_id", "interrupted"]);
    case "message:approval":
    case "message:answer":
      return {};
    case "message:history":
      return compactMessageHistory(data);
    case "message:tail":
      return compactMessageTail(data);
    case "message:wait":
      return compactMessageWait(data);
    case "monitor:events":
      return compactMonitorEvent(data);
    case "monitor:alarm":
      return asObject(data);
    case "cursor:save":
      return compactCursorSave(data);
    case "cursor:list":
      return compactCursorList(data);
    case "cursor:get":
      return pickFields(data, ["event_id"]);
    case "cursor:delete":
      return pickFields(data, ["deleted", "name"]);
    default:
      return asObject(data);
  }
}

interface SessionProjectionOptions {
  includeCreatedAt?: boolean;
  includeModel?: boolean;
  includeTurnCount?: boolean;
  includeCurrentTurnId?: boolean;
  includeItemsInTurn?: boolean;
  includePendingApprovals?: boolean;
  includePendingUserInputs?: boolean;
  includeBusy?: boolean;
  nameOnly?: boolean;
}

function compactProfilesList(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  return {
    profiles: asArray(value.profiles).map((entry) => pickFields(entry, ["name", "flags"])),
  };
}

function compactProfileShow(data: unknown): Record<string, unknown> {
  return pickFields(data, ["name", "flags", "command"]);
}

function compactDaemonUserList(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  return {
    users: asArray(value.users).map((entry) => pickFields(entry, ["token"])),
  };
}

function compactDaemonConfigList(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  return {
    config: asArray(value.config).map((entry) => pickFields(entry, [
      "key",
      "value",
      "default",
      "explicit",
      "needs_restart",
      "type",
    ])),
  };
}

function compactDaemonFleetStatus(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  return {
    total_users: value.total_users,
    total_live_sessions: value.total_live_sessions,
    total_pending: value.total_pending,
    total_app_servers: value.total_app_servers,
    per_user: asArray(value.per_user).map((entry) => pickFields(entry, [
      "token",
      "live",
      "busy",
      "pending",
      "crashed",
      "last_event_id",
      "last_activity_age_s",
    ])),
  };
}

function compactSessionWithFlags(
  data: unknown,
  options: {
    sessionOptions: SessionProjectionOptions;
    extraKeys?: string[];
    allowNullSession?: boolean;
  },
): Record<string, unknown> {
  const value = asObject(data);
  const out: Record<string, unknown> = {};
  if (hasOwn(value, "session")) {
    if (value.session === null && options.allowNullSession) {
      out.session = null;
    } else {
      out.session = projectSession(value.session, options.sessionOptions);
    }
  }
  for (const key of options.extraKeys ?? []) {
    copyIfPresent(out, value, key);
  }
  return out;
}

function compactSessionInfo(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  if (value.session === null) {
    const out: Record<string, unknown> = { session: null };
    copyIfPresent(out, value, "live");
    const thread = projectThread(value.thread);
    if (Object.keys(thread).length > 0) out.thread = thread;
    return out;
  }

  return compactSessionWithFlags(data, {
    sessionOptions: {
      includeModel: true,
      includeTurnCount: true,
      includeCurrentTurnId: true,
      includeItemsInTurn: true,
      includePendingApprovals: true,
      includePendingUserInputs: true,
    },
  });
}

function compactSessionDetach(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  if (Array.isArray(value.results)) {
    return compactBatchResults(data, ["detached", "graceful"]);
  }
  return compactSessionWithFlags(data, {
    sessionOptions: {},
    extraKeys: ["noop", "graceful"],
    allowNullSession: true,
  });
}

function compactSessionContext(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  const out = pickFields(value, ["thread_id"]);
  const thread = projectThread(value.thread);
  if (Object.keys(thread).length > 0) out.thread = thread;
  return out;
}

function compactSessionLogs(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  return pickFields(value, ["session", "state", "lines", "truncated_from"]);
}

function compactSessionList(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  const remote = value.all === true || value.loaded_only === true;
  const out: Record<string, unknown> = {
    sessions: asArray(value.sessions).map((entry) =>
      remote
        ? projectSession(entry, {
            includeModel: true,
            includeBusy: true,
          })
        : projectSession(entry, {
            includeModel: true,
            includeTurnCount: true,
            includeCurrentTurnId: true,
          })),
  };
  copyIfPresent(out, value, "all");
  if (value.loaded_only === true) copyIfPresent(out, value, "loaded_only");
  if (remote) copyIfPresent(out, value, "next_cursor");
  return out;
}

function compactSessionHeal(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  const out: Record<string, unknown> = {};
  if (hasOwn(value, "session")) out.session = projectSession(value.session, {});
  copyIfPresent(out, value, "healed");
  copyIfPresent(out, value, "note");
  return out;
}

function compactSessionHealthAll(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  return {
    summary: pickFields(value.summary, ["total", "healthy", "crashed", "closed", "busy", "pending_total"]),
    sessions: asArray(value.sessions).map((entry) => pickFields(entry, [
      "session",
      "thread_id",
      "state",
      "busy",
      "current_turn_id",
      "current_turn_elapsed_ms",
      "current_item_type",
      "items_done_in_turn",
      "pending_approval_requests",
      "pending_user_input_requests",
      "app_server_alive",
      "last_event_id",
    ])),
  };
}

function compactMessageHistory(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  const out: Record<string, unknown> = {
    session: value.session,
    thread_id: value.thread_id,
    turns: asArray(value.turns),
  };
  copyIfPresent(out, value, "next_cursor");
  copyIfPresent(out, value, "relative_since");
  return stripUndefined(out);
}

function compactMessageTail(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  const out: Record<string, unknown> = {
    session: value.session,
    turns: asArray(value.turns),
  };
  copyIfPresent(out, value, "follow");
  const thread = projectThread(value.thread);
  if (Object.keys(thread).length > 0) out.thread = thread;
  return stripUndefined(out);
}

function compactMessageWait(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  if (Array.isArray(value.outcomes)) {
    return stripUndefined({
      outcomes: asArray(value.outcomes).map((entry) => pickFields(entry, [
        "session",
        "outcome",
        "turn_id",
        "codex_error_info",
      ])),
      overall: value.overall,
    });
  }
  if (Array.isArray(value.still_running)) {
    return stripUndefined({
      session: value.session,
      outcome: value.outcome,
      turn_id: value.turn_id,
      codex_error_info: value.codex_error_info,
      timeout_s: value.timeout_s,
      still_running: asArray(value.still_running),
    });
  }
  return pickFields(data, [
    "thread_id",
    "turn_id",
    "outcome",
    "event_type",
    "event_id",
    "error",
    "duration_ms",
    "items_count",
    "timeout_s",
  ]);
}

function compactBatchResults(data: unknown, successKeys: string[]): Record<string, unknown> {
  const value = asObject(data);
  return {
    results: asArray(value.results).map((entry) => projectBatchResultEntry(entry, successKeys)),
  };
}

function compactMonitorEvent(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  if (!hasOwn(value, "payload")) {
    return stripUndefined({
      id: value.id,
      ts: value.ts,
      type: value.type,
      session: value.session,
      thread_id: value.thread_id,
      key: value.key,
    });
  }

  return stripUndefined({
    id: value.id,
    ts: value.ts,
    type: value.type,
    session: value.session,
    thread_id: value.thread_id,
    key: summarizeEventKey(value),
  });
}

function compactCursorSave(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  return {
    cursor: projectCursor(value.cursor, { includeUpdatedAt: false, includeAutoUpdate: false }),
  };
}

function compactCursorList(data: unknown): Record<string, unknown> {
  const value = asObject(data);
  return {
    cursors: asArray(value.cursors).map((entry) => projectCursor(entry, {
      includeUpdatedAt: true,
      includeAutoUpdate: true,
    })),
  };
}

function projectSession(value: unknown, options: SessionProjectionOptions): Record<string, unknown> {
  const session = asObject(value);
  if (options.nameOnly) {
    return pickFields(session, ["name"]);
  }

  const out = pickFields(session, ["name", "thread_id", "state"]);
  if (options.includeCreatedAt) copyIfPresent(out, session, "created_at");
  if (options.includeModel) copyIfPresent(out, session, "model");
  if (options.includeTurnCount) copyIfPresent(out, session, "turn_count");
  if (options.includeCurrentTurnId) copyIfPresent(out, session, "current_turn_id");
  if (options.includeItemsInTurn) copyIfPresent(out, session, "items_in_turn");
  if (options.includePendingApprovals) copyIfPresent(out, session, "pending_approvals");
  if (options.includePendingUserInputs) copyIfPresent(out, session, "pending_user_inputs");
  if (options.includeBusy) copyIfPresent(out, session, "busy");
  return out;
}

function projectThread(value: unknown): Record<string, unknown> {
  const thread = asObject(value);
  const out = pickFields(thread, [
    "id",
    "name",
    "cwd",
    "source",
    "model_provider",
    "created_at",
    "updated_at",
  ]);
  const status = extractStatus(thread.status);
  if (status) out.status = status;
  return out;
}

function projectCursor(
  value: unknown,
  options: { includeUpdatedAt: boolean; includeAutoUpdate: boolean },
): Record<string, unknown> {
  const cursor = asObject(value);
  const out = pickFields(cursor, ["name", "event_id"]);
  if (options.includeUpdatedAt) copyIfPresent(out, cursor, "updated_at");
  if (options.includeAutoUpdate) copyIfPresent(out, cursor, "auto_update");
  return out;
}

function projectBatchResultEntry(value: unknown, successKeys: string[]): Record<string, unknown> {
  const entry = asObject(value);
  if (entry.ok === false) {
    const error = asObject(entry.error);
    return stripUndefined({
      session: entry.session,
      ok: false,
      error: Object.keys(error).length > 0 ? pickFields(error, ["code"]) : undefined,
    });
  }
  return pickFields(entry, ["session", ...successKeys]);
}

function summarizeEventKey(event: Record<string, unknown>): string | null {
  const payload = asObject(event.payload);
  const type = asString(event.type);
  if (!type) return null;

  if (type.startsWith("turn.")) return scalarString(payload.turn_id);
  if (type === "session.crashed" || type === "session.closed") {
    return labeledSummaryValue("reason", payload.reason ?? payload.crash_reason ?? payload.why);
  }
  if (type === "auto_approved") {
    return labeledSummaryValue("matched_pattern", payload.matched_pattern ?? payload.matchedPattern)
      ?? scalarString(payload.request_id);
  }
  if (type.startsWith("approval.") || type === "user_input.request" || type === "server_request_resolved") {
    return scalarString(payload.request_id);
  }
  if (type.startsWith("item.")) {
    return scalarString(payload.type) ?? scalarString(payload.item_type) ?? scalarString(payload.item_id);
  }
  if (type.startsWith("thread.")) return scalarString(payload.thread_id) ?? scalarString(event.thread_id);
  if (type.startsWith("hook.")) return scalarString(payload.hook_id);
  if (type.startsWith("mcp_server.")) return scalarString(payload.name);
  if (type.startsWith("fuzzy_file_search.")) return scalarString(payload.search_session_id);
  if (type === "monitor.overflow") return scalarString(payload.dropped_count);

  return scalarString(payload.turn_id)
    ?? scalarString(payload.request_id)
    ?? scalarString(payload.type)
    ?? scalarString(payload.item_id)
    ?? scalarString(payload.thread_id)
    ?? scalarString(payload.name)
    ?? scalarString(event.thread_id);
}

function labeledSummaryValue(label: string, value: unknown): string | null {
  const rendered = scalarString(value);
  return rendered ? `${label}=${rendered}` : null;
}

function extractStatus(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" && type.length > 0 ? type : null;
  }
  return null;
}

function pickFields(value: unknown, keys: string[]): Record<string, unknown> {
  const record = asObject(value);
  const out: Record<string, unknown> = {};
  for (const key of keys) copyIfPresent(out, record, key);
  return out;
}

function copyIfPresent(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (hasOwn(source, key)) target[key] = source[key];
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (Array.isArray(value)) return asString(value[value.length - 1]);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
