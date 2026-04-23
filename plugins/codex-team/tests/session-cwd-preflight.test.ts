import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadArchive: vi.fn(),
  threadFork: vi.fn(),
  threadIdOf: vi.fn((resp: { thread: { id: string } }) => resp.thread.id),
  threadLoadedList: vi.fn(),
  threadList: vi.fn(),
  threadRename: vi.fn(),
  threadRead: vi.fn(),
  threadResume: vi.fn(),
  threadSetName: vi.fn(),
  threadStart: vi.fn(),
  threadTurnsList: vi.fn(),
  threadUnarchive: vi.fn(),
  threadUnsubscribe: vi.fn(),
  turnInterrupt: vi.fn(),
}));

import { threadFork, threadSetName, threadStart } from "../src/codex/rpc";
import { sessionFork, sessionNew } from "../src/daemon/handlers/session";

function makeReq(method: string, positionals: string[], flags: Record<string, unknown> = {}) {
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

function makeNewContext() {
  const client = { kind: "client" };
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
      getEffective: vi.fn().mockReturnValue(null),
    },
    retryOptions: vi.fn().mockReturnValue({}),
  };
}

function makeForkContext(source: Record<string, unknown>) {
  return {
    users: {
      has: vi.fn().mockReturnValue(true),
    },
    sessions: {
      get: vi.fn((_user: string, identifier: string) => (identifier === "sess-1" ? source : null)),
      add: vi.fn(),
    },
    pool: {
      acquire: vi.fn().mockResolvedValue({ kind: "fork-client" }),
      release: vi.fn(),
    },
    retryOptions: vi.fn().mockReturnValue({}),
  };
}

describe("session cwd preflight", () => {
  const tmpRoots: string[] = [];
  const permissionTest = process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)
    ? it.skip
    : it;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tmpRoots.splice(0, tmpRoots.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkTmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-cwd-preflight-"));
    tmpRoots.push(dir);
    return dir;
  }

  it("rejects session:new when --cwd points to an existing file", async () => {
    const ctx = makeNewContext();
    const tmpRoot = mkTmpRoot();
    const target = path.join(tmpRoot, "not-a-dir");
    fs.writeFileSync(target, "stub");

    await expect(sessionNew(ctx as never, makeReq("session:new", ["sess-1"], {
      cwd: target,
    }) as never)).rejects.toMatchObject({
      code: "invalid_params",
      message: `cwd '${target}' is not a directory (it is a file)`,
    });

    expect(ctx.pool.acquire).not.toHaveBeenCalled();
    expect(vi.mocked(threadStart)).not.toHaveBeenCalled();
  });

  it("rejects session:new when --cwd does not exist", async () => {
    const ctx = makeNewContext();
    const tmpRoot = mkTmpRoot();
    const target = path.join(tmpRoot, "missing");

    await expect(sessionNew(ctx as never, makeReq("session:new", ["sess-1"], {
      cwd: target,
    }) as never)).rejects.toMatchObject({
      code: "invalid_params",
      message: `cwd '${target}' does not exist`,
    });

    expect(ctx.pool.acquire).not.toHaveBeenCalled();
    expect(vi.mocked(threadStart)).not.toHaveBeenCalled();
  });

  permissionTest("rejects session:new when --cwd is not accessible", async () => {
    const ctx = makeNewContext();
    const tmpRoot = mkTmpRoot();
    const target = path.join(tmpRoot, "locked");
    fs.mkdirSync(target);
    fs.chmodSync(target, 0o000);

    try {
      await expect(sessionNew(ctx as never, makeReq("session:new", ["sess-1"], {
        cwd: target,
      }) as never)).rejects.toMatchObject({
        code: "invalid_params",
        message: `cwd '${target}' is not accessible (permission denied or similar)`,
      });
    } finally {
      fs.chmodSync(target, 0o700);
    }

    expect(ctx.pool.acquire).not.toHaveBeenCalled();
    expect(vi.mocked(threadStart)).not.toHaveBeenCalled();
  });

  it("resolves relative --cwd to an absolute path before starting the session", async () => {
    const ctx = makeNewContext();
    const tmpRoot = mkTmpRoot();
    const target = path.join(tmpRoot, "relative-target");
    const relativeTarget = path.relative(process.cwd(), target);
    fs.mkdirSync(target);
    vi.mocked(threadStart).mockResolvedValue({
      thread: { id: "th-relative" },
    } as never);
    vi.mocked(threadSetName).mockResolvedValue(undefined as never);

    await sessionNew(ctx as never, makeReq("session:new", ["sess-1"], {
      cwd: relativeTarget,
    }) as never);

    expect(vi.mocked(threadStart)).toHaveBeenCalledWith(
      { kind: "client" },
      expect.objectContaining({ cwd: target }),
      {},
    );
    expect(ctx.sessions.add).toHaveBeenCalledWith("user-1", expect.objectContaining({
      cwd: target,
    }));
  });

  it("still starts a session when --cwd points at an existing directory", async () => {
    const ctx = makeNewContext();
    const tmpRoot = mkTmpRoot();
    const target = path.join(tmpRoot, "project");
    fs.mkdirSync(target);
    vi.mocked(threadStart).mockResolvedValue({
      thread: { id: "th-ok" },
    } as never);
    vi.mocked(threadSetName).mockResolvedValue(undefined as never);

    const result = await sessionNew(ctx as never, makeReq("session:new", ["sess-1"], {
      cwd: target,
    }) as never);

    expect(result).toMatchObject({
      session: {
        name: "sess-1",
        thread_id: "th-ok",
        cwd: target,
      },
    });
    expect(ctx.pool.acquire).toHaveBeenCalledTimes(1);
    expect(ctx.sessions.add).toHaveBeenCalledWith("user-1", expect.objectContaining({
      cwd: target,
    }));
  });

  it("rejects session:fork when the source cwd was replaced with a file", async () => {
    const tmpRoot = mkTmpRoot();
    const target = path.join(tmpRoot, "session-root");
    fs.mkdirSync(target);
    fs.rmSync(target, { recursive: true, force: true });
    fs.writeFileSync(target, "replaced");
    const ctx = makeForkContext({
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      cwd: target,
      autoApprovePatterns: [],
    });

    await expect(sessionFork(ctx as never, makeReq("session:fork", ["sess-1", "sess-2"]) as never)).rejects.toMatchObject({
      code: "invalid_params",
      message: `source session's cwd '${target}' is no longer a directory`,
    });

    expect(ctx.pool.acquire).not.toHaveBeenCalled();
    expect(vi.mocked(threadFork)).not.toHaveBeenCalled();
  });
});
