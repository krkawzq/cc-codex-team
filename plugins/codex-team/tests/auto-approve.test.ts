import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { sessionNew } from "../src/daemon/handlers/session";
import { threadSetName, threadStart } from "../src/codex/rpc";

function makeReq(positionals: string[], flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "session:new",
    bearer: "user-1",
    params: {
      positionals,
      flags,
    },
  };
}

function makeContext(configValues: Record<string, unknown> = {}) {
  const client = {};
  return {
    users: {
      has: vi.fn().mockReturnValue(true),
      touch: vi.fn(),
    },
    sessions: {
      get: vi.fn().mockReturnValue(null),
      add: vi.fn(),
    },
    pool: {
      acquire: vi.fn().mockResolvedValue(client),
      release: vi.fn(),
    },
    config: {
      getEffective: vi.fn((key: string) => configValues[key] ?? null),
    },
    retryOptions: vi.fn().mockReturnValue({}),
  };
}

describe("session auto-approve defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(threadStart).mockResolvedValue({
      thread: { id: "th-1" },
    } as never);
    vi.mocked(threadSetName).mockResolvedValue(undefined as never);
  });

  it("inherits daemon default auto-approve patterns when the session flag is omitted", async () => {
    const ctx = makeContext({
      "session.auto_approve_command_patterns": "git,npm,node *",
    });

    await sessionNew(ctx as never, makeReq(["sess-1"]) as never);

    expect(ctx.sessions.add).toHaveBeenCalledWith("user-1", expect.objectContaining({
      autoApprovePatterns: ["git", "npm", "node *"],
    }));
  });

  it("treats an explicit empty --auto-approve as an opt-out of daemon defaults", async () => {
    const ctx = makeContext({
      "session.auto_approve_command_patterns": "git,npm,node *",
    });

    await sessionNew(ctx as never, makeReq(["sess-1"], {
      "auto-approve": "",
    }) as never);

    expect(ctx.sessions.add).toHaveBeenCalledWith("user-1", expect.objectContaining({
      autoApprovePatterns: [],
    }));
  });
});
