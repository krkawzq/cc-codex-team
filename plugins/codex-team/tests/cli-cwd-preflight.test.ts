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
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
  })),
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
      return "/tmp/.codex-team";
    }
  },
}));

import { runCli } from "../src/cli/run";

describe("CLI cwd preflight", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-cli-cwd-"));
    tempDirs.push(dir);
    return dir;
  }

  function mockDaemonSuccess(expectedMethod: string, result: unknown): void {
    let responseHandler: ((msg: Record<string, unknown>) => void) | undefined;
    const socket = {
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(() => socket),
      once: vi.fn(() => socket),
    };

    sockMocks.probeSock.mockResolvedValue(true);
    sockMocks.connectSock.mockResolvedValue(socket);
    sockMocks.onMessages.mockImplementation((_sock, handler) => {
      responseHandler = handler;
    });
    sockMocks.writeMessage.mockImplementation((_sock, req: { id: string; method: string; params: { flags?: Record<string, unknown> } }) => {
      expect(req.method).toBe(expectedMethod);
      setTimeout(() => {
        responseHandler?.({
          kind: "response",
          id: req.id,
          result,
        });
      }, 0);
    });
  }

  it("rejects session:new before daemon bootstrap when --cwd does not exist", async () => {
    const missing = path.join(os.tmpdir(), "codex-team-cli-cwd-missing");

    const code = await runCli(["-b", "token-1", "session", "new", "demo", "--cwd", missing]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"invalid_params\""));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining(`cwd '${missing}' does not exist`));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("rejects session:new before daemon bootstrap when --cwd points at a file", async () => {
    const dir = mkTmpDir();
    const target = path.join(dir, "not-a-dir");
    fs.writeFileSync(target, "stub");

    const code = await runCli(["-b", "token-1", "session", "new", "demo", "--cwd", target]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining(`cwd '${target}' is not a directory`));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("forwards session:new when --cwd points at an existing directory", async () => {
    const target = mkTmpDir();
    mockDaemonSuccess("session:new", {
      session: {
        name: "demo",
        thread_id: "th-1",
        state: "live",
        cwd: target,
      },
    });

    const code = await runCli(["-b", "token-1", "session", "new", "demo", "--cwd", target]);

    expect(code).toBe(0);
    expect(sockMocks.probeSock).toHaveBeenCalledTimes(1);
    expect(sockMocks.connectSock).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"ok\":true"));
  });

  it("rejects session:fork before daemon bootstrap when --cwd does not exist", async () => {
    const missing = path.join(os.tmpdir(), "codex-team-cli-cwd-missing-fork");

    const code = await runCli(["-b", "token-1", "session", "fork", "sess-1", "sess-2", "--cwd", missing]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining(`cwd '${missing}' does not exist`));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("rejects session:heal before daemon bootstrap when --cwd does not exist", async () => {
    const missing = path.join(os.tmpdir(), "codex-team-cli-cwd-missing-heal");

    const code = await runCli(["-b", "token-1", "session", "heal", "sess-1", "--cwd", missing]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining(`cwd '${missing}' does not exist`));
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("skips CLI cwd preflight for session:attach", async () => {
    const missing = path.join(os.tmpdir(), "codex-team-cli-cwd-missing-attach");
    mockDaemonSuccess("session:attach", {
      session: {
        name: "sess-1",
        thread_id: "th-1",
        state: "live",
      },
    });

    const code = await runCli(["-b", "token-1", "session", "attach", "sess-1", "--cwd", missing]);

    expect(code).toBe(0);
    expect(sockMocks.probeSock).toHaveBeenCalledTimes(1);
    expect(sockMocks.connectSock).toHaveBeenCalledTimes(1);
  });

  it("skips CLI cwd preflight for non-session creation methods", async () => {
    const missing = path.join(os.tmpdir(), "codex-team-cli-cwd-missing-status");
    mockDaemonSuccess("status", {
      session_count: 0,
    });

    const code = await runCli(["-b", "token-1", "status", "--cwd", missing]);

    expect(code).toBe(0);
    expect(sockMocks.probeSock).toHaveBeenCalledTimes(1);
    expect(sockMocks.connectSock).toHaveBeenCalledTimes(1);
  });
});
