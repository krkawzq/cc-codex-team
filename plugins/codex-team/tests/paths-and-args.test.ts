import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/cli/args";
import { decodeToken, defaultSockPath, encodeToken, isFilesystemSockPath, isNamedPipePath, normalizeSockPath } from "../src/paths";

describe("paths", () => {
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
});
