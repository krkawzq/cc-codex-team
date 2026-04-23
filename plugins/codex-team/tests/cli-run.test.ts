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
      if (key === "daemon.ready_timeout_seconds") return 0.05;
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

  it("rejects invalid approval shortcut hints before contacting the daemon", async () => {
    const code = await runCli([
      "-b", "token-1",
      "message", "approval",
      "sess-1",
      "req-1",
      "cancel",
      "--kind", "approval.permissions",
    ]);

    expect(code).toBe(2);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("valid actions: accept, accept-session, decline"));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("returns daemon_unreachable when the daemon never comes up", async () => {
    sockMocks.probeSock.mockResolvedValue(false);

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"daemon_unreachable\""));
  });

  it("accepts --bearer=value globals before command matching", async () => {
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
    sockMocks.writeMessage.mockImplementation((_sock, req: { id: string; bearer?: string }) => {
      expect(req.bearer).toBe("token-1");
      setTimeout(() => {
        responseHandler?.({
          kind: "response",
          id: req.id,
          result: { token: "token-1" },
        });
      }, 0);
    });

    const code = await runCli(["--bearer=token-1", "status"]);

    expect(code).toBe(0);
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

  it("emits concise JSON by default for successful responses", async () => {
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
            token: "token-1",
            created_at: "2026-04-23T00:00:00.000Z",
            last_active_at: "2026-04-23T00:01:00.000Z",
            live_sessions: 2,
            retained_events: 4,
            retained_limit: 10,
            pending_requests: 1,
            app_server_count: 3,
            daemon: {
              pid: 77,
              started_at: "2026-04-23T00:59:00.000Z",
              data_dir: "/tmp/data",
            },
          },
        });
      }, 0);
    });

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(
      "{\"ok\":true,\"data\":{\"token\":\"token-1\",\"live_sessions\":2,\"retained_events\":4,\"retained_limit\":10,\"pending_requests\":1,\"app_server_count\":3}}\n",
    );
  });

  it("restores the full JSON body with --full", async () => {
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
            token: "token-1",
            created_at: "2026-04-23T00:00:00.000Z",
            last_active_at: "2026-04-23T00:01:00.000Z",
            live_sessions: 2,
            retained_events: 4,
            retained_limit: 10,
            pending_requests: 1,
            app_server_count: 3,
            daemon: {
              pid: 77,
              started_at: "2026-04-23T00:59:00.000Z",
              data_dir: "/tmp/data",
            },
          },
        });
      }, 0);
    });

    const code = await runCli(["-b", "token-1", "status", "--full"]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(
      "{\"ok\":true,\"data\":{\"token\":\"token-1\",\"created_at\":\"2026-04-23T00:00:00.000Z\",\"last_active_at\":\"2026-04-23T00:01:00.000Z\",\"live_sessions\":2,\"retained_events\":4,\"retained_limit\":10,\"pending_requests\":1,\"app_server_count\":3,\"daemon\":{\"pid\":77,\"started_at\":\"2026-04-23T00:59:00.000Z\",\"data_dir\":\"/tmp/data\"}}}\n",
    );
  });

  it("rejects --short and --full together before contacting the daemon", async () => {
    const code = await runCli(["-b", "token-1", "status", "--short", "--full"]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("--short and --full are mutually exclusive"));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("emits one compact line for successful --short responses", async () => {
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
            token: "token-1",
            live_sessions: 2,
            pending_requests: 1,
            retained_events: 4,
            retained_limit: 10,
            app_server_count: 1,
            daemon: {
              started_at: "2026-04-23T00:59:00.000Z",
            },
          },
        });
      }, 0);
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T01:00:00.000Z"));
    const pending = runCli(["-b", "token-1", "status", "--short"]);
    await vi.runAllTimersAsync();
    const code = await pending;

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(
      "user=token-1 live=2 pending=1 retained=4/10 app_servers=1 daemon_age=1m\n",
    );
  });

  it("preserves paginated short metadata in footer lines", async () => {
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
            sessions: [
              { name: "audit", state: "live", model: "gpt-5.4", current_turn_id: "turn-42" },
            ],
            next_cursor: "cursor-2",
            all: true,
            sort: "last_active",
            format: "json",
          },
        });
      }, 0);
    });

    const code = await runCli(["-b", "token-1", "session", "list", "--all", "--short"]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(
      "audit  live  gpt-5.4  busy=y\n# next_cursor=\"cursor-2\" all=true sort=\"last_active\" format=\"json\"\n",
    );
  });

  it("preserves message history notes in short footer lines", async () => {
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
            turns: [
              { id: "turn-1", status: "completed", item_count: 1 },
            ],
            format: "json",
            note: "Turn items are not included in turnsList responses.",
          },
        });
      }, 0);
    });

    const code = await runCli(["-b", "token-1", "message", "history", "sess-1", "--short"]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(
      "turn-1 completed unknown items=1\n# format=\"json\"\n# note=\"Turn items are not included in turnsList responses.\"\n",
    );
  });

  it("rejects --short with markdown or table formatting before contacting the daemon", async () => {
    const code = await runCli(["-b", "token-1", "message", "history", "sess-1", "--short", "--format", "markdown"]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("--short cannot be used with --format markdown or --format table"));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
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
    expect(sockMocks.connectSock.mock.calls.length).toBeGreaterThanOrEqual(2);
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

  it("acks monitor event frames only after stdout drains", async () => {
    let streamHandler: ((msg: Record<string, unknown>) => void) | undefined;
    const socket = {
      end: vi.fn(),
      destroy: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      on: vi.fn(() => socket),
      once: vi.fn(() => socket),
      destroyed: false,
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
      data: { id: "evt-2", type: "turn.completed" },
    });

    expect(sockMocks.writeMessage).toHaveBeenCalledTimes(1);

    streamHandler?.({
      kind: "stream_end",
      id: reqId,
    });

    process.stdout.emit("drain");
    const code = await pending;

    expect(code).toBe(0);
    expect(sockMocks.writeMessage).toHaveBeenCalledWith(socket, {
      kind: "notification",
      method: "stream_ack",
      params: {
        id: reqId,
        event_id: "evt-2",
      },
    });
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

  it("routes session health --all to the fleet RPC shape", async () => {
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
    sockMocks.writeMessage.mockImplementationOnce((_sock, req: { id: string; method: string }) => {
      expect(req.method).toBe("session:health:all");
      setTimeout(() => {
        responseHandler?.({
          kind: "response",
          id: req.id,
          result: {
            summary: { total: 1, healthy: 1, crashed: 0, closed: 0, busy: 0, pending_total: 0 },
            sessions: [{ session: "audit", thread_id: "th-1", state: "live", busy: false, app_server_alive: true }],
          },
        });
      }, 0);
    });

    const code = await runCli(["-b", "token-1", "session", "health", "--all"]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(
      "{\"ok\":true,\"data\":{\"summary\":{\"total\":1,\"healthy\":1,\"crashed\":0,\"closed\":0,\"busy\":0,\"pending_total\":0},\"sessions\":[{\"session\":\"audit\",\"thread_id\":\"th-1\",\"state\":\"live\",\"busy\":false,\"app_server_alive\":true}]}}\n",
    );
  });

  it("streams session events even without --follow", async () => {
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

    const pending = runCli(["-b", "token-1", "session", "events", "audit", "--limit", "1"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sockMocks.writeMessage.mock.calls[0]?.[1]?.method).toBe("session:events");
    const reqId = sockMocks.writeMessage.mock.calls[0]?.[1]?.id;

    streamHandler?.({
      kind: "stream_chunk",
      id: reqId,
      data: { id: "evt-2", type: "turn.completed", session: "audit" },
    });
    streamHandler?.({
      kind: "stream_end",
      id: reqId,
    });

    const code = await pending;

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith("{\"id\":\"evt-2\",\"type\":\"turn.completed\",\"session\":\"audit\"}\n");
  });

  it("maps message wait outcomes to CLI exit codes", async () => {
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
    sockMocks.writeMessage.mockImplementationOnce((_sock, req: { id: string }) => {
      setTimeout(() => {
        responseHandler?.({
          kind: "response",
          id: req.id,
          result: {
            outcome: "error",
            event_type: "turn.error",
          },
        });
      }, 0);
    }).mockImplementationOnce((_sock, req: { id: string }) => {
      setTimeout(() => {
        responseHandler?.({
          kind: "response",
          id: req.id,
          result: {
            outcome: "timeout",
            timeout_s: 5,
          },
        });
      }, 0);
    });

    const errorCode = await runCli(["-b", "token-1", "message", "wait", "sess-1"]);
    const timeoutCode = await runCli(["-b", "token-1", "message", "wait", "sess-1", "--timeout", "5"]);

    expect(errorCode).toBe(1);
    expect(timeoutCode).toBe(124);
  });
});
