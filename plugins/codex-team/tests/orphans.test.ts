import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-orphans-"));
}

describe("daemon/orphans", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains unresolved live pids for a later retry", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const warn = vi.fn();
    const info = vi.fn();
    const tracked11 = {
      pid: 11,
      nonce: "nonce-11",
      start_time: "start-11",
      tracked_at: "2025-01-01T00:00:00.000Z",
    };
    const tracked22 = {
      pid: 22,
      nonce: "nonce-22",
      start_time: "start-22",
      tracked_at: "2025-01-01T00:00:00.000Z",
    };

    vi.doMock("../src/daemon/processes", () => ({
      inspectCodexAppServerProcess: vi.fn((pid: number) => (pid === 11 ? "unknown" : "mismatch")),
      readProcessStartTime: vi.fn((pid: number) => {
        if (pid === 11) return "start-11";
        if (pid === 22) return "start-22";
        return null;
      }),
    }));
    vi.doMock("../src/logger", () => ({
      logger: { warn, info },
    }));

    const { readPidFile, reapOrphans, writePidFile } = await import("../src/daemon/orphans");
    writePidFile(dir, [tracked11, tracked22]);

    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && (pid === 11 || pid === 22)) return true;
      throw new Error(`unexpected kill(${pid}, ${String(signal)})`);
    }) as typeof process.kill);

    await expect(reapOrphans(dir)).resolves.toBe(0);
    expect(readPidFile(dir)).toEqual([tracked11]);
    expect(warn).toHaveBeenCalledWith(
      "unable to verify orphan codex pid; retaining for retry",
      expect.objectContaining({ pid: 11 }),
    );
  });

  it("verifies tracked start_time and escalates to SIGKILL when SIGTERM does not exit the process", async () => {
    vi.useFakeTimers();
    const dir = mkTmpDir();
    dirs.push(dir);
    let alive = true;
    const warn = vi.fn();
    const info = vi.fn();

    vi.doMock("../src/daemon/processes", () => ({
      inspectCodexAppServerProcess: vi.fn(() => "match"),
      readProcessStartTime: vi.fn(() => (alive ? "start-1" : null)),
    }));
    vi.doMock("../src/logger", () => ({
      logger: { warn, info },
    }));

    const { readPidFile, reapOrphans, writePidFile } = await import("../src/daemon/orphans");
    writePidFile(dir, [{
      pid: 4321,
      nonce: "nonce-1",
      start_time: "start-1",
      tracked_at: "2025-01-01T00:00:00.000Z",
    }]);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== 4321) return true;
      if (signal === 0) {
        if (!alive) {
          const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          throw err;
        }
        return true;
      }
      if (signal === "SIGTERM") return true;
      if (signal === "SIGKILL") {
        alive = false;
        return true;
      }
      return true;
    }) as typeof process.kill);

    const reapPromise = reapOrphans(dir);
    await vi.advanceTimersByTimeAsync(2600);

    await expect(reapPromise).resolves.toBe(1);
    expect(killSpy).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(4321, "SIGKILL");
    expect(readPidFile(dir)).toEqual([]);
    expect(info).toHaveBeenCalledWith("reaped orphan codex processes", { count: 1 });
  });
});
