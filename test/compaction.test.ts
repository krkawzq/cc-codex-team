import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CompactionMonitor } from "../src/compaction";
import { loadConfig } from "../src/config";
import { EventBus } from "../src/eventBus";
import { RegistryStore } from "../src/registry";

test("CompactionMonitor emits once per threshold band", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-compaction-"));
  const cfg = loadConfig(path.join(tempDir, "missing.toml"));
  cfg.compaction.thresholdTokens = 100;
  const bus = new EventBus();
  const registry = new RegistryStore(path.join(tempDir, "registry.json"));
  const monitor = new CompactionMonitor(cfg, registry, bus);
  const sub = await bus.subscribe("events");

  await monitor.observeUsage("alpha", {
    contextTokensEstimate: 120,
    modelContextWindow: 1000,
    cumulativeUsageTokens: 500,
  });
  await monitor.observeUsage("alpha", {
    contextTokensEstimate: 150,
    modelContextWindow: 1000,
    cumulativeUsageTokens: 700,
  });
  await monitor.observeUsage("alpha", {
    contextTokensEstimate: 220,
    modelContextWindow: 1000,
    cumulativeUsageTokens: 900,
  });

  const first = sub.shiftNow();
  const second = sub.shiftNow();
  assert.equal(first?.payload.kind, "compact-suggest");
  assert.equal(first?.payload.level, 1);
  assert.equal(second?.payload.kind, "compact-suggest");
  assert.equal(second?.payload.level, 2);
  assert.equal(sub.shiftNow(), undefined);
});
