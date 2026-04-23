import { describe, expect, it } from "vitest";

import { EventLog } from "../src/daemon/events";
import { sessionEvents } from "../src/daemon/handlers/session";

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

  onAck(): void {}

  close(): void {
    this.closeCb?.();
  }
}

function makeReq(flags: Record<string, unknown> = {}, target = "audit") {
  return {
    kind: "request" as const,
    id: "req-events",
    method: "session:events",
    bearer: "user-1",
    params: {
      positionals: [target],
      flags,
    },
  };
}

async function buildEventLog(): Promise<EventLog> {
  const events = new EventLog(100, null);
  await events.append("user-1", {
    type: "turn.started",
    session: "audit",
    thread_id: "th-1",
    payload: { turn_id: "turn-1" },
  });
  await events.append("user-1", {
    type: "item.agent_message_delta",
    session: "audit",
    thread_id: "th-1",
    payload: { turn_id: "turn-1", delta: "x" },
  });
  await events.append("user-1", {
    type: "item.completed",
    session: "audit",
    thread_id: "th-1",
    payload: { turn_id: "turn-1", type: "commandExecution" },
  });
  await events.append("user-1", {
    type: "turn.completed",
    session: "audit",
    thread_id: "th-1",
    payload: { turn_id: "turn-1" },
  });
  await events.append("user-1", {
    type: "turn.completed",
    session: "other",
    thread_id: "th-2",
    payload: { turn_id: "turn-9" },
  });
  await events.append("user-1", {
    type: "item.completed",
    session: "audit",
    thread_id: "th-1",
    payload: { turn_id: "turn-2", type: "reasoning" },
  });
  return events;
}

function makeCtx(events: EventLog) {
  return {
    users: {
      has: () => true,
    },
    sessions: {
      get: (_user: string, identifier: string) => (
        identifier === "audit" || identifier === "th-1"
          ? { name: "audit", thread_id: "th-1" }
          : null
      ),
    },
    events,
  };
}

describe("session events", () => {
  it("returns chronological retained events for the target session only", async () => {
    const events = await buildEventLog();
    const stream = new FakeStream();

    await sessionEvents(makeCtx(events) as never, makeReq() as never, stream as never);

    expect(stream.endedWith).toBe("ended");
    expect((stream.chunks as Array<{ id: string }>).map((event) => event.id)).toEqual([
      "evt-1",
      "evt-3",
      "evt-4",
      "evt-6",
    ]);
    expect(stream.chunks).not.toContainEqual(expect.objectContaining({ id: "evt-2" }));
    expect(stream.chunks).not.toContainEqual(expect.objectContaining({ session: "other" }));
  });

  it("applies --type, --turn, --since, and --limit filters", async () => {
    const events = await buildEventLog();

    const typeStream = new FakeStream();
    await sessionEvents(makeCtx(events) as never, makeReq({ type: "item.completed" }) as never, typeStream as never);
    expect((typeStream.chunks as Array<{ id: string }>).map((event) => event.id)).toEqual(["evt-3", "evt-6"]);

    const turnStream = new FakeStream();
    await sessionEvents(makeCtx(events) as never, makeReq({ turn: "turn-1" }) as never, turnStream as never);
    expect((turnStream.chunks as Array<{ id: string }>).map((event) => event.id)).toEqual(["evt-1", "evt-3", "evt-4"]);

    const sinceStream = new FakeStream();
    await sessionEvents(makeCtx(events) as never, makeReq({ since: "evt-3", limit: "1" }) as never, sinceStream as never);
    expect((sinceStream.chunks as Array<{ id: string }>).map((event) => event.id)).toEqual(["evt-4"]);

    const limitStream = new FakeStream();
    await sessionEvents(makeCtx(events) as never, makeReq({ limit: "2" }) as never, limitStream as never);
    expect((limitStream.chunks as Array<{ id: string }>).map((event) => event.id)).toEqual(["evt-4", "evt-6"]);
  });

  it("streams newly appended matching events in follow mode", async () => {
    const events = await buildEventLog();
    const stream = new FakeStream();

    await sessionEvents(makeCtx(events) as never, makeReq({ follow: true, limit: "1" }) as never, stream as never);
    expect((stream.chunks as Array<{ id: string }>).map((event) => event.id)).toEqual(["evt-6"]);

    await events.append("user-1", {
      type: "turn.completed",
      session: "audit",
      thread_id: "th-1",
      payload: { turn_id: "turn-3" },
    });
    await Promise.resolve();

    expect(stream.chunks).toContainEqual(expect.objectContaining({ id: "evt-7", type: "turn.completed" }));
    stream.close();
  });

  it("emits a terminal tally for --by-tool", async () => {
    const events = await buildEventLog();
    const stream = new FakeStream();

    await sessionEvents(makeCtx(events) as never, makeReq({ "by-tool": true }) as never, stream as never);

    expect(stream.endedWith).toBe("ended");
    expect(stream.chunks).toEqual([
      {
        target: "audit",
        group_by: "tool",
        summary: "shell=1 reasoning=1",
        counts: {
          shell: 1,
          reasoning: 1,
        },
        item_completed_events: 2,
      },
    ]);
  });
});
