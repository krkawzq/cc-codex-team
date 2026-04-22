import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { connectSock, onMessages, writeMessage } from "../src/ipc/sock";
import { startServer } from "../src/daemon/server";

function mkSockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-server-"));
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

describe("daemon server", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it("serves non-streaming requests and error responses over IPC", async () => {
    const { dir, sockPath } = mkSockPath();
    const server = await startServer({
      sockPath,
      activity: { touch() {} },
      users: {
        get: () => null,
      },
    } as never);
    cleanups.push(() => closeServer(server, sockPath, dir));

    const sock = await connectSock(sockPath, 1000);
    const responses: unknown[] = [];
    const responsePromise = new Promise<void>((resolve) => {
      onMessages(sock, (msg) => {
        responses.push(msg);
        if ((msg as { kind?: string }).kind === "response") resolve();
      });
    });

    writeMessage(sock, {
      kind: "request",
      id: "req-1",
      method: "status",
      params: {},
    });
    await responsePromise;
    sock.end();

    expect(responses).toContainEqual(expect.objectContaining({
      kind: "response",
      id: "req-1",
      error: expect.objectContaining({
        code: "invalid_params",
      }),
    }));
  });

  it("keeps long-lived streaming requests open instead of auto-ending", async () => {
    const { dir, sockPath } = mkSockPath();
    let disposed = false;
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
    } as never);
    cleanups.push(() => closeServer(server, sockPath, dir));

    const sock = await connectSock(sockPath, 1000);
    const messages: Array<Record<string, unknown>> = [];
    const firstChunk = new Promise<void>((resolve) => {
      onMessages(sock, (msg) => {
        messages.push(msg as Record<string, unknown>);
        if ((msg as { kind?: string }).kind === "stream_chunk") resolve();
      });
    });

    writeMessage(sock, {
      kind: "request",
      id: "stream-1",
      method: "monitor:events",
      bearer: "user-1",
      params: {
        streaming: true,
        flags: { stream: true },
      },
    });

    await firstChunk;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toContainEqual(expect.objectContaining({
      kind: "stream_chunk",
      id: "stream-1",
    }));
    expect(messages.find((m) => m.kind === "stream_end")).toBeUndefined();

    sock.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(true);
  });

  it("returns stream_end with an error for invalid streaming requests", async () => {
    const { dir, sockPath } = mkSockPath();
    const server = await startServer({
      sockPath,
      activity: { touch() {} },
      users: {
        has: () => false,
      },
    } as never);
    cleanups.push(() => closeServer(server, sockPath, dir));

    const sock = await connectSock(sockPath, 1000);
    const endPromise = new Promise<Record<string, unknown>>((resolve) => {
      onMessages(sock, (msg) => {
        if ((msg as { kind?: string }).kind === "stream_end") {
          resolve(msg as Record<string, unknown>);
        }
      });
    });

    writeMessage(sock, {
      kind: "request",
      id: "stream-err",
      method: "monitor:events",
      params: {
        streaming: true,
        flags: { stream: true },
      },
    });

    const end = await endPromise;
    sock.end();

    expect(end).toMatchObject({
      kind: "stream_end",
      id: "stream-err",
      error: {
        code: "invalid_params",
      },
    });
  });
});
