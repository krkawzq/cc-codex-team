import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorStore } from "../src/daemon/cursors";
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
