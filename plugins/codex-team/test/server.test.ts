import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

import { sendRequest } from "../src/cli";
import { loadConfig } from "../src/config";
import { DaemonServer } from "../src/server";
import { FakeAppServerClient } from "./helpers/fakeAppServer";

function tempConfig(tempDir: string) {
  const cfg = loadConfig(path.join(tempDir, "missing.toml"));
  cfg.daemon.dataDir = tempDir;
  cfg.daemon.socketPath = path.join(tempDir, "daemon.sock");
  cfg.monitor.watchdogIntervalSeconds = 3600;
  cfg.heartbeat.intervalSeconds = 3600;
  return cfg;
}

test("DaemonServer supports create, read, and doctor over socket", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_socket";
  fake.threadReadResult = {
    thread: {
      id: "thr_socket",
      turns: [{ id: "tr_prev" }],
    },
  };
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
  await server.start();
  try {
    assert.equal(server.eventBus.lastSeq("watchdog"), 1);
    const created = await sendRequest(cfg.daemon.socketPath, "session.create", {
      name: "socket-alpha",
      cwd: tempDir,
    });
    assert.equal(created.ok, true);
    assert.equal((created.data as Record<string, unknown>).thread_id, "thr_socket");

    const read = await sendRequest(cfg.daemon.socketPath, "session.read", {
      name: "socket-alpha",
      includeTurns: true,
    });
    assert.equal(read.ok, true);
    const thread = ((read.data as Record<string, unknown>).thread as Record<string, unknown>);
    assert.equal(thread.id, "thr_socket");
    assert.deepEqual(fake.threadReads, [
      { threadId: "thr_socket", includeTurns: false },
      { threadId: "thr_socket", includeTurns: true },
    ]);

    const doctor = await sendRequest(cfg.daemon.socketPath, "daemon.doctor", {});
    assert.equal(doctor.ok, true);
    const summary = (doctor.data as Record<string, unknown>).summary as Record<string, unknown>;
    assert.equal(summary.total, 1);
  } finally {
    await server.stop();
  }
});

test("DaemonServer rejects reading offline ephemeral sessions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_eph";
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
  await server.start();
  try {
    const created = await sendRequest(cfg.daemon.socketPath, "session.create", {
      name: "socket-eph",
      cwd: tempDir,
      ephemeral: true,
    });
    assert.equal(created.ok, true);

    const closed = await sendRequest(cfg.daemon.socketPath, "session.close", {
      name: "socket-eph",
    });
    assert.equal(closed.ok, true);

    const read = await sendRequest(cfg.daemon.socketPath, "session.read", {
      name: "socket-eph",
      includeTurns: false,
    });
    assert.equal(read.ok, false);
    const error = read.error as Record<string, unknown>;
    assert.equal(error.code, "E_INVALID");
  } finally {
    await server.stop();
  }
});

test("DaemonServer archives persistent thread on forget", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_forget";
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
  await server.start();
  try {
    const created = await sendRequest(cfg.daemon.socketPath, "session.create", {
      name: "forget-alpha",
      cwd: tempDir,
    });
    assert.equal(created.ok, true);

    const forgotten = await sendRequest(cfg.daemon.socketPath, "session.forget", {
      name: "forget-alpha",
    });
    assert.equal(forgotten.ok, true);
    assert.deepEqual(fake.threadArchives, ["thr_forget"]);
    assert.equal((forgotten.data as Record<string, unknown>).archived_thread, true);
  } finally {
    await server.stop();
  }
});

test("DaemonServer refreshes config from disk before session.create", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-config-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    const cfg = tempConfig(tempDir);
    const fake = new FakeAppServerClient();
    fake.nextThreadId = "thr_profile";
    const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
    await server.start();
    try {
      fs.mkdirSync(path.join(configHome, "codex-team"), { recursive: true });
      fs.writeFileSync(
        path.join(configHome, "codex-team", "config.toml"),
        `
[profiles.refactor]
reasoning_effort = "high"
approval_policy = "never"
`,
        "utf8",
      );

      const created = await sendRequest(cfg.daemon.socketPath, "session.create", {
        name: "profiled",
        cwd: tempDir,
        profile: "refactor",
      });
      assert.equal(created.ok, true);
      assert.equal(fake.threadStarts.length, 1);
      assert.deepEqual(fake.threadStarts[0].config, { model_reasoning_effort: "high" });
    } finally {
      await server.stop();
    }
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  }
});

test("DaemonServer serializes duplicate session.create requests", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const clients: FakeAppServerClient[] = [];
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => {
    const fake = new FakeAppServerClient();
    fake.nextThreadId = `thr_${clients.length}`;
    clients.push(fake);
    return fake;
  });
  await server.start();
  try {
    const [first, second] = await Promise.all([
      sendRequest(cfg.daemon.socketPath, "session.create", { name: "dup", cwd: tempDir }),
      sendRequest(cfg.daemon.socketPath, "session.create", { name: "dup", cwd: tempDir }),
    ]);
    assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
    assert.equal(clients.length, 1);
  } finally {
    await server.stop();
  }
});

test("DaemonServer history.get supports sinceTurnId", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const fake = new FakeAppServerClient();
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
  await server.start();
  try {
    const historyDir = path.join(tempDir, "sessions", "hist-alpha");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(
      path.join(historyDir, "turns.jsonl"),
      [
        JSON.stringify({ turnId: "tr_1", completedAt: "2026-01-01T00:00:01Z" }),
        JSON.stringify({ turnId: "tr_2", completedAt: "2026-01-01T00:00:02Z" }),
        JSON.stringify({ turnId: "tr_3", completedAt: "2026-01-01T00:00:03Z" }),
      ].join("\n"),
      "utf8",
    );

    const result = await sendRequest(cfg.daemon.socketPath, "history.get", {
      name: "hist-alpha",
      format: "jsonl",
      sinceTurnId: "tr_1",
    });
    assert.equal(result.ok, true);
    const content = String((result.data as Record<string, unknown>).content);
    assert.match(content, /tr_2/);
    assert.match(content, /tr_3/);
    assert.doesNotMatch(content, /tr_1/);
  } finally {
    await server.stop();
  }
});

test("DaemonServer history.subscribe streams snapshot and appended turns", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const fake = new FakeAppServerClient();
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
  await server.start();
  try {
    const historyDir = path.join(tempDir, "sessions", "stream-alpha");
    const turnsPath = path.join(historyDir, "turns.jsonl");
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(turnsPath, `${JSON.stringify({ turnId: "tr_1" })}\n`, "utf8");

    const socket = net.createConnection(cfg.daemon.socketPath);
    socket.setEncoding("utf8");
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(
      `${JSON.stringify({
        id: "hist-1",
        cmd: "history.subscribe",
        params: { name: "stream-alpha", format: "jsonl", sinceTurnId: "tr_missing" },
      })}\n`,
    );
    const iterator = rl[Symbol.asyncIterator]();
    const snapshot = JSON.parse((await iterator.next()).value as string) as Record<string, unknown>;
    assert.equal((snapshot.payload as Record<string, unknown>).kind, "history-snapshot");

    fs.appendFileSync(turnsPath, `${JSON.stringify({ turnId: "tr_2" })}\n`, "utf8");
    server.eventBus.publish("events", {
      kind: "turn-done",
      session: "stream-alpha",
      turn_id: "tr_2",
    });
    const appended = JSON.parse((await iterator.next()).value as string) as Record<string, unknown>;
    const payload = appended.payload as Record<string, unknown>;
    assert.equal(payload.kind, "history-append");
    assert.match(String(payload.content), /tr_2/);
    rl.close();
    socket.destroy();
  } finally {
    await server.stop();
  }
});

test("DaemonServer health.issues surfaces queue and running problems", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_issue";
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
  await server.start();
  try {
    const created = await sendRequest(cfg.daemon.socketPath, "session.create", {
      name: "issue-alpha",
      cwd: tempDir,
    });
    assert.equal(created.ok, true);

    const live = server.sessions.get("issue-alpha");
    assert.ok(live);
    (live as unknown as { isRunning: () => boolean }).isRunning = () => true;
    (live as unknown as { currentTurnId: () => string | null }).currentTurnId = () => "tr_issue";
    (live as unknown as { currentTurnAgeMs: () => number | null }).currentTurnAgeMs = () => 5_000;
    server.registry.update("issue-alpha", { queueLength: 2 });

    const issues = await sendRequest(cfg.daemon.socketPath, "health.issues", {});
    assert.equal(issues.ok, true);
    const payload = issues.data as Record<string, unknown>;
    const list = payload.issues as Array<Record<string, unknown>>;
    assert.ok(list.some((item) => item.kind === "queue-backlog"));
    assert.ok(list.some((item) => item.kind === "running"));
  } finally {
    await server.stop();
  }
});
