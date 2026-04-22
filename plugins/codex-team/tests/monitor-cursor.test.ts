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

describe("monitor events --cursor", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-creates a named cursor and persists the last seen event on stream close", async () => {
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
      config: { getEffective: () => 30 },
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

    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reloaded = new CursorStore(dir);
    expect(reloaded.get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: "evt-3",
      auto_update: true,
    }));

    await cursors.clearUser("user-1");
  });

  it("updates the cursor after each emitted interval batch", async () => {
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
      config: { getEffective: () => 1 },
      events,
      cursors,
    } as never, makeReq({ interval: "1", cursor: "audit-tail" }) as never, stream as never);

    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(cursors.get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: "evt-2",
      auto_update: true,
    }));

    stream.close();
    await Promise.resolve();
    await cursors.clearUser("user-1");
  });
});
