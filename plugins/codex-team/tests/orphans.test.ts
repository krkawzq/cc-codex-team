import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-orphans-"));
}

describe("daemon/orphans", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifies tracked start_time and escalates to SIGKILL when SIGTERM does not exit the process", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    let alive = true;

    vi.doMock("../src/daemon/processes", () => ({
      isLikelyCodexAppServerProcess: vi.fn(() => true),
      readProcessStartTime: vi.fn(() => (alive ? "start-1" : null)),
    }));

    const { reapOrphans, writePidFile } = await import("../src/daemon/orphans");
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
  });
});
