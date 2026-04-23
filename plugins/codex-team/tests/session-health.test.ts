import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventLog } from "../src/daemon/events";
import { sessionHealth } from "../src/daemon/handlers/session";
import { SessionRegistry, sessionRuntimeDefaults } from "../src/daemon/sessions";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-session-health-"));
}

function makeReq(positionals: string[]) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "session:health",
    bearer: "user-1",
    params: {
      positionals,
      flags: {},
    },
  };
}

describe("sessionHealth", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a compact live snapshot from the tracked session state", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);
    const startedAt = new Date(Date.now() - 2500).toISOString();

    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 3,
      current_turn_id: "turn-7",
      current_turn_started_at: startedAt,
      current_item_type: "agent_message",
      items_in_turn: 2,
      pending_approvals: 1,
      pending_user_inputs: 1,
      token_usage_last_turn: { prompt: 12, completion: 34, total: 46 },
      ...sessionRuntimeDefaults(),
    });
    sessions.update("user-1", "sess-1", {
      current_turn_id: "turn-7",
      current_turn_started_at: startedAt,
      current_item_type: "agent_message",
      items_in_turn: 2,
      pending_approvals: 1,
      pending_user_inputs: 1,
      token_usage_last_turn: { prompt: 12, completion: 34, total: 46 },
    });
    await sessions.flush();

    const event = await events.append("user-1", {
      type: "item.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        turn_id: "turn-7",
      },
    });

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      pool: {
        clientForSession: vi.fn().mockReturnValue({
          isAlive: () => true,
        }),
      },
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue("turn-7"),
      },
      pending: {
        listForUser: vi.fn().mockReturnValue([
          { session_name: "sess-1", kind: "approval.file_change" },
          { session_name: "sess-1", kind: "user_input.request" },
        ]),
      },
      events,
    };

    const result = await sessionHealth(ctx as never, makeReq(["sess-1"]) as never);

    expect(result).toMatchObject({
      session: "sess-1",
      thread_id: "th-1",
      state: "live",
      busy: true,
      current_turn_id: "turn-7",
      current_turn_started_at: startedAt,
      current_item_type: "agent_message",
      items_done_in_turn: 2,
      pending_approval_requests: 1,
      pending_user_input_requests: 1,
      token_usage_last_turn: { prompt: 12, completion: 34, total: 46 },
      app_server_alive: true,
      last_event_id: event.id,
    });
    expect((result as { current_turn_elapsed_ms: number | null }).current_turn_elapsed_ms).toBeGreaterThanOrEqual(2000);
  });
});
