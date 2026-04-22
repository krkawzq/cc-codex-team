import { describe, expect, it, vi } from "vitest";

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

describe("monitor events --summary", () => {
  it("emits compact summaries in stream mode and preserves since handling", async () => {
    const stream = new FakeStream();
    const dispose = vi.fn();
    const subscribers: Array<(event: Record<string, unknown>) => void> = [];
    const listSince = vi.fn().mockReturnValue({
      ok: true,
      events: [
        {
          id: "evt-2",
          ts: "2025-01-01T00:00:00.000Z",
          type: "turn.completed",
          session: "sess-1",
          thread_id: "th-1",
          payload: {
            turn_id: "turn-1",
            items_count: 2,
            turn_items_included: false,
          },
        },
      ],
    });

    await monitorEvents({
      users: { has: () => true },
      config: { getEffective: () => 30 },
      events: {
        listSince,
        subscribe: (_user: string, cb: (event: Record<string, unknown>) => void) => {
          subscribers.push(cb);
          return { dispose };
        },
      },
    } as never, makeReq({ stream: true, summary: true, since: "evt-1" }) as never, stream as never);

    subscribers[0]({
      id: "evt-3",
      ts: "2025-01-01T00:00:01.000Z",
      type: "item.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        item_id: "item-1",
        type: "agent_message",
      },
    });
    subscribers[0]({
      id: "evt-4",
      ts: "2025-01-01T00:00:02.000Z",
      type: "approval.command_execution",
      session: "sess-1",
      thread_id: "th-1",
      payload: {
        request_id: "req-7",
        command: "rm -rf /tmp/nope",
      },
    });

    expect(listSince).toHaveBeenCalledWith("user-1", "evt-1", { includeDelta: true });
    expect(stream.chunks).toEqual([
      {
        id: "evt-2",
        ts: "2025-01-01T00:00:00.000Z",
        type: "turn.completed",
        session: "sess-1",
        key: "turn-1",
      },
      {
        id: "evt-3",
        ts: "2025-01-01T00:00:01.000Z",
        type: "item.completed",
        session: "sess-1",
        key: "agent_message",
      },
      {
        id: "evt-4",
        ts: "2025-01-01T00:00:02.000Z",
        type: "approval.command_execution",
        session: "sess-1",
        key: "req-7",
      },
    ]);

    for (const chunk of stream.chunks as Array<Record<string, unknown>>) {
      expect(Object.keys(chunk)).toEqual(["id", "ts", "type", "session", "key"]);
    }

    stream.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
