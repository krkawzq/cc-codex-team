import { describe, expect, it } from "vitest";

import { PendingRegistry } from "../src/daemon/pending";

describe("PendingRegistry", () => {
  it("distinguishes jsonrpc ids by client identity", () => {
    const reg = new PendingRegistry();
    const clientA = {};
    const clientB = {};

    const a = reg.add({
      client: clientA as never,
      jsonrpc_id: 7,
      kind: "approval.command_execution",
      user: "user-1",
      session_name: "sess-a",
      thread_id: "th-a",
      turn_id: "turn-a",
      raw: {},
    });
    const b = reg.add({
      client: clientB as never,
      jsonrpc_id: 7,
      kind: "approval.command_execution",
      user: "user-1",
      session_name: "sess-b",
      thread_id: "th-b",
      turn_id: "turn-b",
      raw: {},
    });

    expect(reg.removeByJsonrpcId(clientA as never, 7)?.request_id).toBe(a.request_id);
    expect(reg.get(b.request_id)?.request_id).toBe(b.request_id);
    expect(reg.removeByJsonrpcId(clientB as never, 7)?.request_id).toBe(b.request_id);
  });

  it("removes entries by session and user", () => {
    const reg = new PendingRegistry();
    const client = {};
    const a = reg.add({
      client: client as never,
      jsonrpc_id: 1,
      kind: "approval.command_execution",
      user: "user-1",
      session_name: "sess-1",
      thread_id: "th-1",
      turn_id: "turn-1",
      raw: {},
    });
    const b = reg.add({
      client: client as never,
      jsonrpc_id: 2,
      kind: "approval.file_change",
      user: "user-1",
      session_name: "sess-2",
      thread_id: "th-2",
      turn_id: "turn-2",
      raw: {},
    });
    const c = reg.add({
      client: client as never,
      jsonrpc_id: 3,
      kind: "user_input.request",
      user: "user-2",
      session_name: "sess-3",
      thread_id: "th-3",
      turn_id: "turn-3",
      raw: {},
    });

    expect(reg.removeForSession("user-1", "sess-1").map((x) => x.request_id)).toEqual([a.request_id]);
    expect(reg.get(b.request_id)?.request_id).toBe(b.request_id);
    expect(reg.removeForUser("user-1").map((x) => x.request_id)).toEqual([b.request_id]);
    expect(reg.get(c.request_id)?.request_id).toBe(c.request_id);
  });

  it("does not return already-responded entries for cancellation cleanup", () => {
    const reg = new PendingRegistry();
    const client = {};
    const responded = reg.add({
      client: client as never,
      jsonrpc_id: 1,
      kind: "approval.command_execution",
      user: "user-1",
      session_name: "sess-1",
      thread_id: "th-1",
      turn_id: "turn-1",
      raw: {},
    });
    reg.markResponded(responded.request_id);

    expect(reg.removeForSession("user-1", "sess-1")).toEqual([]);
    expect(reg.get(responded.request_id)).toBeNull();
  });
});
