import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClientStore } from "../src/clients";

test("ClientStore does not sweep clients with unknown pid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-client-store-"));
  const store = new ClientStore(tempDir);
  store.register({
    clientId: "c-no-pid",
    workspace: "ws",
    hostname: "host",
    pid: null,
    startedAt: new Date().toISOString(),
    claudeProjectDir: null,
    sessionId: "session",
  });

  assert.deepEqual(store.sweepStale(), []);
  assert.equal(store.list().length, 1);
});

test("ClientStore still sweeps old clients without pid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-client-store-"));
  const store = new ClientStore(tempDir);
  store.register({
    clientId: "c-old",
    workspace: "ws",
    hostname: "host",
    pid: null,
    startedAt: "2020-01-01T00:00:00.000Z",
    claudeProjectDir: null,
    sessionId: "session",
  });

  const stale = store.sweepStale(Date.parse("2020-01-09T00:00:00.000Z"));
  assert.equal(stale.length, 1);
  assert.equal(store.list().length, 0);
});
