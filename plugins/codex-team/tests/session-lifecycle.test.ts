import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadArchive: vi.fn(),
  threadFork: vi.fn(),
  threadIdOf: vi.fn((resp: { thread: { id: string } }) => resp.thread.id),
  threadList: vi.fn(),
  threadRead: vi.fn(),
  threadRename: vi.fn(),
  threadResume: vi.fn(),
  threadSetName: vi.fn(),
  threadStart: vi.fn(),
  threadTurnsList: vi.fn(),
  threadUnarchive: vi.fn(),
  threadUnsubscribe: vi.fn(),
  turnInterrupt: vi.fn(),
}));

import {
  sessionArchive,
  sessionInfo,
  sessionRenameExtended,
  sessionRollback,
  sessionUnarchive,
} from "../src/daemon/handlers/session";
import {
  threadArchive,
  threadFork,
  threadRead,
  threadRename,
  threadResume,
  threadTurnsList,
  threadUnarchive,
  threadUnsubscribe,
} from "../src/codex/rpc";

interface TestSessionRecord {
  name: string;
  thread_id: string;
  state: "live" | "crashed";
  cwd?: string;
  model?: string;
  sandbox?: string;
  approval?: string;
  effort?: string;
  experimental_tools?: string[];
  autoApprovePatterns?: string[];
}

function makeReq(
  method: string,
  positionals: string[],
  flags: Record<string, unknown> = {},
) {
  return {
    kind: "request" as const,
    id: "req-1",
    method,
    bearer: "user-1",
    params: {
      positionals,
      flags,
    },
  };
}

function makeSessionStore(initial: TestSessionRecord[] = []) {
  const byName = new Map<string, TestSessionRecord>();
  const byThreadId = new Map<string, TestSessionRecord>();
  for (const record of initial) {
    byName.set(record.name, record);
    byThreadId.set(record.thread_id, record);
  }

  return {
    get: vi.fn((_user: string, identifier: string) => byName.get(identifier) ?? byThreadId.get(identifier) ?? null),
    add: vi.fn((_user: string, record: TestSessionRecord) => {
      byName.set(record.name, record);
      byThreadId.set(record.thread_id, record);
    }),
    remove: vi.fn((_user: string, name: string) => {
      const record = byName.get(name) ?? null;
      if (!record) return null;
      byName.delete(record.name);
      byThreadId.delete(record.thread_id);
      return record;
    }),
    findLiveAnywhere: vi.fn((threadId: string) => {
      const record = byThreadId.get(threadId);
      return record ? { user: "user-1", record } : null;
    }),
    findUniqueLiveByNameAnywhere: vi.fn((name: string) => {
      const record = byName.get(name);
      return record ? { user: "user-1", record } : null;
    }),
    touch: vi.fn(),
  };
}

function makeCtx(initial: TestSessionRecord[] = []) {
  const sessions = makeSessionStore(initial);
  return {
    users: {
      has: vi.fn().mockReturnValue(true),
      touch: vi.fn(),
    },
    sessions,
    pool: {
      clientForSession: vi.fn().mockReturnValue(null),
      acquire: vi.fn(),
      acquireForAdhoc: vi.fn().mockResolvedValue({ kind: "adhoc-client" }),
      release: vi.fn(),
      rekeySession: vi.fn(),
    },
    queues: {
      beginTeardown: vi.fn().mockResolvedValue({ currentTurnId: null }),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    },
    pending: {
      listForUser: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
    },
    events: {
      append: vi.fn().mockResolvedValue(undefined),
    },
    config: {
      getEffective: vi.fn().mockReturnValue(null),
    },
    retryOptions: vi.fn().mockReturnValue({}),
  };
}

describe("session lifecycle handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects archive on a live session without --and-detach", async () => {
    const ctx = makeCtx([
      { name: "audit", thread_id: "th-live", state: "live", autoApprovePatterns: [] },
    ]);

    await expect(sessionArchive(ctx as never, makeReq("session:archive", ["audit"]) as never)).rejects.toMatchObject({
      code: "invalid_params",
      message: "session is live; pass --and-detach or run `session detach` first",
    });
  });

  it("archives a live session after hard-detaching it and session info reports the archived thread", async () => {
    vi.mocked(threadArchive).mockResolvedValue(undefined as never);
    vi.mocked(threadUnsubscribe).mockResolvedValue(undefined as never);
    vi.mocked(threadRead).mockResolvedValue({
      thread: { id: "th-live", name: "audit", status: { type: "archived" } },
    } as never);

    const ctx = makeCtx([
      { name: "audit", thread_id: "th-live", state: "live", autoApprovePatterns: [] },
    ]);
    const liveClient = { kind: "live-client" };
    ctx.pool.clientForSession.mockReturnValue(liveClient);

    const archived = await sessionArchive(ctx as never, makeReq("session:archive", ["audit"], {
      "and-detach": true,
    }) as never);
    const info = await sessionInfo(ctx as never, makeReq("session:info", ["th-live"]) as never);

    expect(archived).toMatchObject({ thread_id: "th-live", archived: true, detached: true });
    expect(vi.mocked(threadUnsubscribe)).toHaveBeenCalledWith(liveClient, "th-live", {});
    expect(vi.mocked(threadArchive)).toHaveBeenCalledWith({ kind: "adhoc-client" }, "th-live", {});
    expect(info).toMatchObject({
      session: null,
      live: false,
      thread: { id: "th-live", status: { type: "archived" } },
    });
  });

  it("archives a detached thread via an adhoc client", async () => {
    vi.mocked(threadArchive).mockResolvedValue(undefined as never);
    vi.mocked(threadRead).mockResolvedValue({
      thread: { id: "th-detached", name: "audit" },
    } as never);

    const ctx = makeCtx();
    const result = await sessionArchive(ctx as never, makeReq("session:archive", ["th-detached"]) as never);

    expect(result).toMatchObject({ thread_id: "th-detached", archived: true });
    expect(vi.mocked(threadArchive)).toHaveBeenCalledWith({ kind: "adhoc-client" }, "th-detached", {});
  });

  it("unarchives an archived detached thread", async () => {
    vi.mocked(threadRead).mockResolvedValue({
      thread: { id: "th-archived", name: "audit", status: { type: "archived" } },
    } as never);
    vi.mocked(threadUnarchive).mockResolvedValue(undefined as never);

    const ctx = makeCtx();
    const result = await sessionUnarchive(ctx as never, makeReq("session:unarchive", ["th-archived"]) as never);

    expect(result).toMatchObject({ thread_id: "th-archived", unarchived: true });
    expect(vi.mocked(threadUnarchive)).toHaveBeenCalledWith({ kind: "adhoc-client" }, "th-archived", {});
  });

  it("refuses to unarchive a live session", async () => {
    const ctx = makeCtx([
      { name: "audit", thread_id: "th-live", state: "live", autoApprovePatterns: [] },
    ]);

    await expect(sessionUnarchive(ctx as never, makeReq("session:unarchive", ["th-live"]) as never)).rejects.toMatchObject({
      code: "invalid_params",
      message: "thread is live; unarchive applies only to detached archived threads",
    });
  });

  it("renames a detached thread when --detached-ok is passed", async () => {
    vi.mocked(threadRead).mockResolvedValue({
      thread: { id: "th-detached", name: "audit" },
    } as never);
    vi.mocked(threadRename).mockResolvedValue(undefined as never);

    const ctx = makeCtx();
    const result = await sessionRenameExtended(ctx as never, makeReq("session:rename", ["th-detached", "audit-review"], {
      "detached-ok": true,
    }) as never);

    expect(result).toMatchObject({
      session: { name: "audit-review" },
      thread_id: "th-detached",
      detached: true,
    });
    expect(vi.mocked(threadRename)).toHaveBeenCalledWith({ kind: "adhoc-client" }, "th-detached", "audit-review", {});
  });

  it("keeps rename without --detached-ok on detached threads as the previous error path", async () => {
    const ctx = makeCtx();

    await expect(sessionRenameExtended(ctx as never, makeReq("session:rename", ["th-detached", "audit-review"]) as never)).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(vi.mocked(threadRename)).not.toHaveBeenCalled();
  });

  it("rolls back a live session by forking, detaching, archiving the source, and reattaching the fork", async () => {
    vi.mocked(threadTurnsList).mockResolvedValue({
      data: [{ id: "turn-1", status: "completed" }],
      nextCursor: null,
    } as never);
    vi.mocked(threadFork).mockResolvedValue({
      thread: { id: "th-new" },
    } as never);
    vi.mocked(threadUnsubscribe).mockResolvedValue(undefined as never);
    vi.mocked(threadRename).mockResolvedValue(undefined as never);
    vi.mocked(threadArchive).mockResolvedValue(undefined as never);
    vi.mocked(threadResume).mockResolvedValue({
      thread: { id: "th-new", cwd: "/repo" },
    } as never);

    const ctx = makeCtx([
      {
        name: "audit",
        thread_id: "th-old",
        state: "live",
        cwd: "/repo",
        model: "gpt-5.4",
        sandbox: "workspace-write",
        approval: "on-request",
        effort: "high",
        experimental_tools: ["ask-user-question"],
        autoApprovePatterns: ["git*"],
      },
    ]);
    const liveClient = { kind: "live-client" };
    const newClient = { kind: "new-client" };
    ctx.pool.clientForSession.mockReturnValue(liveClient);
    ctx.pool.acquire.mockResolvedValue(newClient);

    const result = await sessionRollback(ctx as never, makeReq("session:rollback", ["audit"], {
      "to-turn": "turn-1",
    }) as never);

    expect(result).toMatchObject({
      name: "audit",
      old_thread_id: "th-old",
      new_thread_id: "th-new",
      forked_at_turn: "turn-1",
    });
    expect(vi.mocked(threadFork)).toHaveBeenCalledWith(liveClient, "th-old", "turn-1", {});
    expect(vi.mocked(threadUnsubscribe)).toHaveBeenCalledWith(liveClient, "th-old", {});
    expect(vi.mocked(threadRename)).toHaveBeenNthCalledWith(
      1,
      { kind: "adhoc-client" },
      "th-old",
      expect.stringMatching(/^audit-pre-rollback-/),
      {},
    );
    expect(vi.mocked(threadArchive)).toHaveBeenCalledWith({ kind: "adhoc-client" }, "th-old", {});
    expect(vi.mocked(threadRename)).toHaveBeenNthCalledWith(
      2,
      { kind: "adhoc-client" },
      "th-new",
      "audit",
      {},
    );
    expect(ctx.pool.acquire).toHaveBeenCalledWith("user-1", "user-1::audit", {
      configOverrides: ["features.default_mode_request_user_input=true"],
    });
    expect(vi.mocked(threadResume)).toHaveBeenCalledWith(newClient, "th-new", {});
    expect(ctx.sessions.add).toHaveBeenCalledWith("user-1", expect.objectContaining({
      name: "audit",
      thread_id: "th-new",
      sandbox: "workspace-write",
      approval: "on-request",
      effort: "high",
      experimental_tools: ["ask-user-question"],
      autoApprovePatterns: ["git*"],
    }));
  });

  it("rejects rollback when the source session has no completed turns", async () => {
    vi.mocked(threadTurnsList).mockResolvedValue({
      data: [],
      nextCursor: null,
    } as never);

    const ctx = makeCtx([
      { name: "audit", thread_id: "th-old", state: "live", autoApprovePatterns: [] },
    ]);
    ctx.pool.clientForSession.mockReturnValue({ kind: "live-client" });

    await expect(sessionRollback(ctx as never, makeReq("session:rollback", ["audit"], {
      "to-turn": "turn-1",
    }) as never)).rejects.toMatchObject({
      code: "invalid_params",
      message: "session has no completed turns yet; rollback requires a completed turn from `message history`",
    });
    expect(vi.mocked(threadFork)).not.toHaveBeenCalled();
  });

  it("supports rollback --detach-after without creating a new live session", async () => {
    vi.mocked(threadTurnsList).mockResolvedValue({
      data: [{ id: "turn-1", status: "completed" }],
      nextCursor: null,
    } as never);
    vi.mocked(threadFork).mockResolvedValue({
      thread: { id: "th-new" },
    } as never);
    vi.mocked(threadUnsubscribe).mockResolvedValue(undefined as never);
    vi.mocked(threadRename).mockResolvedValue(undefined as never);
    vi.mocked(threadArchive).mockResolvedValue(undefined as never);

    const ctx = makeCtx([
      {
        name: "audit",
        thread_id: "th-old",
        state: "live",
        cwd: "/repo",
        autoApprovePatterns: ["git*"],
      },
    ]);
    ctx.pool.clientForSession.mockReturnValue({ kind: "live-client" });

    const result = await sessionRollback(ctx as never, makeReq("session:rollback", ["audit"], {
      "to-turn": "turn-1",
      "detach-after": true,
    }) as never);

    expect(result).toMatchObject({
      name: "audit",
      old_thread_id: "th-old",
      new_thread_id: "th-new",
      forked_at_turn: "turn-1",
      detach_after: true,
    });
    expect(ctx.pool.acquire).not.toHaveBeenCalled();
    expect(vi.mocked(threadResume)).not.toHaveBeenCalled();
    expect(ctx.sessions.add).not.toHaveBeenCalled();
  });
});
