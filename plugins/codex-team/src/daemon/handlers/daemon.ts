import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { CONFIG_KEYS } from "../config";
import { CodexTeamError, invalidParams } from "../../errors";
import type { HandlerFn } from "../dispatch";
import { shutdownDaemon } from "../shutdown";
import { logger } from "../../logger";
import { PACKAGE_ROOT, VERSION } from "../../version";

export const daemonStatus: HandlerFn = async (ctx) => {
  const uptimeMs = Date.now() - ctx.startedAt.getTime();
  const distFreshness = await getDistFreshness();
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
    ...distFreshness,
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
    await ctx.events.append(token, {
      type: "session.closed",
      session: rec.name,
      thread_id: rec.thread_id ?? null,
      payload: {
        session: rec.name,
        thread_id: rec.thread_id ?? null,
        reason: "user_destroyed",
        ts: new Date().toISOString(),
      },
    });
  }
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
  const follow = isTrue(getFlag(req.params, "follow")) || isTrue(getFlag(req.params, "f"));
  const n = toInt(getFlag(req.params, "n"), 100);
  const level = asString(getFlag(req.params, "level"));
  let offset = 0;
  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const emitLine = (line: string) => {
    if (!line) return;
    if (level && !lineMatchesLevel(line, level)) return;
    stream.chunk(safeParseOr(line, { raw: line }));
  };

  const initial = await readTextIfExists(logPath);
  if (initial !== null) {
    const lines = initial.split("\n").filter(Boolean);
    const tailLines = lines.slice(Math.max(0, lines.length - n));
    for (const line of tailLines) emitLine(line);
    offset = Buffer.byteLength(initial);
  } else if (!follow) {
    stream.end();
    return { streamed: true };
  }

  if (!follow) {
    stream.end();
    return { streamed: true };
  }

  const syncAppended = async () => {
    try {
      const stat = await fs.promises.stat(logPath);
      if (stat.size < offset) offset = 0;
      if (stat.size === offset) return;
      const chunk = await readBytes(logPath, offset, stat.size - offset);
      offset = stat.size;
      for (const line of chunk.split("\n").filter(Boolean)) emitLine(line);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        offset = 0;
        return;
      }
      logger.warn("daemon log follow read failed", { err: (e as Error).message });
    }
  };
  const scheduleSync = () => {
    if (closed || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void syncAppended();
    }, 50);
    debounceTimer.unref();
  };
  const watcher = fs.watch(path.dirname(logPath), { persistent: true }, (_event, filename) => {
    if (!filename || filename.toString() === path.basename(logPath)) scheduleSync();
  });
  stream.onClose(() => {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  });
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

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function readBytes(filePath: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function getPkgVersion(): string {
  return VERSION;
}

interface DistFreshness {
  dist_built_at: string | null;
  dist_age_seconds: number | null;
  source_newer_than_dist: boolean | null;
}

async function getDistFreshness(packageRoot = PACKAGE_ROOT): Promise<DistFreshness> {
  const distPath = path.join(packageRoot, "dist", "main.js");
  const distStat = await statIfExists(distPath);
  if (!distStat) {
    return {
      dist_built_at: null,
      dist_age_seconds: null,
      source_newer_than_dist: null,
    };
  }

  const builtAt = new Date(distStat.mtimeMs).toISOString();
  const sourceNewestMtime = await getNewestMtime(path.join(packageRoot, "src"));

  return {
    dist_built_at: builtAt,
    dist_age_seconds: Math.max(0, Math.floor((Date.now() - distStat.mtimeMs) / 1000)),
    source_newer_than_dist: sourceNewestMtime === null ? null : sourceNewestMtime > distStat.mtimeMs,
  };
}

async function statIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function getNewestMtime(dirPath: string): Promise<number | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }

  let newest: number | null = null;
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const childNewest = await getNewestMtime(entryPath);
      if (childNewest !== null && (newest === null || childNewest > newest)) newest = childNewest;
      continue;
    }

    const stat = await statIfExists(entryPath);
    if (stat && (newest === null || stat.mtimeMs > newest)) newest = stat.mtimeMs;
  }
  return newest;
}
