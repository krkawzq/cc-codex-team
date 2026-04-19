import assert from "node:assert/strict";
import test from "node:test";

import { QueueFull } from "../src/errors";
import { SendQueue } from "../src/queue";

test("SendQueue drops oldest when configured", () => {
  const queue = new SendQueue(2, "drop_oldest");
  queue.enqueue({ id: "a", text: "a" });
  queue.enqueue({ id: "b", text: "b" });
  queue.enqueue({ id: "c", text: "c" });
  assert.deepEqual(
    queue.snapshot().map((item) => item.id),
    ["b", "c"],
  );
});

test("SendQueue warn policy stays bounded and drops oldest", () => {
  const queue = new SendQueue(2, "warn");
  queue.enqueue({ id: "a", text: "a" });
  queue.enqueue({ id: "b", text: "b" });
  const result = queue.enqueue({ id: "c", text: "c" });
  assert.equal(result.overflowed, true);
  assert.equal(result.dropped?.id, "a");
  assert.deepEqual(
    queue.snapshot().map((item) => item.id),
    ["b", "c"],
  );
});

test("SendQueue rejects when full and policy is reject", () => {
  const queue = new SendQueue(1, "reject");
  queue.enqueue({ id: "a", text: "a" });
  assert.throws(() => queue.enqueue({ id: "b", text: "b" }), QueueFull);
});
