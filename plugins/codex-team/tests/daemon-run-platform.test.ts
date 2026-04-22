import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runMocks = vi.hoisted(() => ({
  buildContext: vi.fn(),
  startServer: vi.fn(),
  probeSock: vi.fn(),
  unlinkSockIfStale: vi.fn(),
  shutdownDaemon: vi.fn().mockResolvedValue(undefined),
  wireDaemonEvents: vi.fn(),
  reapOrphans: vi.fn(),
}));

vi.mock("../src/daemon/context", () => ({
  buildContext: runMocks.buildContext,
}));
vi.mock("../src/daemon/server", () => ({
  startServer: runMocks.startServer,
}));
vi.mock("../src/ipc/sock", () => ({
  probeSock: runMocks.probeSock,
  unlinkSockIfStale: runMocks.unlinkSockIfStale,
}));
vi.mock("../src/daemon/shutdown", () => ({
  shutdownDaemon: runMocks.shutdownDaemon,
}));
vi.mock("../src/daemon/wire", () => ({
  wireDaemonEvents: runMocks.wireDaemonEvents,
}));
vi.mock("../src/daemon/orphans", () => ({
  reapOrphans: runMocks.reapOrphans,
}));

function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> | T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  const restore = () => {
    if (original) Object.defineProperty(process, "platform", original);
  };
  try {
    const result = fn();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>).finally(restore);
    }
    restore();
    return result;
  } catch (e) {
    restore();
    throw e;
  }
}

describe("daemon/run platform behavior", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  it("uses an exclusive pidfile lock and can recover from a stale pidfile", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-run-"));
    dirs.push(dir);
    const pidPath = path.join(dir, "daemon.pid");
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, "stale");
    const staleTime = Date.now() - 6000;
    fs.utimesSync(pidPath, staleTime / 1000, staleTime / 1000);

    runMocks.buildContext.mockReturnValue({
      sockPath: path.join(dir, "daemon.sock"),
      dataDir: dir,
      config: { getEffective: () => 6 },
      users: { list: () => [] },
      sessions: { listLive: () => [] },
      activity: { lastActivityAt: new Date(), touch() {} },
    });
    runMocks.probeSock.mockResolvedValue(false);
    runMocks.startServer.mockResolvedValue({});

    const { runDaemon } = await import("../src/daemon/run");
    void runDaemon();
    await vi.advanceTimersByTimeAsync(350);

    expect(runMocks.startServer).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(pidPath, "utf8")).pid).toBe(process.pid);
  });

  it("registers SIGBREAK shutdown handling on Windows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-run-"));
    dirs.push(dir);
    const sockPath = path.join(dir, "daemon.sock");
    runMocks.buildContext.mockReturnValue({
      sockPath,
      dataDir: dir,
      config: { getEffective: () => 6 },
      users: { list: () => [] },
      sessions: { listLive: () => [] },
      activity: { lastActivityAt: new Date(), touch() {} },
    });
    runMocks.probeSock.mockResolvedValue(false);
    runMocks.startServer.mockResolvedValue({});

    const { runDaemon } = await import("../src/daemon/run");
    await withPlatform("win32", async () => {
      void runDaemon();
      await vi.advanceTimersByTimeAsync(350);
      process.emit("SIGBREAK");
    });

    expect(runMocks.shutdownDaemon).toHaveBeenCalledWith(expect.any(Object), "SIGBREAK");
  });
});
