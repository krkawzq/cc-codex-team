import { afterEach, describe, expect, it, vi } from "vitest";

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

describe("daemon/processes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reads /proc cmdline on linux", async () => {
    vi.doMock("node:fs", () => ({
      default: {
        readFileSync: vi.fn().mockReturnValue(Buffer.from("codex\0app-server\0--listen\0stdio://\0")),
      },
      readFileSync: vi.fn().mockReturnValue(Buffer.from("codex\0app-server\0--listen\0stdio://\0")),
    }));
    const { readProcessCommandLine } = await import("../src/daemon/processes");
    const cmd = withPlatform("linux", () => readProcessCommandLine(123));

    expect(cmd).toBe("codex app-server --listen stdio://");
  });

  it("uses ps on darwin/freebsd", async () => {
    vi.doMock("node:child_process", () => ({
      default: {
        execFileSync: vi.fn().mockReturnValue("node /tmp/main.js --daemon-internal\n"),
      },
      execFileSync: vi.fn().mockReturnValue("node /tmp/main.js --daemon-internal\n"),
    }));
    const { readProcessCommandLine } = await import("../src/daemon/processes");
    const cmd = withPlatform("darwin", () => readProcessCommandLine(456));

    expect(cmd).toBe("node /tmp/main.js --daemon-internal");
  });

  it("returns null on unsupported platforms", async () => {
    const { readProcessCommandLine } = await import("../src/daemon/processes");
    const cmd = withPlatform("aix" as NodeJS.Platform, () => readProcessCommandLine(789));
    expect(cmd).toBeNull();
  });

  it("classifies codex app-server and daemon commands by substring", async () => {
    vi.doMock("node:fs", () => ({
      default: {
        readFileSync: vi.fn().mockReturnValue(Buffer.from("codex-cli-bin\0app-server\0")),
      },
      readFileSync: vi.fn().mockReturnValue(Buffer.from("codex-cli-bin\0app-server\0")),
    }));
    const linuxModule = await import("../src/daemon/processes");
    expect(withPlatform("linux", () => linuxModule.isLikelyCodexAppServerProcess(1))).toBe(true);

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      default: {
        execFileSync: vi.fn().mockReturnValue("node main.js --daemon-internal\n"),
      },
      execFileSync: vi.fn().mockReturnValue("node main.js --daemon-internal\n"),
    }));
    const darwinModule = await import("../src/daemon/processes");
    expect(withPlatform("darwin", () => darwinModule.isLikelyCodexTeamDaemonProcess(2))).toBe(true);
  });

  it("uses PowerShell-based process inspection on Windows", async () => {
    vi.doMock("node:child_process", () => ({
      default: {
        execFileSync: vi.fn().mockReturnValue("codex app-server --listen stdio://\n"),
      },
      execFileSync: vi.fn().mockReturnValue("codex app-server --listen stdio://\n"),
    }));
    const mod = await import("../src/daemon/processes");

    expect(withPlatform("win32", () => mod.readProcessCommandLine(77))).toBe("codex app-server --listen stdio://");
    expect(withPlatform("win32", () => mod.isLikelyCodexAppServerProcess(77))).toBe(true);
  });

  it("falls back to wmic on Windows when PowerShell is unavailable", async () => {
    const execFileSync = vi.fn()
      .mockImplementationOnce(() => { throw new Error("no powershell"); })
      .mockImplementationOnce(() => { throw new Error("no powershell"); })
      .mockImplementationOnce(() => { throw new Error("no pwsh"); })
      .mockImplementationOnce(() => "CommandLine=codex app-server --listen stdio://\r\n");
    vi.doMock("node:child_process", () => ({
      default: { execFileSync },
      execFileSync,
    }));
    const mod = await import("../src/daemon/processes");

    expect(withPlatform("win32", () => mod.readProcessCommandLine(88))).toBe("codex app-server --listen stdio://");
  });

  it("falls back to tasklist on Windows when richer inspection is unavailable", async () => {
    const execFileSync = vi.fn()
      .mockImplementationOnce(() => { throw new Error("no powershell"); })
      .mockImplementationOnce(() => { throw new Error("no powershell"); })
      .mockImplementationOnce(() => { throw new Error("no pwsh"); })
      .mockImplementationOnce(() => { throw new Error("no wmic"); })
      .mockImplementationOnce(() => "Image Name:   codex.exe\r\nPID:          99\r\n");
    vi.doMock("node:child_process", () => ({
      default: { execFileSync },
      execFileSync,
    }));
    const mod = await import("../src/daemon/processes");

    expect(withPlatform("win32", () => mod.readProcessCommandLine(99))).toBe("codex.exe");
    expect(withPlatform("win32", () => mod.inspectCodexAppServerProcess(99))).toBe("unknown");
  });
});
