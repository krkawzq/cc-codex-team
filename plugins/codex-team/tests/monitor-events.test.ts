import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { monitorEvents } from "../src/daemon/handlers/monitor";
import { startServer } from "../src/daemon/server";
import { connectSock, onMessages, writeMessage } from "../src/ipc/sock";

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

  onAck(): void {
    // monitorEvents only uses acks when a cursor is tracked; these tests do not exercise that path.
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

function mkSockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-monitor-"));
  return {
    dir,
    sockPath: path.join(dir, "daemon.sock"),
  };
}

async function closeServer(server: net.Server, sockPath: string, dir: string) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { fs.unlinkSync(sockPath); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

async function canListenOnSocket(sockPath: string): Promise<boolean> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.unlinkSync(sockPath); } catch {}
  }
}

describe("monitorEvents", () => {
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
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

  it("returns invalid_params when --since points to an unknown checkpoint", async () => {
    const stream = new FakeStream();
    await monitorEvents({
      users: { has: () => true },
      config: { getEffective: () => 30 },
      events: {
        listSince: () => ({ ok: false, reason: "invalid_since" }),
      },
    } as never, makeReq({ since: "evt-404", stream: true }) as never, stream as never);

    expect(stream.endedWith).toMatchObject({
      code: "invalid_params",
      message: "event 'evt-404' not found",
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

  it("keeps an empty filtered stream open for future matching events", async () => {
    vi.useRealTimers();

    const { dir, sockPath } = mkSockPath();
    if (!await canListenOnSocket(sockPath)) {
      console.warn("skipping monitor socket integration test: Unix socket listen is not permitted in this environment");
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    const dispose = vi.fn();
    let subscriber: ((event: Record<string, unknown>) => void) | null = null;
    const server = await startServer({
      sockPath,
      activity: { touch() {} },
      users: {
        has: () => true,
      },
      events: {
        listSince: () => ({
          ok: true,
          events: [
            {
              id: "evt-1",
              ts: "2025-01-01T00:00:00.000Z",
              type: "turn.started",
              session: "sess-1",
              thread_id: "th-1",
              payload: {},
            },
          ],
        }),
        subscribe: (_user: string, cb: (event: Record<string, unknown>) => void) => {
          subscriber = cb;
          return { dispose };
        },
      },
      config: {
        getEffective: () => 30,
      },
    } as never);
    cleanups.push(() => closeServer(server, sockPath, dir));

    const sock = await connectSock(sockPath, 1000);
    cleanups.push(async () => {
      if (!sock.destroyed) sock.destroy();
    });
    const messages: Array<Record<string, unknown>> = [];
    let firstChunkResolve: (() => void) | null = null;
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkResolve = resolve;
    });

    onMessages(sock, (msg) => {
      messages.push(msg as Record<string, unknown>);
      if ((msg as { kind?: string }).kind === "stream_chunk") firstChunkResolve?.();
    });

    writeMessage(sock, {
      kind: "request",
      id: "stream-filtered",
      method: "monitor:events",
      bearer: "user-1",
      params: {
        streaming: true,
        flags: { stream: true, filter: "turn.completed" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages.find((m) => m.kind === "stream_end" || m.kind === "response")).toBeUndefined();

    subscriber?.({
      id: "evt-2",
      ts: "2025-01-01T00:00:01.000Z",
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {},
    });
    await Promise.race([
      firstChunk,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream chunk timeout")), 200)),
    ]);

    expect(messages).toContainEqual(expect.objectContaining({
      kind: "stream_chunk",
      id: "stream-filtered",
      data: expect.objectContaining({ id: "evt-2", type: "turn.completed" }),
    }));
    expect(messages.find((m) => m.kind === "stream_end" || m.kind === "response")).toBeUndefined();

    sock.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
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
