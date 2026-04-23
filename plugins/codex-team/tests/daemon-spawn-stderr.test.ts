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
  })),
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
  },
}));

import { runCli } from "../src/cli/run";

describe("daemon spawn stderr retry", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tempHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-home-"));
    process.env.HOME = tempHome;
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
});
