import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

import { sendRequest, textContentForResponse } from "../src/cli";
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

test("DaemonServer attaches an existing Codex thread as a session", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const fake = new FakeAppServerClient();
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
  await server.start();
  try {
    const attached = await sendRequest(cfg.daemon.socketPath, "session.attach", {
      name: "restored",
      threadId: "thr_saved",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      reasoningEffort: "high",
    });
    assert.equal(attached.ok, true);
    assert.deepEqual(fake.threadResumes, [
      {
        threadId: "thr_saved",
        params: {
          model: "gpt-5.4",
          cwd: tempDir,
          modelProvider: "openai",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          config: { model_reasoning_effort: "high" },
          persistExtendedHistory: false,
        },
      },
    ]);
    assert.deepEqual(fake.threadReads, [{ threadId: "thr_saved", includeTurns: false }]);

    const status = await sendRequest(cfg.daemon.socketPath, "session.status", { name: "restored" });
    assert.equal(status.ok, true);
    assert.equal((status.data as Record<string, unknown>).threadId, "thr_saved");
    assert.equal((status.data as Record<string, unknown>).ephemeral, false);
  } finally {
    await server.stop();
  }
});

test("DaemonServer rejects attaching the same thread twice", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const fake = new FakeAppServerClient();
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
  await server.start();
  try {
    const first = await sendRequest(cfg.daemon.socketPath, "session.attach", {
      name: "restored-one",
      thread_id: "thr_dup",
      cwd: tempDir,
    });
    assert.equal(first.ok, true);

    const second = await sendRequest(cfg.daemon.socketPath, "session.attach", {
      name: "restored-two",
      threadId: "thr_dup",
      cwd: tempDir,
    });
    assert.equal(second.ok, false);
    assert.equal((second.error as Record<string, unknown>).code, "E_INVALID");
    assert.equal(fake.threadResumes.length, 1);
  } finally {
    await server.stop();
  }
});

test("DaemonServer resumes registry sessions with persisted config", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const clients: FakeAppServerClient[] = [];
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => {
    const fake = new FakeAppServerClient();
    fake.nextThreadId = "thr_resume";
    clients.push(fake);
    return fake;
  });
  await server.start();
  try {
    const created = await sendRequest(cfg.daemon.socketPath, "session.create", {
      name: "resumable",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      serviceTier: "flex",
      reasoningEffort: "xhigh",
    });
    assert.equal(created.ok, true);

    const closed = await sendRequest(cfg.daemon.socketPath, "session.close", { name: "resumable" });
    assert.equal(closed.ok, true);

    const resumed = await sendRequest(cfg.daemon.socketPath, "session.resume", { name: "resumable" });
    assert.equal(resumed.ok, true);
    assert.equal(clients.length, 2);
    assert.deepEqual(clients[1].threadResumes, [
      {
        threadId: "thr_resume",
        params: {
          model: "gpt-5.4",
          cwd: tempDir,
          modelProvider: "openai",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          serviceTier: "flex",
          config: { model_reasoning_effort: "xhigh" },
          persistExtendedHistory: false,
        },
      },
    ]);
  } finally {
    await server.stop();
  }
});

test("DaemonServer resumes legacy registry sessions with config fallbacks", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-config-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    fs.mkdirSync(path.join(configHome, "codex-team"), { recursive: true });
    fs.writeFileSync(
      path.join(configHome, "codex-team", "config.toml"),
      `
[defaults]
model = "gpt-default"
cwd = "${tempDir}"
sandbox = "workspace-write"
approval_policy = "never"

[profiles.legacy_profile]
reasoning_effort = "high"
personality = "precise"
base_instructions = "base from profile"
developer_instructions = "developer from profile"
`,
      "utf8",
    );
    const cfg = tempConfig(tempDir);
    cfg.defaults.model = "gpt-default";
    cfg.defaults.cwd = tempDir;
    cfg.defaults.sandbox = "workspace-write";
    cfg.defaults.approvalPolicy = "never";
    const fake = new FakeAppServerClient();
    const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
    await server.start();
    try {
      server.registry.create({
        name: "legacy",
        threadId: "thr_legacy",
        cwd: "",
        model: "",
        modelProvider: null,
        sandbox: "",
        approvalPolicy: "",
        serviceTier: null,
        reasoningEffort: null,
        personality: null,
        profile: "legacy_profile",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastTurnId: null,
        lastTurnEndedAt: null,
        lastPromptText: null,
        status: "closed",
        appServerPid: null,
        ephemeral: false,
        queueLength: 0,
        tokenUsageInput: 0,
        contextTokensEstimate: 0,
        modelContextWindow: null,
        errorMessage: null,
      });

      const resumed = await sendRequest(cfg.daemon.socketPath, "session.resume", { name: "legacy" });
      assert.equal(resumed.ok, true);
      assert.deepEqual(fake.threadResumes, [
        {
          threadId: "thr_legacy",
          params: {
            model: "gpt-default",
            cwd: tempDir,
            sandbox: "workspace-write",
            approvalPolicy: "never",
            personality: "precise",
            baseInstructions: "base from profile",
            developerInstructions: "developer from profile",
            config: { model_reasoning_effort: "high" },
            persistExtendedHistory: false,
          },
        },
      ]);
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

test("DaemonServer does not rewrite registry when resumed thread verification fails", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-server-"));
  const cfg = tempConfig(tempDir);
  const fake = new FakeAppServerClient();
  fake.nextResumeThreadId = "thr_new";
  fake.threadReadError = new Error("read failed");
  const server = new DaemonServer(cfg, cfg.daemon.socketPath, undefined, () => fake);
  await server.start();
  try {
    server.registry.create({
      name: "verify-fail",
      threadId: "thr_old",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: null,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      serviceTier: null,
      reasoningEffort: null,
      personality: null,
      profile: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastTurnId: null,
      lastTurnEndedAt: null,
      lastPromptText: null,
      status: "closed",
      appServerPid: null,
      ephemeral: false,
      queueLength: 0,
      tokenUsageInput: 0,
      contextTokensEstimate: 0,
      modelContextWindow: null,
      errorMessage: null,
    });

    const resumed = await sendRequest(cfg.daemon.socketPath, "session.resume", { name: "verify-fail" });
    assert.equal(resumed.ok, false);
    const status = await sendRequest(cfg.daemon.socketPath, "session.status", { name: "verify-fail" });
    assert.equal(status.ok, true);
    assert.equal((status.data as Record<string, unknown>).threadId, "thr_old");
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

test("CliClient selects plain text output for content commands", () => {
  const content = "## Turn tr_1\n\nFinal answer: done\n";
  assert.equal(
    textContentForResponse({ group: "history", args: {} }, { content }),
    content,
  );
  assert.equal(
    textContentForResponse({ group: "tail", args: {} }, { content: "stderr\n" }),
    "stderr\n",
  );
  assert.equal(
    textContentForResponse({ group: "daemon", action: "logs", args: {} }, { content: "log\n" }),
    "log\n",
  );
  assert.equal(
    textContentForResponse({ group: "session", action: "status", args: {} }, { content }),
    null,
  );
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
