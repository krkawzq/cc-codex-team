import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventLog, isDeltaType } from "../src/daemon/events";
import { encodeToken } from "../src/paths";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-events-"));
}

describe("EventLog", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rotates in-memory events and reports id_rotated", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);

    for (let i = 0; i < 105; i++) {
      await log.append("user-1", {
        type: i % 2 === 0 ? "turn.completed" : "item.agent_message_delta",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i },
      });
    }

    expect(log.retainedCount("user-1")).toBe(100);
    expect(log.oldestId("user-1")).toBe("evt-6");
    await expect(log.listSince("user-1", "evt-1")).resolves.toEqual({
      ok: false,
      reason: "id_rotated",
      oldest_available_id: "evt-6",
    });
    await expect(log.listSince("user-1", "evt-999")).resolves.toEqual({
      ok: false,
      reason: "invalid_since",
    });

    const listed = await log.listSince("user-1", null, { includeDelta: false });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.events.every((e) => !e.type.endsWith("_delta"))).toBe(true);
    }
  });

  it("fans out subscriber callbacks in a microtask instead of inline", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);
    const seen: string[] = [];
    log.subscribe("user-1", (event) => {
      seen.push(event.id);
    });

    const appendPromise = log.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: {},
    });

    expect(seen).toEqual([]);
    await appendPromise;
    await Promise.resolve();
    expect(seen).toEqual(["evt-1"]);
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
      await log.append("user-1", {
        type: "turn.completed",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i },
      });
    }

    await Promise.resolve();
    sub.dispose();
    await log.append("user-1", {
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

  it("retries failed appendFile batches instead of dropping them", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);
    const originalAppendFile = fs.promises.appendFile.bind(fs.promises);
    const appendFileSpy = vi.spyOn(fs.promises, "appendFile")
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation((...args) => originalAppendFile(...args));

    await log.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: { attempt: 1 },
    });

    await log.flush();
    await log.flush();

    const filePath = path.join(dir, "users", encodeToken("user-1"), "events.log");
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line)).filter((entry) => entry.kind !== "event_log_header");
    expect(appendFileSpy).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "evt-1",
      payload: { attempt: 1 },
    });
  });

  it("loads persisted events asynchronously on first read", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, "users", encodeToken("user-1"), "events.log");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({
        id: "evt-1",
        ts: "2025-01-01T00:00:00.000Z",
        type: "turn.completed",
        session: "sess-1",
        thread_id: "th-1",
        payload: { saved: true },
      }),
      "",
    ].join("\n"));

    const readSpy = vi.spyOn(fs.promises, "readFile");
    const log = new EventLog(100, dir);

    const listed = await log.listSince("user-1", null);

    expect(readSpy).toHaveBeenCalled();
    expect(listed).toEqual({
      ok: true,
      events: [
        expect.objectContaining({
          id: "evt-1",
          payload: { saved: true },
        }),
      ],
    });
  });

  it("clearUser drops memory state and closes cleanly", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);

    await log.append("user-1", {
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
