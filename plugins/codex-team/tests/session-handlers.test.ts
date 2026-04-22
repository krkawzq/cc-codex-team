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

import { sessionAttach, sessionDetach, sessionNew } from "../src/daemon/handlers/session";
import { threadStart, threadSetName, threadUnsubscribe, turnInterrupt } from "../src/codex/rpc";

function makeReq(method: string, positionals: string[], flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method,
    bearer: "user-1",
    params: {
      positionals,
      flags,
    },
  };
}

describe("session handlers", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-session-"));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const name of fs.readdirSync(tmpRoot)) {
      fs.rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
    }
  });

  it("maps session:new flags into supported thread/start params", async () => {
    const basePath = path.join(tmpRoot, "base.md");
    const devPath = path.join(tmpRoot, "dev.md");
    fs.writeFileSync(basePath, "base instructions");
    fs.writeFileSync(devPath, "developer instructions");

    vi.mocked(threadStart).mockResolvedValue({
      thread: { id: "th-1" },
    } as never);
    vi.mocked(threadSetName).mockResolvedValue(undefined as never);

    const client = {};
    const ctx = {
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
        getEffective: vi.fn().mockReturnValue(null),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    await sessionNew(ctx as never, makeReq("session:new", ["sess-1"], {
      model: "gpt-5.4",
      cwd: "/tmp/project",
      sandbox: "workspace-write",
      approval: "on-request",
      effort: "high",
      profile: "work",
      personality: "bold",
      "base-instructions": basePath,
      "developer-instructions": devPath,
    }) as never);

    const params = vi.mocked(threadStart).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: "gpt-5.4",
      cwd: "/tmp/project",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      baseInstructions: "base instructions",
      developerInstructions: "developer instructions",
      personality: "bold",
      config: {
        profile: "work",
        model_reasoning_effort: "high",
      },
    });
    expect(params).not.toHaveProperty("sandboxMode");
    expect(params).not.toHaveProperty("effort");
    expect(params).not.toHaveProperty("profile");
  });

  it("interrupts and cleans pending state on detach", async () => {
    vi.mocked(turnInterrupt).mockResolvedValue(undefined as never);
    vi.mocked(threadUnsubscribe).mockResolvedValue(undefined as never);

    const pendingClient = { respondError: vi.fn() };
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions: {
        get: vi.fn().mockReturnValue({ name: "sess-1", thread_id: "th-1" }),
        remove: vi.fn(),
      },
      pool: {
        clientForSession: vi.fn().mockReturnValue({}),
        release: vi.fn(),
      },
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue("turn-1"),
        dispose: vi.fn(),
      },
      pending: {
        removeForSession: vi.fn().mockReturnValue([
          { client: pendingClient, jsonrpc_id: 42 },
        ]),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await sessionDetach(ctx as never, makeReq("session:detach", ["sess-1"]) as never);

    expect(vi.mocked(turnInterrupt)).toHaveBeenCalledWith({}, "th-1", "turn-1", {});
    expect(vi.mocked(threadUnsubscribe)).toHaveBeenCalledWith({}, "th-1", {});
    expect(ctx.queues.dispose).toHaveBeenCalledWith("user-1::sess-1");
    expect(pendingClient.respondError).toHaveBeenCalledWith(42, -32000, "session detached");
    expect(result).toMatchObject({ graceful: false, noop: false });
  });

  it("rejects ambiguous cross-user session names", async () => {
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions: {
        get: vi.fn().mockReturnValue(null),
        findUniqueLiveByNameAnywhere: vi.fn().mockReturnValue("ambiguous"),
        findLiveAnywhere: vi.fn(),
      },
    };

    await expect(sessionAttach(ctx as never, makeReq("session:attach", ["shared-name"]) as never))
      .rejects.toMatchObject({ code: "invalid_params" });
  });
});
