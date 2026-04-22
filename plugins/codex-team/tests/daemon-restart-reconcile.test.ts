import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_REQUEST_CANCELLED_EVENT_TYPE,
  SESSION_CRASHED_EVENT_TYPE,
  SESSION_PENDING_DROPPED_EVENT_TYPE,
  USER_INPUT_REQUEST_CANCELLED_EVENT_TYPE,
} from "../src/daemon/events";
import { reconcileLoadedSessionsAfterRestart } from "../src/daemon/run";
import { SessionRegistry } from "../src/daemon/sessions";
import { userSessionsPath } from "../src/paths";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-restart-reconcile-"));
}

describe("reconcileLoadedSessionsAfterRestart", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks stale live sessions as crashed and emits cancellation events for pending requests", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const filePath = userSessionsPath("user-1", dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      schema_version: 1,
      sessions: [{
        name: "sess-1",
        thread_id: "th-dead",
        state: "live",
        created_at: "2025-01-01T00:00:00.000Z",
        last_active_at: "2025-01-01T00:00:05.000Z",
        turn_count: 2,
        last_turn_id: "turn-8",
        current_turn_id: "turn-9",
        current_turn_started_at: "2025-01-01T00:00:08.000Z",
        current_item_type: "command_execution",
        items_in_turn: 3,
        pending_approvals: 1,
        pending_user_inputs: 1,
      }],
    }, null, 2));

    const sessions = new SessionRegistry(dir);
    const appended: Array<{ user: string; type: string; payload: Record<string, unknown> }> = [];

    const approvalClient = { respondError: vi.fn() };
    const inputClient = { respondError: vi.fn() };
    const pendingEntries = [
      {
        request_id: "req-approval",
        kind: "approval.permissions",
        turn_id: "turn-9",
        user: "user-1",
        session_name: "sess-1",
        thread_id: "th-dead",
        jsonrpc_id: 41,
        client: approvalClient,
        raw: {},
        created_at: "2025-01-01T00:00:08.000Z",
      },
      {
        request_id: "req-input",
        kind: "user_input.request",
        turn_id: "turn-9",
        user: "user-1",
        session_name: "sess-1",
        thread_id: "th-dead",
        jsonrpc_id: 42,
        client: inputClient,
        raw: {},
        created_at: "2025-01-01T00:00:08.000Z",
      },
    ];

    await reconcileLoadedSessionsAfterRestart({
      users: {
        list: () => [{ token: "user-1" }],
      },
      sessions,
      pool: {
        clientForSession: vi.fn().mockReturnValue(null),
      },
      pending: {
        listForUser: vi.fn().mockReturnValue(pendingEntries),
        remove: vi.fn((requestId: string) => pendingEntries.find((entry) => entry.request_id === requestId) ?? null),
      },
      events: {
        append: vi.fn(async (user: string, input: { type: string; payload: Record<string, unknown> }) => {
          appended.push({ user, type: input.type, payload: input.payload });
          return {
            id: `evt-${appended.length}`,
            ts: "2025-01-01T00:00:10.000Z",
            ...input,
          };
        }),
      },
    } as never);

    expect(approvalClient.respondError).toHaveBeenCalledWith(41, -32000, "session_crashed");
    expect(inputClient.respondError).toHaveBeenCalledWith(42, -32000, "session_crashed");
    expect(sessions.get("user-1", "sess-1")).toMatchObject({
      state: "crashed",
      recovery_state: "degraded",
      crash_reason: "app_server_crashed_on_restart",
      last_turn_id: "turn-9",
      current_turn_id: null,
      current_turn_started_at: null,
      current_item_type: null,
      items_in_turn: 0,
      pending_approvals: 0,
      pending_user_inputs: 0,
    });
    expect(appended).toEqual([
      expect.objectContaining({
        user: "user-1",
        type: SESSION_CRASHED_EVENT_TYPE,
        payload: expect.objectContaining({
          reason: "app_server_crashed_on_restart",
          last_turn_id: "turn-9",
        }),
      }),
      expect.objectContaining({
        user: "user-1",
        type: APPROVAL_REQUEST_CANCELLED_EVENT_TYPE,
        payload: expect.objectContaining({
          request_id: "req-approval",
          kind: "approval.permissions",
          reason: "app_server_crashed_on_restart",
        }),
      }),
      expect.objectContaining({
        user: "user-1",
        type: USER_INPUT_REQUEST_CANCELLED_EVENT_TYPE,
        payload: expect.objectContaining({
          request_id: "req-input",
          kind: "user_input.request",
          reason: "app_server_crashed_on_restart",
        }),
      }),
    ]);
  });

  it("emits one synthetic session.pending_dropped event when restart lost pending metadata", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const filePath = userSessionsPath("user-1", dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      schema_version: 1,
      sessions: [{
        name: "sess-1",
        thread_id: "th-dead",
        state: "live",
        created_at: "2025-01-01T00:00:00.000Z",
        last_active_at: "2025-01-01T00:00:05.000Z",
        turn_count: 2,
        last_turn_id: "turn-8",
        current_turn_id: "turn-9",
        current_turn_started_at: "2025-01-01T00:00:08.000Z",
        current_item_type: "command_execution",
        items_in_turn: 3,
        pending_approvals: 1,
        pending_user_inputs: 1,
      }],
    }, null, 2));

    const sessions = new SessionRegistry(dir);
    const appended: Array<{ user: string; type: string; payload: Record<string, unknown> }> = [];

    await reconcileLoadedSessionsAfterRestart({
      users: {
        list: () => [{ token: "user-1" }],
      },
      sessions,
      pool: {
        clientForSession: vi.fn().mockReturnValue(null),
      },
      pending: {
        listForUser: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn(async (user: string, input: { type: string; payload: Record<string, unknown> }) => {
          appended.push({ user, type: input.type, payload: input.payload });
          return {
            id: `evt-${appended.length}`,
            ts: "2025-01-01T00:00:10.000Z",
            ...input,
          };
        }),
      },
    } as never);

    expect(appended).toEqual([
      expect.objectContaining({
        user: "user-1",
        type: SESSION_CRASHED_EVENT_TYPE,
      }),
      expect.objectContaining({
        user: "user-1",
        type: SESSION_PENDING_DROPPED_EVENT_TYPE,
        payload: {
          session: "sess-1",
          thread_id: "th-dead",
          reason: "daemon_restart_pending_lost",
        },
      }),
    ]);
  });
});
