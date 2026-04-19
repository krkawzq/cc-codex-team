import assert from "node:assert/strict";
import test from "node:test";

import { decodeRequest } from "../src/protocol";
import { ProtocolError } from "../src/errors";

test("decodeRequest requires protocol v2", () => {
  assert.throws(
    () => decodeRequest(JSON.stringify({ id: "1", cmd: "session.list", params: {} })),
    ProtocolError,
  );
});

test("decodeRequest accepts v2 workspace envelope", () => {
  const request = decodeRequest(JSON.stringify({
    v: 2,
    id: "1",
    cmd: "session.list",
    workspace: "ws-a",
    clientId: "client-a",
    allWorkspaces: false,
    params: {},
  }));
  assert.equal(request.v, 2);
  assert.equal(request.workspace, "ws-a");
  assert.equal(request.clientId, "client-a");
});
