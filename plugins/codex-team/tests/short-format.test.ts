import { afterEach, describe, expect, it, vi } from "vitest";

import { formatShort } from "../src/format/short";
import { daemonStatus } from "../src/daemon/handlers/daemon";

describe("formatShort", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [
      "status",
      {
        token: "agent-f",
        live_sessions: 2,
        pending_requests: 1,
        retained_events: 7,
        retained_limit: 100,
        app_server_count: 3,
        daemon: {
          started_at: "2026-04-23T00:59:00.000Z",
        },
      },
      "user=agent-f live=2 pending=1 retained=7/100 app_servers=3 daemon_age=1m",
    ],
    [
      "daemon:status",
      {
        pid: 4242,
        sock: "/tmp/codex-team/very/long/path/daemon.sock",
        uptime_s: 3720,
        session_count: 5,
        user_count: 2,
        dist_age_seconds: 180,
      },
      "pid=4242 sock=...ery/long/path/daemon.sock age=1h sessions=5 users=2 dist_age=3m",
    ],
    [
      "session:info",
      {
        session: {
          name: "audit",
          state: "live",
          thread_id: "th-1234567890abcdef",
          model: "gpt-5.4",
          current_turn_id: "turn-42",
          items_in_turn: 2,
        },
        busy: true,
      },
      "audit state=live thread=th-12345...cdef model=gpt-5.4 busy=y turn=turn-42 items=2",
    ],
    [
      "session:list",
      {
        sessions: [
          { name: "audit", state: "live", model: "gpt-5.4", current_turn_id: "turn-42" },
          { name: "notes", state: "live", model: "gpt-5.4-mini", current_turn_id: null },
        ],
      },
      "audit  live  gpt-5.4  busy=y\nnotes  live  gpt-5.4-mini  busy=n",
    ],
    [
      "daemon:user:list",
      {
        users: [
          {
            token: "agent-a",
            live_sessions: 2,
            last_active_at: "2026-04-23T00:55:00.000Z",
          },
        ],
      },
      "YWdlbnQtYQ... name=agent-a live=2 last_seen=5m",
    ],
    [
      "message:history",
      {
        turns: [
          { id: "turn-1", status: "completed", durationMs: 1500, item_count: 3 },
          { id: "turn-2", status: "running", startedAt: 1000, completedAt: 2200, items: [{}, {}] },
        ],
      },
      "turn-1 completed 1s items=3\nturn-2 running 1s items=2",
    ],
  ])("renders %s compactly", (method, data, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T01:00:00.000Z"));

    expect(formatShort(method, data)).toBe(expected);
  });

  it("falls back to unknown for missing optional status and daemon fields", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T01:00:00.000Z"));

    expect(formatShort("status", {
      token: "agent-f",
      live_sessions: 0,
      pending_requests: 0,
      retained_events: 0,
      daemon: {},
    })).toBe(
      "user=agent-f live=0 pending=0 retained=0/unknown app_servers=unknown daemon_age=unknown",
    );

    expect(formatShort("daemon:status", {
      pid: 7,
      sock: "/tmp/daemon.sock",
      started_at: "2026-04-23T00:59:55.000Z",
      user_count: 1,
    })).toBe(
      "pid=7 sock=/tmp/daemon.sock age=5s sessions=unknown users=1 dist_age=unknown",
    );

    expect(formatShort("session:info", {
      session: {
        name: "audit",
        state: "live",
        thread_id: "th-1",
        model: "gpt-5.4",
      },
    })).toBe(
      "audit state=live thread=th-1 model=gpt-5.4 busy=unknown turn=unknown items=unknown",
    );

    expect(formatShort("session:list", {
      sessions: [
        { id: "th-1", status: "completed", model_provider: "openai" },
      ],
    })).toBe(
      "th-1  completed  openai  busy=unknown",
    );

    expect(formatShort("daemon:user:list", {
      users: [
        {
          token: "agent-a",
          created_at: "2026-04-23T00:59:55.000Z",
        },
      ],
    })).toBe(
      "YWdlbnQtYQ... name=agent-a live=unknown last_seen=5s",
    );

    expect(formatShort("message:history", {
      turns: [
        { id: "turn-1", status: "completed" },
      ],
    })).toBe(
      "turn-1 completed unknown items=unknown",
    );
  });

  it("renders session counts from daemonStatus output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T01:00:00.000Z"));

    const data = await daemonStatus({
      startedAt: new Date("2026-04-23T00:00:00.000Z"),
      sockPath: "/tmp/daemon.sock",
      dataDir: "/tmp/data",
      logPath: "/tmp/daemon.log",
      users: {
        list: () => [{ token: "user-1" }, { token: "user-2" }],
      },
      sessions: {
        listLive: (token: string) => token === "user-1" ? [{ name: "sess-a" }, { name: "sess-b" }] : [{ name: "sess-c" }],
      },
      pool: {
        processCount: () => 1,
      },
    } as never);

    expect(formatShort("daemon:status", data)).toContain("sessions=3");
  });

  it("preserves session list pagination metadata in a compact footer", () => {
    expect(formatShort("session:list", {
      sessions: [
        { name: "audit", state: "live", model: "gpt-5.4", current_turn_id: "turn-42" },
      ],
      next_cursor: "cursor-2",
      all: true,
      sort: "last_active",
      format: "json",
    })).toBe(
      "audit  live  gpt-5.4  busy=y\n# next_cursor=\"cursor-2\" all=true sort=\"last_active\" format=\"json\"",
    );
  });

  it("preserves message history notes in a compact footer", () => {
    expect(formatShort("message:history", {
      turns: [
        { id: "turn-1", status: "completed", item_count: 1 },
      ],
      format: "json",
      note: "Turn items are not included in turnsList responses.",
    })).toBe(
      "turn-1 completed unknown items=1\n# format=\"json\"\n# note=\"Turn items are not included in turnsList responses.\"",
    );
  });
});
