import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_REQUEST_CANCELLED_EVENT_TYPE,
  AUTO_APPROVED_EVENT_TYPE,
  EventLog,
  EventRingBuffer,
  SESSION_CLOSED_EVENT_TYPE,
  SESSION_CRASHED_EVENT_TYPE,
  SESSION_PENDING_DROPPED_EVENT_TYPE,
  USER_INPUT_REQUEST_CANCELLED_EVENT_TYPE,
  isDeltaType,
} from "../src/daemon/events";
import { logger } from "../src/logger";
import { encodeToken } from "../src/paths";
import type { TeamEvent } from "../src/types";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-events-"));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeEvent(id: number, type = "turn.completed"): TeamEvent {
  return {
    id: `evt-${id}`,
    ts: new Date(id * 1_000).toISOString(),
    type,
    session: "sess-1",
    thread_id: "th-1",
    payload: { i: id },
  };
}

function readPersistedEvents(filePath: string): TeamEvent[] {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.kind !== "event_log_header") as TeamEvent[];
}

interface EventLogInternals {
  compactFile(user: string): Promise<void>;
  enqueueFsOp(user: string, op: () => Promise<unknown>): Promise<unknown>;
  pendingBytes: Map<string, number>;
  pendingLines: Map<string, string[]>;
}

describe("EventLog", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
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

  it("does not persist duplicate ids when compaction overlaps later appends", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);
    const internals = log as unknown as EventLogInternals;

    for (let i = 0; i < 120; i++) {
      await log.append("user-1", {
        type: "turn.completed",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i },
      });
    }

    const gate = deferred<void>();
    void internals.enqueueFsOp("user-1", async () => {
      await gate.promise;
      return true;
    });

    const compaction = internals.compactFile("user-1");
    for (let i = 120; i < 135; i++) {
      await log.append("user-1", {
        type: "turn.completed",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i },
      });
    }

    gate.resolve();
    await compaction;
    await log.flush();

    const filePath = path.join(dir, "users", encodeToken("user-1"), "events.log");
    const ids = readPersistedEvents(filePath).map((event) => event.id);

    expect(ids[0]).toBe("evt-21");
    expect(ids.at(-1)).toBe("evt-135");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("retries failed appendFile batches instead of dropping them", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);
    // Prime the user's event-log file so subsequent flushes take the appendFile
    // path rather than the one-shot writeFile-with-header path for a fresh file.
    await log.append("user-1", {
      type: "warning",
      session: null,
      thread_id: null,
      payload: { prime: true },
    });
    await log.flush();

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
    const events = lines.map((line) => JSON.parse(line)).filter((entry) => entry.kind !== "event_log_header" && entry?.payload?.prime !== true);
    expect(appendFileSpy).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "evt-2",
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

  it("trims a torn final event-log line on restart and preserves the valid prefix", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, "users", encodeToken("user-1"), "events.log");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({ schema_version: 1, kind: "event_log_header" }),
      JSON.stringify(makeEvent(1)),
      JSON.stringify(makeEvent(2)),
      "{\"id\":\"evt-3\"",
    ].join("\n"));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const log = new EventLog(100, dir);
    const listed = await log.listSince("user-1", null);

    expect(listed).toEqual({
      ok: true,
      events: [
        expect.objectContaining({ id: "evt-1" }),
        expect.objectContaining({ id: "evt-2" }),
      ],
    });
    expect(warnSpy).toHaveBeenCalledWith("trimmed torn final event log line", expect.objectContaining({
      user: "user-1",
      line: 4,
    }));
    expect(readPersistedEvents(filePath).map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
  });

  it("skips malformed event-log lines in the middle and keeps surrounding events", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, "users", encodeToken("user-1"), "events.log");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      JSON.stringify({ schema_version: 1, kind: "event_log_header" }),
      JSON.stringify(makeEvent(1)),
      "{not-json}",
      JSON.stringify(makeEvent(2)),
      "",
    ].join("\n"));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const log = new EventLog(100, dir);
    const listed = await log.listSince("user-1", null);

    expect(listed).toEqual({
      ok: true,
      events: [
        expect.objectContaining({ id: "evt-1" }),
        expect.objectContaining({ id: "evt-2" }),
      ],
    });
    expect(warnSpy).toHaveBeenCalledWith("skipping invalid event log line", expect.objectContaining({
      user: "user-1",
      line: 3,
    }));
    expect(readPersistedEvents(filePath).map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
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

  it("emits one warning and refuses new events when the id counter exceeds the soft limit", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    log.loadUser("user-1");
    (log as unknown as { counters: Map<string, number> }).counters.set("user-1", 2 ** 52);

    await expect(log.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: { attempt: 1 },
    })).rejects.toThrow(/event id counter exceeded safe limit/i);

    await expect(log.append("user-1", {
      type: "turn.completed",
      session: "sess-1",
      thread_id: "th-1",
      payload: { attempt: 2 },
    })).rejects.toThrow(/event id counter exceeded safe limit/i);

    const listed = await log.listSince("user-1", null);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(listed).toEqual({
      ok: true,
      events: [
        expect.objectContaining({
          id: `evt-${2 ** 52 + 1}`,
          type: "warning",
          payload: expect.objectContaining({
            kind: "event_id_overflow",
            dropped_event_type: "turn.completed",
            next_event_id: 2 ** 52 + 1,
          }),
        }),
      ],
    });
  });

  it("flushes overflow backlogs even when new events arrive before the overflow delay", async () => {
    vi.useFakeTimers();

    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);
    const writeSpy = vi.spyOn(fs.promises, "writeFile");
    const largePayload = "x".repeat(1_100_000);

    for (let i = 0; i < 8; i++) {
      await log.append("user-1", {
        type: "turn.completed",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i, blob: largePayload },
      });
      await vi.advanceTimersByTimeAsync(100);
    }

    const filePath = path.join(dir, "users", encodeToken("user-1"), "events.log");
    expect(writeSpy).toHaveBeenCalled();
    await log.flush();
    expect(fs.existsSync(filePath)).toBe(true);
    expect(readPersistedEvents(filePath).length).toBeGreaterThan(0);
  });

  it("caps pending persisted backlog and emits a warning when dropping lines", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const log = new EventLog(100, dir);
    const internals = log as unknown as EventLogInternals;
    const largePayload = "x".repeat(2_000_000);

    for (let i = 0; i < 10; i++) {
      await log.append("user-1", {
        type: "turn.completed",
        session: "sess-1",
        thread_id: "th-1",
        payload: { i, blob: largePayload },
      });
    }

    const listed = await log.listSince("user-1", null);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.events).toContainEqual(expect.objectContaining({
        type: "warning",
        payload: expect.objectContaining({
          kind: "event_log_backlog_overflow",
        }),
      }));
    }

    expect(internals.pendingBytes.get("user-1") ?? 0).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(internals.pendingLines.get("user-1")?.length ?? 0).toBeLessThanOrEqual(1000);
  });
});

describe("EventRingBuffer", () => {
  it("returns correct slices for retained cursors and reports rotated ids", () => {
    const retention = 200;
    const ring = new EventRingBuffer(retention);
    for (let i = 1; i <= retention * 2; i++) {
      ring.push(makeEvent(i, i % 2 === 0 ? "turn.completed" : "item.agent_message_delta"));
    }

    expect(ring.length).toBe(retention);
    expect(ring.oldestId()).toBe("evt-201");

    let seed = 7;
    for (let i = 0; i < 12; i++) {
      seed = (seed * 48271) % 2147483647;
      const cursor = 201 + (seed % (retention - 1));
      const listed = ring.listSince(`evt-${cursor}`);
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        const expectedIds = Array.from({ length: 400 - cursor }, (_, offset) => `evt-${cursor + offset + 1}`);
        expect(listed.events.map((event) => event.id)).toEqual(expectedIds);
      }
    }

    expect(ring.listSince("evt-200")).toEqual({
      ok: false,
      reason: "id_rotated",
      oldest_available_id: "evt-201",
    });
    expect(ring.listSince("evt-401")).toEqual({
      ok: false,
      reason: "invalid_since",
    });
  });

  it("appends 100k events without quadratic slowdown", () => {
    const ring = new EventRingBuffer(10_000);
    const start = performance.now();

    for (let i = 1; i <= 100_000; i++) {
      ring.push(makeEvent(i));
    }

    const elapsedMs = performance.now() - start;
    expect(ring.length).toBe(10_000);
    expect(ring.oldestId()).toBe("evt-90001");
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("isDeltaType", () => {
  it("recognizes *_delta event types", () => {
    expect(isDeltaType("item.agent_message_delta")).toBe(true);
    expect(isDeltaType("turn.completed")).toBe(false);
  });
});

describe("event type constants", () => {
  it("exports integration event names centrally", () => {
    expect(APPROVAL_REQUEST_CANCELLED_EVENT_TYPE).toBe("approval.request_cancelled");
    expect(AUTO_APPROVED_EVENT_TYPE).toBe("auto_approved");
    expect(SESSION_CLOSED_EVENT_TYPE).toBe("session.closed");
    expect(SESSION_CRASHED_EVENT_TYPE).toBe("session.crashed");
    expect(SESSION_PENDING_DROPPED_EVENT_TYPE).toBe("session.pending_dropped");
    expect(USER_INPUT_REQUEST_CANCELLED_EVENT_TYPE).toBe("user_input.request_cancelled");
  });
});
