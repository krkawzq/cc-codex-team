import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorStore } from "../src/daemon/cursors";
import { EventLog } from "../src/daemon/events";
import { daemonUserDestroy } from "../src/daemon/handlers/daemon";
import { encodeToken } from "../src/paths";
import { SessionRegistry } from "../src/daemon/sessions";
import { UserRegistry } from "../src/daemon/users";

function makeReq(token: string, flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "daemon:user:destroy",
    params: {
      positionals: [token],
      flags,
    },
  };
}

describe("daemon:user:destroy", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("destroys a user when no live sessions remain", async () => {
    const pendingClient = { respondError: vi.fn() };
    const pendingEntries = [
      {
        request_id: "req-1",
        kind: "approval.permissions",
        user: "user-1",
        session_name: "sess-1",
        thread_id: "th-1",
        turn_id: "turn-1",
        jsonrpc_id: 7,
        client: pendingClient,
        raw: {},
        created_at: "2025-01-01T00:00:00.000Z",
      },
      {
        request_id: "req-2",
        kind: "user_input.request",
        user: "user-1",
        session_name: "sess-2",
        thread_id: "th-2",
        turn_id: "turn-2",
        jsonrpc_id: 8,
        client: pendingClient,
        raw: {},
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ];
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        destroy: vi.fn(),
      },
      pending: {
        listForUser: vi.fn().mockReturnValue(pendingEntries),
        remove: vi.fn((requestId: string) => pendingEntries.find((entry) => entry.request_id === requestId) ?? null),
      },
      pool: {
        closeUser: vi.fn().mockResolvedValue(undefined),
      },
      sessions: {
        listLive: vi.fn().mockReturnValue([]),
        clearUser: vi.fn().mockResolvedValue([
          { name: "sess-1" },
          { name: "sess-2" },
        ]),
      },
      queues: {
        dispose: vi.fn(),
      },
      events: {
        append: vi.fn().mockResolvedValue(undefined),
        clearUser: vi.fn().mockResolvedValue(undefined),
      },
      cursors: {
        clearUser: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await daemonUserDestroy(ctx as never, makeReq("user-1") as never);

    expect(ctx.sessions.listLive).toHaveBeenCalledWith("user-1");
    expect(ctx.pending.listForUser).toHaveBeenCalledWith("user-1");
    expect(ctx.pool.closeUser).toHaveBeenCalledWith("user-1");
    expect(ctx.sessions.clearUser).toHaveBeenCalledWith("user-1");
    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "approval.request_cancelled",
      session: "sess-1",
      thread_id: "th-1",
      payload: expect.objectContaining({
        request_id: "req-1",
        reason: "user_destroyed",
      }),
    }));
    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "user_input.request_cancelled",
      session: "sess-2",
      thread_id: "th-2",
      payload: expect.objectContaining({
        request_id: "req-2",
        reason: "user_destroyed",
      }),
    }));
    expect(ctx.events.append).toHaveBeenNthCalledWith(1, "user-1", expect.objectContaining({
      type: "approval.request_cancelled",
    }));
    expect(ctx.events.append).toHaveBeenNthCalledWith(2, "user-1", expect.objectContaining({
      type: "user_input.request_cancelled",
    }));
    expect(ctx.events.append).toHaveBeenNthCalledWith(3, "user-1", expect.objectContaining({
      type: "session.closed",
      session: "sess-1",
      payload: expect.objectContaining({ reason: "user_destroyed" }),
    }));
    expect(ctx.events.append).toHaveBeenNthCalledWith(4, "user-1", expect.objectContaining({
      type: "session.closed",
      session: "sess-2",
      payload: expect.objectContaining({ reason: "user_destroyed" }),
    }));
    expect(ctx.queues.dispose).toHaveBeenNthCalledWith(1, "user-1::sess-1");
    expect(ctx.queues.dispose).toHaveBeenNthCalledWith(2, "user-1::sess-2");
    expect(ctx.events.clearUser).toHaveBeenCalledWith("user-1");
    expect(ctx.cursors.clearUser).toHaveBeenCalledWith("user-1");
    expect(pendingClient.respondError).toHaveBeenCalledWith(7, -32000, "user destroyed");
    expect(pendingClient.respondError).toHaveBeenCalledWith(8, -32000, "user destroyed");
    expect(ctx.users.destroy).toHaveBeenCalledWith("user-1");
    expect(result).toEqual({
      destroyed: "user-1",
      sessions_closed: 2,
      pending_canceled: 2,
    });
  });

  it("rejects destroy without --force when live sessions remain", async () => {
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        destroy: vi.fn(),
      },
      pending: {
        listForUser: vi.fn(),
        remove: vi.fn(),
      },
      pool: {
        closeUser: vi.fn(),
      },
      sessions: {
        listLive: vi.fn().mockReturnValue([{ name: "sess-1" }]),
        clearUser: vi.fn(),
      },
      queues: {
        dispose: vi.fn(),
      },
      events: {
        append: vi.fn(),
        clearUser: vi.fn(),
      },
      cursors: {
        clearUser: vi.fn(),
      },
    };

    await expect(daemonUserDestroy(ctx as never, makeReq("user-1") as never))
      .rejects.toMatchObject({ code: "invalid_params" });

    expect(ctx.pending.listForUser).not.toHaveBeenCalled();
    expect(ctx.pool.closeUser).not.toHaveBeenCalled();
    expect(ctx.sessions.clearUser).not.toHaveBeenCalled();
    expect(ctx.users.destroy).not.toHaveBeenCalled();
  });

  it("destroys a user with live sessions when --force is passed", async () => {
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        destroy: vi.fn(),
      },
      pending: {
        listForUser: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
      },
      pool: {
        closeUser: vi.fn().mockResolvedValue(undefined),
      },
      sessions: {
        listLive: vi.fn().mockReturnValue([{ name: "sess-1" }]),
        clearUser: vi.fn().mockResolvedValue([{ name: "sess-1" }]),
      },
      queues: {
        dispose: vi.fn(),
      },
      events: {
        append: vi.fn().mockResolvedValue(undefined),
        clearUser: vi.fn().mockResolvedValue(undefined),
      },
      cursors: {
        clearUser: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await daemonUserDestroy(ctx as never, makeReq("user-1", { force: true }) as never);

    expect(ctx.pool.closeUser).toHaveBeenCalledWith("user-1");
    expect(ctx.sessions.clearUser).toHaveBeenCalledWith("user-1");
    expect(ctx.events.append).toHaveBeenCalledWith("user-1", expect.objectContaining({
      type: "session.closed",
      session: "sess-1",
      payload: expect.objectContaining({ reason: "user_destroyed" }),
    }));
    expect(ctx.queues.dispose).toHaveBeenCalledWith("user-1::sess-1");
    expect(ctx.cursors.clearUser).toHaveBeenCalledWith("user-1");
    expect(ctx.users.destroy).toHaveBeenCalledWith("user-1");
    expect(result).toEqual({
      destroyed: "user-1",
      sessions_closed: 1,
      pending_canceled: 0,
    });
  });

  it("re-creating a destroyed user starts with empty cursor state and does not resurrect cursors.json", async () => {
    vi.useFakeTimers();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-daemon-destroy-"));
    dirs.push(dir);
    const users = new UserRegistry(dir);
    users.create("user-1");
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, dir);
    const cursors = new CursorStore(dir);
    const cursorPath = path.join(dir, "users", encodeToken("user-1"), "cursors.json");

    await cursors.save("user-1", {
      name: "audit-tail",
      event_id: "evt-1",
      auto_update: true,
    });
    cursors.saveBestEffortDebounced("user-1", {
      name: "audit-tail",
      event_id: "evt-2",
      auto_update: true,
    }, 500);

    await daemonUserDestroy({
      users,
      pending: {
        listForUser: () => [],
        remove: () => null,
      },
      pool: {
        closeUser: vi.fn().mockResolvedValue(undefined),
      },
      sessions,
      queues: {
        dispose: vi.fn(),
      },
      events,
      cursors,
    } as never, makeReq("user-1") as never);

    await vi.advanceTimersByTimeAsync(1000);
    users.create("user-1");

    expect(cursors.get("user-1", "audit-tail")).toBeNull();
    expect(fs.existsSync(cursorPath)).toBe(false);
  });

  it("cancels pending debounced cursor flushes during destroy", async () => {
    vi.useFakeTimers();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-daemon-destroy-"));
    dirs.push(dir);
    const users = new UserRegistry(dir);
    users.create("user-1");
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, dir);
    const cursors = new CursorStore(dir);
    const cursorPath = path.join(dir, "users", encodeToken("user-1"), "cursors.json");

    cursors.saveBestEffortDebounced("user-1", {
      name: "audit-tail",
      event_id: "evt-9",
      auto_update: true,
    }, 500);

    await daemonUserDestroy({
      users,
      pending: {
        listForUser: () => [],
        remove: () => null,
      },
      pool: {
        closeUser: vi.fn().mockResolvedValue(undefined),
      },
      sessions,
      queues: {
        dispose: vi.fn(),
      },
      events,
      cursors,
    } as never, makeReq("user-1") as never);

    await vi.advanceTimersByTimeAsync(1000);

    expect(fs.existsSync(cursorPath)).toBe(false);
  });
});
