import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadList: vi.fn(),
  threadRead: vi.fn(),
  threadTurnsList: vi.fn(),
  turnInterrupt: vi.fn(),
  turnSteer: vi.fn(),
}));

import { messageApproval, messageHistory, messageInterrupt, messageSend, messageTail } from "../src/daemon/handlers/message";
import { threadList, threadRead, threadTurnsList, turnInterrupt } from "../src/codex/rpc";
import { PendingRegistry } from "../src/daemon/pending";

function makeReq(positionals: string[], flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "message:test",
    bearer: "user-1",
    params: {
      positionals,
      flags,
    },
  };
}

function makeLiveContext(overrides: Record<string, unknown> = {}) {
  const record = {
    name: "sess-1",
    thread_id: "th-1",
  };
  const client = {
    respondAck: vi.fn().mockResolvedValue({ backpressured: false }),
  };
  return {
    users: {
      has: vi.fn().mockReturnValue(true),
    },
    sessions: {
      get: vi.fn().mockReturnValue(record),
      touch: vi.fn(),
    },
    pool: {
      clientForSession: vi.fn().mockReturnValue(client),
      acquire: vi.fn().mockResolvedValue(client),
    },
    queues: {
      sendOrQueue: vi.fn().mockResolvedValue({ started: true, turn_id: "turn-1", queue_id: null, queued_depth: 0 }),
      getCurrentTurn: vi.fn().mockReturnValue("turn-1"),
      setCurrentTurn: vi.fn(),
    },
    pending: {
      get: vi.fn(),
      claim: vi.fn(),
      releaseClaim: vi.fn(),
      markResponded: vi.fn(),
      remove: vi.fn(),
    },
    events: {
      append: vi.fn().mockResolvedValue(undefined),
    },
    retryOptions: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

function makeDetachedContext(overrides: Record<string, unknown> = {}) {
  const client = {
    respondAck: vi.fn().mockResolvedValue({ backpressured: false }),
  };
  return {
    users: {
      has: vi.fn().mockReturnValue(true),
    },
    sessions: {
      get: vi.fn().mockReturnValue(null),
      findLiveAnywhere: vi.fn().mockReturnValue(null),
      findUniqueLiveByNameAnywhere: vi.fn().mockReturnValue(null),
      listAll: vi.fn().mockReturnValue([]),
      touch: vi.fn(),
    },
    pool: {
      clientForSession: vi.fn().mockReturnValue(null),
      acquire: vi.fn().mockResolvedValue(client),
      acquireForAdhoc: vi.fn().mockResolvedValue(client),
    },
    queues: {
      sendOrQueue: vi.fn().mockResolvedValue({ started: true, turn_id: "turn-1", queue_id: null, queued_depth: 0 }),
      getCurrentTurn: vi.fn().mockReturnValue("turn-1"),
      setCurrentTurn: vi.fn(),
    },
    pending: {
      get: vi.fn(),
      claim: vi.fn(),
      releaseClaim: vi.fn(),
      markResponded: vi.fn(),
      remove: vi.fn(),
    },
    events: {
      append: vi.fn().mockResolvedValue(undefined),
      listSince: vi.fn().mockResolvedValue({
        ok: true,
        events: [{
          type: "session.closed",
          session: "writer",
          thread_id: "th-detached",
        }],
      }),
    },
    retryOptions: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitForImmediate(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("message handlers", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-message-"));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const name of fs.readdirSync(tmpRoot)) {
      fs.rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
    }
  });

  it("builds image attachments as localImage inputs", async () => {
    const imagePath = path.join(tmpRoot, "snap.png");
    fs.writeFileSync(imagePath, "png");
    const ctx = makeLiveContext();

    await messageSend(ctx as never, makeReq(["sess-1", "hello"], { attach: [imagePath] }) as never);

    const input = vi.mocked(ctx.queues.sendOrQueue).mock.calls[0]?.[3] as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { type: "text", text: "hello" },
      { type: "localImage", path: imagePath },
    ]);
  });

  it("returns queue_id when a send is queued", async () => {
    const ctx = makeLiveContext({
      queues: {
        sendOrQueue: vi.fn().mockResolvedValue({ started: false, turn_id: "turn-1", queue_id: "q-1", queued_depth: 1 }),
        getCurrentTurn: vi.fn().mockReturnValue("turn-1"),
        setCurrentTurn: vi.fn(),
      },
    });

    const result = await messageSend(ctx as never, makeReq(["sess-1", "hello"]) as never);

    expect(result).toMatchObject({
      started: false,
      turn_id: "turn-1",
      queue_id: "q-1",
      queued_depth: 1,
    });
  });

  it("rejects unsupported attachment file types", async () => {
    const filePath = path.join(tmpRoot, "notes.txt");
    fs.writeFileSync(filePath, "text");
    const ctx = makeLiveContext();

    await expect(messageSend(ctx as never, makeReq(["sess-1", "hello"], { attach: [filePath] }) as never))
      .rejects.toMatchObject({ code: "invalid_params" });
  });

  it("treats interrupt with no active turn as a noop", async () => {
    const ctx = makeLiveContext({
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
        setCurrentTurn: vi.fn(),
      },
    });

    const result = await messageInterrupt(ctx as never, makeReq(["sess-1"]) as never);

    expect(result).toMatchObject({
      session: "sess-1",
      turn_id: null,
      interrupted: false,
      noop: true,
    });
    expect(vi.mocked(turnInterrupt)).not.toHaveBeenCalled();
  });

  it("returns wire-shaped approval shortcut payloads", async () => {
    const pendingClient = { respondAck: vi.fn().mockResolvedValue({ backpressured: false }) };
    const claim = vi.fn()
      .mockReturnValueOnce({
        request_id: "req-a",
        kind: "approval.command_execution",
        client: pendingClient,
        jsonrpc_id: 11,
        user: "user-1",
        raw: {},
      })
      .mockReturnValueOnce({
        request_id: "req-b",
        kind: "approval.permissions",
        client: pendingClient,
        jsonrpc_id: 12,
        user: "user-1",
        raw: { permissions: { fileSystem: { write: ["/tmp"] } } },
      })
      .mockReturnValueOnce({
        request_id: "req-c",
        kind: "approval.mcp_elicitation",
        client: pendingClient,
        jsonrpc_id: 13,
        user: "user-1",
        raw: { mode: "url" },
      });
    const get = vi.fn()
      .mockReturnValueOnce({ kind: "approval.command_execution", user: "user-1" })
      .mockReturnValueOnce({ kind: "approval.permissions", user: "user-1" })
      .mockReturnValueOnce({ kind: "approval.mcp_elicitation", user: "user-1" });
    const ctx = makeLiveContext({
      pending: {
        get,
        claim,
        releaseClaim: vi.fn(),
        markResponded: vi.fn(),
        remove: vi.fn(),
      },
    });

    const accept = await messageApproval(ctx as never, makeReq(["sess-1", "req-a", "accept"]) as never);
    const session = await messageApproval(ctx as never, makeReq(["sess-1", "req-b", "accept-session"]) as never);
    const decline = await messageApproval(ctx as never, makeReq(["sess-1", "req-c", "decline"]) as never);

    expect(accept).toMatchObject({ response: { decision: "accept" } });
    expect(session).toMatchObject({
      response: {
        permissions: { fileSystem: { write: ["/tmp"] } },
        scope: "session",
      },
    });
    expect(decline).toMatchObject({
      response: {
        action: "decline",
        content: null,
        _meta: null,
      },
    });
    expect(ctx.pending.remove).not.toHaveBeenCalled();
    expect(ctx.pending.markResponded).toHaveBeenCalledTimes(3);
  });

  it("emits a warning when approval replies are backpressured", async () => {
    const pendingClient = { respondAck: vi.fn().mockResolvedValue({ backpressured: true }) };
    const ctx = makeLiveContext({
      pending: {
        get: vi.fn().mockReturnValue({ kind: "approval.command_execution", user: "user-1" }),
        claim: vi.fn().mockReturnValue({
          request_id: "req-a",
          kind: "approval.command_execution",
          client: pendingClient,
          jsonrpc_id: 11,
          user: "user-1",
          raw: {},
        }),
        releaseClaim: vi.fn(),
        markResponded: vi.fn(),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn().mockResolvedValue(undefined),
      },
    });

    await messageApproval(ctx as never, makeReq(["sess-1", "req-a", "accept"]) as never);
    await waitForImmediate();

    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "warning",
      payload: expect.objectContaining({
        kind: "approval_reply_backpressured",
        request_id: "req-a",
      }),
    }));
  });

  it("rejects a second approval writer once the first caller has claimed the pending request", async () => {
    const pending = new PendingRegistry();
    const ack = deferred<{ backpressured: boolean }>();
    const responder = { respondAck: vi.fn(() => ack.promise) };
    const claimed = pending.add({
      client: responder as never,
      jsonrpc_id: 77,
      kind: "approval.command_execution",
      user: "user-1",
      session_name: "sess-1",
      thread_id: "th-1",
      turn_id: "turn-1",
      raw: {},
    });
    const ctx = makeLiveContext({
      pending,
      events: {
        append: vi.fn().mockResolvedValue(undefined),
      },
    });

    const first = messageApproval(ctx as never, makeReq(["sess-1", claimed.request_id, "accept"]) as never);
    const second = messageApproval(ctx as never, makeReq(["sess-1", claimed.request_id, "accept"]) as never);

    await expect(second).rejects.toMatchObject({ code: "invalid_params" });
    ack.resolve({ backpressured: false });
    await expect(first).resolves.toMatchObject({ request_id: claimed.request_id, responded: true });
    expect(responder.respondAck).toHaveBeenCalledTimes(1);
  });

  it("keeps approval responses fast when warning persistence is delayed", async () => {
    const pendingClient = { respondAck: vi.fn().mockResolvedValue({ backpressured: true }) };
    const ctx = makeLiveContext({
      pending: {
        get: vi.fn().mockReturnValue({ kind: "approval.command_execution", user: "user-1" }),
        claim: vi.fn().mockReturnValue({
          request_id: "req-latency",
          kind: "approval.command_execution",
          client: pendingClient,
          jsonrpc_id: 21,
          user: "user-1",
          raw: {},
        }),
        releaseClaim: vi.fn(),
        markResponded: vi.fn(),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          timer.unref();
        })),
      },
    });

    const start = performance.now();
    const result = await messageApproval(ctx as never, makeReq(["sess-1", "req-latency", "accept"]) as never);
    const elapsedMs = performance.now() - start;

    expect(result).toMatchObject({ request_id: "req-latency", responded: true });
    expect(elapsedMs).toBeLessThan(50);
  });

  it("supports relative --since -N history windows", async () => {
    vi.mocked(threadTurnsList)
      .mockResolvedValueOnce({
        data: [
          { id: "turn-5" },
          { id: "turn-4" },
        ],
        nextCursor: "cursor-2",
      } as never)
      .mockResolvedValueOnce({
        data: [
          { id: "turn-3" },
          { id: "turn-2" },
        ],
        nextCursor: "cursor-4",
      } as never);

    const ctx = makeLiveContext();
    const result = await messageHistory(ctx as never, makeReq(["sess-1"], { since: "-3", limit: "2" }) as never);

    expect(result).toMatchObject({
      relative_since: 3,
      turns: [{ id: "turn-3" }, { id: "turn-2" }],
      next_cursor: "cursor-4",
    });
  });

  it("hydrates markdown history and tail output from thread/read when turns/list omits items", async () => {
    const hydratedTurn = {
      id: "turn-1",
      status: "completed",
      durationMs: 42,
      items: [
        {
          id: "user-1",
          type: "userMessage",
          content: [{ type: "text", text: "Inspect the failing turn." }],
        },
        {
          id: "cmd-1",
          type: "commandExecution",
          command: "npm test",
          exit: 1,
          stdout: "FAIL message-handlers.test.ts",
        },
        {
          id: "agent-1",
          type: "agentMessage",
          content: [{ type: "text", text: "I found the missing turn items." }],
        },
      ],
    };
    vi.mocked(threadTurnsList).mockResolvedValue({
      data: [{ id: "turn-1", status: "completed", durationMs: 42 }],
      nextCursor: null,
    } as never);
    vi.mocked(threadRead).mockResolvedValue({
      thread: {
        id: "th-1",
        turns: [hydratedTurn],
      },
    } as never);

    const ctx = makeLiveContext();
    const history = await messageHistory(ctx as never, makeReq(["sess-1"], { format: "markdown" }) as never);
    const tail = await messageTail(ctx as never, makeReq(["sess-1"], { format: "markdown", n: 1 }) as never);

    expect(history.turns).toEqual([hydratedTurn]);
    expect(history.markdown).toContain("<message> {\"role\":\"user\"}");
    expect(history.markdown).toContain("Inspect the failing turn.");
    expect(history.markdown).toContain("<shell>");
    expect(history.markdown).toContain("FAIL message-handlers.test.ts");

    expect(tail.turns).toEqual([hydratedTurn]);
    expect(tail.markdown).toContain("<message> {\"role\":\"user\"}");
    expect(tail.markdown).toContain("Inspect the failing turn.");
    expect(tail.markdown).toContain("<message> {\"role\":\"assistant\"}");
    expect(tail.markdown).toContain("I found the missing turn items.");
  });

  it("reads detached message history by session name", async () => {
    const detachedTurn = {
      id: "turn-2",
      status: "completed",
      items: [
        {
          id: "user-2",
          type: "userMessage",
          content: [{ type: "text", text: "Explain the event stream." }],
        },
      ],
    };
    vi.mocked(threadList).mockResolvedValue({
      data: [{ id: "th-detached", name: "writer" }],
      nextCursor: null,
    } as never);
    vi.mocked(threadRead).mockResolvedValue({
      thread: {
        id: "th-detached",
        name: "writer",
        turns: [detachedTurn],
      },
    } as never);

    const ctx = makeDetachedContext();
    const result = await messageHistory(ctx as never, makeReq(["writer"], { format: "markdown" }) as never);

    expect(result).toMatchObject({
      session: "writer",
      thread_id: "th-detached",
      turns: [detachedTurn],
      next_cursor: null,
      format: "markdown",
    });
    expect(result.markdown).toContain("Explain the event stream.");
    expect(vi.mocked(threadTurnsList)).not.toHaveBeenCalled();
  });

  it("reads detached message tail by session name", async () => {
    const detachedTurns = [
      {
        id: "turn-3",
        status: "completed",
        items: [
          {
            id: "user-3",
            type: "userMessage",
            content: [{ type: "text", text: "Summarize the latest turn." }],
          },
        ],
      },
      {
        id: "turn-2",
        status: "completed",
        items: [
          {
            id: "agent-2",
            type: "agentMessage",
            content: [{ type: "text", text: "Latest turn summary." }],
          },
        ],
      },
    ];
    vi.mocked(threadList).mockResolvedValue({
      data: [{ id: "th-detached", name: "writer" }],
      nextCursor: null,
    } as never);
    vi.mocked(threadRead).mockResolvedValue({
      thread: {
        id: "th-detached",
        name: "writer",
        turns: detachedTurns,
      },
    } as never);

    const ctx = makeDetachedContext();
    const result = await messageTail(ctx as never, makeReq(["writer"], { format: "markdown", n: 1 }) as never);

    expect(result).toMatchObject({
      session: "writer",
      format: "markdown",
      follow: false,
    });
    expect(result.turns).toEqual([detachedTurns[0]]);
    expect(result.markdown).toContain("Summarize the latest turn.");
    expect(vi.mocked(threadTurnsList)).not.toHaveBeenCalled();
  });
});
