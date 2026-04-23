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
      "--truncate", "4096",
      "--experimental-tools", "ask-user-question,request-permissions",
    ]);

    expect(parsed.bearer).toBe("token-1");
    expect(parsed.commandPath).toEqual(["message", "history"]);
    expect(parsed.positionals).toEqual(["sess-1"]);
    expect(parsed.flags.attach).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(parsed.flags.since).toBe("-3");
    expect(parsed.flags.format).toBe("markdown");
    expect(parsed.flags.truncate).toBe("4096");
    expect(parsed.flags["experimental-tools"]).toBe("ask-user-question,request-permissions");
  });

  it("reports unknown commands and missing global flag values", () => {
    expect(parseArgs(["bogus"]).unknown).toMatch("unknown command");
    expect(parseArgs(["-b"]).unknown).toBe("flag -b requires a value");
  });

  it("parses cursor commands and event-id flags", () => {
    const parsed = parseArgs([
      "-b", "token-1",
      "cursor", "save", "audit-tail",
      "--event-id", "evt-9",
    ]);

    expect(parsed.bearer).toBe("token-1");
    expect(parsed.commandPath).toEqual(["cursor", "save"]);
    expect(parsed.positionals).toEqual(["audit-tail"]);
    expect(parsed.flags["event-id"]).toBe("evt-9");
  });

  it("parses global value flags in --flag=value form", () => {
    const parsed = parseArgs([
      "--bearer=token-1",
      "--daemon-sock=/tmp/codex-team.sock",
      "status",
    ]);

    expect(parsed.bearer).toBe("token-1");
    expect(parsed.daemonSock).toBe("/tmp/codex-team.sock");
    expect(parsed.commandPath).toEqual(["status"]);
  });

  it("parses monitor cursor flags alongside other monitor options", () => {
    const parsed = parseArgs([
      "-b", "token-1",
      "monitor", "events",
      "--cursor", "audit-tail",
      "--stream",
    ]);

    expect(parsed.commandPath).toEqual(["monitor", "events"]);
    expect(parsed.flags.cursor).toBe("audit-tail");
    expect(parsed.flags.stream).toBe(true);
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

    const cursor = parseArgs(["cursor", "--help"]);
    expect(cursor.help).toBe(true);
    expect(cursor.commandPath).toEqual(["cursor"]);
    expect(cursor.positionals).toEqual([]);
    expect(cursor.unknown).toBeNull();
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

  it("parses the new session health/heal and message wait commands", () => {
    const health = parseArgs(["-b", "token-1", "session", "health", "sess-1"]);
    expect(health.commandPath).toEqual(["session", "health"]);
    expect(health.positionals).toEqual(["sess-1"]);

    const heal = parseArgs(["-b", "token-1", "session", "heal", "sess-1", "--force"]);
    expect(heal.commandPath).toEqual(["session", "heal"]);
    expect(heal.flags.force).toBe(true);

    const wait = parseArgs(["-b", "token-1", "message", "wait", "sess-1", "--for", "turn-1", "--timeout", "30"]);
    expect(wait.commandPath).toEqual(["message", "wait"]);
    expect(wait.positionals).toEqual(["sess-1"]);
    expect(wait.flags.for).toBe("turn-1");
    expect(wait.flags.timeout).toBe("30");
  });

  it("parses the session archive, unarchive, rename, and rollback lifecycle commands", () => {
    const archive = parseArgs(["-b", "token-1", "session", "archive", "sess-1", "--and-detach"]);
    expect(archive.commandPath).toEqual(["session", "archive"]);
    expect(archive.positionals).toEqual(["sess-1"]);
    expect(archive.flags["and-detach"]).toBe(true);

    const unarchive = parseArgs(["-b", "token-1", "session", "unarchive", "th-1"]);
    expect(unarchive.commandPath).toEqual(["session", "unarchive"]);
    expect(unarchive.positionals).toEqual(["th-1"]);

    const rename = parseArgs(["-b", "token-1", "session", "rename", "th-1", "audit", "--detached-ok"]);
    expect(rename.commandPath).toEqual(["session", "rename"]);
    expect(rename.positionals).toEqual(["th-1", "audit"]);
    expect(rename.flags["detached-ok"]).toBe(true);

    const rollback = parseArgs(["-b", "token-1", "session", "rollback", "audit", "--to-turn", "turn-1", "--detach-after"]);
    expect(rollback.commandPath).toEqual(["session", "rollback"]);
    expect(rollback.positionals).toEqual(["audit"]);
    expect(rollback.flags["to-turn"]).toBe("turn-1");
    expect(rollback.flags["detach-after"]).toBe(true);
  });

  it("treats --short and --full as mutually exclusive output modes", () => {
    const parsed = parseArgs(["-b", "token-1", "status", "--short", "--full"]);

    expect(parsed.commandPath).toEqual(["status"]);
    expect(parsed.unknown).toBe("--short and --full are mutually exclusive");
  });
});
