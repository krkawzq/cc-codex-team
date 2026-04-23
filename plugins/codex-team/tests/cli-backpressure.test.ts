import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockMocks = vi.hoisted(() => ({
  connectSock: vi.fn(),
  probeSock: vi.fn(),
  writeMessage: vi.fn(),
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

vi.mock("../src/ipc/sock", async () => {
  const actual = await vi.importActual<typeof import("../src/ipc/sock")>("../src/ipc/sock");
  return {
    ...actual,
    connectSock: sockMocks.connectSock,
    probeSock: sockMocks.probeSock,
    writeMessage: sockMocks.writeMessage,
  };
});

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

class FakeSocket extends EventEmitter {
  pause = vi.fn();
  resume = vi.fn();
  end = vi.fn(() => {
    this.emit("end");
    return this;
  });
  destroy = vi.fn((_error?: Error) => {
    this.emit("close");
    return this;
  });
}

describe("runCli stream backpressure", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CODEX_TEAM_CLI_STDOUT_MAX_BYTES = "220";
    let firstWrite = true;
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      void chunk;
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    delete process.env.CODEX_TEAM_CLI_STDOUT_MAX_BYTES;
  });

  it("pauses and resumes socket reads when streaming stdout exceeds the byte ceiling", async () => {
    const socket = new FakeSocket();
    sockMocks.probeSock.mockResolvedValue(true);
    sockMocks.connectSock.mockResolvedValue(socket);
    sockMocks.writeMessage.mockImplementation((sock: FakeSocket, msg: { kind: string; id?: string; method?: string }) => {
      if (msg.kind !== "request" || !msg.id) return;
      queueMicrotask(() => {
        const frames = Array.from({ length: 6 }, (_entry, index) => ({
          kind: "stream_chunk",
          id: msg.id,
          data: { seq: index, payload: "x".repeat(72) },
        }));
        frames.push({ kind: "stream_end", id: msg.id });
        const payload = frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
        sock.emit("data", Buffer.from(payload));
      });
    });

    const pending = runCli(["daemon", "logs"]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.pause).toHaveBeenCalledTimes(1);
    expect(socket.resume).not.toHaveBeenCalled();

    process.stdout.emit("drain");
    const code = await pending;

    expect(code).toBe(0);
    expect(socket.resume).toHaveBeenCalledTimes(1);
  });
});
