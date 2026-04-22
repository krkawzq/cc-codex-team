import { afterEach, describe, expect, it, vi } from "vitest";

import { formatShort } from "../src/format/short";

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
  });
});
