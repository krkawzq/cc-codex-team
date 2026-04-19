import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config";

test("loadConfig reads snake_case TOML keys", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-config-"));
  const configPath = path.join(tempDir, "config.toml");
  fs.writeFileSync(
    configPath,
    `
[daemon]
data_dir = "/tmp/data"
socket_path = "/tmp/socket.sock"
launch_args_override = ["app-server", "--listen", "stdio://"]

[defaults]
approval_policy = "on-request"
`,
    "utf8",
  );

  const cfg = loadConfig(configPath);
  assert.equal(cfg.daemon.dataDir, "/tmp/data");
  assert.equal(cfg.daemon.socketPath, "/tmp/socket.sock");
  assert.deepEqual(cfg.daemon.launchArgsOverride, ["app-server", "--listen", "stdio://"]);
  assert.equal(cfg.defaults.approvalPolicy, "on-request");
});

test("loadConfig applies env overrides", () => {
  const previous = process.env.CODEX_TEAM_QUEUE_MAXPERSESSION;
  process.env.CODEX_TEAM_QUEUE_MAXPERSESSION = "9";
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-config-"));
    const configPath = path.join(tempDir, "missing.toml");
    const cfg = loadConfig(configPath);
    assert.equal(cfg.queue.maxPerSession, 9);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_TEAM_QUEUE_MAXPERSESSION;
    } else {
      process.env.CODEX_TEAM_QUEUE_MAXPERSESSION = previous;
    }
  }
});

test("loadConfig accepts snake-case env override names", () => {
  const previous = process.env.CODEX_TEAM_QUEUE_MAX_PER_SESSION;
  process.env.CODEX_TEAM_QUEUE_MAX_PER_SESSION = "11";
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-config-"));
    const cfg = loadConfig(path.join(tempDir, "missing.toml"));
    assert.equal(cfg.queue.maxPerSession, 11);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_TEAM_QUEUE_MAX_PER_SESSION;
    } else {
      process.env.CODEX_TEAM_QUEUE_MAX_PER_SESSION = previous;
    }
  }
});

test("loadConfig rejects invalid enum values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-config-"));
  const configPath = path.join(tempDir, "config.toml");
  fs.writeFileSync(
    configPath,
    `
[queue]
overflow_policy = "forever"
`,
    "utf8",
  );
  assert.throws(() => loadConfig(configPath), /queue\.overflow_policy/);
});

test("loadConfig reads multiple watchdog alarms", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-config-"));
  const configPath = path.join(tempDir, "config.toml");
  fs.writeFileSync(
    configPath,
    `
[monitor.watchdog_alarms.fast]
interval_seconds = 60
template = "fast {{sentAt}}"
emit_idle = true

[monitor.watchdog_alarms.slow]
interval_seconds = 3600
task_brief_file = "/tmp/brief.md"
`,
    "utf8",
  );
  const cfg = loadConfig(configPath);
  assert.equal(cfg.monitor.watchdogAlarms.fast.intervalSeconds, 60);
  assert.equal(cfg.monitor.watchdogAlarms.fast.emitIdle, true);
  assert.equal(cfg.monitor.watchdogAlarms.slow.taskBriefFile, "/tmp/brief.md");
});

test("loadConfig rejects reserved watchdog alarm name", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-config-"));
  const configPath = path.join(tempDir, "config.toml");
  fs.writeFileSync(
    configPath,
    `
[monitor.watchdog_alarms.default]
interval_seconds = 60
`,
    "utf8",
  );
  assert.throws(() => loadConfig(configPath), /reserved/);
});
