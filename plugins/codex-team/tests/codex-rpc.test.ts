import { describe, expect, it, vi } from "vitest";

import { turnInterrupt, turnSteer } from "../src/codex/rpc";

describe("codex rpc wrappers", () => {
  it("sends expectedTurnId on turn/steer", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({}),
    };

    const input = [{ type: "text", text: "peer" }];
    await turnSteer(client as never, "th-1", "turn-2", input as never);

    expect(client.request).toHaveBeenCalledWith("turn/steer", {
      threadId: "th-1",
      expectedTurnId: "turn-2",
      input,
    });
  });

  it("always sends turnId on turn/interrupt", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({}),
    };

    await turnInterrupt(client as never, "th-1", "turn-2");

    expect(client.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "th-1",
      turnId: "turn-2",
    });
  });
});
