import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadRead: vi.fn(),
  threadTurnsList: vi.fn(),
  turnInterrupt: vi.fn(),
  turnSteer: vi.fn(),
}));

import { messageApproval, messageHistory, messageInterrupt, messageSend } from "../src/daemon/handlers/message";
import { threadTurnsList, turnInterrupt } from "../src/codex/rpc";

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
    respond: vi.fn(),
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
    const ctx = makeLiveContext({
      pending: {
        get: vi.fn()
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
          }),
        markResponded: vi.fn(),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn().mockResolvedValue(undefined),
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
    const ctx = makeLiveContext({
      pending: {
        get: vi.fn().mockReturnValue({
          request_id: "req-a",
          kind: "approval.command_execution",
          client: { respondAck: vi.fn().mockResolvedValue({ backpressured: true }) },
          jsonrpc_id: 11,
          user: "user-1",
          raw: {},
        }),
        markResponded: vi.fn(),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn().mockResolvedValue(undefined),
      },
    });

    await messageApproval(ctx as never, makeReq(["sess-1", "req-a", "accept"]) as never);

    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "warning",
      payload: expect.objectContaining({
        kind: "approval_reply_backpressured",
        request_id: "req-a",
      }),
    }));
  });

  it("rejects replies for requests that are already marked responded", async () => {
    const ctx = makeLiveContext({
      pending: {
        get: vi.fn().mockReturnValue({
          request_id: "req-a",
          kind: "approval.command_execution",
          client: { respondAck: vi.fn() },
          jsonrpc_id: 11,
          user: "user-1",
          responded_at: "2025-01-01T00:00:00.000Z",
          raw: {},
        }),
        markResponded: vi.fn(),
        remove: vi.fn(),
      },
    });

    await expect(messageApproval(ctx as never, makeReq(["sess-1", "req-a", "accept"]) as never))
      .rejects.toMatchObject({ code: "invalid_params" });
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
});
