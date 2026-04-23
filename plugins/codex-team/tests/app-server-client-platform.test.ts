import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> | T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  const finish = () => {
    if (original) Object.defineProperty(process, "platform", original);
  };
  try {
    const result = fn();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(finish);
    }
    finish();
    return result;
  } catch (e) {
    finish();
    throw e;
  }
}

function createFakeProc() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding(enc: string): void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding(enc: string): void };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};

  const stdin = {
    writable: true,
    writes: [] as string[],
    end: vi.fn(function end() {
      this.writable = false;
    }),
    write(chunk: string, cb?: (err?: Error | null) => void) {
      this.writes.push(chunk);
      const msg = JSON.parse(chunk.trim()) as { id?: string; method?: string };
      if (msg.method === "initialize" && msg.id) {
        queueMicrotask(() => {
          stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ready: true } }) + "\n");
          cb?.(null);
        });
        return true;
      }
      queueMicrotask(() => cb?.(null));
      return true;
    },
  };

  const proc = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    stdin: typeof stdin;
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    kill(signal?: string): boolean;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.pid = 1234;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal?: string) => {
    proc.exitCode = signal === "SIGKILL" ? 137 : 0;
    proc.signalCode = signal ?? null;
    queueMicrotask(() => proc.emit("exit", proc.exitCode, proc.signalCode));
    return true;
  });
  return proc;
}

describe("AppServerClient platform launch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("wraps JS entrypoints with the current Node executable", async () => {
    const fakeProc = createFakeProc();
    const spawn = vi.fn().mockReturnValue(fakeProc);
    vi.doMock("node:child_process", () => ({
      default: {
        spawn,
        execFileSync: vi.fn(),
      },
      spawn,
      execFileSync: vi.fn(),
    }));

    const { AppServerClient } = await import("../src/codex/appServerClient");
    const client = new AppServerClient({
      bin: "/tmp/codex.js",
    });

    await client.start();

    expect(spawn).toHaveBeenCalledWith(process.execPath, ["/tmp/codex.js", "app-server", "--listen", "stdio://"], expect.any(Object));
  });

  it("wraps Windows .cmd shims with the command processor", async () => {
    const fakeProc = createFakeProc();
    const spawn = vi.fn().mockReturnValue(fakeProc);
    const execFileSync = vi.fn().mockReturnValue("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd\r\n");
    vi.doMock("node:child_process", () => ({
      default: {
        spawn,
        execFileSync,
      },
      spawn,
      execFileSync,
    }));

    const { AppServerClient } = await import("../src/codex/appServerClient");
    await withPlatform("win32", async () => {
      const client = new AppServerClient({
        bin: "codex",
      });
      await client.start();
    });

    expect(execFileSync).toHaveBeenCalledWith("where", ["codex"], expect.any(Object));
    expect(spawn).toHaveBeenCalledWith(expect.stringMatching(/cmd\.exe$/i), ["/d", "/s", "/c", expect.stringContaining("codex.cmd")], expect.any(Object));
  });

  it("times out unanswered app-server requests using the configured timeout", async () => {
    vi.useFakeTimers();
    const fakeProc = createFakeProc();
    const spawn = vi.fn().mockReturnValue(fakeProc);
    vi.doMock("node:child_process", () => ({
      default: {
        spawn,
        execFileSync: vi.fn(),
      },
      spawn,
      execFileSync: vi.fn(),
    }));

    const { AppServerClient } = await import("../src/codex/appServerClient");
    const { RequestTimeoutError } = await import("../src/codex/errors");
    const client = new AppServerClient({
      requestTimeoutMs: 1000,
    });

    await client.start();
    const pending = client.request("thread/read", { threadId: "th-1" });
    const expectation = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);

    await expectation;
    expect(fakeProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("waits for stdin-driven shutdown before killing on Windows", async () => {
    vi.useFakeTimers();
    const fakeProc = createFakeProc();
    const spawn = vi.fn().mockReturnValue(fakeProc);
    vi.doMock("node:child_process", () => ({
      default: {
        spawn,
        execFileSync: vi.fn(),
      },
      spawn,
      execFileSync: vi.fn(),
    }));

    const { AppServerClient } = await import("../src/codex/appServerClient");

    await withPlatform("win32", async () => {
      const client = new AppServerClient();
      await client.start();
      const closing = client.close(1000);
      expect(fakeProc.stdin.end).toHaveBeenCalledTimes(1);
      expect(fakeProc.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      await closing;
    });

    expect(fakeProc.kill).toHaveBeenCalledWith();
  });

  it("acknowledges response writes and reports stdin backpressure", async () => {
    const fakeProc = createFakeProc();
    let pendingWriteCb: ((err?: Error | null) => void) | null = null;
    fakeProc.stdin.write = vi.fn((chunk: string, cb?: (err?: Error | null) => void) => {
      fakeProc.stdin.writes.push(chunk);
      const msg = JSON.parse(chunk.trim()) as { id?: string; method?: string };
      if (msg.method === "initialize" && msg.id) {
        queueMicrotask(() => {
          fakeProc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ready: true } }) + "\n");
          cb?.(null);
        });
        return true;
      }
      pendingWriteCb = cb ?? null;
      return false;
    }) as never;

    const spawn = vi.fn().mockReturnValue(fakeProc);
    vi.doMock("node:child_process", () => ({
      default: {
        spawn,
        execFileSync: vi.fn(),
      },
      spawn,
      execFileSync: vi.fn(),
    }));

    const { AppServerClient } = await import("../src/codex/appServerClient");
    const client = new AppServerClient();

    await client.start();
    const pendingAck = client.respondAck("req-1", { ok: true } as never);
    pendingWriteCb?.(null);

    await expect(pendingAck).resolves.toEqual({ backpressured: true });
  });

  it("retains stdout and stderr log tails with per-line events", async () => {
    const fakeProc = createFakeProc();
    const spawn = vi.fn().mockReturnValue(fakeProc);
    vi.doMock("node:child_process", () => ({
      default: {
        spawn,
        execFileSync: vi.fn(),
      },
      spawn,
      execFileSync: vi.fn(),
    }));

    const { AppServerClient } = await import("../src/codex/appServerClient");
    const client = new AppServerClient();
    const stdoutLines: Array<{ stream: string; line: string }> = [];
    const stderrLines: Array<{ stream: string; line: string }> = [];

    await client.start();
    client.on("stdout_line", (line) => stdoutLines.push({ stream: line.stream, line: line.line }));
    client.on("stderr_line", (line) => stderrLines.push({ stream: line.stream, line: line.line }));

    fakeProc.stdout.emit("data", JSON.stringify({ jsonrpc: "2.0", method: "thread.updated" }) + "\n");
    fakeProc.stderr.emit("data", "warn 1\nwarn");
    fakeProc.stderr.emit("data", " 2\n");

    expect(stdoutLines).toEqual([
      { stream: "stdout", line: "{\"jsonrpc\":\"2.0\",\"method\":\"thread.updated\"}" },
    ]);
    expect(stderrLines).toEqual([
      { stream: "stderr", line: "warn 1" },
      { stream: "stderr", line: "warn 2" },
    ]);
    expect(client.stdoutTail()).toHaveLength(2);
    expect(client.stdoutTail().at(-1)).toMatchObject({
      stream: "stdout",
      line: "{\"jsonrpc\":\"2.0\",\"method\":\"thread.updated\"}",
    });
    expect(client.stderrTail()).toHaveLength(2);
    expect(client.stderrTailText()).toBe("warn 1\nwarn 2");
  });
});
