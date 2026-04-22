import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const orphanMocks = vi.hoisted(() => ({
  inspectCodexAppServerProcess: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../src/daemon/processes", () => ({
  inspectCodexAppServerProcess: orphanMocks.inspectCodexAppServerProcess,
}));

vi.mock("../src/logger", () => ({
  logger: {
    warn: orphanMocks.warn,
    info: orphanMocks.info,
  },
}));

import { readPidFile, reapOrphans, writePidFile } from "../src/daemon/orphans";

describe("daemon/orphans", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains unresolved live pids for a later retry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-orphans-"));
    dirs.push(dir);
    writePidFile(dir, [11, 22]);

    orphanMocks.inspectCodexAppServerProcess
      .mockImplementationOnce(() => "unknown")
      .mockImplementationOnce(() => "mismatch");

    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && (pid === 11 || pid === 22)) return true;
      throw new Error(`unexpected kill(${pid}, ${String(signal)})`);
    }) as typeof process.kill);

    expect(reapOrphans(dir)).toBe(0);
    expect(readPidFile(dir)).toEqual([11]);
    expect(orphanMocks.warn).toHaveBeenCalledWith(
      "unable to verify orphan codex pid; retaining for retry",
      expect.objectContaining({ pid: 11 }),
    );
  });

  it("drops successfully terminated codex app-server pids from the retry file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-orphans-"));
    dirs.push(dir);
    writePidFile(dir, [33]);

    orphanMocks.inspectCodexAppServerProcess.mockReturnValue("match");

    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid !== 33) throw new Error("unexpected pid");
      if (signal === 0 || signal === "SIGTERM") return true;
      throw new Error(`unexpected signal ${String(signal)}`);
    }) as typeof process.kill);

    expect(reapOrphans(dir)).toBe(1);
    expect(readPidFile(dir)).toEqual([]);
    expect(orphanMocks.info).toHaveBeenCalledWith("reaped orphan codex processes", { count: 1 });
  });
});
