import { encodeToken } from "../paths";

export function formatShort(method: string, data: unknown): string {
  switch (method) {
    case "status":
      return formatStatus(data);
    case "daemon:status":
      return formatDaemonStatus(data);
    case "daemon:user:list":
      return formatDaemonUserList(data);
    case "session:info":
      return formatSessionInfo(data);
    case "session:list":
      return formatSessionList(data);
    case "message:history":
      return formatMessageHistory(data);
    default:
      throw new Error(`--short is not supported for '${method}'`);
  }
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
  const threadId = asString(session.thread_id) ?? asString(thread.id) ?? "unknown";

  return [
    sessionLabel(session, thread),
    `state=${sessionState(value, session, thread)}`,
    `thread=${shortId(threadId)}`,
    `model=${formatScalar(session.model ?? value.model ?? thread.model ?? thread.model_provider)}`,
    `busy=${busyFlag(value.busy ?? session.busy ?? thread.busy, turn)}`,
    `turn=${currentTurnId(turn)}`,
    `items=${itemCount(turn)}`,
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
      return [
        sessionLabel(session, session),
        sessionState(session, session, session),
        formatScalar(session.model ?? session.model_provider),
        `busy=${busyFlag(session.busy, turn)}`,
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

function busyFlag(value: unknown, turn: Record<string, unknown> | null): string {
  if (value === true) return "y";
  if (value === false) return "n";
  if (turn) return "y";
  return "unknown";
}

function currentTurnId(turn: Record<string, unknown> | null): string {
  if (!turn) return "unknown";
  return formatScalar(turn.id ?? turn.turn_id ?? turn.turnId);
}

function itemCount(turn: Record<string, unknown> | null): string {
  if (!turn) return "unknown";
  if (Array.isArray(turn.items)) return String(turn.items.length);
  return formatScalar(turn.item_count ?? turn.itemCount ?? turn.items_count);
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

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
