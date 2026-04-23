import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  turnStart: vi.fn(),
}));

import { turnStart } from "../src/codex/rpc";
import { QueueTeardownError, TurnQueues } from "../src/daemon/queues";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TurnQueues", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("serializes completion draining against concurrent sendOrQueue", async () => {
    const nextTurn = deferred<{ turnId: string }>();
    vi.mocked(turnStart).mockImplementationOnce(() => nextTurn.promise as never);

    const queues = new TurnQueues();
    const client = {};
    queues.setCurrentTurn("user-1::sess-1", "turn-1");

    const queued = await queues.sendOrQueue("user-1::sess-1", client as never, "th-1", [{ type: "text", text: "queued" }] as never);
    expect(queued).toMatchObject({ started: false, turn_id: "turn-1", queued_depth: 1 });
    expect(queued.queue_id).toMatch(/^q-/);

    const drainPromise = queues.onTurnCompleted("user-1::sess-1", client as never, "th-1");
    const duringDrain = queues.sendOrQueue("user-1::sess-1", client as never, "th-1", [{ type: "text", text: "later" }] as never);

    nextTurn.resolve({ turnId: "turn-2" });

    await expect(drainPromise).resolves.toMatchObject({ turn_id: "turn-2", queue_id: queued.queue_id, failed: false });
    await expect(duringDrain).resolves.toMatchObject({ started: false, turn_id: "turn-2", queued_depth: 1 });
    expect(queues.getCurrentTurn("user-1::sess-1")).toBe("turn-2");
    expect(queues.depth("user-1::sess-1")).toBe(1);
    expect(vi.mocked(turnStart)).toHaveBeenCalledTimes(1);
  });

  it("keeps the queued item in place when auto-drain dispatch fails", async () => {
    vi.mocked(turnStart)
      .mockRejectedValueOnce(new Error("overloaded"))
      .mockResolvedValueOnce({ turnId: "turn-2" } as never);

    const queues = new TurnQueues();
    const client = {};
    queues.setCurrentTurn("user-1::sess-1", "turn-1");

    const queued = await queues.sendOrQueue("user-1::sess-1", client as never, "th-1", [{ type: "text", text: "queued" }] as never);
    const failed = await queues.onTurnCompleted("user-1::sess-1", client as never, "th-1");

    expect(failed).toMatchObject({
      turn_id: null,
      queue_id: queued.queue_id,
      failed: true,
      error_message: "overloaded",
    });
    expect(queues.depth("user-1::sess-1")).toBe(1);
    expect(queues.getCurrentTurn("user-1::sess-1")).toBeNull();

    const retried = await queues.onTurnCompleted("user-1::sess-1", client as never, "th-1");
    expect(retried).toMatchObject({
      turn_id: "turn-2",
      queue_id: queued.queue_id,
      failed: false,
    });
    expect(queues.depth("user-1::sess-1")).toBe(0);
    expect(queues.getCurrentTurn("user-1::sess-1")).toBe("turn-2");
  });

  it("releases a failed turn and drains the next queued item when willRetry is false", async () => {
    vi.mocked(turnStart).mockResolvedValueOnce({ turnId: "turn-2" } as never);

    const queues = new TurnQueues();
    const client = {};
    queues.setCurrentTurn("user-1::sess-1", "turn-1");

    const queued = await queues.sendOrQueue("user-1::sess-1", client as never, "th-1", [{ type: "text", text: "queued" }] as never);
    const drained = await queues.onTurnErrored(
      "user-1::sess-1",
      "turn-1",
      { willRetry: false },
      client as never,
      "th-1",
    );

    expect(drained).toMatchObject({
      turn_id: "turn-2",
      queue_id: queued.queue_id,
      failed: false,
      dropped: [],
    });
    expect(queues.getCurrentTurn("user-1::sess-1")).toBe("turn-2");
    expect(queues.depth("user-1::sess-1")).toBe(0);
  });

  it("preserves the current turn when a failure is marked for retry", async () => {
    const queues = new TurnQueues();
    const client = {};
    queues.setCurrentTurn("user-1::sess-1", "turn-1");

    await queues.sendOrQueue("user-1::sess-1", client as never, "th-1", [{ type: "text", text: "queued" }] as never);
    const result = await queues.onTurnErrored(
      "user-1::sess-1",
      "turn-1",
      { willRetry: true },
      client as never,
      "th-1",
    );

    expect(result).toMatchObject({ turn_id: null, queue_id: null, failed: false, dropped: [] });
    expect(queues.getCurrentTurn("user-1::sess-1")).toBe("turn-1");
    expect(queues.depth("user-1::sess-1")).toBe(1);
    expect(vi.mocked(turnStart)).not.toHaveBeenCalled();
  });

  it("blocks queued drain dispatch once teardown begins, even if turnStart is already in flight", async () => {
    const nextTurn = deferred<{ turnId: string }>();
    vi.mocked(turnStart).mockImplementationOnce(() => nextTurn.promise as never);

    const queues = new TurnQueues();
    const client = {};
    queues.setCurrentTurn("user-1::sess-1", "turn-1");

    const queued = await queues.sendOrQueue("user-1::sess-1", client as never, "th-1", [{ type: "text", text: "queued" }] as never);
    const drainPromise = queues.onTurnCompleted("user-1::sess-1", client as never, "th-1");
    const teardownPromise = queues.beginTeardown("user-1::sess-1");

    nextTurn.resolve({ turnId: "turn-2" });

    await expect(drainPromise).resolves.toMatchObject({ turn_id: null, queue_id: null, failed: false });
    await expect(teardownPromise).resolves.toMatchObject({ currentTurnId: null });
    expect(queues.getCurrentTurn("user-1::sess-1")).toBeNull();
    expect(queues.depth("user-1::sess-1")).toBe(1);
    expect(queued.queue_id).toMatch(/^q-/);
  });

  it("rejects new sends once teardown has started", async () => {
    const queues = new TurnQueues();
    const client = {};

    await queues.beginTeardown("user-1::sess-1");

    await expect(
      queues.sendOrQueue("user-1::sess-1", client as never, "th-1", [{ type: "text", text: "hello" }] as never),
    ).rejects.toBeInstanceOf(QueueTeardownError);
  });

  it("keeps a failed queue head ahead of new work, then drops it after the retry limit and resumes FIFO", async () => {
    vi.mocked(turnStart)
      .mockRejectedValueOnce(new Error("overloaded-1"))
      .mockRejectedValueOnce(new Error("overloaded-2"))
      .mockResolvedValueOnce({ turnId: "turn-3" } as never);

    const queues = new TurnQueues();
    const client = {};
    queues.setCurrentTurn("user-1::sess-1", "turn-1");

    const head = await queues.sendOrQueue("user-1::sess-1", client as never, "th-1", [{ type: "text", text: "head" }] as never);
    const firstAttempt = await queues.onTurnCompleted("user-1::sess-1", client as never, "th-1", { maxAttempts: 2 } as never);
    expect(firstAttempt).toMatchObject({
      turn_id: null,
      queue_id: head.queue_id,
      failed: true,
      error_message: "overloaded-1",
      dropped: [],
    });

    const tail = await queues.sendOrQueue("user-1::sess-1", client as never, "th-1", [{ type: "text", text: "tail" }] as never);
    expect(tail).toMatchObject({
      started: false,
      turn_id: null,
      queued_depth: 2,
    });

    const retried = await queues.onTurnCompleted("user-1::sess-1", client as never, "th-1", { maxAttempts: 2 } as never);
    expect(retried).toMatchObject({
      turn_id: "turn-3",
      queue_id: tail.queue_id,
      failed: false,
      dropped: [
        {
          queue_id: head.queue_id,
          error_message: "overloaded-2",
          failure_count: 2,
        },
      ],
    });
    expect(queues.getCurrentTurn("user-1::sess-1")).toBe("turn-3");
    expect(queues.depth("user-1::sess-1")).toBe(0);
    expect(vi.mocked(turnStart)).toHaveBeenCalledTimes(3);
  });
});
