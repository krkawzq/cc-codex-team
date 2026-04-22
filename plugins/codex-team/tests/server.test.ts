import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockMocks = vi.hoisted(() => ({
  listenSock: vi.fn(),
  onMessages: vi.fn(),
  writeMessage: vi.fn(),
}));

vi.mock("../src/ipc/sock", () => sockMocks);

import { startServer } from "../src/daemon/server";

class FakeServer extends EventEmitter {
  close(cb?: () => void): this {
    cb?.();
    return this;
  }
}

class FakeSocket extends EventEmitter {
  frames: string[] = [];

  write(frame: string): boolean {
    this.frames.push(frame);
    return true;
  }
}

async function bootServer(ctx: Record<string, unknown>) {
  const server = new FakeServer();
  const socket = new FakeSocket();
  const writes: unknown[] = [];
  let handler: ((msg: Record<string, unknown>) => Promise<void>) | undefined;
  let closeHandler: (() => void) | undefined;

  sockMocks.listenSock.mockResolvedValue(server);
  sockMocks.onMessages.mockImplementation((_socket, next, onClose) => {
    handler = next;
    closeHandler = onClose;
  });
  sockMocks.writeMessage.mockImplementation((_socket, msg) => {
    writes.push(msg);
  });

  await startServer(ctx as never);
  server.emit("connection", socket);

  return {
    socket,
    writes,
    request: async (msg: Record<string, unknown>) => {
      await handler?.(msg);
    },
    close: () => closeHandler?.(),
  };
}

function decodeFrames(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.frames.map((frame) => JSON.parse(frame.trim()) as Record<string, unknown>);
}

describe("daemon server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves non-streaming requests and error responses over IPC", async () => {
    const harness = await bootServer({
      sockPath: "/tmp/daemon.sock",
      activity: { touch() {} },
      users: {
        get: () => null,
      },
    });

    await harness.request({
      kind: "request",
      id: "req-1",
      method: "status",
      params: {},
    });

    expect(harness.writes).toContainEqual(expect.objectContaining({
      kind: "response",
      id: "req-1",
      error: expect.objectContaining({
        code: "invalid_params",
      }),
    }));
  });

  it("keeps long-lived streaming requests open instead of auto-ending", async () => {
    let disposed = false;
    const harness = await bootServer({
      sockPath: "/tmp/daemon.sock",
      activity: { touch() {} },
      users: {
        has: () => true,
      },
      events: {
        listSince: async () => ({
          ok: true,
          events: [
            {
              id: "evt-1",
              ts: new Date().toISOString(),
              type: "turn.completed",
              session: "sess-1",
              thread_id: "th-1",
              payload: {},
            },
          ],
        }),
        subscribe: () => ({
          dispose() {
            disposed = true;
          },
        }),
      },
      config: {
        getEffective: () => 30,
      },
    });

    await harness.request({
      kind: "request",
      id: "stream-1",
      method: "monitor:events",
      bearer: "user-1",
      params: {
        streaming: true,
        flags: { stream: true },
      },
    });

    const streamed = decodeFrames(harness.socket);
    expect(streamed).toContainEqual(expect.objectContaining({
      kind: "stream_chunk",
      id: "stream-1",
    }));
    expect(streamed.find((msg) => msg.kind === "stream_end")).toBeUndefined();

    harness.close();
    expect(disposed).toBe(true);
  });

  it("returns stream_end with an error for invalid streaming requests", async () => {
    const harness = await bootServer({
      sockPath: "/tmp/daemon.sock",
      activity: { touch() {} },
      users: {
        has: () => false,
      },
    });

    await harness.request({
      kind: "request",
      id: "stream-err",
      method: "monitor:events",
      params: {
        streaming: true,
        flags: { stream: true },
      },
    });

    expect(harness.writes).toContainEqual(expect.objectContaining({
      kind: "stream_end",
      id: "stream-err",
      error: expect.objectContaining({
        code: "invalid_params",
      }),
    }));
  });
});
