import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgs } from "../src/cli/args";
import { decodeToken, defaultDataDir, defaultSockPath, encodeToken, expandUserPath, homeDir, isFilesystemSockPath, isNamedPipePath, normalizeSockPath } from "../src/paths";

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

describe("paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encodes tokens as URL-safe base64 and decodes losslessly", () => {
    const token = "abc+/=汉字 token";
    const encoded = encodeToken(token);

    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(decodeToken(encoded)).toBe(token);
  });

  it("normalizes Windows sock paths to named pipes", () => {
    const normalized = normalizeSockPath("C:\\tmp\\daemon.sock", "win32");
    expect(isNamedPipePath(normalized)).toBe(true);
    expect(isFilesystemSockPath("C:\\tmp\\daemon.sock", "win32")).toBe(false);
    expect(normalizeSockPath("\\\\.\\pipe\\custom-pipe", "win32")).toBe("\\\\.\\pipe\\custom-pipe");
  });

  it("uses a short tmpdir fallback for overly long Unix socket paths", () => {
    const longDataDir = `/tmp/${"a".repeat(200)}`;
    const sockPath = defaultSockPath(longDataDir, "darwin");

    expect(sockPath).toContain("codex-team-");
    expect(sockPath.endsWith(".sock")).toBe(true);
    expect(Buffer.byteLength(sockPath, "utf8")).toBeLessThanOrEqual(90);
  });

  it("uses a named pipe default on Windows", () => {
    expect(isNamedPipePath(defaultSockPath("C:\\Users\\me\\.codex-team", "win32"))).toBe(true);
  });

  it("prefers the Windows home directory over a POSIX-style HOME override", () => {
    vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\native");
    const originalHome = process.env.HOME;
    process.env.HOME = "/c/Users/msys";

    try {
      const resolved = withPlatform("win32", () => homeDir());
      expect(resolved).toBe("C:\\Users\\native");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("expands leading ~ for both POSIX and Windows paths", () => {
    expect(expandUserPath("~/logs/daemon.log", "darwin", "/Users/tester")).toBe("/Users/tester/logs/daemon.log");
    expect(expandUserPath("~\\logs\\daemon.log", "win32", "C:\\Users\\tester")).toBe("C:\\Users\\tester\\logs\\daemon.log");
  });

  it("rejects unsupported ~user path forms", () => {
    expect(() => expandUserPath("~alice/.codex-team", "darwin", "/Users/tester")).toThrow(/only '~' is supported/i);
  });

  it("expands CODEX_TEAM_DATA_DIR before deriving default paths", () => {
    const originalDataDir = process.env.CODEX_TEAM_DATA_DIR;
    const originalHome = process.env.HOME;
    process.env.CODEX_TEAM_DATA_DIR = "~/.codex-team-alt";
    process.env.HOME = "/home/tester";

    try {
      expect(defaultDataDir()).toBe("/home/tester/.codex-team-alt");
      expect(defaultSockPath()).toBe(path.join("/home/tester/.codex-team-alt", "daemon.sock"));
    } finally {
      if (originalDataDir === undefined) delete process.env.CODEX_TEAM_DATA_DIR;
      else process.env.CODEX_TEAM_DATA_DIR = originalDataDir;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});

describe("parseArgs", () => {
  it("parses globals, repeated flags, and negative numbers correctly", () => {
    const parsed = parseArgs([
      "-b", "token-1",
      "message", "history", "sess-1",
      "--attach", "/tmp/a.png",
      "--attach", "/tmp/b.png",
      "--since", "-3",
      "--format=markdown",
    ]);

    expect(parsed.bearer).toBe("token-1");
    expect(parsed.commandPath).toEqual(["message", "history"]);
    expect(parsed.positionals).toEqual(["sess-1"]);
    expect(parsed.flags.attach).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(parsed.flags.since).toBe("-3");
    expect(parsed.flags.format).toBe("markdown");
  });

  it("reports unknown commands and missing global flag values", () => {
    expect(parseArgs(["bogus"]).unknown).toMatch("unknown command");
    expect(parseArgs(["-b"]).unknown).toBe("flag -b requires a value");
  });

  it("resolves subgroup help paths and skips positional validation", () => {
    const subgroup = parseArgs(["daemon", "config", "--help"]);
    expect(subgroup.help).toBe(true);
    expect(subgroup.commandPath).toEqual(["daemon", "config"]);
    expect(subgroup.unknown).toBeNull();

    const leaf = parseArgs(["message", "approval", "--help"]);
    expect(leaf.help).toBe(true);
    expect(leaf.commandPath).toEqual(["message", "approval"]);
    expect(leaf.positionals).toEqual([]);
    expect(leaf.unknown).toBeNull();
  });

  it("treats --help as a command-path terminator", () => {
    const daemonGroup = parseArgs(["daemon", "--help", "user", "create"]);
    expect(daemonGroup.help).toBe(true);
    expect(daemonGroup.commandPath).toEqual(["daemon"]);
    expect(daemonGroup.positionals).toEqual([]);
    expect(daemonGroup.unknown).toBeNull();

    const sessionGroup = parseArgs(["session", "--help", "new"]);
    expect(sessionGroup.help).toBe(true);
    expect(sessionGroup.commandPath).toEqual(["session"]);
    expect(sessionGroup.positionals).toEqual([]);
    expect(sessionGroup.unknown).toBeNull();

    const sessionLeaf = parseArgs(["session", "new", "--help"]);
    expect(sessionLeaf.help).toBe(true);
    expect(sessionLeaf.commandPath).toEqual(["session", "new"]);
    expect(sessionLeaf.positionals).toEqual([]);
    expect(sessionLeaf.unknown).toBeNull();
  });
});
