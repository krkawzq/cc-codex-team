import assert from "node:assert/strict";
import test from "node:test";

import { EventBus } from "../src/eventBus";

test("EventBus filters subscribers by workspace and replays through the filter", async () => {
  const bus = new EventBus(10, 10);
  bus.publish("events", { workspace: "ws-a", kind: "turn-done", session: "one" });
  bus.publish("events", { workspace: "ws-b", kind: "turn-done", session: "two" });

  const wsA = await bus.subscribe("events", 0, { workspace: "ws-a", clientId: "client-a" });
  const all = await bus.subscribe("events", 0, { allWorkspaces: true, clientId: "admin" });

  assert.equal((await wsA.shift()).payload.session, "one");
  assert.equal((await all.shift()).payload.session, "one");
  assert.equal((await all.shift()).payload.session, "two");

  bus.publish("events", { workspace: "ws-b", kind: "turn-done", session: "three" });
  await assert.rejects(wsA.shift(20, "no ws-a event"));

  assert.equal(await bus.detachClient("client-a"), 1);
});
