import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMocks = vi.hoisted(() => ({
  threadFork: vi.fn(),
  threadIdOf: vi.fn((resp: { thread: { id: string } }) => resp.thread.id),
  threadList: vi.fn(),
  threadRead: vi.fn(),
  threadResume: vi.fn(),
  threadSetName: vi.fn(),
  threadStart: vi.fn(),
  threadTurnsList: vi.fn(),
  threadUnsubscribe: vi.fn(),
  turnInterrupt: vi.fn(),
  turnSteer: vi.fn(),
}));

const sockMocks = vi.hoisted(() => ({
  connectSock: vi.fn(),
  probeSock: vi.fn(),
  writeMessage: vi.fn(),
  onMessages: vi.fn(),
}));

const processMocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
  spawnSync: vi.fn(() => ({ status: 0, error: undefined })),
}));

vi.mock("../src/codex/rpc", () => rpcMocks);
vi.mock("../src/ipc/sock", () => sockMocks);
vi.mock("node:child_process", () => processMocks);
vi.mock("../src/daemon/config", () => ({
  ConfigStore: class {
    getEffective(key: string) {
      if (key === "daemon.ready_timeout_seconds") return 0.05;
      if (key === "daemon.connect_timeout_seconds") return 5;
      if (key === "daemon.connect_retry_attempts") return 3;
      if (key === "daemon.connect_retry_delay_seconds") return 0.25;
      return null;
    }
    resolvedDataDir() { return "/tmp/cct-cohort-test"; }
    resolvedLogPath() { return "/tmp/cct-cohort-test/daemon.log"; }
    resolvedSockPath() { return "/tmp/cct-cohort-test/daemon.sock"; }
  },
}));

import { parseArgs } from "../src/cli/args";
import { renderHelp } from "../src/cli/help";
import { runCli } from "../src/cli/run";
import { EventLog } from "../src/daemon/events";
import { messageSendMany, messageWait } from "../src/daemon/handlers/message";
import { sessionDetach } from "../src/daemon/handlers/session";
import { SessionRegistry, sessionRuntimeDefaults, type SessionRecord } from "../src/daemon/sessions";
import { formatCompact } from "../src/format/compact";
import { globToRegExp, matchesGlob } from "../src/util/glob";
import { threadUnsubscribe, turnInterrupt } from "../src/codex/rpc";

function makeReq(method: string, positionals: string[], flags: Record<string, unknown> = {}, stdinContent?: string) {
  const params: Record<string, unknown> = {
    positionals,
    flags,
  };
  if (stdinContent !== undefined) params.stdin_content = stdinContent;
  return {
    kind: "request" as const,
    id: "req-1",
    method,
    bearer: "user-1",
    params,
  };
}

function makeLiveRecord(name: string, threadId: string): SessionRecord {
  return {
    name,
    thread_id: threadId,
    state: "live",
    autoApprovePatterns: [],
    created_at: "2025-01-01T00:00:00.000Z",
    last_active_at: "2025-01-01T00:00:00.000Z",
    turn_count: 0,
    ...sessionRuntimeDefaults(),
  };
}

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runCliWithResult(argv: string[], result: unknown): Promise<number> {
  let responseHandler: ((msg: Record<string, unknown>) => void) | undefined;
  const socket = {
    end: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(() => socket),
    once: vi.fn(() => socket),
  };

  sockMocks.probeSock.mockResolvedValue(true);
  sockMocks.connectSock.mockResolvedValue(socket);
  sockMocks.onMessages.mockImplementation((_sock, handler) => {
    responseHandler = handler;
  });
  sockMocks.writeMessage.mockImplementation((_sock, req: { id: string }) => {
    queueMicrotask(() => {
      responseHandler?.({
        kind: "response",
        id: req.id,
        result,
      });
    });
  });

  return await runCli(argv);
}

describe("cohort commands", () => {
  const dirs: string[] = [];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    stdoutSpy.mockRestore();
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("send-many to 3 sessions with one missing returns partial results and exit 1", async () => {
    const live = new Map([
      ["audit", makeLiveRecord("audit", "th-audit")],
      ["lint", makeLiveRecord("lint", "th-lint")],
    ]);
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions: {
        get: vi.fn((_user: string, identifier: string) => live.get(identifier) ?? null),
        touch: vi.fn(),
      },
      pool: {
        clientForSession: vi.fn().mockImplementation(() => ({})),
      },
      queues: {
        sendOrQueue: vi.fn()
          .mockResolvedValueOnce({ started: true, turn_id: "turn-audit", queue_id: null, queued_depth: 0 })
          .mockResolvedValueOnce({ started: true, turn_id: "turn-lint", queue_id: null, queued_depth: 0 }),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await messageSendMany(ctx as never, makeReq(
      "message:send-many",
      ["audit", "lint", "missing", "Run all your pending checks."],
    ) as never) as { results: Array<Record<string, unknown>> };

    expect(result).toEqual({
      results: [
        { session: "audit", turn_id: "turn-audit", started: true, queue_id: null, queued_depth: 0 },
        { session: "lint", turn_id: "turn-lint", started: true, queue_id: null, queued_depth: 0 },
        {
          session: "missing",
          ok: false,
          error: { code: "session_not_found", message: "session 'missing' not live in this user" },
        },
      ],
    });
    expect(ctx.queues.sendOrQueue).toHaveBeenCalledTimes(2);
    expect(formatCompact("message:send-many", result)).toEqual({
      results: [
        { session: "audit", turn_id: "turn-audit", started: true, queue_id: null, queued_depth: 0 },
        { session: "lint", turn_id: "turn-lint", started: true, queue_id: null, queued_depth: 0 },
        { session: "missing", ok: false, error: { code: "session_not_found" } },
      ],
    });
    expect(parseArgs(["-b", "token-1", "message", "send-many", "audit", "lint", "hello"]).commandPath).toEqual(["message", "send-many"]);
    expect(renderHelp(["message", "send-many"])).toContain("Requires at least two explicit targets.");

    await expect(runCliWithResult(
      ["-b", "token-1", "message", "send-many", "audit", "lint", "missing", "Run all your pending checks."],
      result,
    )).resolves.toBe(1);
  });

  it("send-many with --file broadcasts file contents and preserves per-target results", async () => {
    const dir = mkTmpDir("codex-team-cohort-send-many-");
    dirs.push(dir);
    const promptPath = path.join(dir, "brief.md");
    fs.writeFileSync(promptPath, "Use the file payload");

    const live = new Map([
      ["audit", makeLiveRecord("audit", "th-audit")],
      ["lint", makeLiveRecord("lint", "th-lint")],
    ]);
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions: {
        get: vi.fn((_user: string, identifier: string) => live.get(identifier) ?? null),
        touch: vi.fn(),
      },
      pool: {
        clientForSession: vi.fn().mockImplementation(() => ({})),
      },
      queues: {
        sendOrQueue: vi.fn()
          .mockResolvedValueOnce({ started: true, turn_id: "turn-audit", queue_id: null, queued_depth: 0 })
          .mockResolvedValueOnce({ started: false, turn_id: "turn-lint", queue_id: "q-lint", queued_depth: 1 }),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await messageSendMany(ctx as never, makeReq(
      "message:send-many",
      ["audit", "lint", "missing"],
      { file: promptPath },
    ) as never) as { results: Array<Record<string, unknown>> };

    const sentInput = vi.mocked(ctx.queues.sendOrQueue).mock.calls[0]?.[3] as Array<Record<string, unknown>>;
    expect(sentInput).toEqual([{ type: "text", text: "Use the file payload" }]);
    expect(result.results).toEqual([
      { session: "audit", turn_id: "turn-audit", started: true, queue_id: null, queued_depth: 0 },
      { session: "lint", turn_id: "turn-lint", started: false, queue_id: "q-lint", queued_depth: 1 },
      {
        session: "missing",
        ok: false,
        error: { code: "session_not_found", message: "session 'missing' not live in this user" },
      },
    ]);
  });

  it("wait --all returns completed when every target completes and exits 0", async () => {
    const dir = mkTmpDir("codex-team-cohort-wait-all-");
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);
    sessions.add("user-1", makeLiveRecord("audit", "th-audit"));
    sessions.add("user-1", makeLiveRecord("lint", "th-lint"));
    await sessions.flush();

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    const waiting = messageWait(ctx as never, makeReq("message:wait", ["audit", "lint"], { all: true, timeout: "5" }) as never);
    await Promise.resolve();
    await Promise.resolve();

    await events.append("user-1", {
      type: "turn.started",
      session: "audit",
      thread_id: "th-audit",
      payload: { turn_id: "turn-audit" },
    });
    await events.append("user-1", {
      type: "turn.completed",
      session: "audit",
      thread_id: "th-audit",
      payload: { turn_id: "turn-audit", status: "completed" },
    });
    await events.append("user-1", {
      type: "turn.started",
      session: "lint",
      thread_id: "th-lint",
      payload: { turn_id: "turn-lint" },
    });
    await events.append("user-1", {
      type: "turn.completed",
      session: "lint",
      thread_id: "th-lint",
      payload: { turn_id: "turn-lint", status: "completed" },
    });

    const result = await waiting as { outcomes: Array<Record<string, unknown>>; overall: string };
    expect(result).toEqual({
      outcomes: [
        { session: "audit", outcome: "completed", turn_id: "turn-audit" },
        { session: "lint", outcome: "completed", turn_id: "turn-lint" },
      ],
      overall: "completed",
    });
    expect(formatCompact("message:wait", result)).toEqual(result);
    expect(parseArgs(["-b", "token-1", "message", "wait", "--all", "audit", "lint"]).flags.all).toBe(true);
    expect(renderHelp(["message", "wait"])).toContain("--any");

    await expect(runCliWithResult(
      ["-b", "token-1", "message", "wait", "--all", "audit", "lint", "--timeout", "5"],
      result,
    )).resolves.toBe(0);
  });

  it("wait --all returns error when one target errors and exits 1", async () => {
    const dir = mkTmpDir("codex-team-cohort-wait-error-");
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);
    sessions.add("user-1", makeLiveRecord("audit", "th-audit"));
    sessions.add("user-1", makeLiveRecord("lint", "th-lint"));
    await sessions.flush();

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    const waiting = messageWait(ctx as never, makeReq("message:wait", ["audit", "lint"], { all: true, timeout: "5" }) as never);
    await Promise.resolve();

    await events.append("user-1", {
      type: "turn.started",
      session: "audit",
      thread_id: "th-audit",
      payload: { turn_id: "turn-audit" },
    });
    await events.append("user-1", {
      type: "turn.completed",
      session: "audit",
      thread_id: "th-audit",
      payload: { turn_id: "turn-audit", status: "completed" },
    });
    await events.append("user-1", {
      type: "turn.started",
      session: "lint",
      thread_id: "th-lint",
      payload: { turn_id: "turn-lint" },
    });
    await events.append("user-1", {
      type: "turn.error",
      session: "lint",
      thread_id: "th-lint",
      payload: {
        turn_id: "turn-lint",
        error: {
          message: "boom",
          codex_error_info: "context_window_exceeded",
        },
      },
    });

    const result = await waiting as { outcomes: Array<Record<string, unknown>>; overall: string };
    expect(result).toEqual({
      outcomes: [
        { session: "audit", outcome: "completed", turn_id: "turn-audit" },
        { session: "lint", outcome: "error", turn_id: "turn-lint", codex_error_info: "context_window_exceeded" },
      ],
      overall: "error",
    });

    await expect(runCliWithResult(
      ["-b", "token-1", "message", "wait", "--all", "audit", "lint", "--timeout", "5"],
      result,
    )).resolves.toBe(1);
  });

  it("wait --all times out unfinished targets and exits 124", async () => {
    vi.useFakeTimers();
    const dir = mkTmpDir("codex-team-cohort-wait-timeout-");
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);
    sessions.add("user-1", makeLiveRecord("audit", "th-audit"));
    sessions.add("user-1", makeLiveRecord("lint", "th-lint"));
    await sessions.flush();

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    const waiting = messageWait(ctx as never, makeReq("message:wait", ["audit", "lint"], { all: true, timeout: "5" }) as never);
    await Promise.resolve();

    await events.append("user-1", {
      type: "turn.started",
      session: "audit",
      thread_id: "th-audit",
      payload: { turn_id: "turn-audit" },
    });
    await events.append("user-1", {
      type: "turn.completed",
      session: "audit",
      thread_id: "th-audit",
      payload: { turn_id: "turn-audit", status: "completed" },
    });
    await events.append("user-1", {
      type: "turn.started",
      session: "lint",
      thread_id: "th-lint",
      payload: { turn_id: "turn-lint" },
    });

    await vi.advanceTimersByTimeAsync(5000);
    const result = await waiting as { outcomes: Array<Record<string, unknown>>; overall: string };
    expect(result).toEqual({
      outcomes: [
        { session: "audit", outcome: "completed", turn_id: "turn-audit" },
        { session: "lint", outcome: "timeout", turn_id: "turn-lint" },
      ],
      overall: "timeout",
    });

    await expect(runCliWithResult(
      ["-b", "token-1", "message", "wait", "--all", "audit", "lint", "--timeout", "5"],
      result,
    )).resolves.toBe(124);
  });

  it("wait --any returns the first completed target, reports still-running sessions, and exits 0", async () => {
    const dir = mkTmpDir("codex-team-cohort-wait-any-");
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);
    sessions.add("user-1", makeLiveRecord("audit", "th-audit"));
    sessions.add("user-1", makeLiveRecord("lint", "th-lint"));
    await sessions.flush();

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    const waiting = messageWait(ctx as never, makeReq("message:wait", ["audit", "lint"], { any: true, timeout: "5" }) as never);
    await Promise.resolve();

    await events.append("user-1", {
      type: "turn.started",
      session: "audit",
      thread_id: "th-audit",
      payload: { turn_id: "turn-audit" },
    });
    await events.append("user-1", {
      type: "turn.completed",
      session: "audit",
      thread_id: "th-audit",
      payload: { turn_id: "turn-audit", status: "completed" },
    });

    const result = await waiting as Record<string, unknown>;
    expect(result).toEqual({
      session: "audit",
      outcome: "completed",
      turn_id: "turn-audit",
      still_running: ["lint"],
    });
    expect(parseArgs(["-b", "token-1", "message", "wait", "--any", "audit", "lint"]).flags.any).toBe(true);

    await expect(runCliWithResult(
      ["-b", "token-1", "message", "wait", "--any", "audit", "lint", "--timeout", "5"],
      result,
    )).resolves.toBe(0);
  });

  it("wait --any returns timeout when no target finishes and exits 124", async () => {
    vi.useFakeTimers();
    const dir = mkTmpDir("codex-team-cohort-wait-any-timeout-");
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);
    const events = new EventLog(100, null);
    sessions.add("user-1", makeLiveRecord("audit", "th-audit"));
    sessions.add("user-1", makeLiveRecord("lint", "th-lint"));
    await sessions.flush();

    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions,
      events,
      queues: {
        getCurrentTurn: vi.fn().mockReturnValue(null),
      },
    };

    const waiting = messageWait(ctx as never, makeReq("message:wait", ["audit", "lint"], { any: true, timeout: "5" }) as never);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);

    const result = await waiting as Record<string, unknown>;
    expect(result).toEqual({
      outcome: "timeout",
      timeout_s: 5,
      still_running: ["audit", "lint"],
    });

    await expect(runCliWithResult(
      ["-b", "token-1", "message", "wait", "--any", "audit", "lint", "--timeout", "5"],
      result,
    )).resolves.toBe(124);
  });

  it("detach --all with no matches returns an empty result set", async () => {
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions: {
        listLive: vi.fn().mockReturnValue([
          makeLiveRecord("audit", "th-audit"),
          makeLiveRecord("lint", "th-lint"),
        ]),
      },
      pool: {
        clientForSession: vi.fn(),
        release: vi.fn(),
      },
      queues: {
        beginTeardown: vi.fn(),
        waitForIdle: vi.fn(),
        dispose: vi.fn(),
      },
      pending: {},
      events: {
        append: vi.fn().mockResolvedValue(undefined),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await sessionDetach(ctx as never, makeReq("session:detach", [], {
      all: true,
      match: "mapper-*",
    }) as never);

    expect(result).toEqual({ results: [] });
    expect(formatCompact("session:detach", result)).toEqual({ results: [] });
    expect(renderHelp(["session", "detach"])).toContain("--match");
  });

  it("detach --all --match only detaches matching sessions", async () => {
    vi.mocked(threadUnsubscribe).mockResolvedValue(undefined as never);

    const removed: string[] = [];
    const live = [
      makeLiveRecord("mapper-a", "th-a"),
      makeLiveRecord("mapper-b", "th-b"),
      makeLiveRecord("mapper-c", "th-c"),
      makeLiveRecord("audit", "th-audit"),
      makeLiveRecord("lint", "th-lint"),
    ];
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
      },
      sessions: {
        listLive: vi.fn().mockReturnValue(live),
        remove: vi.fn((_user: string, name: string) => {
          removed.push(name);
          return live.find((rec) => rec.name === name) ?? null;
        }),
      },
      pool: {
        clientForSession: vi.fn().mockReturnValue({}),
        release: vi.fn(),
      },
      queues: {
        beginTeardown: vi.fn().mockImplementation(async (_sessionKey: string) => ({ currentTurnId: null })),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        finalDispose: vi.fn(),
      },
      pending: {},
      events: {
        append: vi.fn().mockResolvedValue(undefined),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    const result = await sessionDetach(ctx as never, makeReq("session:detach", [], {
      all: true,
      match: "mapper-*",
    }) as never) as { results: Array<Record<string, unknown>> };

    expect(result).toEqual({
      results: [
        { session: "mapper-a", detached: true, graceful: false },
        { session: "mapper-b", detached: true, graceful: false },
        { session: "mapper-c", detached: true, graceful: false },
      ],
    });
    expect(removed).toEqual(["mapper-a", "mapper-b", "mapper-c"]);
    expect(vi.mocked(threadUnsubscribe)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(turnInterrupt)).not.toHaveBeenCalled();
    expect(formatCompact("session:detach", result)).toEqual(result);
  });

  it("glob helper supports wildcards, anchors matches, and escapes regex metacharacters", () => {
    expect(matchesGlob("mapper-*", "mapper-a")).toBe(true);
    expect(matchesGlob("mapper-?", "mapper-a")).toBe(true);
    expect(matchesGlob("mapper-?", "mapper-ab")).toBe(false);
    expect(matchesGlob("*-lint", "audit-lint")).toBe(true);
    expect(matchesGlob("*-lint", "audit-lint-extra")).toBe(false);
    expect(matchesGlob("build[1]", "build[1]")).toBe(true);
    expect(matchesGlob("build[1]", "build1")).toBe(false);
    expect(globToRegExp("a.+b").test("a.+b")).toBe(true);
    expect(globToRegExp("a.+b").test("axxxb")).toBe(false);
  });
});
