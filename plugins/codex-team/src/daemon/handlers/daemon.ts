import fs from "node:fs";
import { spawn } from "node:child_process";

import { CONFIG_KEYS } from "../config";
import { CodexTeamError, invalidParams } from "../../errors";
import type { HandlerFn } from "../dispatch";
import { shutdownDaemon } from "../shutdown";
import { logger } from "../../logger";

export const daemonStatus: HandlerFn = async (ctx) => {
  const uptimeMs = Date.now() - ctx.startedAt.getTime();
  return {
    pid: process.pid,
    version: getPkgVersion(),
    uptime_s: Math.floor(uptimeMs / 1000),
    sock: ctx.sockPath,
    data_dir: ctx.dataDir,
    log_path: ctx.logPath,
    user_count: ctx.users.list().length,
    app_server_count: ctx.pool.processCount(),
    started_at: ctx.startedAt.toISOString(),
  };
};

export const daemonStart: HandlerFn = async () => {
  return { already_running: true };
};

export const daemonStop: HandlerFn = async (ctx, req) => {
  const force = isTrue(getFlag(req.params, "force"));
  if (force) {
    setTimeout(() => process.exit(1), 10);
  } else {
    setTimeout(() => void shutdownDaemon(ctx, "daemon stop"), 10);
  }
  return { stopping: true, force };
};

export const daemonRestart: HandlerFn = async (ctx) => {
  const entry = process.argv[1];
  spawn(process.execPath, [entry, "--daemon-internal"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true,
  }).unref();
  setTimeout(() => void shutdownDaemon(ctx, "daemon restart"), 100);
  return { restarting: true };
};

export const daemonUserCreate: HandlerFn = async (ctx, req) => {
  const token = reqPositional(req, 0, "token");
  const user = ctx.users.create(token);
  return user;
};

export const daemonUserDestroy: HandlerFn = async (ctx, req) => {
  const token = reqPositional(req, 0, "token");
  const force = isTrue(getFlag(req.params, "force"));
  if (!ctx.users.has(token)) {
    throw new CodexTeamError("user_not_found", `user '${token}' not found`);
  }
  const liveSessions = ctx.sessions.listLive(token);
  if (!force && liveSessions.length > 0) {
    throw invalidParams(
      `cannot destroy user '${token}' while ${liveSessions.length} live session(s) remain; pass --force to destroy anyway`,
    );
  }
  const pending = ctx.pending.removeForUser(token);
  for (const p of pending) {
    try { p.client.respondError(p.jsonrpc_id, -32000, "user destroyed"); } catch { /* ignore */ }
  }
  await ctx.pool.closeUser(token);
  const sessions = await ctx.sessions.clearUser(token);
  for (const rec of sessions) {
    ctx.queues.dispose(`${token}::${rec.name}`);
  }
  await ctx.events.clearUser(token);
  ctx.users.destroy(token);
  return { destroyed: token, sessions_closed: sessions.length, pending_canceled: pending.length };
};

export const daemonUserList: HandlerFn = async (ctx) => {
  return { users: ctx.users.list() };
};

export const daemonConfigGet: HandlerFn = async (ctx, req) => {
  const key = reqPositional(req, 0, "key");
  const entry = ctx.config.get(key);
  if (!entry) throw invalidParams(`unknown config key: ${key}`);
  return {
    key,
    value: entry.value,
    default: entry.spec.default,
    source: entry.source,
    needs_restart: entry.spec.needsRestart,
  };
};

export const daemonConfigSet: HandlerFn = async (ctx, req) => {
  const key = reqPositional(req, 0, "key");
  const value = reqPositional(req, 1, "value");
  const result = ctx.config.set(key, value);
  if (!result.ok) throw invalidParams(result.error);
  applyHotConfigChange(ctx, key, result.value);
  return {
    key,
    value: result.value,
    needs_restart: result.needs_restart,
  };
};

function applyHotConfigChange(ctx: Parameters<HandlerFn>[0], key: string, value: unknown): void {
  if (key === "daemon.log_level" && typeof value === "string") {
    logger.setLevel(value as "info");
    return;
  }
  if (key === "monitor.event_log_retention" && typeof value === "number") {
    ctx.events.setRetention(value);
    return;
  }
}

export const daemonConfigUnset: HandlerFn = async (ctx, req) => {
  const key = reqPositional(req, 0, "key");
  const result = ctx.config.unset(key);
  if (!result.ok) throw invalidParams(result.error);
  applyHotConfigChange(ctx, key, ctx.config.getEffective(key));
  return { key, needs_restart: result.needs_restart };
};

export const daemonConfigList: HandlerFn = async (ctx, req) => {
  const explicitOnly = isTrue(getFlag(req.params, "explicit-only"));
  const snapshot = ctx.config.snapshot();
  const rows = [] as Array<Record<string, unknown>>;
  for (const key of Object.keys(CONFIG_KEYS)) {
    const spec = CONFIG_KEYS[key];
    const isExplicit = key in snapshot.explicit;
    if (explicitOnly && !isExplicit) continue;
    rows.push({
      key,
      value: snapshot.effective[key],
      default: spec.default,
      explicit: isExplicit,
      needs_restart: spec.needsRestart,
      type: spec.type,
      description: spec.description,
    });
  }
  return { config: rows };
};

export const daemonConfigReset: HandlerFn = async (ctx, req) => {
  if (!isTrue(getFlag(req.params, "yes"))) {
    throw invalidParams("pass --yes to confirm reset");
  }
  ctx.config.reset();
  applyHotConfigChange(ctx, "daemon.log_level", ctx.config.getEffective("daemon.log_level"));
  applyHotConfigChange(ctx, "monitor.event_log_retention", ctx.config.getEffective("monitor.event_log_retention"));
  return { reset: true };
};

export const daemonLogsStream: HandlerFn = async (ctx, req, stream) => {
  if (!stream) throw new CodexTeamError("internal", "daemonLogs requires a stream");
  const logPath = ctx.logPath;
  if (!fs.existsSync(logPath)) {
    stream.end();
    return { streamed: true };
  }
  const follow = isTrue(getFlag(req.params, "follow")) || isTrue(getFlag(req.params, "f"));
  const n = toInt(getFlag(req.params, "n"), 100);
  const level = asString(getFlag(req.params, "level"));

  const contents = fs.readFileSync(logPath, "utf8");
  const lines = contents.split("\n").filter(Boolean);
  const tailLines = lines.slice(Math.max(0, lines.length - n));
  for (const line of tailLines) {
    if (level && !lineMatchesLevel(line, level)) continue;
    stream.chunk(safeParseOr(line, { raw: line }));
  }

  if (!follow) {
    stream.end();
    return { streamed: true };
  }

  const watcher = fs.watch(logPath, { persistent: true }, () => {
    // cheap tail: re-read trailing file on change. Production version would maintain an offset.
    try {
      const data = fs.readFileSync(logPath, "utf8");
      const newLines = data.split("\n").filter(Boolean);
      const reset = newLines.length < lines.length || newLines.some((line, idx) => idx < lines.length && lines[idx] !== line);
      const diff = reset ? newLines : newLines.slice(lines.length);
      lines.splice(0, lines.length, ...newLines);
      for (const line of diff) {
        if (level && !lineMatchesLevel(line, level)) continue;
        stream.chunk(safeParseOr(line, { raw: line }));
      }
    } catch {
      // ignore
    }
  });
  stream.onClose(() => watcher.close());
  return { streamed: true };
};

function reqPositional(req: { params: Record<string, unknown> }, idx: number, name: string): string {
  const positionals = (req.params.positionals ?? []) as string[];
  const v = positionals[idx];
  if (typeof v !== "string" || v.length === 0) {
    throw invalidParams(`missing positional '${name}'`);
  }
  return v;
}

function getFlag(params: Record<string, unknown>, key: string): unknown {
  const flags = params.flags as Record<string, unknown> | undefined;
  if (!flags || typeof flags !== "object") return undefined;
  return flags[key];
}

function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function toInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return fallback;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function lineMatchesLevel(line: string, level: string): boolean {
  try {
    const obj = JSON.parse(line) as { level?: string };
    return obj.level === level;
  } catch {
    return false;
  }
}

function safeParseOr<T>(line: string, fallback: T): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return fallback;
  }
}

function getPkgVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../../package.json");
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
