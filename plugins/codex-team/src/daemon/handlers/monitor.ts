import { spawn } from "node:child_process";

import type { HandlerFn } from "../dispatch";
import { CodexTeamError, invalidParams } from "../../errors";
import type { TeamEvent } from "../../types";
import { isDeltaType } from "../events";

const MAX_INTERVAL_QUEUE_EVENTS = 512;
const MAX_INTERVAL_QUEUE_BYTES = 512 * 1024;
const MAX_FLUSH_EVENTS_PER_TICK = 64;

interface MonitorEventSummary {
  id: string;
  ts: string;
  type: string;
  session: string | null;
  key: string | null;
}

export const monitorEvents: HandlerFn = async (ctx, req, stream) => {
  if (!stream) throw new CodexTeamError("internal", "monitor events requires streaming");
  const user = req.bearer;
  if (!user) throw invalidParams("-b required");
  if (!ctx.users.has(user)) {
    throw new CodexTeamError("user_not_found", `user '${user}' not found`);
  }

  const flags = asFlags(req);
  const streamMode = isTrue(flags["stream"]);
  const intervalGiven = flags["interval"] !== undefined;
  if (streamMode && intervalGiven) throw invalidParams("--stream and --interval are mutually exclusive");

  const intervalDefault = numConfig(ctx, "monitor.default_interval_seconds", 30);
  const intervalS = intervalGiven ? toInt(flags["interval"], intervalDefault) : intervalDefault;
  if (intervalS <= 0 && !streamMode) throw invalidParams("--interval must be > 0");

  const includeDelta = isTrue(flags["include-delta"]);
  const summaryMode = isTrue(flags["summary"]);
  const filterTypes = parseTypeList(flags["filter"]);
  const excludeTypes = parseTypeList(flags["exclude"]);
  const sinceId = asString(flags["since"]);
  const sessionFilter = asString(flags["session"]);
  const emit = (event: TeamEvent): void => {
    stream.chunk(summaryMode ? summarizeEvent(event) : event);
  };

  const accept = (e: TeamEvent): boolean => {
    if (!includeDelta && isDeltaType(e.type)) return false;
    if (filterTypes && filterTypes.length > 0 && !filterTypes.includes(e.type)) return false;
    if (excludeTypes && excludeTypes.length > 0 && excludeTypes.includes(e.type)) return false;
    if (sessionFilter) {
      const match = e.session === sessionFilter || e.thread_id === sessionFilter;
      if (!match) return false;
    }
    return true;
  };

  const backlog = await ctx.events.listSince(user, sinceId, { includeDelta: true });
  if (!backlog.ok) {
    if (backlog.reason === "id_rotated") {
      stream.end(new CodexTeamError("id_rotated", `event '${sinceId}' has been rotated out`, {
        oldest_available_id: backlog.oldest_available_id,
      }));
    } else {
      stream.end(invalidParams(`event '${sinceId}' not found`));
    }
    return { streaming: true };
  }

  const initialEvents = backlog.events.filter(accept);
  const queue: TeamEvent[] = streamMode ? [...initialEvents] : [];
  let queueBytes = 0;
  let overflowDropped = 0;
  let overflowDroppedBytes = 0;
  let overflowSeq = 0;

  const enqueueIntervalEvent = (event: TeamEvent): void => {
    queue.push(event);
    queueBytes += eventSize(event);
    while (queue.length > MAX_INTERVAL_QUEUE_EVENTS || queueBytes > MAX_INTERVAL_QUEUE_BYTES) {
      const dropped = queue.shift();
      if (!dropped) break;
      overflowDropped++;
      const droppedBytes = eventSize(dropped);
      overflowDroppedBytes += droppedBytes;
      queueBytes = Math.max(0, queueBytes - droppedBytes);
    }
  };

  const takeOverflowEvent = (): TeamEvent | null => {
    if (overflowDropped === 0) return null;
    const event: TeamEvent = {
      id: `monitor-overflow-${++overflowSeq}`,
      ts: new Date().toISOString(),
      type: "monitor.overflow",
      session: sessionFilter ?? null,
      thread_id: null,
      payload: {
        dropped_count: overflowDropped,
        dropped_bytes: overflowDroppedBytes,
        limit_events: MAX_INTERVAL_QUEUE_EVENTS,
        limit_bytes: MAX_INTERVAL_QUEUE_BYTES,
      },
    };
    overflowDropped = 0;
    overflowDroppedBytes = 0;
    return event;
  };

  if (!streamMode) {
    for (const event of initialEvents) enqueueIntervalEvent(event);
  }

  if (streamMode) {
    for (const e of queue) emit(e);
    queue.length = 0;
    const sub = ctx.events.subscribe(user, (e) => {
      if (accept(e)) emit(e);
    });
    stream.onClose(() => sub.dispose());
    return { streaming: true };
  }

  const sub = ctx.events.subscribe(user, (e) => {
    if (accept(e)) enqueueIntervalEvent(e);
  });
  let closed = false;
  let draining = false;
  let drainTimer: NodeJS.Timeout | null = null;
  const scheduleDrain = (delayMs: number): void => {
    if (closed || drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drainQueue();
    }, delayMs);
    drainTimer.unref();
  };
  const drainQueue = (): void => {
    if (closed || draining) return;
    draining = true;
    const overflowEvent = takeOverflowEvent();
    if (overflowEvent) emit(overflowEvent);
    const batch = queue.splice(0, MAX_FLUSH_EVENTS_PER_TICK);
    for (const event of batch) {
      queueBytes = Math.max(0, queueBytes - eventSize(event));
      emit(event);
    }
    draining = false;
    if (overflowDropped > 0 || queue.length > 0) scheduleDrain(1);
  };
  const timer = setInterval(() => {
    if (overflowDropped === 0 && queue.length === 0) return;
    scheduleDrain(0);
  }, intervalS * 1000);

  // Emit any initial backlog immediately (otherwise user waits up to intervalS for first response).
  if (overflowDropped > 0 || queue.length > 0) {
    scheduleDrain(0);
  }

  stream.onClose(() => {
    closed = true;
    clearInterval(timer);
    if (drainTimer) clearTimeout(drainTimer);
    sub.dispose();
  });
  return { streaming: true };
};

export const monitorAlarm: HandlerFn = async (_ctx, req, stream) => {
  if (!stream) throw new CodexTeamError("internal", "monitor alarm requires streaming");
  const positionals = asPositionals(req);
  const intervalS = toInt(positionals[0], 0);
  if (intervalS <= 0) throw invalidParams("first positional must be interval seconds (positive integer)");
  const command = positionals[1];
  if (!command) throw invalidParams("missing command string");
  const flags = asFlags(req);
  const once = isTrue(flags["once"]);
  const timeoutS = toInt(flags["timeout"], 60);

  let cancelled = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let activeChild: ReturnType<typeof spawn> | null = null;
  let activeTimeoutTimer: NodeJS.Timeout | null = null;
  let activeKillHardTimer: NodeJS.Timeout | null = null;
  let activeTimedOut = false;

  stream.onClose(() => {
    cancelled = true;
    if (timer) clearInterval(timer);
    requestActiveChildShutdown();
  });

  const runOnce = async (): Promise<void> => {
    if (cancelled || running) return;
    running = true;
    const start = Date.now();
    try {
      await new Promise<void>((resolve) => {
        const { file, args } = shellCommand(command);
        const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        activeChild = child;
        activeTimedOut = false;
        let stdoutBuf = "";
        let stderrBuf = "";
        const timeoutTimer = setTimeout(() => {
          activeTimedOut = true;
          clearActiveTimeoutTimer();
          requestChildShutdown(child);
        }, timeoutS * 1000);
        timeoutTimer.unref();
        activeTimeoutTimer = timeoutTimer;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (c) => { stdoutBuf += c; });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (c) => { stderrBuf += c; });
        child.on("error", (err) => {
          clearActiveKillTimers();
          if (activeChild === child) activeChild = null;
          if (!cancelled) stream.chunk({ __alarm_event: "spawn_error", error: err.message });
          resolve();
        });
        child.on("exit", (code, signal) => {
          clearActiveKillTimers();
          if (activeChild === child) activeChild = null;
          if (!cancelled) {
            if (stdoutBuf) stream.chunk({ stdout: stdoutBuf });
            if (stderrBuf) stream.chunk({ stderr: stderrBuf });
            stream.chunk({
              __alarm_event: activeTimedOut ? "timeout" : "exit",
              exit_code: code,
              signal,
              duration_ms: Date.now() - start,
            });
          }
          resolve();
        });
      });
    } finally {
      running = false;
    }
  };

  await runOnce();
  if (once || cancelled) {
    if (!cancelled) stream.end();
    return { streaming: true };
  }

  timer = setInterval(() => {
    void runOnce();
  }, intervalS * 1000);
  return { streaming: true };

  function clearActiveKillTimers(): void {
    clearActiveTimeoutTimer();
    clearActiveHardKillTimer();
  }

  function clearActiveTimeoutTimer(): void {
    if (activeTimeoutTimer) {
      clearTimeout(activeTimeoutTimer);
      activeTimeoutTimer = null;
    }
  }

  function clearActiveHardKillTimer(): void {
    if (activeKillHardTimer) {
      clearTimeout(activeKillHardTimer);
      activeKillHardTimer = null;
    }
  }

  function requestActiveChildShutdown(): void {
    const child = activeChild;
    if (!child) return;
    requestChildShutdown(child);
  }

  function requestChildShutdown(child: ReturnType<typeof spawn>): void {
    if (activeChild !== child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.stdin?.end(); } catch { /* ignore */ }
    scheduleHardKill(child, 5000);
    if (process.platform === "win32") return;
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }

  function scheduleHardKill(child: ReturnType<typeof spawn>, delayMs: number): void {
    clearActiveHardKillTimer();
    activeKillHardTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === "win32") child.kill();
        else child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, delayMs);
    activeKillHardTimer.unref();
  }
};

function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return {
    file: process.env.SHELL || "sh",
    args: ["-c", command],
  };
}

function asFlags(req: { params: Record<string, unknown> }): Record<string, unknown> {
  const f = req.params.flags;
  return f && typeof f === "object" ? (f as Record<string, unknown>) : {};
}

function asPositionals(req: { params: Record<string, unknown> }): string[] {
  const p = req.params.positionals;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
}

function isTrue(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function asString(v: unknown): string | null {
  if (Array.isArray(v)) {
    const last = v[v.length - 1];
    return typeof last === "string" ? last : null;
  }
  return typeof v === "string" ? v : null;
}

function toInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return fallback;
}

function parseTypeList(v: unknown): string[] | null {
  const s = asString(v);
  if (!s) return null;
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function numConfig(ctx: { config: { getEffective(k: string): unknown } }, key: string, fallback: number): number {
  const v = ctx.config.getEffective(key);
  return typeof v === "number" ? v : fallback;
}

function eventSize(event: TeamEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}

function summarizeEvent(event: TeamEvent): MonitorEventSummary {
  return {
    id: event.id,
    ts: event.ts,
    type: event.type,
    session: event.session,
    key: summarizeEventKey(event),
  };
}

function summarizeEventKey(event: TeamEvent): string | null {
  const payload = event.payload;

  if (event.type.startsWith("turn.")) return asPayloadString(payload.turn_id);
  if (event.type.startsWith("approval.") || event.type === "user_input.request" || event.type === "server_request_resolved") {
    return asPayloadString(payload.request_id);
  }
  if (event.type.startsWith("item.")) {
    return asPayloadString(payload.type) ?? asPayloadString(payload.item_type) ?? asPayloadString(payload.item_id);
  }
  if (event.type.startsWith("thread.")) return asPayloadString(payload.thread_id) ?? event.thread_id;
  if (event.type.startsWith("hook.")) return asPayloadString(payload.hook_id);
  if (event.type.startsWith("mcp_server.")) return asPayloadString(payload.name);
  if (event.type.startsWith("fuzzy_file_search.")) return asPayloadString(payload.search_session_id);
  if (event.type === "monitor.overflow") return asPayloadString(payload.dropped_count);
  return (
    asPayloadString(payload.turn_id) ??
    asPayloadString(payload.request_id) ??
    asPayloadString(payload.type) ??
    asPayloadString(payload.item_id) ??
    asPayloadString(payload.thread_id) ??
    asPayloadString(payload.name) ??
    event.thread_id
  );
}

function asPayloadString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
