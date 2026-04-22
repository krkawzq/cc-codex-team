import { encodeToken } from "../paths";

export function formatShort(method: string, data: unknown): string {
  switch (method) {
    case "status":
      return formatStatus(data);
    case "daemon:status":
      return formatDaemonStatus(data);
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
  return `${encoded.slice(0, 8)}...`;
}

export const __private__ = {
  humanizeMs,
};
