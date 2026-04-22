import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { monitorEvents } from "../src/daemon/handlers/monitor";

class FakeStream {
  chunks: unknown[] = [];
  endedWith: unknown = null;
  private closeCb: (() => void) | null = null;

  chunk(data: unknown): void {
    this.chunks.push(data);
  }

  end(error?: unknown): void {
    this.endedWith = error ?? "ended";
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    this.closeCb?.();
  }
}

function makeReq(flags: Record<string, unknown> = {}, bearer = "user-1") {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "monitor:events",
    bearer,
    params: {
      flags,
    },
  };
}

describe("monitorEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns id_rotated as a stream error", async () => {
    const stream = new FakeStream();
    await monitorEvents({
      users: { has: () => true },
      config: { getEffective: () => 30 },
      events: {
        listSince: () => ({ ok: false, reason: "id_rotated", oldest_available_id: "evt-9" }),
      },
    } as never, makeReq({ since: "evt-1", stream: true }) as never, stream as never);

    expect(stream.endedWith).toMatchObject({
      code: "id_rotated",
      data: { oldest_available_id: "evt-9" },
    });
  });

  it("streams backlog immediately and subscribes for future events in stream mode", async () => {
    const dispose = vi.fn();
    const stream = new FakeStream();
    const subscribers: Array<(event: Record<string, unknown>) => void> = [];
    const backlogEvent = {
      id: "evt-2",
      ts: "2025-01-01T00:00:00.000Z",
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {},
    };

    await monitorEvents({
      users: { has: () => true },
      config: { getEffective: () => 30 },
      events: {
        listSince: () => ({ ok: true, events: [backlogEvent] }),
        subscribe: (_user: string, cb: (event: Record<string, unknown>) => void) => {
          subscribers.push(cb);
          return { dispose };
        },
      },
    } as never, makeReq({ stream: true, session: "sess-1" }) as never, stream as never);

    expect(stream.chunks).toEqual([backlogEvent]);

    subscribers[0]({
      id: "evt-3",
      ts: "2025-01-01T00:00:01.000Z",
      type: "item.agent_message_delta",
      session: "sess-1",
      thread_id: "th-1",
      payload: {},
    });
    expect(stream.chunks).toEqual([backlogEvent]);

    subscribers[0]({
      id: "evt-4",
      ts: "2025-01-01T00:00:02.000Z",
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {},
    });
    expect(stream.chunks).toContainEqual(expect.objectContaining({ id: "evt-4" }));

    stream.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("batches events on interval in polling mode and respects include-delta", async () => {
    const dispose = vi.fn();
    const stream = new FakeStream();
    let subscriber: ((event: Record<string, unknown>) => void) | null = null;

    await monitorEvents({
      users: { has: () => true },
      config: { getEffective: () => 1 },
      events: {
        listSince: () => ({ ok: true, events: [] }),
        subscribe: (_user: string, cb: (event: Record<string, unknown>) => void) => {
          subscriber = cb;
          return { dispose };
        },
      },
    } as never, makeReq({ interval: "1", "include-delta": true }) as never, stream as never);

    subscriber?.({
      id: "evt-5",
      ts: "2025-01-01T00:00:03.000Z",
      type: "item.agent_message_delta",
      session: "sess-1",
      thread_id: "th-1",
      payload: {},
    });
    subscriber?.({
      id: "evt-6",
      ts: "2025-01-01T00:00:04.000Z",
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {},
    });

    expect(stream.chunks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync();
    expect(stream.chunks.map((x) => (x as { id: string }).id)).toEqual(["evt-5", "evt-6"]);

    stream.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("emits monitor.overflow and flushes large interval batches across multiple ticks", async () => {
    const dispose = vi.fn();
    const stream = new FakeStream();
    let subscriber: ((event: Record<string, unknown>) => void) | null = null;

    await monitorEvents({
      users: { has: () => true },
      config: { getEffective: () => 1 },
      events: {
        listSince: () => ({ ok: true, events: [] }),
        subscribe: (_user: string, cb: (event: Record<string, unknown>) => void) => {
          subscriber = cb;
          return { dispose };
        },
      },
    } as never, makeReq({ interval: "1", "include-delta": true }) as never, stream as never);

    for (let i = 0; i < 600; i++) {
      subscriber?.({
        id: `evt-${i}`,
        ts: "2025-01-01T00:00:00.000Z",
        type: "turn.completed",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i },
      });
    }

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersToNextTimerAsync();

    expect(stream.chunks[0]).toMatchObject({
      type: "monitor.overflow",
      payload: expect.objectContaining({
        dropped_count: expect.any(Number),
      }),
    });
    expect((stream.chunks[0] as { payload: { dropped_count: number } }).payload.dropped_count).toBeGreaterThan(0);
    expect(stream.chunks.filter((chunk) => (chunk as { type?: string }).type === "turn.completed").length).toBeLessThan(600);

    const chunkCountAfterFirstTick = stream.chunks.length;
    expect(chunkCountAfterFirstTick).toBeLessThanOrEqual(65);

    await vi.advanceTimersToNextTimerAsync();
    expect(stream.chunks.length).toBeGreaterThan(chunkCountAfterFirstTick);
  });
});
