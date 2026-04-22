import { encodeToken } from "../paths";

export function formatShort(method: string, data: unknown): string {
  const value = asObject(data);
  let body: string;
  switch (method) {
    case "status":
      body = formatStatus(data);
      break;
    case "daemon:status":
      body = formatDaemonStatus(data);
      break;
    case "daemon:user:list":
      body = formatDaemonUserList(data);
      break;
    case "session:info":
      body = formatSessionInfo(data);
      break;
    case "session:list":
      body = formatSessionList(data);
      break;
    case "message:history":
      body = formatMessageHistory(data);
      break;
    default:
      throw new Error(`--short is not supported for '${method}'`);
  }

  const footerLines = extractFooterLines(method, value);
  return footerLines.length > 0 ? `${body}\n${footerLines.join("\n")}` : body;
}

function formatStatus(data: unknown): string {
  const value = asObject(data);
  const daemon = asObject(value.daemon);
  const retainedCount = formatScalar(value.retained_events);
  const retainedLimit = formatScalar(
    value.retained_limit ?? value.retention ?? value.event_log_retention ?? daemon.retained_limit,
  );
  const appServers = formatScalar(value.app_server_count ?? daemon.app_server_count);

  return [
    `user=${formatScalar(value.token ?? value.user ?? value.name)}`,
    `live=${formatScalar(value.live_sessions)}`,
    `pending=${formatScalar(value.pending_requests)}`,
    `retained=${retainedCount}/${retainedLimit}`,
    `app_servers=${appServers}`,
    `daemon_age=${formatAgeFromDateish(daemon.started_at ?? value.started_at)}`,
  ].join(" ");
}

function formatDaemonStatus(data: unknown): string {
  const value = asObject(data);
  const distAge = value.dist_age_seconds;

  return [
    `pid=${formatScalar(value.pid)}`,
    `sock=${shortPath(asString(value.sock) ?? "unknown")}`,
    `age=${formatDaemonAge(value)}`,
    `sessions=${formatScalar(value.session_count ?? value.sessions)}`,
    `users=${formatScalar(value.user_count ?? value.users)}`,
    `dist_age=${typeof distAge === "number" && Number.isFinite(distAge) ? humanizeMs(distAge * 1000) : "unknown"}`,
  ].join(" ");
}

function formatDaemonAge(data: Record<string, unknown>): string {
  if (typeof data.uptime_s === "number" && Number.isFinite(data.uptime_s)) {
    return humanizeMs(data.uptime_s * 1000);
  }
  return formatAgeFromDateish(data.started_at);
}

function formatSessionInfo(data: unknown): string {
  const value = asObject(data);
  const session = asObject(value.session);
  const thread = asObject(value.thread);
  const turn = resolveCurrentTurn(value, session, thread);
  const turnId = resolveCurrentTurnId(value, session, thread, turn);
  const turnIdKnown = hasCurrentTurnIdField(value, session, thread);
  const itemsInTurn = resolveItemsInTurn(value, session, thread, turn);
  const threadId = asString(session.thread_id) ?? asString(thread.id) ?? "unknown";

  return [
    sessionLabel(session, thread),
    `state=${sessionState(value, session, thread)}`,
    `thread=${shortId(threadId)}`,
    `model=${formatScalar(session.model ?? value.model ?? thread.model ?? thread.model_provider)}`,
    `busy=${busyFlag(value.busy ?? session.busy ?? thread.busy, turnId, turn, turnIdKnown)}`,
    `turn=${formatNullableScalar(turnId)}`,
    `items=${formatNullableCount(itemsInTurn)}`,
  ].join(" ");
}

function formatSessionList(data: unknown): string {
  const value = asObject(data);
  const sessions = Array.isArray(value.sessions) ? value.sessions : [];
  if (sessions.length === 0) return "(no sessions)";

  return sessions
    .map((entry) => {
      const session = asObject(entry);
      const turn = resolveCurrentTurn(session, session, session);
      const turnId = resolveCurrentTurnId(session, session, session, turn);
      const turnIdKnown = hasCurrentTurnIdField(session, session, session);
      return [
        sessionLabel(session, session),
        sessionState(session, session, session),
        formatScalar(session.model ?? session.model_provider),
        `busy=${busyFlag(session.busy, turnId, turn, turnIdKnown)}`,
      ].join("  ");
    })
    .join("\n");
}

function formatDaemonUserList(data: unknown): string {
  const value = asObject(data);
  const users = Array.isArray(value.users) ? value.users : [];
  if (users.length === 0) return "(no users)";

  return users
    .map((entry) => {
      const user = asObject(entry);
      const live = user.live_sessions ?? user.live_count ?? user.session_count ?? user.live;
      return [
        shortTokenPrefix(user.token),
        `name=${formatScalar(user.name ?? user.token)}`,
        `live=${formatCount(live)}`,
        `last_seen=${formatAgeFromDateish(user.last_active_at ?? user.created_at)}`,
      ].join(" ");
    })
    .join("\n");
}

function formatMessageHistory(data: unknown): string {
  const value = asObject(data);
  const turns = Array.isArray(value.turns) ? value.turns : [];
  if (turns.length === 0) return "(no turns)";

  return turns
    .map((entry) => {
      const turn = asObject(entry);
      return [
        formatScalar(turn.id),
        formatScalar(turn.status),
        formatTurnDuration(turn),
        `items=${formatCount(turn.items && Array.isArray(turn.items) ? turn.items.length : turn.item_count ?? turn.itemCount)}`,
      ].join(" ");
    })
    .join("\n");
}

function formatAgeFromDateish(value: unknown): string {
  const date = parseDate(value);
  if (!date) return "unknown";
  return humanizeMs(Math.max(0, Date.now() - date.getTime()));
}

function humanizeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${Math.floor(ms)}ms`;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function shortPath(value: string): string {
  if (value.length <= 28) return value;
  return `...${value.slice(-25)}`;
}

function shortId(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function sessionLabel(session: Record<string, unknown>, thread: Record<string, unknown>): string {
  return formatScalar(session.name ?? thread.name ?? thread.id);
}

function sessionState(
  root: Record<string, unknown>,
  session: Record<string, unknown>,
  thread: Record<string, unknown>,
): string {
  const status = session.state ?? extractStatus(thread.status) ?? (root.live === false ? "retained" : undefined);
  return formatScalar(status);
}

function extractStatus(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" && type.length > 0 ? type : null;
  }
  return null;
}

function resolveCurrentTurn(
  root: Record<string, unknown>,
  session: Record<string, unknown>,
  thread: Record<string, unknown>,
): Record<string, unknown> | null {
  const candidate = root.current_turn ?? root.turn ?? session.current_turn ?? session.turn ?? thread.current_turn ?? thread.turn;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }
  return null;
}

function busyFlag(
  value: unknown,
  turnId: string | null,
  turn: Record<string, unknown> | null,
  turnIdKnown: boolean,
): string {
  if (value === true) return "y";
  if (value === false) return "n";
  if (turnId) return "y";
  if (turnIdKnown) return "n";
  if (turn) return "y";
  return "unknown";
}

function resolveCurrentTurnId(
  root: Record<string, unknown>,
  session: Record<string, unknown>,
  thread: Record<string, unknown>,
  turn: Record<string, unknown> | null,
): string | null {
  const direct = asString(
    root.current_turn_id
      ?? root.currentTurnId
      ?? session.current_turn_id
      ?? session.currentTurnId
      ?? thread.current_turn_id
      ?? thread.currentTurnId,
  );
  if (direct) return direct;
  if (!turn) return null;
  return asString(turn.id ?? turn.turn_id ?? turn.turnId);
}

function resolveItemsInTurn(
  root: Record<string, unknown>,
  session: Record<string, unknown>,
  thread: Record<string, unknown>,
  turn: Record<string, unknown> | null,
): number | string | null {
  const direct = asFiniteNumber(
    root.items_in_turn
      ?? root.itemsInTurn
      ?? session.items_in_turn
      ?? session.itemsInTurn
      ?? thread.items_in_turn
      ?? thread.itemsInTurn,
  );
  if (direct !== null) return direct;
  if (!turn) return null;
  if (Array.isArray(turn.items)) return turn.items.length;
  const count = asFiniteNumber(turn.item_count ?? turn.itemCount ?? turn.items_count);
  return count ?? null;
}

function formatTurnDuration(turn: Record<string, unknown>): string {
  const direct = turn.durationMs ?? turn.duration_ms;
  if (typeof direct === "number" && Number.isFinite(direct)) return humanizeMs(direct);

  const started = asFiniteNumber(turn.startedAt ?? turn.started_at);
  const completed = asFiniteNumber(turn.completedAt ?? turn.completed_at);
  if (started !== null && completed !== null && completed >= started) {
    return humanizeMs(completed - started);
  }
  return "unknown";
}

function formatCount(value: unknown): string {
  if (Array.isArray(value)) return String(value.length);
  return formatScalar(value);
}

function formatNullableCount(value: number | string | null): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return "unknown";
}

function formatNullableScalar(value: string | null): string {
  return value ?? "unknown";
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | null {
  if (Array.isArray(value)) return asString(value[value.length - 1]);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasCurrentTurnIdField(...records: Record<string, unknown>[]): boolean {
  return records.some((record) =>
    hasOwn(record, "current_turn_id") || hasOwn(record, "currentTurnId")
  );
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function formatScalar(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "unknown";
}

export function shortTokenPrefix(token: unknown): string {
  const encoded = typeof token === "string" && token.length > 0 ? encodeToken(token) : "unknown";
  return `${encoded.slice(0, 10)}...`;
}

export const __private__ = {
  humanizeMs,
};

function extractFooterLines(method: string, value: Record<string, unknown>): string[] {
  switch (method) {
    case "session:list":
      return extractSessionListFooters(value);
    case "message:history":
      return extractMessageHistoryFooters(value);
    default:
      return [];
  }
}

function extractSessionListFooters(value: Record<string, unknown>): string[] {
  const nextCursor = asString(value.next_cursor);
  const includeContract = value.all === true || nextCursor !== null;
  if (!includeContract) return [];

  const fields = [
    ["next_cursor", nextCursor],
    ["all", value.all],
    ["sort", asString(value.sort)],
    ["format", asString(value.format)],
  ] as const;

  const footer = formatFooterLine(fields);
  return footer ? [footer] : [];
}

function extractMessageHistoryFooters(value: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const meta = formatFooterLine([
    ["next_cursor", asString(value.next_cursor)],
    ["relative_since", asFiniteNumber(value.relative_since)],
    ["format", asString(value.format)],
  ]);
  if (meta) lines.push(meta);

  const note = asString(value.note);
  if (note) {
    const noteLine = formatFooterLine([["note", note]]);
    if (noteLine) lines.push(noteLine);
  }

  return lines;
}

function formatFooterLine(entries: ReadonlyArray<readonly [string, unknown]>): string | null {
  const parts = entries
    .flatMap(([key, value]) => {
      const encoded = encodeFooterValue(value);
      return encoded === null ? [] : [`${key}=${encoded}`];
    });

  return parts.length > 0 ? `# ${parts.join(" ")}` : null;
}

function encodeFooterValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.length === 0) return null;
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : null;
}
