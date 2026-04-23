import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadArchive: vi.fn(),
  threadFork: vi.fn(),
  threadIdOf: vi.fn((resp: { thread: { id: string } }) => resp.thread.id),
  threadLoadedList: vi.fn(),
  threadList: vi.fn(),
  threadRename: vi.fn(),
  threadRead: vi.fn(),
  threadResume: vi.fn(),
  threadSetName: vi.fn(),
  threadStart: vi.fn(),
  threadTurnsList: vi.fn(),
  threadUnarchive: vi.fn(),
  threadUnsubscribe: vi.fn(),
  turnInterrupt: vi.fn(),
}));

import { sessionAttach, sessionDetach, sessionFork, sessionList, sessionNew, sessionRename } from "../src/daemon/handlers/session";
import {
  threadFork,
  threadList,
  threadRead,
  threadResume,
  threadStart,
  threadSetName,
  threadUnsubscribe,
  turnInterrupt,
} from "../src/codex/rpc";
import { PendingRegistry } from "../src/daemon/pending";
import { TurnQueues } from "../src/daemon/queues";
import { SessionRegistry } from "../src/daemon/sessions";

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
    const projectDir = path.join(tmpRoot, "project");
    fs.writeFileSync(basePath, "base instructions");
    fs.writeFileSync(devPath, "developer instructions");
    fs.mkdirSync(projectDir);

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
      cwd: projectDir,
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
      cwd: projectDir,
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

  it("rejects invalid auto-approve regex on session:new", async () => {
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
        acquire: vi.fn(),
        release: vi.fn(),
      },
      config: {
        getEffective: vi.fn().mockReturnValue(null),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    await expect(sessionNew(ctx as never, makeReq("session:new", ["sess-1"], {
      "auto-approve": "/unterminated",
    }) as never)).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(ctx.pool.acquire).not.toHaveBeenCalled();
    expect(ctx.sessions.add).not.toHaveBeenCalled();
  });

  it("interrupts and cleans pending state on detach", async () => {
    vi.mocked(turnInterrupt).mockResolvedValue(undefined as never);
    vi.mocked(threadUnsubscribe).mockResolvedValue(undefined as never);

    const pendingClient = { respondError: vi.fn() };
    const pendingEntry = {
      request_id: "req-1",
      kind: "approval.permissions",
      user: "user-1",
      session_name: "sess-1",
      thread_id: "th-1",
      turn_id: "turn-1",
      jsonrpc_id: 42,
      client: pendingClient,
      raw: {},
      created_at: "2025-01-01T00:00:00.000Z",
    };
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
        finalDispose: vi.fn(),
      },
      pending: {
        listForUser: vi.fn().mockReturnValue([pendingEntry]),
        remove: vi.fn().mockReturnValue(pendingEntry),
      },
      events: {
        append: vi.fn().mockResolvedValue(undefined),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await sessionDetach(ctx as never, makeReq("session:detach", ["sess-1"]) as never);

    expect(vi.mocked(turnInterrupt)).toHaveBeenCalledWith({}, "th-1", "turn-1", {});
    expect(vi.mocked(threadUnsubscribe)).toHaveBeenCalledWith({}, "th-1", {});
    expect(ctx.queues.finalDispose).toHaveBeenCalledWith("user-1::sess-1");
    expect(pendingClient.respondError).toHaveBeenCalledWith(42, -32000, "session detached");
    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "approval.request_cancelled",
      session: "sess-1",
      thread_id: "th-1",
      payload: expect.objectContaining({
        request_id: "req-1",
        reason: "user_detach",
      }),
    }));
    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "session.closed",
      payload: expect.objectContaining({ reason: "user_detach" }),
    }));
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
        finalDispose: vi.fn(),
      },
      pending: {
        removeForSession: vi.fn().mockReturnValue([]),
      },
      events: {
        append: vi.fn().mockResolvedValue(undefined),
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

  it("rekeys queue and pending runtime state on rename", async () => {
    vi.mocked(threadSetName).mockResolvedValue(undefined as never);
    const dataDir = path.join(tmpRoot, "rename-state");
    const sessions = new SessionRegistry(dataDir, { persistDebounceMs: 0 });
    const queues = new TurnQueues();
    const pending = new PendingRegistry();

    sessions.add("user-1", {
      name: "foo",
      thread_id: "th-1",
      state: "live",
      autoApprovePatterns: [],
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
    });
    queues.setCurrentTurn("user-1::foo", "turn-1");
    pending.add({
      kind: "approval.permissions",
      client: {} as never,
      jsonrpc_id: 7,
      user: "user-1",
      session_name: "foo",
      thread_id: "th-1",
      turn_id: "turn-1",
      raw: {},
    });

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      pool: {
        clientForSession: vi.fn().mockReturnValue({}),
        rekeySession: vi.fn(),
      },
      queues,
      pending,
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await sessionRename(ctx as never, makeReq("session:rename", ["foo", "bar"]) as never);

    expect(result).toMatchObject({
      session: {
        name: "bar",
        thread_id: "th-1",
      },
    });
    expect(queues.getCurrentTurn("user-1::foo")).toBeNull();
    expect(queues.getCurrentTurn("user-1::bar")).toBe("turn-1");
    expect(pending.listForUser("user-1")).toEqual([
      expect.objectContaining({
        session_name: "bar",
        thread_id: "th-1",
      }),
    ]);

    await sessions.flush();
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

  it("attaches a detached session by name", async () => {
    const adhocClient = { kind: "adhoc-client" };
    const liveClient = { kind: "live-client" };
    vi.mocked(threadList).mockResolvedValue({
      data: [{ id: "th-detached", name: "refactor" }],
      nextCursor: null,
    } as never);
    vi.mocked(threadResume).mockResolvedValue(undefined as never);

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        touch: vi.fn(),
      },
      sessions: {
        get: vi.fn().mockReturnValue(null),
        findLiveAnywhere: vi.fn().mockReturnValue(null),
        findUniqueLiveByNameAnywhere: vi.fn().mockReturnValue(null),
        add: vi.fn(),
      },
      pool: {
        acquireForAdhoc: vi.fn().mockResolvedValue(adhocClient),
        acquire: vi.fn().mockResolvedValue(liveClient),
        release: vi.fn(),
      },
      config: {
        getEffective: vi.fn().mockReturnValue(null),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await sessionAttach(ctx as never, makeReq("session:attach", ["refactor"]) as never);

    expect(result).toMatchObject({
      session: {
        name: "refactor",
        thread_id: "th-detached",
      },
    });
    expect(ctx.pool.acquireForAdhoc).toHaveBeenCalled();
    expect(vi.mocked(threadList)).toHaveBeenCalledWith(adhocClient, {
      pageSize: 200,
      includeArchived: true,
    }, {});
    expect(vi.mocked(threadResume)).toHaveBeenCalledWith(liveClient, "th-detached", {});
    expect(ctx.pool.acquire).toHaveBeenCalledWith("user-1", "user-1::refactor", undefined);
  });

  it("keeps direct UUID attach on the existing thread-id path", async () => {
    const threadId = "019db000-1111-2222-3333-444444444444";
    const client = { kind: "live-client" };
    vi.mocked(threadResume).mockResolvedValue(undefined as never);

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        touch: vi.fn(),
      },
      sessions: {
        get: vi.fn().mockReturnValue(null),
        findLiveAnywhere: vi.fn().mockReturnValue(null),
        findUniqueLiveByNameAnywhere: vi.fn(),
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

    const result = await sessionAttach(ctx as never, makeReq("session:attach", [threadId]) as never);

    expect(result).toMatchObject({
      session: {
        name: "s-019db000",
        thread_id: threadId,
      },
    });
    expect(vi.mocked(threadResume)).toHaveBeenCalledWith(client, threadId, {});
    expect(vi.mocked(threadList)).not.toHaveBeenCalled();
    expect(vi.mocked(threadRead)).not.toHaveBeenCalled();
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
        finalDispose: vi.fn(),
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

  it("rejects attach when inherited auto-approve patterns are invalid", async () => {
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        touch: vi.fn(),
      },
      sessions: {
        get: vi.fn().mockReturnValue(null),
        findLiveAnywhere: vi.fn().mockReturnValue({
          user: "user-1",
          record: {
            name: "sess-1",
            thread_id: "th-1",
            state: "live",
            autoApprovePatterns: ["/unterminated"],
          },
        }),
        findUniqueLiveByNameAnywhere: vi.fn(),
        add: vi.fn(),
      },
      pool: {
        acquire: vi.fn(),
        release: vi.fn(),
      },
      config: {
        getEffective: vi.fn().mockReturnValue(null),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    await expect(sessionAttach(ctx as never, makeReq("session:attach", ["th-1"]) as never)).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(ctx.pool.acquire).not.toHaveBeenCalled();
    expect(ctx.sessions.add).not.toHaveBeenCalled();
  });

  it("passes pagination flags through session list --all", async () => {
    vi.mocked(threadList).mockResolvedValue({
      data: [],
      nextCursor: "cursor-2",
    } as never);

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions: {
        findLiveAnywhere: vi.fn().mockReturnValue(null),
      },
      pool: {
        acquireForAdhoc: vi.fn().mockResolvedValue({}),
        clientForSession: vi.fn().mockReturnValue(null),
      },
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await sessionList(ctx as never, makeReq("session:list", [], {
      all: true,
      cursor: "cursor-1",
      limit: "10",
    }) as never);

    expect(vi.mocked(threadList)).toHaveBeenCalledWith({}, {
      cursor: "cursor-1",
      pageSize: 10,
      includeArchived: false,
    }, {});
    expect(result).toMatchObject({
      next_cursor: "cursor-2",
      all: true,
    });
  });

  it("filters mixed thread states for session list --all", async () => {
    vi.mocked(threadList).mockResolvedValue({
      data: [
        { id: "th-live", name: "live-thread" },
        { id: "th-crashed", name: "crashed-thread" },
        { id: "th-closed", name: "closed-thread" },
        { id: "th-archived", name: "archived-thread", status: "archived" },
        { id: "th-closed-2", name: "closed-thread-2" },
      ],
      nextCursor: null,
    } as never);

    const liveByThread = new Map([
      ["th-live", {
        user: "user-1",
        record: {
          name: "live",
          thread_id: "th-live",
          state: "live",
          model: "gpt-5.4",
          turn_count: 3,
          current_turn_id: "turn-1",
          last_active_at: "2025-01-01T00:00:05.000Z",
        },
      }],
      ["th-crashed", {
        user: "user-1",
        record: {
          name: "crashed",
          thread_id: "th-crashed",
          state: "crashed",
          model: "gpt-5.4-mini",
          turn_count: 1,
          current_turn_id: null,
          last_active_at: "2025-01-01T00:00:04.000Z",
        },
      }],
    ]);

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions: {
        findLiveAnywhere: vi.fn((threadId: string) => liveByThread.get(threadId) ?? null),
      },
      pool: {
        acquireForAdhoc: vi.fn().mockResolvedValue({}),
        clientForSession: vi.fn().mockReturnValue({ isAlive: () => true }),
      },
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await sessionList(ctx as never, makeReq("session:list", [], {
      all: true,
      state: "live,crashed",
      archived: "include",
      owner: "any",
    }) as never) as { sessions: Array<Record<string, unknown>> };

    expect(result.sessions).toEqual([
      expect.objectContaining({
        name: "live",
        thread_id: "th-live",
        state: "live",
        busy: true,
      }),
      expect.objectContaining({
        name: "crashed",
        thread_id: "th-crashed",
        state: "crashed",
        busy: false,
      }),
    ]);
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
        finalDispose: vi.fn(),
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

  it("rejects fork when the source session has invalid auto-approve patterns", async () => {
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions: {
        get: vi.fn((user: string, identifier: string) => (
          identifier === "sess-1"
            ? {
                name: "sess-1",
                thread_id: "th-1",
                state: "live",
                autoApprovePatterns: ["/unterminated"],
              }
            : null
        )),
      },
      pool: {
        acquire: vi.fn(),
        release: vi.fn(),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    vi.mocked(threadFork).mockResolvedValue({
      thread: { id: "th-2" },
    } as never);

    await expect(sessionFork(ctx as never, makeReq("session:fork", ["sess-1", "sess-2"]) as never)).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(ctx.pool.acquire).not.toHaveBeenCalled();
    expect(vi.mocked(threadFork)).not.toHaveBeenCalled();
  });
});
