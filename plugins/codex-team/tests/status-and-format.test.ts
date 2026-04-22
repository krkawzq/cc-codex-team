import { describe, expect, it } from "vitest";

import { CodexTeamError, invalidParams, methodNotFound, notImplemented } from "../src/errors";
import { err, ok } from "../src/result";
import { renderContext, renderHistory, renderInline, renderItem, renderSessionInfo, renderTag } from "../src/format/markdown";
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
      autoApprovePatterns: [],
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-02T00:00:00.000Z",
      turn_count: 2,
    });
    expect(sessionInfo).toContain("**model**");

    const table = renderTable([{ a: 1, b: "x" }, { a: 20, b: "yy" }], ["a", "b"]);
    expect(table).toContain("a   b");
    expect(table).toContain("20  yy");
  });

  it("renders userMessage items inline with text attrs", () => {
    const rendered = renderItem({
      id: "item-1",
      type: "userMessage",
      content: [{ type: "text", text: "Fix the markdown renderer." }],
    });

    expect(rendered).toBe(
      "<item>{\"id\":\"item-1\",\"type\":\"userMessage\",\"text\":\"Fix the markdown renderer.\"}<\\item>",
    );
  });

  it("renders agentMessage items as blocks with markdown bodies", () => {
    const rendered = renderItem({
      id: "item-2",
      type: "agentMessage",
      phase: "final_answer",
      content: [{ type: "text", text: "Here is the result:\n\n- fixed A\n- fixed B" }],
    });

    expect(rendered).toContain("<item> {\"id\":\"item-2\",\"type\":\"agentMessage\",\"phase\":\"final_answer\"}");
    expect(rendered).toContain("Here is the result:\n\n- fixed A\n- fixed B");
    expect(rendered).not.toContain("\"content\":");
  });

  it("renders commandExecution items with nested shell tags", () => {
    const rendered = renderItem({
      id: "item-3",
      type: "commandExecution",
      command: "ls -la",
      cwd: "/repo",
      exit: 0,
      durationMs: 32,
      stdout: "total 24",
      stderr: "drwxr-xr-x 5 user staff 160",
    });

    expect(rendered).toContain("<item> {\"id\":\"item-3\",\"type\":\"commandExecution\"}");
    expect(rendered).toContain("<shell> {\"cmd\":\"ls -la\",\"cwd\":\"/repo\",\"exit\":0,\"duration_ms\":32}");
    expect(rendered).toContain("total 24\ndrwxr-xr-x 5 user staff 160");
    expect(rendered).not.toContain("\"stdout\":");
  });

  it("renders fallback items inline without dumping JSON bodies", () => {
    const rendered = renderItem({
      id: "item-4",
      type: "mcpToolCall",
      server: "docs",
      args: { q: "markdown" },
      output: "ignored body",
    });

    expect(rendered).toBe(
      "<item>{\"id\":\"item-4\",\"type\":\"mcpToolCall\",\"server\":\"docs\",\"args\":{\"q\":\"markdown\"}}<\\item>",
    );
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
