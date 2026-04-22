import { describe, expect, it } from "vitest";

import { CodexTeamError, invalidParams, methodNotFound, notImplemented } from "../src/errors";
import { err, ok } from "../src/result";
import { renderContext, renderHistory, renderInline, renderSessionInfo, renderTag } from "../src/format/markdown";
import { renderTable } from "../src/format/table";
import { status } from "../src/daemon/handlers/status";

function makeReq(bearer?: string) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "status",
    bearer,
    params: {},
  };
}

describe("status handler", () => {
  it("returns user status for an existing token", async () => {
    const ctx = {
      users: {
        get: () => ({ token: "user-1", created_at: "2025-01-01T00:00:00.000Z", last_active_at: "2025-01-02T00:00:00.000Z" }),
        touch: () => {},
      },
      sessions: {
        listLive: () => [{ name: "sess-1" }],
      },
      events: {
        retainedCount: () => 3,
      },
      pending: {
        listForUser: () => [{ request_id: "req-a" }, { request_id: "req-b" }],
      },
      startedAt: new Date("2025-01-03T00:00:00.000Z"),
      dataDir: "/tmp/data",
    };

    const result = await status(ctx as never, makeReq("user-1") as never);
    expect(result).toMatchObject({
      token: "user-1",
      live_sessions: 1,
      retained_events: 3,
      pending_requests: 2,
      daemon: {
        data_dir: "/tmp/data",
      },
    });
  });

  it("throws for missing or unknown bearer", async () => {
    await expect(status({
      users: { get: () => null },
    } as never, makeReq() as never)).rejects.toMatchObject({ code: "invalid_params" });

    await expect(status({
      users: { get: () => null },
    } as never, makeReq("missing") as never)).rejects.toMatchObject({ code: "user_not_found" });
  });
});

describe("format helpers", () => {
  it("renders markdown tags and tables predictably", () => {
    expect(renderTag("demo", { a: 1 }, "body")).toContain("<demo> {\"a\":1}");
    expect(renderInline("item", { id: "x" })).toBe("<item>{\"id\":\"x\"}<\\item>");

    const history = renderHistory({
      session: "sess-1",
      thread_id: "th-1",
      turns: [{ id: "turn-1", status: "completed", durationMs: 10 }],
      nextCursor: "cursor-2",
    });
    expect(history).toContain("\"next_cursor\":\"cursor-2\"");
    expect(history).toContain("<turn>{\"id\":\"turn-1\"");

    const context = renderContext({
      session: "sess-1",
      thread_id: "th-1",
      thread: { id: "th-1", cwd: "/tmp/project", preview: "hello", model_provider: "openai" },
    });
    expect(context).toContain("\"cwd\":\"/tmp/project\"");

    const sessionInfo = renderSessionInfo({
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      model: "gpt-5.4",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-02T00:00:00.000Z",
      turn_count: 2,
    });
    expect(sessionInfo).toContain("**model**");

    const table = renderTable([{ a: 1, b: "x" }, { a: 20, b: "yy" }], ["a", "b"]);
    expect(table).toContain("a   b");
    expect(table).toContain("20  yy");
  });
});

describe("error/result helpers", () => {
  it("creates structured helper values", () => {
    expect(ok({ x: 1 })).toEqual({ ok: true, data: { x: 1 } });
    expect(err("bad", "oops", { detail: 1 })).toEqual({
      ok: false,
      error: { code: "bad", message: "oops", data: { detail: 1 } },
    });

    expect(invalidParams("bad arg")).toBeInstanceOf(CodexTeamError);
    expect(notImplemented("foo").code).toBe("not_implemented");
    expect(methodNotFound("bar").code).toBe("method_not_found");
  });
});
