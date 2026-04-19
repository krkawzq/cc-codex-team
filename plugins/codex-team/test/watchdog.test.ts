import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config";
import { EventBus } from "../src/eventBus";
import { RegistryStore } from "../src/registry";
import { WatchdogTimer } from "../src/watchdog";

test("WatchdogTimer suppresses idle periodic ticks by default but supports forced tick", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-watchdog-"));
  const cfg = loadConfig(path.join(tempDir, "missing.toml"));
  cfg.monitor.watchdogEmitIdle = false;
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const watchdog = new WatchdogTimer(cfg, registry, bus, new Map());
  const sub = await bus.subscribe("watchdog");

  await watchdog.tickOnce();
  assert.equal(sub.shiftNow(), undefined);

  await watchdog.tickOnce({ force: true });
  const event = sub.shiftNow();
  assert.equal(event?.payload.kind, "watchdog-tick");
  assert.match(String(event?.payload.message), /sent_at=/);
  assert.match(String(event?.payload.message), /local_time=/);
  assert.equal(typeof event?.payload.sentAt, "string");
  assert.equal(typeof event?.payload.localTime, "string");
});

test("WatchdogTimer renders workspace variable", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-watchdog-"));
  const cfg = loadConfig(path.join(tempDir, "missing.toml"));
  cfg.monitor.watchdogTemplate = "workspace={{workspace}}";
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const watchdog = new WatchdogTimer(cfg, registry, bus, new Map());
  const sub = await bus.subscribe("watchdog", 0, { workspace: "ws-x" });

  await watchdog.tickOnce({ force: true, workspace: "ws-x" });
  const event = sub.shiftNow();
  assert.equal(event?.payload.workspace, "ws-x");
  assert.equal(event?.payload.message, "workspace=ws-x");
});

test("WatchdogTimer renders configurable reminder template", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-watchdog-"));
  const cfg = loadConfig(path.join(tempDir, "missing.toml"));
  cfg.monitor.watchdogTemplate = "At {{sentAt}} local {{localTime}} :: Team {{summary.total}} / queued {{summary.queued}}{{#if taskBrief}} :: {{taskBrief}}{{/if}}";
  cfg.monitor.watchdogTaskBriefFile = path.join(tempDir, "brief.md");
  fs.writeFileSync(cfg.monitor.watchdogTaskBriefFile, "ship it\n", "utf8");
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const watchdog = new WatchdogTimer(cfg, registry, bus, new Map());
  const sub = await bus.subscribe("watchdog");

  await watchdog.tickOnce({ force: true });
  const event = sub.shiftNow();
  assert.equal(event?.payload.kind, "watchdog-tick");
  assert.match(String(event?.payload.message), /^At .* local .* :: Team 0 \/ queued 0 :: ship it$/);
});

test("WatchdogTimer renders named alarm templates independently", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-watchdog-"));
  const cfg = loadConfig(path.join(tempDir, "missing.toml"));
  const fastBrief = path.join(tempDir, "fast.md");
  fs.writeFileSync(fastBrief, "fast brief\n", "utf8");
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const watchdog = new WatchdogTimer(cfg, registry, bus, new Map());
  const sub = await bus.subscribe("watchdog");

  await watchdog.tickOnce({
    force: true,
    alarmName: "fast",
    alarm: {
      enabled: true,
      intervalSeconds: 60,
      taskBriefFile: fastBrief,
      taskBriefHeadLines: 1,
      emitIdle: true,
      template: "Alarm {{alarm}} at {{sentAt}}: {{taskBrief}}",
      templateFile: "",
    },
  });

  const event = sub.shiftNow();
  assert.equal(event?.payload.alarm, "fast");
  assert.match(String(event?.payload.message), /^Alarm fast at .*: fast brief$/);
});
