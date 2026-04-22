import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { wireDaemonEvents } from "../src/daemon/wire";

class FakePool extends EventEmitter {
  clientById = vi.fn();
  clientForSession = vi.fn();
  release = vi.fn();
}

describe("wireDaemonEvents", () => {
  it("updates the current turn on turn.started notifications", async () => {
    const pool = new FakePool();
    const ctx = {
      pool,
      sessions: {
        get: vi.fn().mockReturnValue({ name: "sess-1", thread_id: "th-1" }),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn(),
      },
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue(null),
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
    };

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
    const ctx = {
      pool,
      sessions: {
        get: vi.fn().mockReturnValue({ name: "sess-1", thread_id: "th-1" }),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn(),
      },
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue({ turn_id: "turn-2", queue_id: "q-1" }),
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
    };
    pool.clientForSession.mockReturnValue({});

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
    const ctx = {
      pool,
      sessions: {
        get: vi.fn().mockReturnValue({ name: "sess-1", thread_id: "th-1" }),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn(),
      },
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue({
          turn_id: null,
          queue_id: "q-1",
          failed: true,
          error_message: "overloaded",
        }),
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
    };
    pool.clientForSession.mockReturnValue({});

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
    const ctx = {
      pool,
      sessions: {
        get: vi.fn().mockReturnValue({ name: "sess-1", thread_id: "th-1" }),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn(),
      },
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue(null),
        dispose: vi.fn(),
      },
      pending: {
        removeForSession: vi.fn().mockReturnValue([]),
        removeByJsonrpcId: vi.fn(),
        listForUser: vi.fn().mockReturnValue([
          { request_id: "req-a", jsonrpc_id: 7 },
        ]),
        remove: vi.fn(),
        add: vi.fn(),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

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

  it("tracks server requests with the emitting client and logs them as events", () => {
    const pool = new FakePool();
    const client = {};
    pool.clientById.mockReturnValue(client);
    const addedPending = { request_id: "req-1" };
    const ctx = {
      pool,
      sessions: {
        get: vi.fn().mockReturnValue({ name: "sess-1", thread_id: "th-1" }),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn(),
      },
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue(null),
        dispose: vi.fn(),
      },
      pending: {
        removeForSession: vi.fn().mockReturnValue([]),
        removeByJsonrpcId: vi.fn(),
        listForUser: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        add: vi.fn().mockReturnValue(addedPending),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

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

  it("records turn.error and clears session pending state on client_close", async () => {
    const pool = new FakePool();
    const ctx = {
      pool,
      sessions: {
        get: vi.fn().mockReturnValue({ name: "sess-1", thread_id: "th-1" }),
        remove: vi.fn(),
      },
      events: {
        append: vi.fn(),
      },
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue(null),
        dispose: vi.fn(),
      },
      pending: {
        removeForSession: vi.fn().mockReturnValue([{ request_id: "req-1" }]),
        removeByJsonrpcId: vi.fn(),
        listForUser: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        add: vi.fn(),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    wireDaemonEvents(ctx as never);

    pool.emit("client_close", {
      user: "user-1",
      clientId: "client-1",
      sessions: ["user-1::sess-1"],
      exitCode: 9,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "turn.error",
      session: "sess-1",
      thread_id: "th-1",
      payload: expect.objectContaining({
        will_retry: false,
      }),
    }));
    expect(ctx.queues.dispose).toHaveBeenCalledWith("user-1::sess-1");
    expect(ctx.pending.removeForSession).toHaveBeenCalledWith("user-1", "sess-1");
  });
});
