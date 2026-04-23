import { describe, expect, it } from "vitest";

import { CodexTeamError, invalidParams, methodNotFound, notImplemented } from "../src/errors";
import { err, ok } from "../src/result";
import { INLINE_MAX_BYTES, renderContext, renderHistory, renderInline, renderItem, renderSessionInfo, renderTag, renderTail } from "../src/format/markdown";
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
      config: {
        getEffective: () => 10000,
      },
      pool: {
        processCount: () => 4,
      },
      startedAt: new Date("2025-01-03T00:00:00.000Z"),
      dataDir: "/tmp/data",
    };

    const result = await status(ctx as never, makeReq("user-1") as never);
    expect(result).toMatchObject({
      token: "user-1",
      live_sessions: 1,
      retained_events: 3,
      retained_limit: 10000,
      pending_requests: 2,
      app_server_count: 4,
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

    const tail = renderTail({
      session: "sess-1",
      thread_id: "th-1",
      turns: [{
        id: "turn-2",
        status: "completed",
        items: [
          { type: "userMessage", text: "hello" },
          { type: "agentMessage", text: "world" },
        ],
      }],
      thread: null,
      follow: false,
    });
    expect(tail).toContain("<message> {\"role\":\"user\"}");
    expect(tail).toContain("hello");
    expect(tail).toContain("<message> {\"role\":\"assistant\"}");
    expect(tail).toContain("world");

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
      "<user-input>{\"id\":\"item-1\",\"text\":\"Fix the markdown renderer.\"}<\\user-input>",
    );
  });

  it("renders agentMessage items as blocks with markdown bodies", () => {
    const rendered = renderItem({
      id: "item-2",
      type: "agentMessage",
      phase: "final_answer",
      content: [{ type: "text", text: "Here is the result:\n\n- fixed A\n- fixed B" }],
    });

    expect(rendered).toContain("<agent-message> {\"id\":\"item-2\",\"phase\":\"final_answer\"}");
    expect(rendered).toContain("Here is the result:\n\n- fixed A\n- fixed B");
    expect(rendered).not.toContain("\"content\":");
  });

  it("renders commandExecution items as shell tags", () => {
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

    expect(rendered).toContain("<shell> {\"id\":\"item-3\",\"cmd\":\"ls -la\",\"cwd\":\"/repo\",\"exit\":0,\"duration_ms\":32}");
    expect(rendered).toContain("total 24\ndrwxr-xr-x 5 user staff 160");
    expect(rendered).not.toContain("\"stdout\":");
  });

  it("renders mcpToolCall items with nested args and result tags", () => {
    const rendered = renderItem({
      id: "item-4",
      type: "mcpToolCall",
      server: "docs",
      tool: "search",
      args: { q: "markdown" },
      output: "1 result",
    });

    expect(rendered).toContain("<tool.search> {\"id\":\"item-4\",\"server\":\"docs\",\"tool\":\"search\"}");
    expect(rendered).toContain("<mcp-args>{\"q\":\"markdown\"}<\\mcp-args>");
    expect(rendered).toContain("<mcp-result> {}");
    expect(rendered).toContain("1 result");
  });

  it("clips inline userMessage text without flipping it into block form", () => {
    const rendered = renderItem({
      id: "item-clip",
      type: "userMessage",
      text: "x".repeat(120),
    }, "", { truncate: 80 });

    expect(rendered).toContain("<user-input>{\"id\":\"item-clip\",\"text\":\"");
    expect(rendered).not.toContain("<user-input> {");
    expect(rendered).toContain("…[40 bytes truncated; use --truncate 0 to disable]");
  });

  it("keeps large userMessage bodies in block form even when truncate exceeds the inline limit", () => {
    const rendered = renderItem({
      id: "item-5",
      type: "userMessage",
      text: "x".repeat(INLINE_MAX_BYTES + 1024),
    }, "", { truncate: 4096 });

    expect(rendered).toContain("<user-input> {\"id\":\"item-5\"}");
    expect(rendered).not.toContain("\"text\":");
  });

  it("disables markdown truncation when truncate is 0", () => {
    const longText = "0123456789".repeat(INLINE_MAX_BYTES / 2 + 1024);
    const rendered = renderItem({
      id: "item-no-truncate",
      type: "userMessage",
      text: longText,
    }, "", { truncate: 0 });

    expect(rendered).toContain("<user-input> {\"id\":\"item-no-truncate\"}");
    expect(rendered).toContain(longText);
    expect(rendered).not.toContain("bytes truncated");
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
