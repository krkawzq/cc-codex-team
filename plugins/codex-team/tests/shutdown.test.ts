import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("shutdownDaemon", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("shuts down pool/events and schedules process exit", async () => {
    vi.useFakeTimers();
    const unlinkSync = vi.spyOn(fs, "unlinkSync").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { shutdownDaemon } = await import("../src/daemon/shutdown");

    const ctx = {
      pool: { shutdown: vi.fn().mockResolvedValue(undefined) },
      sessions: { flush: vi.fn().mockResolvedValue(undefined) },
      events: { flush: vi.fn().mockResolvedValue(undefined) },
      sockPath: "/tmp/daemon.sock",
      dataDir: "/tmp/data",
    };

    await shutdownDaemon(ctx as never, "test reason", 7);
    await vi.advanceTimersByTimeAsync(20);

    expect(ctx.pool.shutdown).toHaveBeenCalledTimes(1);
    expect(ctx.sessions.flush).toHaveBeenCalledTimes(1);
    expect(ctx.events.flush).toHaveBeenCalledTimes(1);
    expect(unlinkSync).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(7);

    vi.useRealTimers();
    exitSpy.mockRestore();
    unlinkSync.mockRestore();
  });
});
