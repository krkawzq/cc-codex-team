import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionRegistry } from "../src/daemon/sessions";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-sessions-"));
}

describe("SessionRegistry list accessors", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listLive excludes crashed sessions while listAll keeps them available", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);

    sessions.add("user-1", {
      name: "live-1",
      thread_id: "th-live",
      state: "live",
      autoApprovePatterns: [],
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
    });
    sessions.add("user-1", {
      name: "crashed-1",
      thread_id: "th-crashed",
      state: "crashed",
      autoApprovePatterns: [],
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
    });

    expect(sessions.listLive("user-1").map((session) => session.name)).toEqual(["live-1"]);
    expect(sessions.listAll("user-1").map((session) => session.name)).toEqual(["live-1", "crashed-1"]);
  });
});
