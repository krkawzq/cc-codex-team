import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { onMessages, writeMessage } from "../src/ipc/sock";

class FakeSocket extends EventEmitter {
  writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

describe("ipc/sock", () => {
  it("writes newline-delimited JSON messages", () => {
    const socket = new FakeSocket();

    writeMessage(socket as never, { kind: "response", id: "1", result: { ok: true } });

    expect(socket.writes).toEqual([JSON.stringify({ kind: "response", id: "1", result: { ok: true } }) + "\n"]);
  });

  it("parses framed messages, ignores malformed JSON, and calls onClose once", () => {
    const socket = new FakeSocket();
    const seen: unknown[] = [];
    const onClose = vi.fn();

    onMessages(socket as never, (msg) => {
      seen.push(msg);
    }, onClose);

    socket.emit("data", Buffer.from("{bad json}\n"));
    socket.emit("data", Buffer.from("{\"kind\":\"response\",\"id\":\"1\",\"result\":1}\n{\"kind\":\"response\""));
    socket.emit("data", Buffer.from(",\"id\":\"2\",\"result\":2}\n"));
    socket.emit("end");
    socket.emit("close");

    expect(seen).toEqual([
      { kind: "response", id: "1", result: 1 },
      { kind: "response", id: "2", result: 2 },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
