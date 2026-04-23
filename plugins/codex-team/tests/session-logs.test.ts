import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadArchive: vi.fn(),
  threadFork: vi.fn(),
  threadIdOf: vi.fn((resp: { thread: { id: string } }) => resp.thread.id),
  threadLoadedList: vi.fn(),
  threadList: vi.fn(),
  threadRead: vi.fn(),
  threadRename: vi.fn(),
  threadResume: vi.fn(),
  threadSetName: vi.fn(),
  threadStart: vi.fn(),
  threadTurnsList: vi.fn(),
  threadUnarchive: vi.fn(),
  threadUnsubscribe: vi.fn(),
  turnInterrupt: vi.fn(),
}));

import type { AppServerLogLine } from "../src/codex/appServerClient";
import { threadList } from "../src/codex/rpc";
import { sessionLogs } from "../src/daemon/handlers/session";
import { formatShort } from "../src/format/short";

class FakeLogClient extends EventEmitter {
  private readonly entries: AppServerLogLine[];
  private readonly alive: boolean;
  private readonly processId: number;

  constructor(entries: AppServerLogLine[], options: { alive?: boolean; pid?: number } = {}) {
    super();
    this.entries = [...entries];
    this.alive = options.alive ?? true;
    this.processId = options.pid ?? 12345;
  }

  isAlive(): boolean {
    return this.alive;
  }

  pid(): number {
    return this.processId;
  }

  stderrTail(n = 400): AppServerLogLine[] {
    const entries = this.entries.filter((entry) => entry.stream === "stderr");
    return entries.slice(Math.max(0, entries.length - n));
  }

  stdoutTail(n = 400): AppServerLogLine[] {
    const entries = this.entries.filter((entry) => entry.stream === "stdout");
    return entries.slice(Math.max(0, entries.length - n));
  }

  logTail(stream: "stdout" | "stderr" | "all", n = 400): AppServerLogLine[] {
    const selected = stream === "all"
      ? this.entries
      : this.entries.filter((entry) => entry.stream === stream);
    return selected.slice(Math.max(0, selected.length - n));
  }

  emitLine(stream: "stdout" | "stderr", line: string, ts: string): void {
    const entry = logLine(stream, line, ts);
    this.entries.push(entry);
    this.emit(`${stream}_line`, entry);
  }
}

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

function logLine(stream: "stdout" | "stderr", line: string, ts: string): AppServerLogLine {
  return { stream, line, ts };
}

function makeReq(target = "audit", flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-session-logs",
    method: "session:logs",
    bearer: "user-1",
    params: {
      positionals: [target],
      flags,
    },
  };
}

function makeCtx(options: {
  session?: { name: string; thread_id: string; state: "live" | "crashed" };
  client?: FakeLogClient | null;
  closedLogs?: {
    appServerId: string;
    pid: number | null;
    closedAt: string;
    stderrTail: AppServerLogLine[];
    stdoutTail: AppServerLogLine[];
  } | null;
} = {}) {
  const session = options.session ?? { name: "audit", thread_id: "th-1", state: "live" as const };
  const client = options.client ?? null;
  return {
    users: {
      has: vi.fn().mockReturnValue(true),
    },
    sessions: {
      get: vi.fn((_user: string, identifier: string) => (
        session && (identifier === session.name || identifier === session.thread_id) ? session : null
      )),
      findLiveAnywhere: vi.fn().mockReturnValue(null),
      findUniqueLiveByNameAnywhere: vi.fn().mockReturnValue(null),
    },
    pool: {
      clientForSession: vi.fn().mockReturnValue(client),
      sessionBinding: vi.fn().mockImplementation(() => (
        client ? { appServerId: "as-1", pid: client.pid() } : null
      )),
      closedLogsForSession: vi.fn().mockReturnValue(options.closedLogs ?? null),
      acquireForAdhoc: vi.fn().mockResolvedValue({ kind: "adhoc-client" }),
    },
    retryOptions: vi.fn().mockReturnValue({}),
  };
}

describe("session logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the stderr tail for a live session", async () => {
    const client = new FakeLogClient([
      logLine("stderr", "boot", "2026-04-23T12:00:00.000Z"),
      logLine("stderr", "ready", "2026-04-23T12:00:01.000Z"),
    ]);

    const result = await sessionLogs(makeCtx({ client }) as never, makeReq() as never);

    expect(result).toEqual({
      session: "audit",
      thread_id: "th-1",
      app_server_id: "as-1",
      pid: 12345,
      lines: [
        logLine("stderr", "boot", "2026-04-23T12:00:00.000Z"),
        logLine("stderr", "ready", "2026-04-23T12:00:01.000Z"),
      ],
      truncated_from: null,
    });
  });

  it("caps the response to the requested line count", async () => {
    const client = new FakeLogClient(Array.from({ length: 8 }, (_, index) => (
      logLine("stderr", `line-${index + 1}`, `2026-04-23T12:00:0${index}.000Z`)
    )));

    const result = await sessionLogs(makeCtx({ client }) as never, makeReq("audit", { n: "5" }) as never) as {
      lines: AppServerLogLine[];
      truncated_from: number | null;
    };

    expect(result.lines.map((entry) => entry.line)).toEqual([
      "line-4",
      "line-5",
      "line-6",
      "line-7",
      "line-8",
    ]);
    expect(result.truncated_from).toBe(8);
  });

  it("streams new log lines in follow mode", async () => {
    const client = new FakeLogClient([
      logLine("stderr", "seed", "2026-04-23T12:00:00.000Z"),
    ]);
    const stream = new FakeStream();

    await sessionLogs(makeCtx({ client }) as never, makeReq("audit", { follow: true }) as never, stream as never);
    expect(stream.chunks).toEqual([
      {
        session: "audit",
        thread_id: "th-1",
        app_server_id: "as-1",
        pid: 12345,
        lines: [logLine("stderr", "seed", "2026-04-23T12:00:00.000Z")],
        truncated_from: null,
      },
    ]);

    client.emitLine("stderr", "next", "2026-04-23T12:00:01.000Z");

    expect(stream.chunks).toContainEqual({
      session: "audit",
      thread_id: "th-1",
      app_server_id: "as-1",
      pid: 12345,
      lines: [logLine("stderr", "next", "2026-04-23T12:00:01.000Z")],
      truncated_from: null,
    });

    client.emit("close", 0);
    expect(stream.endedWith).toBe("ended");
  });

  it("rejects detached sessions with a re-attach hint", async () => {
    vi.mocked(threadList).mockResolvedValue({
      data: [{ id: "th-detached", name: "audit" }],
      nextCursor: null,
    } as never);

    const ctx = makeCtx({ session: undefined, client: null });
    ctx.sessions.get.mockReturnValue(null);

    await expect(sessionLogs(ctx as never, makeReq("audit") as never)).rejects.toMatchObject({
      code: "session_not_live",
      message: expect.stringContaining("session attach audit"),
    });
  });

  it("returns the captured tail for crashed sessions", async () => {
    const result = await sessionLogs(makeCtx({
      session: { name: "audit", thread_id: "th-1", state: "crashed" },
      closedLogs: {
        appServerId: "as-9",
        pid: 999,
        closedAt: "2026-04-23T12:00:02.000Z",
        stderrTail: [logLine("stderr", "panic", "2026-04-23T12:00:00.000Z")],
        stdoutTail: [],
      },
    }) as never, makeReq() as never);

    expect(result).toEqual({
      session: "audit",
      thread_id: "th-1",
      app_server_id: "as-9",
      pid: 999,
      lines: [logLine("stderr", "panic", "2026-04-23T12:00:00.000Z")],
      truncated_from: null,
      state: "crashed",
    });
  });

  it("renders short output as timestamp stream line", () => {
    expect(formatShort("session:logs", {
      lines: [
        logLine("stderr", "boom", "2026-04-23T12:00:00.000Z"),
        logLine("stdout", "{\"jsonrpc\":\"2.0\"}", "2026-04-23T12:00:01.000Z"),
      ],
    })).toBe(
      "2026-04-23T12:00:00.000Z stderr boom\n2026-04-23T12:00:01.000Z stdout {\"jsonrpc\":\"2.0\"}",
    );
  });
});
