import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorStore, readCursorLock, reclaimStaleCursorLock, verifyCursorLockOwnership } from "../src/daemon/cursors";
import { cursorDelete, cursorGet, cursorList, cursorSave } from "../src/daemon/handlers/cursor";

function makeReq(method: string, positionals: string[] = [], flags: Record<string, unknown> = {}, bearer = "user-1") {
  return {
    kind: "request" as const,
    id: "req-1",
    method,
    bearer,
    params: {
      positionals,
      flags,
    },
  };
}

describe("CursorStore and cursor handlers", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports save/list/get/delete roundtrips and persists across store re-instantiation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-cursors-"));
    dirs.push(dir);
    const store = new CursorStore(dir);
    const listSince = vi.fn().mockResolvedValue({
      ok: true,
      events: [
        {
          id: "evt-1",
          ts: "2025-01-01T00:00:00.000Z",
          type: "turn.started",
          session: "sess-1",
          thread_id: "th-1",
          payload: {},
        },
        {
          id: "evt-2",
          ts: "2025-01-01T00:00:01.000Z",
          type: "turn.completed",
          session: "sess-1",
          thread_id: "th-1",
          payload: {},
        },
      ],
    });
    const ctx = {
      users: { has: () => true },
      events: { listSince },
      cursors: store,
    };

    const saved = await cursorSave(ctx as never, makeReq("cursor:save", ["audit-tail"]) as never);
    expect(saved).toEqual({
      cursor: expect.objectContaining({
        name: "audit-tail",
        event_id: "evt-2",
        auto_update: true,
        updated_at: expect.any(String),
      }),
    });
    expect(listSince).toHaveBeenCalledWith("user-1", null, { includeDelta: true });

    const listed = await cursorList(ctx as never, makeReq("cursor:list") as never);
    expect(listed).toEqual({
      cursors: [
        expect.objectContaining({
          name: "audit-tail",
          event_id: "evt-2",
          auto_update: true,
        }),
      ],
    });

    const gotten = await cursorGet(ctx as never, makeReq("cursor:get", ["audit-tail"]) as never);
    expect(gotten).toEqual({ event_id: "evt-2" });

    const reloaded = new CursorStore(dir);
    expect(reloaded.list("user-1")).toEqual([
      expect.objectContaining({
        name: "audit-tail",
        event_id: "evt-2",
        auto_update: true,
      }),
    ]);
    expect(reloaded.get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: "evt-2",
      auto_update: true,
    }));

    const deleted = await cursorDelete(ctx as never, makeReq("cursor:delete", ["audit-tail"]) as never);
    expect(deleted).toEqual({ deleted: true, name: "audit-tail" });
    expect(new CursorStore(dir).list("user-1")).toEqual([]);
  });

  it("serializes concurrent saves from different store instances without corrupting the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-cursors-"));
    dirs.push(dir);

    const first = new CursorStore(dir);
    const second = new CursorStore(dir);

    await Promise.all([
      first.save("user-1", { name: "audit-a", event_id: "evt-1", auto_update: true }),
      second.save("user-1", { name: "audit-b", event_id: "evt-2", auto_update: true }),
    ]);

    const reloaded = new CursorStore(dir);
    expect(reloaded.list("user-1")).toEqual([
      expect.objectContaining({ name: "audit-a", event_id: "evt-1" }),
      expect.objectContaining({ name: "audit-b", event_id: "evt-2" }),
    ]);

    const raw = fs.readFileSync(path.join(dir, "users", "dXNlci0x", "cursors.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("reclaims a stale lock file left by a dead process", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-cursors-"));
    dirs.push(dir);
    const store = new CursorStore(dir);
    const userPath = path.join(dir, "users", "dXNlci0x");
    const lockPath = path.join(userPath, "cursors.json.lock");

    fs.mkdirSync(userPath, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      host: "stale-host",
    }));

    await expect(store.save("user-1", {
      name: "audit-tail",
      event_id: "evt-9",
      auto_update: true,
    })).resolves.toMatchObject({
      name: "audit-tail",
      event_id: "evt-9",
    });

    expect(store.get("user-1", "audit-tail")).toEqual(expect.objectContaining({
      name: "audit-tail",
      event_id: "evt-9",
    }));
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("allows only one concurrent stale-lock reclaim to succeed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-cursors-"));
    dirs.push(dir);
    const userPath = path.join(dir, "users", "dXNlci0x");
    const lockPath = path.join(userPath, "cursors.json.lock");

    fs.mkdirSync(userPath, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      host: "stale-host",
    }));

    const [first, second] = await Promise.all([
      reclaimStaleCursorLock(lockPath),
      reclaimStaleCursorLock(lockPath),
    ]);
    const heldLocks = [first, second].filter((lease): lease is NonNullable<typeof lease> => lease !== null);

    expect(heldLocks).toHaveLength(1);
    expect(first === null || second === null).toBe(true);
    expect(await verifyCursorLockOwnership(lockPath, heldLocks[0]!.record)).toBe(true);

    await heldLocks[0]!.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("verifies reclaimed lock ownership and aborts when another record wins the path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-cursors-"));
    dirs.push(dir);
    const userPath = path.join(dir, "users", "dXNlci0x");
    const lockPath = path.join(userPath, "cursors.json.lock");

    fs.mkdirSync(userPath, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      host: "stale-host",
    }));

    const lease = await reclaimStaleCursorLock(lockPath);
    expect(lease).not.toBeNull();
    expect(await readCursorLock(lockPath)).toEqual(expect.objectContaining({
      pid: process.pid,
      nonce: lease!.record.nonce,
    }));
    expect(await verifyCursorLockOwnership(lockPath, lease!.record)).toBe(true);
    await lease!.release();

    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      host: "stale-host",
    }));
    const otherRecord = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      host: "other-host",
      nonce: "other-nonce",
    };
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    let lockReadCount = 0;
    vi.spyOn(fs.promises, "readFile").mockImplementation((async (...args: Parameters<typeof fs.promises.readFile>) => {
      if (args[0] === lockPath) {
        lockReadCount += 1;
        if (lockReadCount === 2) {
          fs.writeFileSync(lockPath, JSON.stringify(otherRecord));
          return JSON.stringify(otherRecord);
        }
      }
      return await originalReadFile(...args);
    }) as typeof fs.promises.readFile);

    await expect(reclaimStaleCursorLock(lockPath)).resolves.toBeNull();
    expect(await readCursorLock(lockPath)).toEqual(expect.objectContaining(otherRecord));
  });

  it("rejects save when the final rename fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-cursors-"));
    dirs.push(dir);
    const store = new CursorStore(dir);

    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));

    await expect(store.save("user-1", {
      name: "audit-tail",
      event_id: "evt-9",
      auto_update: true,
    })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(store.get("user-1", "audit-tail")).toBeNull();
  });
});
