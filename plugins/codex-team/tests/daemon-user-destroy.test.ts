import { describe, expect, it, vi } from "vitest";

import { daemonUserDestroy } from "../src/daemon/handlers/daemon";

function makeReq(token: string) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "daemon:user:destroy",
    params: {
      positionals: [token],
      flags: {},
    },
  };
}

describe("daemon:user:destroy", () => {
  it("cleans runtime state before deleting the user", async () => {
    const pendingClient = { respondError: vi.fn() };
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        destroy: vi.fn(),
      },
      pending: {
        removeForUser: vi.fn().mockReturnValue([
          { client: pendingClient, jsonrpc_id: 7 },
          { client: pendingClient, jsonrpc_id: 8 },
        ]),
      },
      pool: {
        closeUser: vi.fn().mockResolvedValue(undefined),
      },
      sessions: {
        clearUser: vi.fn().mockResolvedValue([
          { name: "sess-1" },
          { name: "sess-2" },
        ]),
      },
      queues: {
        dispose: vi.fn(),
      },
      events: {
        clearUser: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = await daemonUserDestroy(ctx as never, makeReq("user-1") as never);

    expect(ctx.pending.removeForUser).toHaveBeenCalledWith("user-1");
    expect(ctx.pool.closeUser).toHaveBeenCalledWith("user-1");
    expect(ctx.sessions.clearUser).toHaveBeenCalledWith("user-1");
    expect(ctx.queues.dispose).toHaveBeenNthCalledWith(1, "user-1::sess-1");
    expect(ctx.queues.dispose).toHaveBeenNthCalledWith(2, "user-1::sess-2");
    expect(ctx.events.clearUser).toHaveBeenCalledWith("user-1");
    expect(pendingClient.respondError).toHaveBeenCalledWith(7, -32000, "user destroyed");
    expect(pendingClient.respondError).toHaveBeenCalledWith(8, -32000, "user destroyed");
    expect(ctx.users.destroy).toHaveBeenCalledWith("user-1");
    expect(result).toEqual({
      destroyed: "user-1",
      sessions_closed: 2,
      pending_canceled: 2,
    });
  });
});
