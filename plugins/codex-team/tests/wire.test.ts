import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadResume: vi.fn(),
}));

import { wireDaemonEvents } from "../src/daemon/wire";
import { threadResume } from "../src/codex/rpc";

class FakePool extends EventEmitter {
  clientById = vi.fn();
  clientForSession = vi.fn();
  release = vi.fn();
  acquire = vi.fn();
}

function makeContext(pool: FakePool, overrides: Record<string, unknown> = {}) {
  return {
    pool,
    sessions: {
      get: vi.fn().mockReturnValue({ name: "sess-1", thread_id: "th-1" }),
      update: vi.fn(),
      remove: vi.fn(),
    },
    events: {
      append: vi.fn().mockResolvedValue(undefined),
    },
    queues: {
      setCurrentTurn: vi.fn(),
      onTurnCompleted: vi.fn().mockResolvedValue({ turn_id: null, queue_id: null, failed: false }),
      isTeardown: vi.fn().mockReturnValue(false),
      onClientClosed: vi.fn(),
      dispose: vi.fn(),
    },
    pending: {
      removeForSession: vi.fn().mockReturnValue([]),
      removeByJsonrpcId: vi.fn(),
      listForUser: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
      add: vi.fn(),
    },
    retryOptions: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

describe("wireDaemonEvents", () => {
  it("updates the current turn on turn.started notifications", async () => {
    const pool = new FakePool();
    const ctx = makeContext(pool);

    wireDaemonEvents(ctx as never);

    pool.emit("notification", {
      user: "user-1",
      clientId: "client-1",
      notification: {
        method: "turn/started",
        params: {
          threadId: "th-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.queues.setCurrentTurn).toHaveBeenCalledWith("user-1::sess-1", "turn-1");
  });

  it("emits a local event when a queued turn starts draining", async () => {
    const pool = new FakePool();
    pool.clientForSession.mockReturnValue({});
    const ctx = makeContext(pool, {
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue({ turn_id: "turn-2", queue_id: "q-1", failed: false }),
        isTeardown: vi.fn().mockReturnValue(false),
        onClientClosed: vi.fn(),
        dispose: vi.fn(),
      },
    });

    wireDaemonEvents(ctx as never);

    pool.emit("notification", {
      user: "user-1",
      clientId: "client-1",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "th-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "turn.queued_started",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        turn_id: "turn-2",
        queue_id: "q-1",
      },
    }));
  });

  it("emits turn.queued_failed when draining a queued turn fails", async () => {
    const pool = new FakePool();
    pool.clientForSession.mockReturnValue({});
    const ctx = makeContext(pool, {
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue({
          turn_id: null,
          queue_id: "q-1",
          failed: true,
          error_message: "overloaded",
        }),
        isTeardown: vi.fn().mockReturnValue(false),
        onClientClosed: vi.fn(),
        dispose: vi.fn(),
      },
    });

    wireDaemonEvents(ctx as never);

    pool.emit("notification", {
      user: "user-1",
      clientId: "client-1",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "th-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "turn.queued_failed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        queue_id: "q-1",
        error: {
          message: "overloaded",
        },
      },
    }));
  });

  it("removes pending requests by client identity on serverRequest/resolved", async () => {
    const pool = new FakePool();
    const clientA = {};
    pool.clientById.mockReturnValue(clientA);
    const ctx = makeContext(pool);

    wireDaemonEvents(ctx as never);

    pool.emit("notification", {
      user: "user-1",
      clientId: "client-1",
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: "th-1",
          requestId: 7,
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.pending.removeByJsonrpcId).toHaveBeenCalledWith(clientA, 7);
    expect(ctx.pending.remove).not.toHaveBeenCalled();
  });

  it("tracks server requests with the emitting client and logs them as events", async () => {
    const pool = new FakePool();
    const client = {};
    pool.clientById.mockReturnValue(client);
    const addedPending = { request_id: "req-1" };
    const ctx = makeContext(pool, {
      pending: {
        removeForSession: vi.fn().mockReturnValue([]),
        removeByJsonrpcId: vi.fn(),
        listForUser: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        add: vi.fn().mockReturnValue(addedPending),
      },
    });

    wireDaemonEvents(ctx as never);

    pool.emit("server_request", {
      user: "user-1",
      clientId: "client-1",
      request: {
        id: 5,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "th-1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "need write",
        },
      },
      respond: vi.fn(),
      respondError: vi.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.pending.add).toHaveBeenCalledWith(expect.objectContaining({
      client,
      jsonrpc_id: 5,
      kind: "approval.file_change",
      user: "user-1",
      session_name: "sess-1",
      thread_id: "th-1",
      turn_id: "turn-1",
    }));
    expect(ctx.events.append).toHaveBeenLastCalledWith("user-1", expect.objectContaining({
      type: "approval.file_change",
      session: "sess-1",
      thread_id: "th-1",
      payload: expect.objectContaining({
        request_id: "req-1",
      }),
    }));
  });

  it("rejects late server requests when the session is tearing down", async () => {
    const pool = new FakePool();
    const respondError = vi.fn();
    const ctx = makeContext(pool, {
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue({ turn_id: null, queue_id: null, failed: false }),
        isTeardown: vi.fn().mockReturnValue(true),
        onClientClosed: vi.fn(),
        dispose: vi.fn(),
      },
    });

    wireDaemonEvents(ctx as never);

    pool.emit("server_request", {
      user: "user-1",
      clientId: "client-1",
      request: {
        id: 5,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "th-1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "need write",
        },
      },
      respond: vi.fn(),
      respondError,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(respondError).toHaveBeenCalledWith(-32000, "session detached");
    expect(ctx.pending.add).not.toHaveBeenCalled();
  });

  it("recovers unexpected client_close by respawning and resuming the session", async () => {
    const pool = new FakePool();
    const replacement = { client: "replacement" };
    pool.acquire.mockResolvedValue(replacement);
    const ctx = makeContext(pool, {
      pending: {
        removeForSession: vi.fn().mockReturnValue([{ request_id: "req-1" }]),
        removeByJsonrpcId: vi.fn(),
        listForUser: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        add: vi.fn(),
      },
    });
    vi.mocked(threadResume).mockResolvedValue(undefined as never);

    wireDaemonEvents(ctx as never);

    pool.emit("client_close", {
      user: "user-1",
      clientId: "client-1",
      sessions: ["user-1::sess-1"],
      exitCode: 9,
      reason: "unexpected",
    });

    await vi.waitFor(() => {
      expect(ctx.sessions.update).toHaveBeenCalledTimes(2);
    });

    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "turn.error",
      session: "sess-1",
      thread_id: "th-1",
      payload: expect.objectContaining({
        will_retry: false,
      }),
    }));
    expect(ctx.sessions.update).toHaveBeenNthCalledWith(1, "user-1", "sess-1", { recovery_state: "degraded" });
    expect(ctx.queues.onClientClosed).toHaveBeenCalledWith("user-1::sess-1");
    expect(ctx.pending.removeForSession).toHaveBeenCalledWith("user-1", "sess-1");
    expect(pool.acquire).toHaveBeenCalledWith("user-1", "user-1::sess-1");
    expect(vi.mocked(threadResume)).toHaveBeenCalledWith(replacement, "th-1", {});
    expect(ctx.sessions.update).toHaveBeenNthCalledWith(2, "user-1", "sess-1", { recovery_state: null });
    expect(ctx.queues.dispose).not.toHaveBeenCalled();
  });
});
