import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorStore } from "../src/daemon/cursors";
import { EventLog } from "../src/daemon/events";
import { monitorEvents } from "../src/daemon/handlers/monitor";

class FakeStream {
  chunks: unknown[] = [];
  endedWith: unknown = null;
  private closeCb: (() => void | Promise<void>) | null = null;
  private ackCb: ((ack: { event_id: string | null }) => void) | null = null;

  chunk(data: unknown): void {
    this.chunks.push(data);
  }

  end(error?: unknown): void {
    this.endedWith = error ?? "ended";
  }

  onClose(cb: () => void | Promise<void>): void {
    this.closeCb = cb;
  }

  onAck(cb: (ack: { event_id: string | null }) => void): void {
    this.ackCb = cb;
  }

  async close(): Promise<void> {
    await this.closeCb?.();
  }

  ack(eventId: string): void {
    this.ackCb?.({ event_id: eventId });
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

function makeConfig(values: Record<string, unknown> = {}) {
  return {
    getEffective(key: string): unknown {
      if (key in values) return values[key];
      if (key === "monitor.default_interval_seconds") return 30;
      if (key === "monitor.cursor_persist_debounce_ms") return 200;
      return null;
    },
  };
}

describe("monitor events --cursor", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-creates a named cursor and persists the last acked event", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-monitor-cursor-"));
    dirs.push(dir);
    const events = new EventLog(100, dir);
    const cursors = new CursorStore(dir);
    const stream = new FakeStream();

    await events.append("user-1", {
      type: "turn.started",
      session: "sess-1",
      thread_id: "th-1",
      payload: { turn_id: "turn-1" },
    });
    await events.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: { turn_id: "turn-1" },
    });

    await monitorEvents({
      users: { has: () => true },
      config: makeConfig(),
      events,
      cursors,
    } as never, makeReq({ stream: true, cursor: "audit-tail" }) as never, stream as never);

    expect(cursors.get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: null,
      auto_update: true,
    }));

    await events.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: { turn_id: "turn-2" },
    });
    await Promise.resolve();

    stream.ack("evt-3");
    await Promise.resolve();
    await Promise.resolve();
    await cursors.clearUser("user-1");

    const reloaded = new CursorStore(dir);
    expect(reloaded.get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: "evt-3",
      auto_update: true,
    }));
  });

  it("updates the cursor after each acked interval batch", async () => {
    vi.useFakeTimers();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-monitor-cursor-"));
    dirs.push(dir);
    const events = new EventLog(100, dir);
    const cursors = new CursorStore(dir);
    const stream = new FakeStream();

    await events.append("user-1", {
      type: "turn.started",
      session: "sess-1",
      thread_id: "th-1",
      payload: { turn_id: "turn-1" },
    });
    await events.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: { turn_id: "turn-1" },
    });
    await cursors.save("user-1", {
      name: "audit-tail",
      event_id: "evt-1",
      auto_update: true,
    });

    await monitorEvents({
      users: { has: () => true },
      config: makeConfig({
        "monitor.default_interval_seconds": 1,
      }),
      events,
      cursors,
    } as never, makeReq({ interval: "1", cursor: "audit-tail" }) as never, stream as never);

    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    stream.ack("evt-2");
    await Promise.resolve();
    await Promise.resolve();
    await cursors.clearUser("user-1");

    expect(new CursorStore(dir).get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: "evt-2",
      auto_update: true,
    }));
  });

  it("does not persist synthetic overflow ids and marks them non-ackable", async () => {
    vi.useFakeTimers();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-monitor-cursor-"));
    dirs.push(dir);
    const cursors = new CursorStore(dir);
    const stream = new FakeStream();
    let subscriber: ((event: Record<string, unknown>) => void) | null = null;

    await monitorEvents({
      users: { has: () => true },
      config: makeConfig({
        "monitor.default_interval_seconds": 1,
      }),
      events: {
        listSince: () => ({ ok: true, events: [] }),
        subscribe: (_user: string, cb: (event: Record<string, unknown>) => void) => {
          subscriber = cb;
          return { dispose() {} };
        },
      },
      cursors,
    } as never, makeReq({ interval: "1", cursor: "audit-tail", "include-delta": true }) as never, stream as never);

    for (let i = 0; i < 600; i++) {
      subscriber?.({
        id: `evt-${i + 1}`,
        ts: "2025-01-01T00:00:00.000Z",
        type: "turn.completed",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i },
      });
    }

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersToNextTimerAsync();

    const overflow = stream.chunks[0] as { id: string; type: string; ackable?: boolean };
    expect(overflow).toMatchObject({
      type: "monitor.overflow",
      ackable: false,
    });

    stream.ack(overflow.id);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await cursors.clearUser("user-1");

    expect(new CursorStore(dir).get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: null,
      auto_update: true,
    }));
  });

  it("coalesces bursts of acked cursor updates into at most two rewrites", async () => {
    vi.useFakeTimers();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-monitor-cursor-"));
    dirs.push(dir);
    const cursors = new CursorStore(dir);
    const stream = new FakeStream();

    await monitorEvents({
      users: { has: () => true },
      config: makeConfig({
        "monitor.cursor_persist_debounce_ms": 200,
      }),
      events: {
        listSince: () => ({ ok: true, events: [] }),
        subscribe: () => ({ dispose() {} }),
      },
      cursors,
    } as never, makeReq({ stream: true, cursor: "audit-tail" }) as never, stream as never);

    const renameSpy = vi.spyOn(fs.promises, "rename");
    for (let i = 1; i <= 100; i++) {
      stream.ack(`evt-${i}`);
    }

    await vi.advanceTimersByTimeAsync(50);
    expect(renameSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    await stream.close();
    await cursors.clearUser("user-1");

    expect(renameSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(renameSpy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(new CursorStore(dir).get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      event_id: "evt-100",
    }));
  });

  it("flushes a pending cursor update when the stream closes", async () => {
    vi.useFakeTimers();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-monitor-cursor-"));
    dirs.push(dir);
    const cursors = new CursorStore(dir);
    const stream = new FakeStream();

    await monitorEvents({
      users: { has: () => true },
      config: makeConfig({
        "monitor.cursor_persist_debounce_ms": 500,
      }),
      events: {
        listSince: () => ({ ok: true, events: [] }),
        subscribe: () => ({ dispose() {} }),
      },
      cursors,
    } as never, makeReq({ stream: true, cursor: "audit-tail" }) as never, stream as never);

    stream.ack("evt-42");
    await stream.close();
    await cursors.clearUser("user-1");

    expect(new CursorStore(dir).get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: "evt-42",
      auto_update: true,
    }));
  });

  it("does not persist observed events when the stream closes before ack", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-monitor-cursor-"));
    dirs.push(dir);
    const events = new EventLog(100, dir);
    const cursors = new CursorStore(dir);
    const stream = new FakeStream();

    await events.append("user-1", {
      type: "turn.started",
      session: "sess-1",
      thread_id: "th-1",
      payload: { turn_id: "turn-1" },
    });
    await cursors.save("user-1", {
      name: "audit-tail",
      event_id: "evt-1",
      auto_update: true,
    });

    await monitorEvents({
      users: { has: () => true },
      config: makeConfig(),
      events,
      cursors,
    } as never, makeReq({ stream: true, cursor: "audit-tail" }) as never, stream as never);

    await events.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: { turn_id: "turn-2" },
    });
    await Promise.resolve();

    await stream.close();
    await cursors.clearUser("user-1");

    expect(new CursorStore(dir).get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: "evt-1",
      auto_update: true,
    }));
  });
});
