import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ipcAddressFromPath, ipcConnect, ipcListen, ipcReady, removeStaleIpcArtifact } from "../src/platform";
import { readFallbackClientEnv, writeHookEnvExports } from "../src/platform/env";
import { resolveConfigDir, resolveDataDir } from "../src/platform/paths";
import { whichExecutable } from "../src/platform/which";

test("platform ipc wraps a local socket endpoint", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-platform-ipc-"));
  const address = ipcAddressFromPath(
    process.platform === "win32"
      ? `\\\\.\\pipe\\codex-team-test-${process.pid}-${Date.now()}`
      : path.join(tempDir, "daemon.sock"),
  );
  await removeStaleIpcArtifact(address);
  const server = await ipcListen(address, (socket: net.Socket) => {
    socket.once("data", (chunk) => {
      socket.write(chunk);
    });
  });
  try {
    assert.equal(await ipcReady(address), true);
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = ipcConnect(address);
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.once("connect", () => socket.write("ping"));
      socket.once("data", (chunk) => {
        socket.end();
        resolve(String(chunk));
      });
    });
    assert.equal(echoed, "ping");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeStaleIpcArtifact(address);
  }
});

test("platform env writes and reads fallback client env", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-platform-env-"));
  writeHookEnvExports(
    {
      CODEX_TEAM_WORKSPACE: "proj-test",
      CODEX_TEAM_CLIENT_ID: "c-test",
      CODEX_TEAM_SESSION_ID: "sess-test",
      CODEX_TEAM_PROJECT_DIR: tempDir,
    },
    tempDir,
  );
  assert.deepEqual(readFallbackClientEnv(tempDir), {
    CODEX_TEAM_WORKSPACE: "proj-test",
    CODEX_TEAM_CLIENT_ID: "c-test",
    CODEX_TEAM_SESSION_ID: "sess-test",
    CODEX_TEAM_PROJECT_DIR: tempDir,
  });
});

test("platform paths honor explicit env overrides", () => {
  const previousConfig = process.env.CODEX_TEAM_CONFIG_DIR;
  const previousData = process.env.CODEX_TEAM_DAEMON_DATA_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-platform-paths-"));
  process.env.CODEX_TEAM_CONFIG_DIR = path.join(tempDir, "cfg");
  process.env.CODEX_TEAM_DAEMON_DATA_DIR = path.join(tempDir, "data");
  try {
    assert.equal(resolveConfigDir(), path.join(tempDir, "cfg"));
    assert.equal(resolveDataDir(""), path.join(tempDir, "data"));
  } finally {
    restoreEnv("CODEX_TEAM_CONFIG_DIR", previousConfig);
    restoreEnv("CODEX_TEAM_DAEMON_DATA_DIR", previousData);
  }
});

test("platform data dir uses Claude plugin data for direct Node entrypoints", () => {
  const previousData = process.env.CODEX_TEAM_DAEMON_DATA_DIR;
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-platform-plugin-data-"));
  delete process.env.CODEX_TEAM_DAEMON_DATA_DIR;
  process.env.CLAUDE_PLUGIN_DATA = path.join(tempDir, "plugin-data");
  process.env.CLAUDE_PLUGIN_ROOT = path.join(tempDir, "plugin-root");
  try {
    assert.equal(resolveDataDir(""), path.join(tempDir, "plugin-data", "data"));
  } finally {
    restoreEnv("CODEX_TEAM_DAEMON_DATA_DIR", previousData);
    restoreEnv("CLAUDE_PLUGIN_DATA", previousPluginData);
    restoreEnv("CLAUDE_PLUGIN_ROOT", previousPluginRoot);
  }
});

test("whichExecutable finds an executable on PATH", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-platform-which-"));
  const bin = path.join(tempDir, process.platform === "win32" ? "codex.cmd" : "codex");
  fs.writeFileSync(bin, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
  if (process.platform !== "win32") {
    fs.chmodSync(bin, 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = `${tempDir}${path.delimiter}${previous || ""}`;
  try {
    assert.equal(whichExecutable("codex"), bin);
  } finally {
    restoreEnv("PATH", previous);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
