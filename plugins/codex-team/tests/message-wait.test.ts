import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventLog } from "../src/daemon/events";
import { messageWait } from "../src/daemon/handlers/message";
import { SessionRegistry, sessionRuntimeDefaults } from "../src/daemon/sessions";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-message-wait-"));
}

function makeReq(flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "message:wait",
    bearer: "user-1",
    params: {
      positionals: ["sess-1"],
      flags,
    },
  };
}

describe("messageWait", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for the next turn when the session is idle", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);

    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
      ...sessionRuntimeDefaults(),
    });
    await sessions.flush();

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    const waiting = messageWait(ctx as never, makeReq() as never);
    await Promise.resolve();

    await events.append("user-1", {
      type: "turn.started",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        turn_id: "turn-1",
      },
    });
    await events.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        turn_id: "turn-1",
        status: "completed",
        duration_ms: 850,
        items_count: 2,
        token_usage: { input: 12, cached_input: 0, output: 8, reasoning_output: 0, total: 20 },
        ended_at: "2025-01-01T00:00:01.000Z",
        turn_items_included: false,
      },
    });

    const result = await waiting;
    expect(result).toMatchObject({
      session: "sess-1",
      thread_id: "th-1",
      turn_id: "turn-1",
      outcome: "completed",
      event_type: "turn.completed",
      status: "completed",
      duration_ms: 850,
      items_count: 2,
      token_usage: { input: 12, cached_input: 0, output: 8, reasoning_output: 0, total: 20 },
      ended_at: "2025-01-01T00:00:01.000Z",
      turn_items_included: false,
    });
  });

  it.each([
    { status: "completed", outcome: "completed" },
    { status: "failed", outcome: "error" },
    { status: "cancelled", outcome: "error" },
  ])("returns status-aware terminal payloads for historical turn.completed events ($status)", async ({ status, outcome }) => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);

    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 1,
      ...sessionRuntimeDefaults(),
    });
    await sessions.flush();

    await events.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        turn_id: "turn-9",
        status,
        duration_ms: 1337,
        items_count: 4,
        token_usage: { input: 21, cached_input: 0, output: 13, reasoning_output: 0, total: 34 },
        ended_at: "2025-01-01T00:00:09.000Z",
        turn_items_included: false,
      },
    });

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    await expect(messageWait(ctx as never, makeReq({ for: "turn-9" }) as never)).resolves.toMatchObject({
      session: "sess-1",
      thread_id: "th-1",
      turn_id: "turn-9",
      outcome,
      event_type: "turn.completed",
      status,
      duration_ms: 1337,
      items_count: 4,
      token_usage: { input: 21, cached_input: 0, output: 13, reasoning_output: 0, total: 34 },
      ended_at: "2025-01-01T00:00:09.000Z",
      turn_items_included: false,
    });
  });

  it("returns a recent terminal event immediately when the session already went idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:10.000Z"));
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);

    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 1,
      ...sessionRuntimeDefaults(),
    });
    await sessions.flush();

    await events.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        turn_id: "turn-2",
        status: "completed",
        duration_ms: 900,
        items_count: 1,
        token_usage: { input: 4, cached_input: 0, output: 2, reasoning_output: 0, total: 6 },
        ended_at: "2025-01-01T00:00:09.000Z",
        turn_items_included: false,
      },
    });

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    await expect(messageWait(ctx as never, makeReq() as never)).resolves.toMatchObject({
      session: "sess-1",
      thread_id: "th-1",
      turn_id: "turn-2",
      outcome: "completed",
      event_type: "turn.completed",
    });
  });

  it("does not reuse stale terminal events when the session has been idle for a while", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);

    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 1,
      ...sessionRuntimeDefaults(),
    });
    await sessions.flush();

    await events.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        turn_id: "turn-stale",
        status: "completed",
      },
    });

    vi.setSystemTime(new Date("2025-01-01T00:01:00.000Z"));
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    const waiting = messageWait(ctx as never, makeReq({ timeout: "5" }) as never);
    await Promise.resolve();

    await events.append("user-1", {
      type: "turn.started",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        turn_id: "turn-fresh",
      },
    });
    await events.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        turn_id: "turn-fresh",
        status: "completed",
      },
    });

    await expect(waiting).resolves.toMatchObject({
      turn_id: "turn-fresh",
      outcome: "completed",
    });
  });

  it("returns timeout when no matching terminal event arrives", async () => {
    vi.useFakeTimers();
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);

    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
      ...sessionRuntimeDefaults(),
    });
    await sessions.flush();

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    const waiting = messageWait(ctx as never, makeReq({ timeout: "5" }) as never);
    await vi.advanceTimersByTimeAsync(5000);

    await expect(waiting).resolves.toMatchObject({
      session: "sess-1",
      thread_id: "th-1",
      outcome: "timeout",
      timeout_s: 5,
    });
  });
});
