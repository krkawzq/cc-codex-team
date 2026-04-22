import { spawn } from "node:child_process";

import type { HandlerFn } from "../dispatch";
import { CodexTeamError, invalidParams } from "../../errors";
import type { TeamEvent } from "../../types";
import { isDeltaType } from "../events";

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
  const filterTypes = parseTypeList(flags["filter"]);
  const excludeTypes = parseTypeList(flags["exclude"]);
  const sinceId = asString(flags["since"]);
  const sessionFilter = asString(flags["session"]);

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

  const backlog = ctx.events.listSince(user, sinceId, { includeDelta: true });
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

  const queue: TeamEvent[] = backlog.events.filter(accept);

  if (streamMode) {
    for (const e of queue) stream.chunk(e);
    queue.length = 0;
    const sub = ctx.events.subscribe(user, (e) => {
      if (accept(e)) stream.chunk(e);
    });
    stream.onClose(() => sub.dispose());
    return { streaming: true };
  }

  const sub = ctx.events.subscribe(user, (e) => {
    if (accept(e)) queue.push(e);
  });
  const timer = setInterval(() => {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    for (const e of batch) stream.chunk(e);
  }, intervalS * 1000);

  // Emit any initial backlog immediately (otherwise user waits up to intervalS for first response).
  if (queue.length > 0) {
    const initial = queue.splice(0, queue.length);
    for (const e of initial) stream.chunk(e);
  }

  stream.onClose(() => {
    clearInterval(timer);
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
  let activeKillTimer: NodeJS.Timeout | null = null;
  let activeKillHardTimer: NodeJS.Timeout | null = null;
  let activeTimedOut = false;

  stream.onClose(() => {
    cancelled = true;
    if (timer) clearInterval(timer);
    terminateActiveChild();
  });

  const runOnce = async (): Promise<void> => {
    if (cancelled || running) return;
    running = true;
    const start = Date.now();
    try {
      await new Promise<void>((resolve) => {
        const { file, args } = shellCommand(command);
        const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        activeChild = child;
        activeTimedOut = false;
        let stdoutBuf = "";
        let stderrBuf = "";
        const killer = setTimeout(() => {
          activeTimedOut = true;
          terminateChild(child);
        }, timeoutS * 1000);
        killer.unref();
        activeKillTimer = killer;
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
    if (activeKillTimer) {
      clearTimeout(activeKillTimer);
      activeKillTimer = null;
    }
    if (activeKillHardTimer) {
      clearTimeout(activeKillHardTimer);
      activeKillHardTimer = null;
    }
  }

  function terminateActiveChild(): void {
    const child = activeChild;
    if (!child) return;
    terminateChild(child);
  }

  function terminateChild(child: ReturnType<typeof spawn>): void {
    if (activeChild !== child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!activeKillHardTimer) {
      activeKillHardTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 5000);
      activeKillHardTimer.unref();
    }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
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

// ----- helpers -----

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
