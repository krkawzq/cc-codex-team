import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventLog, isDeltaType } from "../src/daemon/events";
import { encodeToken } from "../src/paths";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-events-"));
}

describe("EventLog", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rotates in-memory events and reports id_rotated", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);

    for (let i = 0; i < 105; i++) {
      log.append("user-1", {
        type: i % 2 === 0 ? "turn.completed" : "item.agent_message_delta",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i },
      });
    }

    expect(log.retainedCount("user-1")).toBe(100);
    expect(log.oldestId("user-1")).toBe("evt-6");
    expect(log.listSince("user-1", "evt-1")).toEqual({
      ok: false,
      reason: "id_rotated",
      oldest_available_id: "evt-6",
    });
    expect(log.listSince("user-1", "evt-999")).toEqual({
      ok: false,
      reason: "invalid_since",
    });

    const listed = log.listSince("user-1", null, { includeDelta: false });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.events.every((e) => !e.type.endsWith("_delta"))).toBe(true);
    }
  });

  it("supports subscribe/dispose and runtime compaction", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);
    const seen: string[] = [];
    const sub = log.subscribe("user-1", (event) => {
      seen.push(event.id);
    });

    for (let i = 0; i < 205; i++) {
      log.append("user-1", {
        type: "turn.completed",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i },
      });
    }

    sub.dispose();
    log.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: { i: 999 },
    });

    await log.flush();

    expect(seen.length).toBe(205);
    const filePath = path.join(dir, "users", encodeToken("user-1"), "events.log");
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThan(206);
  });

  it("clearUser drops memory state and closes cleanly", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);

    log.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {},
    });

    await log.clearUser("user-1");

    expect(log.retainedCount("user-1")).toBe(0);
    expect(log.oldestId("user-1")).toBeNull();
  });

  it("rejects newer persisted event-log schema versions", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, "users", encodeToken("user-1"), "events.log");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      schema_version: 2,
      kind: "event_log_header",
    }) + "\n");

    const log = new EventLog(100, dir);
    expect(() => log.loadUser("user-1")).toThrow(/schema_version/i);
  });
});

describe("isDeltaType", () => {
  it("recognizes *_delta event types", () => {
    expect(isDeltaType("item.agent_message_delta")).toBe(true);
    expect(isDeltaType("turn.completed")).toBe(false);
  });
});
