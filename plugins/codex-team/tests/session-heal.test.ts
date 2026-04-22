import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadFork: vi.fn(),
  threadIdOf: vi.fn((resp: { thread: { id: string } }) => resp.thread.id),
  threadList: vi.fn(),
  threadRead: vi.fn(),
  threadResume: vi.fn(),
  threadSetName: vi.fn(),
  threadStart: vi.fn(),
  threadUnsubscribe: vi.fn(),
  turnInterrupt: vi.fn(),
}));

import { threadResume } from "../src/codex/rpc";
import { sessionHeal } from "../src/daemon/handlers/session";
import { SessionRegistry, sessionRuntimeDefaults } from "../src/daemon/sessions";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-session-heal-"));
}

function makeReq(flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "session:heal",
    bearer: "user-1",
    params: {
      positionals: ["sess-1"],
      flags,
    },
  };
}

describe("sessionHeal", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-attaches a crashed session to a fresh app-server client", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "crashed",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 2,
      crash_reason: "app-server process exited unexpectedly",
      ...sessionRuntimeDefaults(),
    });
    sessions.update("user-1", "sess-1", {
      current_turn_id: "turn-9",
      current_turn_started_at: "2025-01-01T00:00:01.000Z",
      current_item_type: "command_execution",
      items_in_turn: 3,
      crash_reason: "app-server process exited unexpectedly",
    });
    await sessions.flush();

    const client = { tag: "replacement" };
    vi.mocked(threadResume).mockResolvedValue(undefined as never);

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        touch: vi.fn(),
      },
      sessions,
      pool: {
        clientForSession: vi.fn().mockReturnValue(null),
        release: vi.fn(),
        acquire: vi.fn().mockResolvedValue(client),
      },
      queues: {
        dispose: vi.fn(),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await sessionHeal(ctx as never, makeReq() as never);

    expect(ctx.pool.acquire).toHaveBeenCalledWith("user-1", "user-1::sess-1", undefined);
    expect(vi.mocked(threadResume)).toHaveBeenCalledWith(client, "th-1", {});
    expect(result).toMatchObject({
      ok: true,
      healed: true,
      forced: false,
      session: {
        name: "sess-1",
        state: "live",
        crash_reason: null,
        current_turn_id: null,
        current_item_type: null,
        items_in_turn: 0,
      },
    });
  });
});
