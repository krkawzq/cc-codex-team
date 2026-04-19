import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config";
import { EventBus } from "../src/eventBus";
import { RegistryStore } from "../src/registry";
import { SessionFactory } from "../src/session";
import { turnDoneNotificationSet, FakeAppServerClient } from "./helpers/fakeAppServer";

function tempConfig(tempDir: string) {
  const cfg = loadConfig(path.join(tempDir, "missing.toml"));
  cfg.daemon.dataDir = tempDir;
  return cfg;
}

test("Session.send --wait returns summary and writes history", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-session-"));
  const cfg = tempConfig(tempDir);
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_a";
  fake.nextTurnId = "tr_a";
  fake.queuedTurnNotifications.push(turnDoneNotificationSet("tr_a", "DONE", 17));

  const factory = new SessionFactory(cfg, registry, bus, null, () => fake);
  const session = await factory.create("alpha", { cwd: tempDir });
  const sub = await bus.subscribe("events");
  const summary = await session.send("do work", { wait: true });

  const started = sub.shiftNow();
  assert.equal(started?.payload.kind, "turn-start");
  assert.match(String(started?.payload.queued_or_turn_id || ""), /^pending-/);
  assert.equal(started?.payload.turn_id, "tr_a");

  assert.equal(summary.final_message, "DONE");
  assert.equal(registry.get("alpha").status, "idle");
  assert.equal(registry.get("alpha").tokenUsageInput, 17);

  const historyPath = path.join(tempDir, "sessions", "default", "alpha", "history.md");
  const turnsPath = path.join(tempDir, "sessions", "default", "alpha", "turns.jsonl");
  assert.match(fs.readFileSync(historyPath, "utf8"), /DONE/);
  assert.match(fs.readFileSync(turnsPath, "utf8"), /"turnId":"tr_a"/);
  await session.close();
});

test("Session.clearQueue rejects queued waiters instead of hanging", { timeout: 1000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-session-"));
  const cfg = tempConfig(tempDir);
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_b";
  fake.nextTurnId = "tr_blocked";
  fake.queuedTurnNotifications.push([]);

  const factory = new SessionFactory(cfg, registry, bus, null, () => fake);
  const session = await factory.create("beta", { cwd: tempDir });

  await session.send("first");
  const queued = session.send("second", { wait: true });
  await new Promise((resolve) => setImmediate(resolve));
  session.clearQueue();

  await assert.rejects(queued, /cleared/);

  await fake.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("Session.compact resets stale token metrics when no fresh usage arrives", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-session-"));
  const cfg = tempConfig(tempDir);
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_c";

  const factory = new SessionFactory(cfg, registry, bus, null, () => fake);
  const session = await factory.create("compact-alpha", { cwd: tempDir });
  registry.update("compact-alpha", {
    tokenUsageInput: 999,
    contextTokensEstimate: 888,
    modelContextWindow: 950000,
  });

  await session.compact();
  const entry = registry.get("compact-alpha");
  assert.equal(entry.tokenUsageInput, 0);
  assert.equal(entry.contextTokensEstimate, 0);
  assert.equal(entry.modelContextWindow, 950000);
  await session.close();
});

test("Session.compact retries after a failed compaction turn", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-session-"));
  const cfg = tempConfig(tempDir);
  cfg.compaction.retryAttempts = 1;
  cfg.compaction.retryDelayMs = 1;
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_retry";
  fake.queuedCompactNotifications.push([
    {
      method: "item/started",
      params: {
        threadId: "thr_retry",
        turnId: "compact_fail",
        item: { type: "contextCompaction", id: "compact_1" },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thr_retry",
        turn: { id: "compact_fail", status: "failed", error: { message: "transient" } },
      },
    },
  ]);

  const factory = new SessionFactory(cfg, registry, bus, null, () => fake);
  const session = await factory.create("retry-alpha", { cwd: tempDir });
  await session.compact();
  assert.equal(registry.get("retry-alpha").status, "idle");
  await session.close();
});

test("Session.compact refuses to run while a turn is active", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-session-"));
  const cfg = tempConfig(tempDir);
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_busy";
  fake.nextTurnId = "tr_busy";
  fake.queuedTurnNotifications.push([]);

  const factory = new SessionFactory(cfg, registry, bus, null, () => fake);
  const session = await factory.create("busy-alpha", { cwd: tempDir });
  await session.send("long turn");
  await assert.rejects(() => session.compact(), /running/);
  await fake.close();
});

test("Session.compact times out and marks session errored", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-session-"));
  const cfg = tempConfig(tempDir);
  cfg.compaction.retryAttempts = 0;
  cfg.compaction.timeoutSeconds = 1;
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const fake = new FakeAppServerClient();
  fake.nextThreadId = "thr_timeout";
  fake.queuedCompactNotifications.push([]);

  const factory = new SessionFactory(cfg, registry, bus, null, () => fake);
  const session = await factory.create("timeout-alpha", { cwd: tempDir });
  await assert.rejects(() => session.compact(), /compact timed out/);
  assert.equal(registry.get("timeout-alpha").status, "errored");
  await fake.close();
});
