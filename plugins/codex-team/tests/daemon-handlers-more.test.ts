import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const daemonHandlerMocks = vi.hoisted(() => ({
  shutdownDaemon: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("../src/daemon/shutdown", () => ({
  shutdownDaemon: daemonHandlerMocks.shutdownDaemon,
}));
vi.mock("node:child_process", () => ({
  spawn: daemonHandlerMocks.spawn,
}));

import {
  daemonConfigGet,
  daemonConfigList,
  daemonConfigSet,
  daemonLogsStream,
  daemonRestart,
  daemonStatus,
  daemonStop,
  daemonUserCreate,
  daemonUserList,
} from "../src/daemon/handlers/daemon";

class FakeStream {
  chunks: unknown[] = [];
  private closeCb: (() => void) | null = null;

  chunk(data: unknown): void {
    this.chunks.push(data);
  }

  end(): void {}

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    this.closeCb?.();
  }
}

function makeReq(positionals: string[] = [], flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "daemon:test",
    params: {
      positionals,
      flags,
    },
  };
}

describe("daemon handlers", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("returns daemon status and user list", async () => {
    const startedAt = new Date(Date.now() - 2500);
    const ctx = {
      startedAt,
      sockPath: "/tmp/daemon.sock",
      dataDir: "/tmp/data",
      logPath: "/tmp/daemon.log",
      users: {
        list: () => [{ token: "user-1" }, { token: "user-2" }],
        create: vi.fn().mockReturnValue({ token: "user-3" }),
      },
      pool: {
        processCount: () => 4,
      },
    };

    expect(await daemonStatus(ctx as never, makeReq() as never)).toMatchObject({
      sock: "/tmp/daemon.sock",
      data_dir: "/tmp/data",
      user_count: 2,
      app_server_count: 4,
    });
    expect(await daemonUserList(ctx as never, makeReq() as never)).toEqual({
      users: [{ token: "user-1" }, { token: "user-2" }],
    });
    expect(await daemonUserCreate(ctx as never, makeReq(["user-3"]) as never)).toEqual({ token: "user-3" });
  });

  it("gets, sets, and lists config values", async () => {
    const ctx = {
      config: {
        get: vi.fn().mockReturnValue({
          value: "info",
          source: "default",
          spec: { default: "info", needsRestart: false },
        }),
        set: vi.fn().mockReturnValue({ ok: true, value: "debug", needs_restart: false }),
        snapshot: vi.fn().mockReturnValue({
          explicit: { "daemon.log_level": "debug" },
          effective: {
            "daemon.log_level": "debug",
            "daemon.idle_shutdown_hours": 6,
          },
        }),
      },
      events: {
        setRetention: vi.fn(),
      },
    };

    expect(await daemonConfigGet(ctx as never, makeReq(["daemon.log_level"]) as never)).toEqual({
      key: "daemon.log_level",
      value: "info",
      default: "info",
      source: "default",
      needs_restart: false,
    });
    expect(await daemonConfigSet(ctx as never, makeReq(["daemon.log_level", "debug"]) as never)).toEqual({
      key: "daemon.log_level",
      value: "debug",
      needs_restart: false,
    });
    const listed = await daemonConfigList(ctx as never, makeReq([], { "explicit-only": true }) as never);
    expect((listed as { config: Array<Record<string, unknown>> }).config).toHaveLength(1);
  });

  it("streams daemon logs, including truncation during follow", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-logs-"));
    dirs.push(dir);
    const logPath = path.join(dir, "daemon.log");
    fs.writeFileSync(logPath, [
      JSON.stringify({ level: "info", a: 1 }),
      JSON.stringify({ level: "error", a: 2 }),
      "",
    ].join("\n"));

    let watchCb: (() => void) | null = null;
    const watcher = { close: vi.fn() };
    vi.spyOn(fs, "watch").mockImplementation((_p, _opts, cb) => {
      watchCb = cb as () => void;
      return watcher as never;
    });

    const stream = new FakeStream();
    await daemonLogsStream({ logPath } as never, makeReq([], { follow: true, level: "error", n: 10 }) as never, stream as never);

    expect(stream.chunks).toEqual([{ level: "error", a: 2 }]);

    fs.writeFileSync(logPath, [
      JSON.stringify({ level: "info", a: 1 }),
      JSON.stringify({ level: "error", a: 2 }),
      JSON.stringify({ level: "error", a: 3 }),
      "",
    ].join("\n"));
    watchCb?.();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(stream.chunks).toContainEqual({ level: "error", a: 3 });

    fs.writeFileSync(logPath, JSON.stringify({ level: "error", a: 4 }) + "\n");
    watchCb?.();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(stream.chunks).toContainEqual({ level: "error", a: 4 });

    stream.close();
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("stops and restarts the daemon via timers", async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const stop = await daemonStop({} as never, makeReq([], { force: true }) as never);
    expect(stop).toEqual({ stopping: true, force: true });
    await vi.advanceTimersByTimeAsync(20);
    expect(exitSpy).toHaveBeenCalledWith(1);

    const restart = await daemonRestart({} as never, makeReq() as never);
    expect(restart).toEqual({ restarting: true });
    expect(daemonHandlerMocks.spawn).toHaveBeenCalledWith(process.execPath, [process.argv[1], "--daemon-internal"], expect.any(Object));
    await vi.advanceTimersByTimeAsync(200);
    expect(daemonHandlerMocks.shutdownDaemon).toHaveBeenCalled();

    vi.useRealTimers();
    exitSpy.mockRestore();
  });
});
