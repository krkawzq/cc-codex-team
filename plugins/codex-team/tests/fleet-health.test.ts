import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventLog } from "../src/daemon/events";
import { daemonFleetStatus } from "../src/daemon/handlers/daemon";
import { sessionHealthAll } from "../src/daemon/handlers/session";
import { SessionRegistry, sessionRuntimeDefaults } from "../src/daemon/sessions";

function makeSessionHealthReq(flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-health",
    method: "session:health:all",
    bearer: "user-1",
    params: {
      positionals: [],
      flags,
    },
  };
}

function makeDaemonFleetReq(flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-fleet",
    method: "daemon:fleet:status",
    params: {
      positionals: [],
      flags,
    },
  };
}

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-fleet-health-"));
}

describe("fleet health handlers", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns one entry per tracked session with a fleet summary", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);
    sessions.add("user-1", {
      name: "audit",
      thread_id: "th-1",
      state: "live",
      created_at: "2026-04-23T00:00:00.000Z",
      last_active_at: "2026-04-23T00:00:00.000Z",
      turn_count: 3,
      autoApprovePatterns: [],
      ...sessionRuntimeDefaults(),
    });
    sessions.add("user-1", {
      name: "worker",
      thread_id: "th-2",
      state: "live",
      created_at: "2026-04-23T00:00:00.000Z",
      last_active_at: "2026-04-23T00:00:00.000Z",
      turn_count: 4,
      current_turn_id: "turn-2",
      current_turn_started_at: "2026-04-23T00:00:10.000Z",
      autoApprovePatterns: [],
      ...sessionRuntimeDefaults(),
    });
    sessions.update("user-1", "worker", {
      current_turn_id: "turn-2",
      current_turn_started_at: "2026-04-23T00:00:10.000Z",
    });
    sessions.add("user-1", {
      name: "lint",
      thread_id: "th-3",
      state: "crashed",
      created_at: "2026-04-23T00:00:00.000Z",
      last_active_at: "2026-04-23T00:00:00.000Z",
      turn_count: 1,
      autoApprovePatterns: [],
      ...sessionRuntimeDefaults(),
    });

    await events.append("user-1", {
      type: "turn.completed",
      session: "audit",
      thread_id: "th-1",
      payload: { turn_id: "turn-1" },
    });
    await events.append("user-1", {
      type: "turn.started",
      session: "worker",
      thread_id: "th-2",
      payload: { turn_id: "turn-2" },
    });
    await events.append("user-1", {
      type: "session.crashed",
      session: "lint",
      thread_id: "th-3",
      payload: { reason: "app-server exited" },
    });

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      pool: {
        clientForSession: vi.fn((sessionKey: string) => {
          if (sessionKey === "user-1::audit") return { isAlive: () => true };
          if (sessionKey === "user-1::worker") return { isAlive: () => true };
          return { isAlive: () => false };
        }),
      },
      queues: {
        getCurrentTurn: vi.fn((sessionKey: string) => sessionKey === "user-1::worker" ? "turn-2" : null),
      },
      pending: {
        listForUser: vi.fn().mockReturnValue([
          { session_name: "worker", kind: "approval.command_execution" },
          { session_name: "worker", kind: "user_input.request" },
        ]),
      },
      events,
    };

    const result = await sessionHealthAll(ctx as never, makeSessionHealthReq({ all: true }) as never) as {
      summary: Record<string, number>;
      sessions: Array<Record<string, unknown>>;
    };

    expect(result.summary).toEqual({
      total: 2,
      healthy: 2,
      crashed: 0,
      closed: 0,
      busy: 1,
      pending_total: 2,
    });
    expect(result.sessions.map((entry) => entry.session)).toEqual(["audit", "worker"]);
    expect(result.sessions).toContainEqual(expect.objectContaining({
      session: "worker",
      busy: true,
      pending_approval_requests: 1,
      pending_user_input_requests: 1,
      app_server_alive: true,
    }));
  });

  it("filters idle healthy sessions with --only-unhealthy", async () => {
    const result = await sessionHealthAll({
      users: { has: () => true },
      sessions: {
        listLive: () => ([
          { name: "audit", thread_id: "th-1", state: "live", pending_approvals: 0, pending_user_inputs: 0, autoApprovePatterns: [], ...sessionRuntimeDefaults() },
          { name: "worker", thread_id: "th-2", state: "live", current_turn_id: "turn-2", pending_approvals: 0, pending_user_inputs: 0, autoApprovePatterns: [], ...sessionRuntimeDefaults() },
        ]),
      },
      pool: {
        clientForSession: (sessionKey: string) => ({
          isAlive: () => sessionKey !== "user-1::lint",
        }),
      },
      queues: {
        getCurrentTurn: (sessionKey: string) => sessionKey === "user-1::worker" ? "turn-2" : null,
      },
      pending: {
        listForUser: () => [],
      },
      events: {
        latestEvent: () => null,
      },
    } as never, makeSessionHealthReq({ all: true, "only-unhealthy": true }) as never) as {
      sessions: Array<Record<string, unknown>>;
    };

    expect(result.sessions.map((entry) => entry.session)).toEqual(["worker"]);
  });

  it("filters session health snapshots by state", async () => {
    const result = await sessionHealthAll({
      users: { has: () => true },
      sessions: {
        listLive: () => ([
          { name: "audit", thread_id: "th-1", state: "live", pending_approvals: 0, pending_user_inputs: 0, autoApprovePatterns: [], ...sessionRuntimeDefaults() },
        ]),
      },
      pool: {
        clientForSession: () => ({ isAlive: () => false }),
      },
      queues: {
        getCurrentTurn: () => null,
      },
      pending: {
        listForUser: () => [],
      },
      events: {
        latestEvent: () => null,
      },
    } as never, makeSessionHealthReq({ all: true, state: "crashed" }) as never) as {
      summary: Record<string, number>;
      sessions: Array<Record<string, unknown>>;
    };

    expect(result.summary.total).toBe(0);
    expect(result.sessions).toEqual([]);
  });

  it("aggregates daemon fleet status and respects explicit user filters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T01:00:00.000Z"));

    const sessionsByUser: Record<string, Array<Record<string, unknown>>> = {
      "claude-alice": [
        { name: "audit", thread_id: "th-1", state: "live", current_turn_id: "turn-1" },
        { name: "lint", thread_id: "th-2", state: "crashed", current_turn_id: null },
      ],
      "claude-bob": [
        { name: "review", thread_id: "th-3", state: "live", current_turn_id: null },
      ],
    };

    const ctx = {
      users: {
        list: () => ([
          { token: "claude-alice" },
          { token: "claude-bob" },
        ]),
        has: (token: string) => token in sessionsByUser,
        get: (token: string) => ({
          token,
          created_at: "2026-04-23T00:00:00.000Z",
          last_active_at: token === "claude-alice"
            ? "2026-04-23T00:59:18.000Z"
            : "2026-04-23T00:58:00.000Z",
        }),
      },
      sessions: {
        listLive: (token: string) => sessionsByUser[token] as never,
      },
      pending: {
        listForUser: (token: string) => token === "claude-alice" ? [{}, {}] : [{}],
      },
      pool: {
        processCount: () => 4,
        clientForSession: (sessionKey: string) => ({
          isAlive: () => sessionKey !== "claude-alice::lint",
        }),
      },
      queues: {
        getCurrentTurn: (sessionKey: string) => sessionKey === "claude-alice::audit" ? "turn-1" : null,
      },
      events: {
        latestEvent: (token: string) => ({ id: token === "claude-alice" ? "evt-10" : "evt-20" }),
      },
    };

    const full = await daemonFleetStatus(ctx as never, makeDaemonFleetReq() as never) as {
      total_users: number;
      total_live_sessions: number;
      total_pending: number;
      total_app_servers: number;
      per_user: Array<Record<string, unknown>>;
    };
    expect(full).toMatchObject({
      total_users: 2,
      total_live_sessions: 2,
      total_pending: 3,
      total_app_servers: 4,
      per_user: [
        {
          token: "claude-alice",
          live: 1,
          busy: 1,
          pending: 2,
          crashed: 1,
          last_event_id: "evt-10",
          last_activity_age_s: 42,
        },
        {
          token: "claude-bob",
          live: 1,
          busy: 0,
          pending: 1,
          crashed: 0,
          last_event_id: "evt-20",
          last_activity_age_s: 120,
        },
      ],
    });

    const filtered = await daemonFleetStatus(ctx as never, makeDaemonFleetReq({ users: "claude-bob" }) as never) as {
      total_users: number;
      total_live_sessions: number;
      total_pending: number;
      per_user: Array<Record<string, unknown>>;
    };
    expect(filtered.total_users).toBe(1);
    expect(filtered.total_live_sessions).toBe(1);
    expect(filtered.total_pending).toBe(1);
    expect(filtered.per_user).toEqual([
      expect.objectContaining({ token: "claude-bob", live: 1, crashed: 0 }),
    ]);

    vi.useRealTimers();
  });
});
