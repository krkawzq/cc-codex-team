import fs from "node:fs";
import net from "node:net";
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

const DAEMON_STDERR_PATH_ENV = "CODEX_TEAM_DAEMON_STDERR_PATH";

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
    delete process.env[DAEMON_STDERR_PATH_ENV];
    process.env.HOME = originalHome;
    vi.doUnmock("../src/daemon/context");
    vi.doUnmock("../src/daemon/server");
    vi.doUnmock("../src/daemon/orphans");
    vi.doUnmock("../src/daemon/wire");
    vi.doUnmock("../src/daemon/processes");
    vi.resetModules();
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

  it("translates pre-spawn EROFS data-dir failures into data_dir_not_writable", async () => {
    sockMocks.probeSock.mockResolvedValue(false);
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
    });

    try {
      const code = await runCli(["-b", "token-1", "status"]);

      expect(code).toBe(1);
      expect(processMocks.spawn).not.toHaveBeenCalled();
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"data_dir_not_writable\""));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining(`"${"data_dir"}":"${path.join(tempHome, ".codex-team")}"`));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"errno\":\"EROFS\""));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("CODEX_TEAM_DATA_DIR"));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("codex-team doctor"));
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it("translates pre-spawn EACCES data-dir failures into data_dir_not_writable", async () => {
    sockMocks.probeSock.mockResolvedValue(false);
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    try {
      const code = await runCli(["-b", "token-1", "status"]);

      expect(code).toBe(1);
      expect(processMocks.spawn).not.toHaveBeenCalled();
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"data_dir_not_writable\""));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"errno\":\"EACCES\""));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("CODEX_TEAM_DATA_DIR"));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("codex-team doctor"));
    } finally {
      accessSpy.mockRestore();
    }
  });

  it("writes a raw socket_bind_denied diagnostic during daemon preflight", async () => {
    vi.resetModules();
    const stderrPath = path.join(tempHome, ".codex-team", "daemon-spawn.stderr");
    process.env[DAEMON_STDERR_PATH_ENV] = stderrPath;

    const buildContext = vi.fn(() => ({
      sockPath: path.join(tempHome, ".codex-team", "daemon.sock"),
      dataDir: path.join(tempHome, ".codex-team"),
      config: { getEffective: () => 6 },
      users: { list: () => [] },
      sessions: { listLive: () => [] },
      activity: { lastActivityAt: new Date(), touch() {} },
    }));
    const startServer = vi.fn();
    vi.doMock("../src/daemon/context", () => ({ buildContext }));
    vi.doMock("../src/daemon/server", () => ({ startServer }));
    vi.doMock("../src/daemon/orphans", () => ({ reapOrphans: vi.fn() }));
    vi.doMock("../src/daemon/wire", () => ({ wireDaemonEvents: vi.fn() }));
    vi.doMock("../src/daemon/processes", () => ({ isLikelyCodexTeamDaemonProcess: vi.fn(() => true) }));

    const fakeServer = {
      once: vi.fn(() => fakeServer),
      off: vi.fn(() => fakeServer),
      listen: vi.fn(() => {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }),
      close: vi.fn((callback?: (err?: Error) => void) => {
        callback?.();
        return fakeServer;
      }),
    };
    const createServerSpy = vi.spyOn(net, "createServer").mockImplementation(() => fakeServer as unknown as net.Server);

    const { runDaemon } = await import("../src/daemon/run");
    const code = await runDaemon();
    createServerSpy.mockRestore();

    expect(code).toBe(1);
    expect(startServer).not.toHaveBeenCalled();
    const payload = JSON.parse(fs.readFileSync(stderrPath, "utf8").trim()) as {
      kind: string;
      errno: string;
      msg: string;
      probed_path: string;
    };
    expect(payload.kind).toBe("socket_bind_denied");
    expect(payload.errno).toBe("EPERM");
    expect(payload.msg).toBe("socket bind denied");
    expect(payload.probed_path).toContain(path.join(tempHome, ".codex-team"));
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
            `${JSON.stringify({
              ts: "2026-04-23T00:00:00.000Z",
              level: "error",
              msg: "socket bind denied",
              kind: "socket_bind_denied",
              errno: "EPERM",
              probed_path: "/tmp/codex-team-probe.sock",
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
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"errno\":\"EPERM\""));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"probed_path\":\"/tmp/codex-team-probe.sock\""));
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("codex-team cannot bind a local IPC socket here"),
    );
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining("\"daemon_unreachable\""));
  });

  it("adds a doctor suggested_action when daemon spawn fails for a non-data-dir reason", async () => {
    sockMocks.probeSock.mockResolvedValue(false);
    processMocks.spawn.mockImplementationOnce(() => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    });

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"daemon_unreachable\""));
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"suggested_action\":\"run `codex-team doctor` to diagnose\""),
    );
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining("\"data_dir_not_writable\""));
  });

  it("adds a doctor suggested_action when the daemon exits without bootstrap stderr", async () => {
    sockMocks.probeSock.mockResolvedValue(false);
    const firstChild = makeChildProcess();
    const secondChild = makeChildProcess();

    processMocks.spawn
      .mockImplementationOnce(() => firstChild)
      .mockImplementationOnce(() => {
        setTimeout(() => {
          secondChild.emitExit(1);
        }, 0);
        return secondChild;
      });

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"daemon_unreachable\""));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"exit_code\":1"));
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"suggested_action\":\"run `codex-team doctor` to diagnose\""),
    );
  });

  it("still succeeds when the daemon becomes ready on the retry path", async () => {
    let responseHandler: ((msg: Record<string, unknown>) => void) | undefined;
    const socket = {
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(() => socket),
      once: vi.fn(() => socket),
    };

    sockMocks.probeSock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    sockMocks.connectSock.mockResolvedValue(socket);
    sockMocks.onMessages.mockImplementation((_sock, handler) => {
      responseHandler = handler;
    });
    sockMocks.writeMessage.mockImplementation((_sock, req: { id: string }) => {
      setTimeout(() => {
        responseHandler?.({
          kind: "response",
          id: req.id,
          result: {
            session_count: 0,
          },
        });
      }, 0);
    });

    const firstChild = makeChildProcess();
    const secondChild = makeChildProcess();
    processMocks.spawn
      .mockImplementationOnce(() => firstChild)
      .mockImplementationOnce(() => secondChild);

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(0);
    expect(processMocks.spawn).toHaveBeenCalledTimes(2);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"ok\":true"));
  });

  it("auto-cleans stale pid and sock artifacts and spawns a fresh daemon", async () => {
    // probeSock: first call false (initial check), later true (daemon alive)
    let probeSeq = 0;
    sockMocks.probeSock.mockImplementation(async () => ++probeSeq > 1);
    const dataDir = path.join(tempHome, ".codex-team");
    fs.mkdirSync(dataDir, { recursive: true });
    const staleSockPath = path.join(dataDir, "daemon.sock");
    const stalePidPath = path.join(dataDir, "daemon.pid");
    fs.writeFileSync(stalePidPath, JSON.stringify({ pid: 999999 }));
    fs.writeFileSync(staleSockPath, "");
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === 999999 && signal === 0) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill);

    let responseHandler: ((m: { kind: string; id: string; result?: unknown }) => void) | null = null;
    sockMocks.onMessages.mockImplementation((_sock, handler: (msg: { kind: string; id: string; result?: unknown }) => void) => {
      responseHandler = handler;
    });
    sockMocks.writeMessage.mockImplementation((_sock, req: { id: string }) => {
      setTimeout(() => {
        responseHandler?.({ kind: "response", id: req.id, result: { session_count: 0 } });
      }, 0);
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const child = makeChildProcess();
    processMocks.spawn.mockImplementationOnce(() => child);

    const code = await runCli(["-b", "token-1", "status"]);

    expect(code).toBe(0);
    // pidfile + sock were cleaned up, then daemon was spawned
    expect(fs.existsSync(stalePidPath)).toBe(false);
    expect(fs.existsSync(staleSockPath)).toBe(false);
    expect(processMocks.spawn).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("auto-cleanup"));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("999999"));
  });
});
