import { describe, expect, it } from "vitest";

import { normalizeNotification, normalizeServerRequest } from "../src/daemon/normalize";

describe("daemon normalize", () => {
  it("maps supported server-request method names to internal kinds", () => {
    expect(normalizeServerRequest({
      id: 1,
      method: "item/permissions/requestApproval",
      params: { threadId: "th-1", turnId: "turn-1", itemId: "item-1", command: "git status", permissions: { fs: true } },
    })).toMatchObject({
      kind: "approval.permissions",
      autoApproveTarget: "git status",
      threadId: "th-1",
      payload: {
        turn_id: "turn-1",
        item_id: "item-1",
        command: "git status",
        permissions: { fs: true },
      },
    });

    expect(normalizeServerRequest({
      id: 2,
      method: "mcpServer/elicitation/request",
      params: { threadId: "th-2", turnId: null, serverName: "demo", mode: "url", url: "https://example.com" },
    })).toMatchObject({
      kind: "approval.mcp_elicitation",
      payload: {
        server_name: "demo",
        mode: "url",
        url: "https://example.com",
      },
    });

    expect(normalizeServerRequest({
      id: 3,
      method: "item/tool/requestUserInput",
      params: { threadId: "th-3", turnId: "turn-3", itemId: "item-3", questions: [{ id: "q1" }] },
    })).toMatchObject({
      kind: "user_input.request",
      payload: {
        turn_id: "turn-3",
        item_id: "item-3",
        questions: [{ id: "q1" }],
      },
    });
  });

  it("extracts thread ids from thread-started notifications", () => {
    const normalized = normalizeNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "th-1",
          cwd: "/tmp/project",
          source: "interactive",
        },
      },
    });

    expect(normalized.threadId).toBe("th-1");
    expect(normalized.payload).toMatchObject({
      thread_id: "th-1",
      cwd: "/tmp/project",
      source: "interactive",
      thread: {
        id: "th-1",
      },
    });
  });

  it("uses camelCase payload fields for turn, name, hook, and server-request notifications", () => {
    expect(normalizeNotification({
      method: "turn/started",
      params: {
        threadId: "th-1",
        turn: {
          id: "turn-1",
          status: "inProgress",
          items: [],
          startedAt: 100,
          completedAt: 101,
          durationMs: 42,
        },
      },
    }).payload).toMatchObject({
      turn_id: "turn-1",
      started_at: 100,
      completed_at: 101,
      duration_ms: 42,
    });

    expect(normalizeNotification({
      method: "thread/name/updated",
      params: {
        threadId: "th-2",
        threadName: "renamed",
      },
    }).payload).toEqual({ name: "renamed" });

    expect(normalizeNotification({
      method: "hook/started",
      params: {
        threadId: "th-3",
        turnId: "turn-3",
        run: {
          id: "hook-1",
          status: "running",
        },
      },
    }).payload).toMatchObject({
      turn_id: "turn-3",
      hook_id: "hook-1",
      status: "running",
      run: {
        id: "hook-1",
      },
    });

    expect(normalizeNotification({
      method: "serverRequest/resolved",
      params: {
        threadId: "th-4",
        requestId: 99,
      },
    }).payload).toEqual({ request_id: 99 });
  });
});
