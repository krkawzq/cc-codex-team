import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadFork: vi.fn(),
  threadIdOf: vi.fn((resp: { thread: { id: string } }) => resp.thread.id),
  threadList: vi.fn(),
  threadRead: vi.fn(),
  threadResume: vi.fn(),
  threadSetName: vi.fn(),
  threadStart: vi.fn(),
  threadUnsubscribe: vi.fn(),
  turnInterrupt: vi.fn(),
}));

import { sessionNew } from "../src/daemon/handlers/session";
import { threadSetName, threadStart } from "../src/codex/rpc";
import { PendingRegistry } from "../src/daemon/pending";
import { wireDaemonEvents } from "../src/daemon/wire";
import { logger } from "../src/logger";

function makeReq(positionals: string[], flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "session:new",
    bearer: "user-1",
    params: {
      positionals,
      flags,
    },
  };
}

function makeContext(configValues: Record<string, unknown> = {}) {
  const client = {};
  return {
    users: {
      has: vi.fn().mockReturnValue(true),
      touch: vi.fn(),
    },
    sessions: {
      get: vi.fn().mockReturnValue(null),
      add: vi.fn(),
    },
    pool: {
      acquire: vi.fn().mockResolvedValue(client),
      release: vi.fn(),
    },
    config: {
      getEffective: vi.fn((key: string) => configValues[key] ?? null),
    },
    retryOptions: vi.fn().mockReturnValue({}),
  };
}

describe("session auto-approve defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(threadStart).mockResolvedValue({
      thread: { id: "th-1" },
    } as never);
    vi.mocked(threadSetName).mockResolvedValue(undefined as never);
  });

  it("inherits daemon default auto-approve patterns when the session flag is omitted", async () => {
    const ctx = makeContext({
      "session.auto_approve_command_patterns": "git,npm,node *",
    });

    await sessionNew(ctx as never, makeReq(["sess-1"]) as never);

    expect(ctx.sessions.add).toHaveBeenCalledWith("user-1", expect.objectContaining({
      autoApprovePatterns: ["git", "npm", "node *"],
    }));
  });

  it("treats an explicit empty --auto-approve as an opt-out of daemon defaults", async () => {
    const ctx = makeContext({
      "session.auto_approve_command_patterns": "git,npm,node *",
    });

    await sessionNew(ctx as never, makeReq(["sess-1"], {
      "auto-approve": "",
    }) as never);

    expect(ctx.sessions.add).toHaveBeenCalledWith("user-1", expect.objectContaining({
      autoApprovePatterns: [],
    }));
  });
});

class FakePool extends EventEmitter {
  clientById = vi.fn();
}

class MemoryEvents {
  entries: Array<{ user: string; type: string; session: string | null; thread_id: string | null; payload: Record<string, unknown> }> = [];

  async append(user: string, event: { type: string; session: string | null; thread_id: string | null; payload: Record<string, unknown> }): Promise<void> {
    this.entries.push({ user, ...event });
  }
}

function makeWireContext(patterns: string[]) {
  const pool = new FakePool();
  const events = new MemoryEvents();
  const pending = new PendingRegistry();
  const client = {
    respondAck: vi.fn().mockResolvedValue({ backpressured: false }),
  };
  pool.clientById.mockReturnValue(client);
  return {
    pool,
    client,
    events,
    pending,
    ctx: {
      pool,
      sessions: {
        get: vi.fn().mockReturnValue({
          name: "sess-1",
          thread_id: "th-1",
          state: "live",
          autoApprovePatterns: patterns,
          experimental_tools: [],
        }),
        update: vi.fn(),
        remove: vi.fn(),
      },
      events,
      queues: {
        setCurrentTurn: vi.fn(),
        onTurnCompleted: vi.fn().mockResolvedValue({ turn_id: null, queue_id: null, failed: false }),
        isTeardown: vi.fn().mockReturnValue(false),
        onClientClosed: vi.fn(),
        dispose: vi.fn(),
      },
      pending,
      retryOptions: vi.fn().mockReturnValue({}),
    },
  };
}

describe("daemon auto-approve flow", () => {
  it("short-circuits matching approval requests and emits auto_approved", async () => {
    const { pool, client, events, pending, ctx } = makeWireContext(["git*"]);

    wireDaemonEvents(ctx as never);

    pool.emit("server_request", {
      user: "user-1",
      clientId: "client-1",
      request: {
        id: 5,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "th-1",
          turnId: "turn-1",
          itemId: "item-1",
          command: "git status",
          permissions: { fileSystem: { write: ["/tmp"] } },
        },
      },
      respond: vi.fn(),
      respondError: vi.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(client.respondAck).toHaveBeenCalledWith(5, {
      permissions: { fileSystem: { write: ["/tmp"] } },
      scope: "session",
    });
    expect(pending.listForUser("user-1")).toHaveLength(0);
    expect(events.entries).toContainEqual(expect.objectContaining({
      user: "user-1",
      type: "auto_approved",
      session: "sess-1",
      thread_id: "th-1",
      payload: expect.objectContaining({
        kind: "approval.permissions",
        matched_pattern: "git*",
        command_preview: "git status",
        decision: "accept-session",
      }),
    }));
  });

  it("keeps non-matching approval requests pending", async () => {
    const { pool, client, events, pending, ctx } = makeWireContext(["npm"]);

    wireDaemonEvents(ctx as never);

    pool.emit("server_request", {
      user: "user-1",
      clientId: "client-1",
      request: {
        id: 7,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "th-1",
          turnId: "turn-1",
          itemId: "item-1",
          command: "git status",
          permissions: { fileSystem: { write: ["/tmp"] } },
        },
      },
      respond: vi.fn(),
      respondError: vi.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(client.respondAck).not.toHaveBeenCalled();
    expect(pending.listForUser("user-1")).toHaveLength(1);
    expect(events.entries).toContainEqual(expect.objectContaining({
      user: "user-1",
      type: "approval.permissions",
      session: "sess-1",
      thread_id: "th-1",
    }));
    expect(events.entries.some((entry) => entry.type === "auto_approved")).toBe(false);
  });

  it("logs and keeps requests pending when a stored pattern throws during matching", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { pool, client, events, pending, ctx } = makeWireContext(["/unterminated"]);

    wireDaemonEvents(ctx as never);

    pool.emit("server_request", {
      user: "user-1",
      clientId: "client-1",
      request: {
        id: 8,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "th-1",
          turnId: "turn-2",
          itemId: "item-2",
          command: "git status",
          permissions: { fileSystem: { write: ["/tmp"] } },
        },
      },
      respond: vi.fn(),
      respondError: vi.fn(),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(client.respondAck).not.toHaveBeenCalled();
    expect(pending.listForUser("user-1")).toHaveLength(1);
    expect(events.entries).toContainEqual(expect.objectContaining({
      user: "user-1",
      type: "approval.permissions",
      session: "sess-1",
      thread_id: "th-1",
    }));
    expect(warn).toHaveBeenCalledWith(
      "auto-approve pattern match failed; ignoring pattern",
      expect.objectContaining({
        pattern: "/unterminated",
      }),
    );
  });
});
