import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockMocks = vi.hoisted(() => ({
  connectSock: vi.fn(),
  probeSock: vi.fn(),
  writeMessage: vi.fn(),
  onMessages: vi.fn(),
}));

const processMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
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

    resolvedDataDir() {
      return path.join(process.env.HOME ?? os.tmpdir(), ".codex-team");
    }
  },
}));

import { runCli } from "../src/cli/run";

function makeChildProcess() {
  const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  const child = {
    unref: vi.fn(),
    once: vi.fn((event: string, listener: (code: number | null, signal: NodeJS.Signals | null) => void) => {
      if (event === "exit") exitListeners.add(listener);
      return child;
    }),
    off: vi.fn((event: string, listener: (code: number | null, signal: NodeJS.Signals | null) => void) => {
      if (event === "exit") exitListeners.delete(listener);
      return child;
    }),
    removeListener: vi.fn((event: string, listener: (code: number | null, signal: NodeJS.Signals | null) => void) => {
      if (event === "exit") exitListeners.delete(listener);
      return child;
    }),
    emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
      for (const listener of Array.from(exitListeners)) listener(code, signal);
    },
  };
  return child;
}

describe("daemon spawn stderr retry", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tempHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-home-"));
    process.env.HOME = tempHome;
    processMocks.spawn.mockImplementation(() => makeChildProcess());
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("retries once with stderr wired to a stable file", async () => {
    sockMocks.probeSock.mockResolvedValue(false);

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(1);
    expect(processMocks.spawn).toHaveBeenCalledTimes(2);

    const firstCall = processMocks.spawn.mock.calls[0];
    expect(firstCall?.[1]).toEqual([
      process.argv[1],
      "--daemon-internal",
    ]);
    expect(firstCall?.[2]).toMatchObject({
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });

    const secondCall = processMocks.spawn.mock.calls[1];
    expect(secondCall?.[1]).toEqual([
      process.argv[1],
      "--daemon-internal",
      "--stderr-to",
      path.join(tempHome, ".codex-team", "daemon-spawn.stderr"),
    ]);
    expect(secondCall?.[2]).toMatchObject({
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", expect.any(Number)],
    });
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("daemon-spawn.stderr"));
  });

  it("surfaces early bootstrap stderr and translates socket bind denial", async () => {
    sockMocks.probeSock.mockResolvedValue(false);
    const firstChild = makeChildProcess();
    const secondChild = makeChildProcess();

    processMocks.spawn
      .mockImplementationOnce(() => firstChild)
      .mockImplementationOnce((_command: string, args: string[]) => {
        const stderrPath = args[3]!;
        setTimeout(() => {
          fs.mkdirSync(path.dirname(stderrPath), { recursive: true });
          fs.writeFileSync(
            stderrPath,
            `[codex-team-daemon-bootstrap] ${JSON.stringify({
              code: "socket_bind_denied",
              message: "local Unix socket bind denied by environment (error: EPERM). codex-team requires socket bind for daemon IPC - likely running in a restricted sandbox.",
              data: {
                error: "EPERM",
                suggested_action: "run `codex-team doctor` to diagnose",
              },
            })}\n`,
          );
          secondChild.emitExit(1);
        }, 0);
        return secondChild;
      });

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"socket_bind_denied\""));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"bootstrap_stderr\""));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("run `codex-team doctor` to diagnose"));
  });

  it("fails fast on stale pid and sock artifacts without respawning", async () => {
    sockMocks.probeSock.mockResolvedValue(false);
    const dataDir = path.join(tempHome, ".codex-team");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "daemon.pid"), JSON.stringify({ pid: 999999 }));
    fs.writeFileSync(path.join(dataDir, "daemon.sock"), "");
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === 999999 && signal === 0) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill);

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(1);
    expect(processMocks.spawn).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("stale daemon.pid + daemon.sock"));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"pid\":999999"));
  });
});
