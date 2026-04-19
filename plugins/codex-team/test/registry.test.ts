import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RegistryStore } from "../src/registry";

function sampleEntry(tempDir: string) {
  return {
    workspace: "default",
    name: "alpha",
    createdByClientId: null,
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
    status: "idle" as const,
    appServerPid: 123,
    queueLength: 0,
    tokenUsageInput: 0,
    errorMessage: null,
  };
}

test("RegistryStore persists create and update", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-registry-"));
  const store = new RegistryStore(path.join(tempDir, "registry.json"));
  store.create(sampleEntry(tempDir));
  store.update("alpha", { status: "running", queueLength: 2 });

  const reloaded = new RegistryStore(path.join(tempDir, "registry.json"));
  const entry = reloaded.get("alpha");
  assert.equal(entry.status, "running");
  assert.equal(entry.queueLength, 2);
});

test("RegistryStore allows same session name in different workspaces", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-registry-"));
  const store = new RegistryStore(path.join(tempDir, "registry.json"));
  store.create({ ...sampleEntry(tempDir), workspace: "ws-a", name: "same" });
  store.create({ ...sampleEntry(tempDir), workspace: "ws-b", name: "same", threadId: "thr_2" });

  assert.equal(store.list("ws-a").length, 1);
  assert.equal(store.list("ws-b").length, 1);
  assert.equal(store.get("same", "ws-b").threadId, "thr_2");
});

test("RegistryStore rejects entries without workspace", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-registry-"));
  const filePath = path.join(tempDir, "registry.json");
  const invalid = sampleEntry(tempDir) as Record<string, unknown>;
  delete invalid.workspace;
  fs.writeFileSync(filePath, JSON.stringify({ sessions: { alpha: invalid } }), "utf8");

  assert.throws(() => new RegistryStore(filePath), /missing workspace/);
});
