import { describe, expect, it } from "vitest";

import { formatCompact } from "../src/format/compact";

describe("formatCompact", () => {
  it.each([
    ["version", { daemon_version: "0.5.3", extra: true }, { daemon_version: "0.5.3" }],
    [
      "status",
      {
        token: "agent-a",
        created_at: "2026-04-23T00:00:00.000Z",
        live_sessions: 2,
        retained_events: 4,
        retained_limit: 100,
        pending_requests: 1,
        app_server_count: 3,
        daemon: { pid: 42 },
      },
      {
        token: "agent-a",
        live_sessions: 2,
        retained_events: 4,
        retained_limit: 100,
        pending_requests: 1,
        app_server_count: 3,
      },
    ],
    [
      "daemon:fleet:status",
      {
        total_users: 2,
        total_live_sessions: 3,
        total_pending: 1,
        total_app_servers: 4,
        per_user: [
          {
            token: "claude-a",
            live: 2,
            busy: 1,
            pending: 1,
            crashed: 0,
            last_event_id: "evt-1",
            last_activity_age_s: 42,
            ignored: true,
          },
        ],
      },
      {
        total_users: 2,
        total_live_sessions: 3,
        total_pending: 1,
        total_app_servers: 4,
        per_user: [
          {
            token: "claude-a",
            live: 2,
            busy: 1,
            pending: 1,
            crashed: 0,
            last_event_id: "evt-1",
            last_activity_age_s: 42,
          },
        ],
      },
    ],
    [
      "daemon:status",
      {
        pid: 42,
        version: "0.5.3",
        uptime_s: 90,
        sock: "/tmp/daemon.sock",
        data_dir: "/tmp/data",
        log_path: "/tmp/log",
        session_count: 3,
        user_count: 2,
        app_server_count: 1,
        dist_age_seconds: 15,
        source_newer_than_dist: false,
      },
      {
        pid: 42,
        version: "0.5.3",
        uptime_s: 90,
        sock: "/tmp/daemon.sock",
        session_count: 3,
        user_count: 2,
        app_server_count: 1,
        dist_age_seconds: 15,
        source_newer_than_dist: false,
      },
    ],
    ["daemon:start", { already_running: true }, { already_running: true }],
    ["daemon:stop", { stopping: true, force: true }, { stopping: true, force: true }],
    ["daemon:restart", { restarting: true }, { restarting: true }],
    ["daemon:logs", { level: "info", msg: "started" }, { level: "info", msg: "started" }],
    ["daemon:user:create", { token: "agent-a", created_at: "2026-04-23T00:00:00.000Z" }, { token: "agent-a" }],
    ["daemon:user:destroy", { destroyed: "agent-a", sessions_closed: 2, pending_canceled: 1 }, { destroyed: "agent-a" }],
    [
      "daemon:user:list",
      { users: [{ token: "agent-a", created_at: "x" }, { token: "agent-b", last_active_at: "y" }] },
      { users: [{ token: "agent-a" }, { token: "agent-b" }] },
    ],
    [
      "daemon:config:get",
      { key: "daemon.log_level", value: "debug", default: "info", source: "explicit", needs_restart: false, extra: true },
      { key: "daemon.log_level", value: "debug", default: "info", source: "explicit", needs_restart: false },
    ],
    [
      "daemon:config:set",
      { key: "daemon.log_level", value: "debug", needs_restart: false, ignored: true },
      { key: "daemon.log_level", value: "debug", needs_restart: false },
    ],
    [
      "daemon:config:unset",
      { key: "daemon.log_level", needs_restart: true, ignored: true },
      { key: "daemon.log_level", needs_restart: true },
    ],
    [
      "daemon:config:list",
      {
        config: [
          {
            key: "daemon.log_level",
            value: "debug",
            default: "info",
            explicit: true,
            needs_restart: false,
            type: "enum",
            description: "log verbosity",
          },
        ],
      },
      {
        config: [
          {
            key: "daemon.log_level",
            value: "debug",
            default: "info",
            explicit: true,
            needs_restart: false,
            type: "enum",
          },
        ],
      },
    ],
    ["daemon:config:reset", { reset: true }, { reset: true }],
    [
      "session:new",
      {
        session: {
          name: "audit",
          thread_id: "th-1",
          state: "live",
          created_at: "2026-04-23T00:00:00.000Z",
          model: "gpt-5.4",
          cwd: "/repo",
        },
      },
      {
        session: {
          name: "audit",
          thread_id: "th-1",
          state: "live",
          created_at: "2026-04-23T00:00:00.000Z",
        },
      },
    ],
    [
      "session:attach",
      {
        session: { name: "audit", thread_id: "th-1", state: "live", model: "gpt-5.4" },
        noop: true,
      },
      {
        session: { name: "audit", thread_id: "th-1", state: "live" },
        noop: true,
      },
    ],
    [
      "session:detach",
      {
        session: { name: "audit", thread_id: "th-1", state: "live", model: "gpt-5.4" },
        noop: false,
        graceful: true,
      },
      {
        session: { name: "audit", thread_id: "th-1", state: "live" },
        noop: false,
        graceful: true,
      },
    ],
    [
      "session:archive",
      {
        thread_id: "th-1",
        archived: true,
        archived_at: "2026-04-23T00:00:00.000Z",
        detached: true,
      },
      {
        thread_id: "th-1",
        archived: true,
      },
    ],
    [
      "session:unarchive",
      {
        thread_id: "th-1",
        unarchived: true,
        unarchived_at: "2026-04-23T00:00:00.000Z",
      },
      {
        thread_id: "th-1",
        unarchived: true,
      },
    ],
    [
      "session:fork",
      {
        session: { name: "audit-fix", thread_id: "th-2", state: "live", model: "gpt-5.4" },
        forked_from: "audit",
        at_turn: "turn-1",
      },
      { session: { name: "audit-fix", thread_id: "th-2", state: "live" } },
    ],
    [
      "session:rename",
      {
        session: { name: "audit-renamed", thread_id: "th-2", state: "live", model: "gpt-5.4" },
      },
      { session: { name: "audit-renamed" } },
    ],
    [
      "session:rollback",
      {
        name: "audit",
        old_thread_id: "th-1",
        new_thread_id: "th-2",
        forked_at_turn: "turn-1",
        archived_source_name: "audit-pre-rollback-2026-04-23T00:00:00.000Z",
      },
      {
        name: "audit",
        forked_at_turn: "turn-1",
        old_thread_id: "th-1",
        new_thread_id: "th-2",
      },
    ],
    [
      "session:info",
      {
        session: {
          name: "audit",
          thread_id: "th-1",
          state: "live",
          model: "gpt-5.4",
          turn_count: 3,
          current_turn_id: "turn-7",
          items_in_turn: 2,
          pending_approvals: 1,
          pending_user_inputs: 1,
        },
      },
      {
        session: {
          name: "audit",
          thread_id: "th-1",
          state: "live",
          model: "gpt-5.4",
          turn_count: 3,
          current_turn_id: "turn-7",
          items_in_turn: 2,
          pending_approvals: 1,
          pending_user_inputs: 1,
        },
      },
    ],
    [
      "session:context",
      {
        thread_id: "th-1",
        thread: {
          id: "th-1",
          name: "audit",
          status: { type: "running" },
          cwd: "/repo",
          source: "local",
          model_provider: "openai",
          created_at: 1,
          updated_at: 2,
          preview: "large preview",
          gitInfo: { branch: "main" },
        },
      },
      {
        thread_id: "th-1",
        thread: {
          id: "th-1",
          name: "audit",
          cwd: "/repo",
          source: "local",
          model_provider: "openai",
          created_at: 1,
          updated_at: 2,
          status: "running",
        },
      },
    ],
    [
      "session:list",
      {
        sessions: [
          {
            name: "audit",
            thread_id: "th-1",
            state: "live",
            model: "gpt-5.4",
            turn_count: 3,
            current_turn_id: "turn-7",
            cwd: "/repo",
          },
        ],
        all: false,
        sort: "last_active",
      },
      {
        sessions: [
          {
            name: "audit",
            thread_id: "th-1",
            state: "live",
            model: "gpt-5.4",
            turn_count: 3,
            current_turn_id: "turn-7",
          },
        ],
        all: false,
      },
    ],
    [
      "session:list",
      {
        sessions: [
          {
            name: "audit",
            thread_id: "th-1",
            state: "live",
            model: "gpt-5.4",
            busy: true,
            preview: "drop me",
          },
        ],
        all: true,
        next_cursor: "cursor-2",
      },
      {
        sessions: [
          {
            name: "audit",
            thread_id: "th-1",
            state: "live",
            model: "gpt-5.4",
            busy: true,
          },
        ],
        all: true,
        next_cursor: "cursor-2",
      },
    ],
    [
      "session:health:all",
      {
        summary: {
          total: 2,
          healthy: 1,
          crashed: 1,
          closed: 0,
          busy: 1,
          pending_total: 2,
          ignored: true,
        },
        sessions: [
          {
            session: "audit",
            thread_id: "th-1",
            state: "live",
            busy: true,
            current_turn_id: "turn-7",
            current_turn_elapsed_ms: 2500,
            current_item_type: "agent_message",
            items_done_in_turn: 2,
            pending_approval_requests: 1,
            pending_user_input_requests: 1,
            app_server_alive: true,
            last_event_id: "evt-8",
            token_usage_last_turn: { total: 10 },
          },
        ],
      },
      {
        summary: {
          total: 2,
          healthy: 1,
          crashed: 1,
          closed: 0,
          busy: 1,
          pending_total: 2,
        },
        sessions: [
          {
            session: "audit",
            thread_id: "th-1",
            state: "live",
            busy: true,
            current_turn_id: "turn-7",
            current_turn_elapsed_ms: 2500,
            current_item_type: "agent_message",
            items_done_in_turn: 2,
            pending_approval_requests: 1,
            pending_user_input_requests: 1,
            app_server_alive: true,
            last_event_id: "evt-8",
          },
        ],
      },
    ],
    [
      "session:health",
      {
        session: "audit",
        thread_id: "th-1",
        state: "live",
        busy: true,
        current_turn_id: "turn-7",
        current_turn_elapsed_ms: 2500,
        current_item_type: "agent_message",
        items_done_in_turn: 2,
        pending_approval_requests: 1,
        pending_user_input_requests: 1,
        app_server_alive: true,
        last_event_id: "evt-8",
        token_usage_last_turn: { total: 10 },
      },
      {
        session: "audit",
        thread_id: "th-1",
        state: "live",
        busy: true,
        current_turn_id: "turn-7",
        current_turn_elapsed_ms: 2500,
        current_item_type: "agent_message",
        items_done_in_turn: 2,
        pending_approval_requests: 1,
        pending_user_input_requests: 1,
        app_server_alive: true,
        last_event_id: "evt-8",
      },
    ],
    [
      "session:events",
      {
        id: "evt-7",
        ts: "2026-04-23T00:00:00.000Z",
        type: "turn.completed",
        session: "audit",
        thread_id: "th-1",
        payload: { turn_id: "turn-7" },
      },
      {
        id: "evt-7",
        ts: "2026-04-23T00:00:00.000Z",
        type: "turn.completed",
        session: "audit",
        thread_id: "th-1",
        payload: { turn_id: "turn-7" },
      },
    ],
    [
      "session:heal",
      {
        session: { name: "audit", thread_id: "th-1", state: "live", model: "gpt-5.4" },
        healed: true,
        forced: true,
      },
      {
        session: { name: "audit", thread_id: "th-1", state: "live" },
        healed: true,
      },
    ],
    [
      "message:send",
      { session: "audit", thread_id: "th-1", turn_id: "turn-7", started: false, queue_id: "q-1", queued_depth: 2 },
      { turn_id: "turn-7", started: false, queue_id: "q-1", queued_depth: 2 },
    ],
    ["message:peer", { session: "audit", turn_id: "turn-7", peered: true }, { turn_id: "turn-7", peered: true }],
    [
      "message:interrupt",
      { session: "audit", turn_id: "turn-7", interrupted: false, noop: true },
      { turn_id: "turn-7", interrupted: false },
    ],
    [
      "message:approval",
      { session: "audit", request_id: "req-1", kind: "approval.command_execution", responded: true },
      {},
    ],
    [
      "message:answer",
      { session: "audit", request_id: "req-2", responded: true, response: { answers: {} } },
      {},
    ],
    [
      "message:history",
      {
        session: "audit",
        thread_id: "th-1",
        turns: [{ id: "turn-1", status: "completed", items_count: 1 }],
        next_cursor: "cursor-2",
        format: "json",
        note: "static note",
      },
      {
        session: "audit",
        thread_id: "th-1",
        turns: [{ id: "turn-1", status: "completed", items_count: 1 }],
        next_cursor: "cursor-2",
      },
    ],
    [
      "message:tail",
      {
        session: "audit",
        turns: [{ id: "turn-1", status: "completed" }],
        format: "json",
        follow: true,
        thread: {
          id: "th-1",
          name: "audit",
          status: { type: "idle" },
          cwd: "/repo",
          source: "local",
          model_provider: "openai",
          updated_at: 10,
          preview: "drop me",
        },
      },
      {
        session: "audit",
        turns: [{ id: "turn-1", status: "completed" }],
        follow: true,
        thread: {
          id: "th-1",
          name: "audit",
          cwd: "/repo",
          source: "local",
          model_provider: "openai",
          updated_at: 10,
          status: "idle",
        },
      },
    ],
    [
      "message:wait",
      {
        session: "audit",
        thread_id: "th-1",
        turn_id: "turn-1",
        outcome: "error",
        event_type: "turn.error",
        event_id: "evt-9",
        error: { message: "boom" },
        duration_ms: 1000,
        items_count: 2,
        token_usage: { total: 10 },
      },
      {
        thread_id: "th-1",
        turn_id: "turn-1",
        outcome: "error",
        event_type: "turn.error",
        event_id: "evt-9",
        error: { message: "boom" },
        duration_ms: 1000,
        items_count: 2,
      },
    ],
    [
      "monitor:events",
      {
        id: "evt-1",
        ts: "2026-04-23T00:00:00.000Z",
        type: "turn.completed",
        session: "audit",
        thread_id: "th-1",
        payload: { turn_id: "turn-7", items_count: 2 },
      },
      {
        id: "evt-1",
        ts: "2026-04-23T00:00:00.000Z",
        type: "turn.completed",
        session: "audit",
        thread_id: "th-1",
        key: "turn-7",
      },
    ],
    [
      "monitor:alarm",
      { __alarm_event: "exit", exit_code: 0, signal: null, duration_ms: 10 },
      { __alarm_event: "exit", exit_code: 0, signal: null, duration_ms: 10 },
    ],
    [
      "cursor:save",
      { cursor: { name: "audit-tail", event_id: "evt-9", updated_at: "2026-04-23T00:00:00.000Z", auto_update: true } },
      { cursor: { name: "audit-tail", event_id: "evt-9" } },
    ],
    [
      "cursor:list",
      { cursors: [{ name: "audit-tail", event_id: "evt-9", updated_at: "2026-04-23T00:00:00.000Z", auto_update: true }] },
      { cursors: [{ name: "audit-tail", event_id: "evt-9", updated_at: "2026-04-23T00:00:00.000Z", auto_update: true }] },
    ],
    ["cursor:get", { event_id: "evt-9" }, { event_id: "evt-9" }],
    ["cursor:delete", { deleted: true, name: "audit-tail" }, { deleted: true, name: "audit-tail" }],
  ])("projects %s into the concise default shape", (method, data, expected) => {
    expect(formatCompact(method, data)).toEqual(expected);
  });

  it("keeps non-live session info thread metadata but drops bulky preview fields", () => {
    expect(formatCompact("session:info", {
      session: null,
      live: false,
      thread: {
        id: "th-1",
        status: { type: "idle" },
        cwd: "/repo",
        source: "local",
        model_provider: "openai",
        created_at: 1,
        updated_at: 2,
        preview: "drop me",
      },
    })).toEqual({
      session: null,
      live: false,
      thread: {
        id: "th-1",
        status: "idle",
        cwd: "/repo",
        source: "local",
        model_provider: "openai",
        created_at: 1,
        updated_at: 2,
      },
    });
  });

  it("passes through pre-summarized monitor events unchanged except for missing optional fields", () => {
    expect(formatCompact("monitor:events", {
      id: "evt-1",
      ts: "2026-04-23T00:00:00.000Z",
      type: "turn.completed",
      session: "audit",
      key: "turn-7",
    })).toEqual({
      id: "evt-1",
      ts: "2026-04-23T00:00:00.000Z",
      type: "turn.completed",
      session: "audit",
      key: "turn-7",
    });
  });
});
