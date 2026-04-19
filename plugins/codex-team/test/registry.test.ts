import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RegistryStore } from "../src/registry";

test("RegistryStore persists create and update", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-registry-"));
  const store = new RegistryStore(path.join(tempDir, "registry.json"));
  store.create({
    name: "alpha",
    threadId: "thr_1",
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
    appServerPid: 123,
    queueLength: 0,
    tokenUsageInput: 0,
    errorMessage: null,
  });
  store.update("alpha", { status: "running", queueLength: 2 });

  const reloaded = new RegistryStore(path.join(tempDir, "registry.json"));
  const entry = reloaded.get("alpha");
  assert.equal(entry.status, "running");
  assert.equal(entry.queueLength, 2);
});
