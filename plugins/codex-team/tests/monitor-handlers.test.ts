import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monitorMocks = vi.hoisted(() => {
  const spawn = vi.fn();
  return { spawn };
});

vi.mock("node:child_process", () => monitorMocks);

import { monitorAlarm } from "../src/daemon/handlers/monitor";

class FakeStream extends EventEmitter {
  public chunks: unknown[] = [];

  chunk(data: unknown): void {
    this.chunks.push(data);
  }

  end(): void {}

  onClose(cb: () => void): void {
    this.on("close", cb);
  }
}

function makeChild() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};

  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === "SIGTERM") {
      child.exitCode = 0;
      child.signalCode = signal ?? null;
      child.emit("exit", 0, signal ?? null);
    }
    if (signal === "SIGKILL") {
      child.exitCode = 137;
      child.signalCode = signal ?? null;
      child.emit("exit", 137, signal ?? null);
    }
    return true;
  });
  return child;
}

function makeReq(positionals: string[], flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "monitor:alarm",
    params: {
      positionals,
      flags,
    },
  };
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

describe("monitorAlarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the pending SIGKILL timer when the child exits after timeout SIGTERM", async () => {
    const child = makeChild();
    monitorMocks.spawn.mockReturnValue(child);
    const stream = new FakeStream();

    const promise = monitorAlarm({} as never, makeReq(["1", "echo hi"], { once: true, timeout: "1" }) as never, stream as never);

    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    await vi.advanceTimersByTimeAsync(5000);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(stream.chunks).toContainEqual(expect.objectContaining({ __alarm_event: "timeout" }));
  });

  it("terminates an active child when the stream closes", async () => {
    const first = makeChild();
    const second = makeChild();
    monitorMocks.spawn
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const stream = new FakeStream();
    const handlerPromise = monitorAlarm({} as never, makeReq(["1", "echo hi"]) as never, stream as never);

    first.emit("exit", 0, null);
    await handlerPromise;

    await vi.advanceTimersByTimeAsync(1000);
    stream.emit("close");

    expect(second.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("kills a stuck first-run child even if the stream closes before the initial run finishes", async () => {
    const child = makeChild();
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        child.exitCode = 137;
        child.signalCode = signal ?? null;
        child.emit("exit", 137, signal ?? null);
      }
      return true;
    });
    monitorMocks.spawn.mockReturnValue(child);

    const stream = new FakeStream();
    const handlerPromise = monitorAlarm({} as never, makeReq(["1", "sleep 999"], { once: true }) as never, stream as never);

    stream.emit("close");
    await vi.advanceTimersByTimeAsync(5000);

    await handlerPromise;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not overlap recurring alarm runs while a previous run is still active", async () => {
    const first = makeChild();
    const second = makeChild();
    monitorMocks.spawn
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const stream = new FakeStream();
    const handlerPromise = monitorAlarm({} as never, makeReq(["1", "echo hi"]) as never, stream as never);

    first.emit("exit", 0, null);
    await handlerPromise;

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(monitorMocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("uses cmd.exe semantics on Windows", async () => {
    const child = makeChild();
    monitorMocks.spawn.mockReturnValue(child);
    const stream = new FakeStream();

    await withPlatform("win32", async () => {
      const promise = monitorAlarm({} as never, makeReq(["1", "echo hi"], { once: true }) as never, stream as never);
      child.emit("exit", 0, null);
      await promise;
    });

    expect(monitorMocks.spawn).toHaveBeenCalledWith(expect.stringMatching(/cmd\.exe$/i), ["/d", "/s", "/c", "echo hi"], expect.any(Object));
  });
});
