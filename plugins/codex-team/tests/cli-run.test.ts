import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockMocks = vi.hoisted(() => ({
  connectSock: vi.fn(),
  probeSock: vi.fn(),
  writeMessage: vi.fn(),
  onMessages: vi.fn(),
}));

const processMocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

vi.mock("../src/ipc/sock", () => sockMocks);
vi.mock("node:child_process", () => processMocks);
vi.mock("../src/daemon/config", () => ({
  ConfigStore: class {
    getEffective(key: string) {
      if (key === "daemon.ready_timeout_seconds") return 15;
      if (key === "daemon.connect_timeout_seconds") return 5;
      if (key === "daemon.connect_retry_attempts") return 3;
      if (key === "daemon.connect_retry_delay_seconds") return 0.25;
      return null;
    }
  },
}));

import { runCli } from "../src/cli/run";

describe("runCli", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    stdoutSpy.mockRestore();
  });

  it("fails fast when bearer is missing for user-level commands", async () => {
    const code = await runCli(["message", "send", "sess-1", "hello"]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"invalid_params\""));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("returns daemon_unreachable when the daemon never comes up", async () => {
    vi.useFakeTimers();
    sockMocks.probeSock.mockResolvedValue(false);

    const pending = runCli(["-b", "token-1", "status"]);
    await vi.advanceTimersByTimeAsync(16000);
    const code = await pending;

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"daemon_unreachable\""));
  });

  it("rejects monitor events when --since and --cursor are combined", async () => {
    const code = await runCli([
      "-b", "token-1",
      "monitor", "events",
      "--since", "evt-1",
      "--cursor", "audit-tail",
    ]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"invalid_params\""));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("--since and --cursor are mutually exclusive"));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("prints group help for command groups", async () => {
    const code = await runCli(["session", "--help"]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("codex-team session"));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("emits raw markdown for successful read responses with --format markdown", async () => {
    let responseHandler: ((msg: Record<string, unknown>) => void) | undefined;
    const socket = {
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(() => socket),
      once: vi.fn(() => socket),
    };

    sockMocks.probeSock.mockResolvedValue(true);
    sockMocks.connectSock.mockResolvedValue(socket);
    sockMocks.onMessages.mockImplementation((_sock, handler) => {
      responseHandler = handler;
    });
    sockMocks.writeMessage.mockImplementation((_sock, req: { id: string }) => {
      setTimeout(() => {
        responseHandler?.({
          kind: "response",
          id: req.id,
          result: {
            format: "markdown",
            markdown: "<history>{\"session\":\"sess-1\"}<\\history>",
          },
        });
      }, 0);
    });

    const code = await runCli(["-b", "token-1", "message", "history", "sess-1", "--format", "markdown"]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith("<history>{\"session\":\"sess-1\"}<\\history>\n");
    expect(stdoutSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("\"ok\":true"),
    );
  });

  it("prints only the saved event id for cursor get", async () => {
    let responseHandler: ((msg: Record<string, unknown>) => void) | undefined;
    const socket = {
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(() => socket),
      once: vi.fn(() => socket),
    };

    sockMocks.probeSock.mockResolvedValue(true);
    sockMocks.connectSock.mockResolvedValue(socket);
    sockMocks.onMessages.mockImplementation((_sock, handler) => {
      responseHandler = handler;
    });
    sockMocks.writeMessage.mockImplementation((_sock, req: { id: string }) => {
      setTimeout(() => {
        responseHandler?.({
          kind: "response",
          id: req.id,
          result: {
            event_id: "evt-9",
          },
        });
      }, 0);
    });

    const code = await runCli(["-b", "token-1", "cursor", "get", "audit-tail"]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith("evt-9\n");
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining("\"ok\":true"));
  });

  it("treats abnormal stream socket close as failure", async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const socket = {
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] ??= [];
        listeners[event].push(cb);
        return socket;
      }),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] ??= [];
        listeners[event].push(cb);
        return socket;
      }),
    };

    sockMocks.probeSock.mockResolvedValue(true);
    sockMocks.connectSock.mockResolvedValue(socket);
    sockMocks.onMessages.mockImplementation((_sock, _handler, onClose) => {
      if (onClose) setTimeout(() => onClose(), 0);
    });

    const code = await runCli(["-b", "token-1", "monitor", "events", "--stream"]);

    expect(code).toBe(1);
  });

  it("retries transient daemon connect failures before succeeding", async () => {
    const listeners: Record<string, ((msg: unknown) => void)[]> = {};
    const socket = {
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, cb: (msg: unknown) => void) => {
        listeners[event] ??= [];
        listeners[event].push(cb);
        return socket;
      }),
      once: vi.fn((event: string, cb: (msg: unknown) => void) => {
        listeners[event] ??= [];
        listeners[event].push(cb);
        return socket;
      }),
    };

    sockMocks.probeSock.mockResolvedValue(true);
    sockMocks.connectSock
      .mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockResolvedValue(socket);
    sockMocks.onMessages.mockImplementation((_sock, handler) => {
      listeners.response_handler = [handler];
    });
    sockMocks.writeMessage.mockImplementation((_sock, req: { id: string }) => {
      const handler = listeners.response_handler?.[0];
      if (handler) {
        setTimeout(() => handler({
          kind: "response",
          id: req.id,
          result: { ok: true },
        }), 0);
      }
    });

    const code = await runCli(["daemon", "status"]);

    expect(code).toBe(0);
    expect(sockMocks.connectSock).toHaveBeenCalledTimes(3);
  });

  it("retries read-only requests when the daemon closes the connection mid-flight", async () => {
    let closeHandler: (() => void) | undefined;
    const firstSocket = {
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(() => firstSocket),
      once: vi.fn((event: string, cb: () => void) => {
        if (event === "error") return firstSocket;
        return firstSocket;
      }),
    };
    const secondSocket = {
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(() => secondSocket),
      once: vi.fn(() => secondSocket),
    };

    sockMocks.probeSock.mockResolvedValue(true);
    sockMocks.connectSock
      .mockResolvedValueOnce(firstSocket)
      .mockResolvedValueOnce(secondSocket);
    sockMocks.onMessages
      .mockImplementationOnce((_sock, _handler, onClose) => {
        closeHandler = onClose;
      })
      .mockImplementationOnce((_sock, handler) => {
        setTimeout(() => handler({
          kind: "response",
          id: "retry-id",
          result: { token: "user-1" },
        }), 0);
      });
    sockMocks.writeMessage
      .mockImplementationOnce(() => {
        setTimeout(() => closeHandler?.(), 0);
      })
      .mockImplementationOnce((_sock, req: { id: string }) => {
        setTimeout(() => {
          const handler = sockMocks.onMessages.mock.calls[1]?.[1];
          handler?.({
            kind: "response",
            id: req.id,
            result: { token: "user-1" },
          });
        }, 0);
      });

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(0);
    expect(sockMocks.connectSock).toHaveBeenCalledTimes(2);
  });

  it("pauses the daemon socket until stdout drains during streaming", async () => {
    let streamHandler: ((msg: Record<string, unknown>) => void) | undefined;
    const socket = {
      end: vi.fn(),
      destroy: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      on: vi.fn(() => socket),
      once: vi.fn(() => socket),
    };

    sockMocks.probeSock.mockResolvedValue(true);
    sockMocks.connectSock.mockResolvedValue(socket);
    sockMocks.onMessages.mockImplementation((_sock, handler) => {
      streamHandler = handler;
    });

    let writes = 0;
    stdoutSpy.mockImplementation(() => {
      writes += 1;
      return writes > 1;
    });

    const pending = runCli(["-b", "token-1", "monitor", "events", "--stream"]);
    await new Promise((resolve) => setImmediate(resolve));
    const reqId = sockMocks.writeMessage.mock.calls[0]?.[1]?.id;

    streamHandler?.({
      kind: "stream_chunk",
      id: reqId,
      data: { hello: "world" },
    });
    expect(socket.pause).toHaveBeenCalledTimes(1);

    streamHandler?.({
      kind: "stream_end",
      id: reqId,
    });

    process.stdout.emit("drain");
    const code = await pending;

    expect(socket.resume).toHaveBeenCalledTimes(1);
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });

  it("emits raw markdown stream chunks for message tail --follow --format markdown", async () => {
    let streamHandler: ((msg: Record<string, unknown>) => void) | undefined;
    const socket = {
      end: vi.fn(),
      destroy: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      on: vi.fn(() => socket),
      once: vi.fn(() => socket),
    };

    sockMocks.probeSock.mockResolvedValue(true);
    sockMocks.connectSock.mockResolvedValue(socket);
    sockMocks.onMessages.mockImplementation((_sock, handler) => {
      streamHandler = handler;
    });

    const pending = runCli([
      "-b",
      "token-1",
      "message",
      "tail",
      "sess-1",
      "--follow",
      "--format",
      "markdown",
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    const reqId = sockMocks.writeMessage.mock.calls[0]?.[1]?.id;

    streamHandler?.({
      kind: "stream_chunk",
      id: reqId,
      data: { markdown: "<tail>{\"session\":\"sess-1\"}<\\tail>" },
    });
    streamHandler?.({
      kind: "stream_end",
      id: reqId,
    });

    const code = await pending;

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith("<tail>{\"session\":\"sess-1\"}<\\tail>\n");
    expect(stdoutSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("\"markdown\""),
    );
  });
});
