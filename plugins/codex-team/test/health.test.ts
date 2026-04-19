import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config";
import { EventBus } from "../src/eventBus";
import { HealthMonitor } from "../src/health";
import { RegistryStore } from "../src/registry";
import type { Session } from "../src/session";

function tempConfig(tempDir: string) {
  const cfg = loadConfig(path.join(tempDir, "missing.toml"));
  cfg.daemon.dataDir = tempDir;
  return cfg;
}

test("HealthMonitor emits turn-stuck once per stuck turn", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-health-"));
  const cfg = tempConfig(tempDir);
  cfg.heartbeat.turnStuckSeconds = 1;

  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  registry.create({
    name: "alpha",
    threadId: "thr_1",
    ephemeral: false,
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
    status: "running",
    appServerPid: 1,
    queueLength: 0,
    tokenUsageInput: 0,
    errorMessage: null,
  });

  const bus = new EventBus();
  const sessions = new Map<string, Session>();
  sessions.set(
    "alpha",
    {
      isTransportAlive: () => true,
      healthCheck: async () => {},
      isRunning: () => true,
      currentTurnId: () => "tr_1",
      currentTurnAgeMs: () => 2_000,
      stderrTail: () => "",
    } as unknown as Session,
  );
  let resumeCalls = 0;
  const health = new HealthMonitor(cfg, registry, sessions, bus, {
    resume: async () => {
      resumeCalls += 1;
      throw new Error("should not be called");
    },
  });

  const sub = await bus.subscribe("events");
  await health.tickOnce();
  const first = sub.shiftNow();
  assert.equal(first?.payload.kind, "turn-stuck");
  await health.tickOnce();
  const second = sub.shiftNow();
  assert.equal(second, undefined);
  assert.equal(resumeCalls, 0);
});

test("HealthMonitor does not auto-heal ephemeral sessions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-health-"));
  const cfg = tempConfig(tempDir);
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  registry.create({
    name: "eph",
    threadId: "thr_eph",
    ephemeral: true,
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
    status: "errored",
    appServerPid: null,
    queueLength: 0,
    tokenUsageInput: 0,
    errorMessage: "down",
  });

  const bus = new EventBus();
  let resumeCalls = 0;
  const health = new HealthMonitor(cfg, registry, new Map(), bus, {
    resume: async () => {
      resumeCalls += 1;
      throw new Error("unexpected");
    },
  });
  const sub = await bus.subscribe("events");
  await health.tickOnce();
  const event = sub.shiftNow();
  assert.equal(event?.payload.kind, "session-down");
  assert.equal(resumeCalls, 0);
});

test("HealthMonitor emits subprocess-recycled for idle heal", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-health-"));
  const cfg = tempConfig(tempDir);
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  registry.create({
    name: "alpha",
    threadId: "thr_1",
    ephemeral: false,
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
    status: "idle",
    appServerPid: null,
    queueLength: 0,
    tokenUsageInput: 0,
    errorMessage: null,
  });

  const bus = new EventBus();
  const health = new HealthMonitor(cfg, registry, new Map(), bus, {
    resume: async () =>
      ({
        absorbQueue: async () => {},
        isRunning: () => false,
        currentTurnId: () => null,
        currentTurnAgeMs: () => null,
      }) as unknown as Session,
  });
  const sub = await bus.subscribe("events");
  await health.tickOnce();
  const event = sub.shiftNow();
  assert.equal(event?.payload.kind, "subprocess-recycled");
  assert.equal(event?.payload.was_during_turn, false);
});

test("HealthMonitor migrates queued sends into resumed session", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-health-"));
  const cfg = tempConfig(tempDir);
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  registry.create({
    name: "alpha",
    threadId: "thr_1",
    ephemeral: false,
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
    status: "running",
    appServerPid: 1,
    queueLength: 1,
    tokenUsageInput: 0,
    contextTokensEstimate: 0,
    modelContextWindow: null,
    errorMessage: null,
  });

  const bus = new EventBus();
  const oldSession = {
    isTransportAlive: () => false,
    healthCheck: async () => {},
    isRunning: () => true,
    currentTurnId: () => "tr_old",
    currentTurnAgeMs: () => 2_000,
    stderrTail: () => "",
    detachForRecovery: async () => [{ id: "pending-1", text: "next" }],
  } as unknown as Session;
  const sessions = new Map<string, Session>([["alpha", oldSession]]);

  const absorbed: Array<Record<string, unknown>> = [];
  const resumed = {
    absorbQueue: async (items: Array<Record<string, unknown>>) => {
      absorbed.push(...items);
    },
  } as unknown as Session;

  const health = new HealthMonitor(cfg, registry, sessions, bus, {
    resume: async () => resumed,
  });
  await health.tickOnce();
  assert.equal(absorbed.length, 1);
  assert.equal(absorbed[0].id, "pending-1");
});
