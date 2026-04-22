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
import { threadResume, threadStart, threadSetName, threadUnsubscribe, turnInterrupt } from "../src/codex/rpc";

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
      "experimental-tools": "ask-user-question",
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
        features: {
          default_mode_request_user_input: true,
        },
      },
    });
    expect(params).not.toHaveProperty("sandboxMode");
    expect(params).not.toHaveProperty("effort");
    expect(params).not.toHaveProperty("profile");
    expect(ctx.pool.acquire).toHaveBeenCalledWith("user-1", "user-1::sess-1", {
      configOverrides: ["features.default_mode_request_user_input=true"],
    });
    expect(ctx.sessions.add).toHaveBeenCalledWith("user-1", expect.objectContaining({
      experimental_tools: ["ask-user-question"],
      autoApprovePatterns: [],
    }));
  });

  it("uses daemon default experimental tools when the session flag is omitted", async () => {
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
        getEffective: vi.fn((key: string) => (
          key === "experimental.default_tools" ? "ask-user-question" : null
        )),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    await sessionNew(ctx as never, makeReq("session:new", ["sess-1"]) as never);

    expect(vi.mocked(threadStart).mock.calls[0]?.[1]).toMatchObject({
      config: {
        features: {
          default_mode_request_user_input: true,
        },
      },
    });
    expect(ctx.pool.acquire).toHaveBeenCalledWith("user-1", "user-1::sess-1", {
      configOverrides: ["features.default_mode_request_user_input=true"],
    });
  });

  it("stores explicit auto-approve patterns on new sessions", async () => {
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
      "auto-approve": "git*, node *, /sh -c cat.*/i",
    }) as never);

    expect(ctx.sessions.add).toHaveBeenCalledWith("user-1", expect.objectContaining({
      autoApprovePatterns: ["git*", "node *", "/sh -c cat.*/i"],
    }));
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
        beginTeardown: vi.fn().mockResolvedValue({ currentTurnId: "turn-1" }),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
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

  it("waits for the active turn to finish before graceful detach unsubscribes", async () => {
    vi.mocked(threadUnsubscribe).mockResolvedValue(undefined as never);
    let releaseIdle!: () => void;
    const idlePromise = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });

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
        beginTeardown: vi.fn().mockResolvedValue({ currentTurnId: "turn-1" }),
        waitForIdle: vi.fn().mockImplementation(() => idlePromise),
        dispose: vi.fn(),
      },
      pending: {
        removeForSession: vi.fn().mockReturnValue([]),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const detachPromise = sessionDetach(ctx as never, makeReq("session:detach", ["sess-1"], { graceful: true }) as never);
    await Promise.resolve();

    expect(vi.mocked(turnInterrupt)).not.toHaveBeenCalled();
    expect(vi.mocked(threadUnsubscribe)).not.toHaveBeenCalled();

    releaseIdle();
    await detachPromise;

    expect(vi.mocked(threadUnsubscribe)).toHaveBeenCalledWith({}, "th-1", {});
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

  it("serializes concurrent thread takeover attaches so only one resume runs", async () => {
    let owner: "user-1" | "user-2" | null = "user-1";
    const client = {};
    let resumeRelease!: () => void;
    const resumePromise = new Promise<void>((resolve) => {
      resumeRelease = resolve;
    });
    vi.mocked(threadResume).mockImplementation(() => resumePromise as never);

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        touch: vi.fn(),
      },
      sessions: {
        get: vi.fn((user: string, identifier: string) => {
          if (user === "user-2" && owner === "user-2" && identifier === "th-1") {
            return { name: "sess-1", thread_id: "th-1" };
          }
          return null;
        }),
        touch: vi.fn(),
        findLiveAnywhere: vi.fn(() => {
          if (owner === "user-1") {
            return {
              user: "user-1",
              record: { name: "sess-1", thread_id: "th-1", state: "live" },
            };
          }
          if (owner === "user-2") {
            return {
              user: "user-2",
              record: { name: "sess-1", thread_id: "th-1", state: "live" },
            };
          }
          return null;
        }),
        findUniqueLiveByNameAnywhere: vi.fn(),
        remove: vi.fn(() => {
          owner = null;
          return { name: "sess-1", thread_id: "th-1" };
        }),
        add: vi.fn(() => {
          owner = "user-2";
        }),
      },
      pool: {
        clientForSession: vi.fn().mockReturnValue({}),
        acquire: vi.fn().mockResolvedValue(client),
        release: vi.fn(),
      },
      queues: {
        beginTeardown: vi.fn().mockResolvedValue({ currentTurnId: null }),
        dispose: vi.fn(),
      },
      pending: {
        removeForSession: vi.fn().mockReturnValue([]),
      },
      events: {
        append: vi.fn(),
      },
      config: {
        getEffective: vi.fn().mockReturnValue(null),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const reqA = { ...makeReq("session:attach", ["th-1"], { takeover: true }), bearer: "user-2" };
    const reqB = { ...makeReq("session:attach", ["th-1"], { takeover: true }), bearer: "user-2", id: "req-2" };

    const first = sessionAttach(ctx as never, reqA as never);
    const second = sessionAttach(ctx as never, reqB as never);
    await vi.waitFor(() => {
      expect(vi.mocked(threadResume)).toHaveBeenCalledTimes(1);
    });

    resumeRelease();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toMatchObject({ session: { thread_id: "th-1" } });
    expect(b).toMatchObject({ noop: true });
    expect(ctx.pool.acquire).toHaveBeenCalledTimes(1);
  });

  it("releases the acquired client if attach loses the registry add race after resume", async () => {
    vi.mocked(threadResume).mockResolvedValue(undefined as never);

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        touch: vi.fn(),
      },
      sessions: {
        get: vi.fn().mockReturnValue(null),
        findLiveAnywhere: vi.fn()
          .mockReturnValueOnce({
            user: "user-1",
            record: { name: "sess-1", thread_id: "th-1", state: "live" },
          })
          .mockReturnValue(null)
          .mockReturnValue(null),
        findUniqueLiveByNameAnywhere: vi.fn(),
        remove: vi.fn().mockReturnValue({ name: "sess-1", thread_id: "th-1" }),
        add: vi.fn(() => {
          throw new Error("lost race");
        }),
      },
      pool: {
        clientForSession: vi.fn().mockReturnValue({}),
        acquire: vi.fn().mockResolvedValue({}),
        release: vi.fn(),
      },
      queues: {
        beginTeardown: vi.fn().mockResolvedValue({ currentTurnId: null }),
        dispose: vi.fn(),
      },
      pending: {
        removeForSession: vi.fn().mockReturnValue([]),
      },
      events: {
        append: vi.fn(),
      },
      config: {
        getEffective: vi.fn().mockReturnValue(null),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const req = { ...makeReq("session:attach", ["th-1"], { takeover: true }), bearer: "user-2" };

    await expect(sessionAttach(ctx as never, req as never)).rejects.toThrow("lost race");
    expect(ctx.pool.release).toHaveBeenCalledWith("user-2::sess-1");
  });
});
