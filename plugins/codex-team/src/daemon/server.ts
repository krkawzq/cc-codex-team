import type net from "node:net";

import { CodexTeamError } from "../errors";
import { JsonRpcError } from "../codex/errors";
import type { DaemonContext } from "./context";
import type { IpcMessage, IpcRequest, IpcResponse, IpcStreamChunk, IpcStreamEnd } from "../ipc/protocol";
import { listenSock, onMessages, writeMessage } from "../ipc/sock";
import { getHandler, type StreamHandle } from "./dispatch";
import { logger } from "../logger";

const MAX_STREAM_QUEUE_BYTES = 1024 * 1024;
const MAX_STREAM_QUEUE_MESSAGES = 1024;

export async function startServer(ctx: DaemonContext): Promise<net.Server> {
  const server = await listenSock(ctx.sockPath);
  server.on("connection", (socket) => handleConnection(ctx, socket));
  logger.info("daemon listening", { sock: ctx.sockPath });
  return server;
}

function handleConnection(ctx: DaemonContext, socket: net.Socket): void {
  const closeCallbacks = new Set<() => void>();

  onMessages(
    socket,
    async (msg: IpcMessage) => {
      if (msg.kind !== "request") return;
      try {
        await handleRequest(ctx, socket, msg, closeCallbacks);
      } catch (e) {
        sendError(socket, msg.id, e);
      }
    },
    () => {
      for (const cb of closeCallbacks) {
        try { cb(); } catch { /* ignore */ }
      }
      closeCallbacks.clear();
    },
  );
  socket.on("error", (e) => {
    logger.debug("socket error", { err: e.message });
  });
}

async function handleRequest(
  ctx: DaemonContext,
  socket: net.Socket,
  req: IpcRequest,
  closeCallbacks: Set<() => void>,
): Promise<void> {
  ctx.activity.touch();
  const handler = getHandler(req.method);
  const streaming = req.params?.streaming === true;

  if (streaming) {
    const stream = createStreamHandle(socket, req.id, closeCallbacks);
    try {
      await handler(ctx, req, stream);
    } catch (e) {
      stream.end(toCodexTeamError(e));
    }
    return;
  }

  const result = await handler(ctx, req);
  const resp: IpcResponse = {
    kind: "response",
    id: req.id,
    result,
  };
  writeMessage(socket, resp);
}

function createStreamHandle(socket: net.Socket, id: string, closeCallbacks: Set<() => void>): StreamHandle {
  let ended = false;
  let blocked = false;
  let queuedBytes = 0;
  const queuedFrames: string[] = [];

  const flushQueued = (): void => {
    while (queuedFrames.length > 0) {
      const frame = queuedFrames[0]!;
      if (!socket.write(frame)) {
        blocked = true;
        return;
      }
      queuedFrames.shift();
      queuedBytes = Math.max(0, queuedBytes - Buffer.byteLength(frame));
    }
    blocked = false;
  };

  const onDrain = (): void => flushQueued();
  socket.on("drain", onDrain);
  closeCallbacks.add(() => socket.off("drain", onDrain));

  const enqueueFrame = (frame: string): void => {
    if (ended) return;
    if (!blocked && queuedFrames.length === 0) {
      if (!socket.write(frame)) {
        blocked = true;
      }
      return;
    }
    queuedFrames.push(frame);
    queuedBytes += Buffer.byteLength(frame);
    if (queuedFrames.length > MAX_STREAM_QUEUE_MESSAGES || queuedBytes > MAX_STREAM_QUEUE_BYTES) {
      queuedFrames.length = 0;
      queuedBytes = 0;
      ended = true;
      const msg: IpcStreamEnd = {
        kind: "stream_end",
        id,
        error: {
          code: "internal",
          message: "stream consumer too slow",
        },
      };
      writeMessage(socket, msg);
      try { socket.end(); } catch { /* ignore */ }
      return;
    }
    flushQueued();
  };

  return {
    chunk(data: unknown): void {
      if (ended) return;
      const msg: IpcStreamChunk = { kind: "stream_chunk", id, data };
      enqueueFrame(JSON.stringify(msg) + "\n");
    },
    end(error?: CodexTeamError): void {
      if (ended) return;
      ended = true;
      const msg: IpcStreamEnd = { kind: "stream_end", id };
      if (error) {
        msg.error = { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
      }
      if (queuedFrames.length > 0) {
        const frame = JSON.stringify(msg) + "\n";
        queuedFrames.push(frame);
        queuedBytes += Buffer.byteLength(frame);
        flushQueued();
        return;
      }
      writeMessage(socket, msg);
    },
    onClose(cb: () => void): void {
      closeCallbacks.add(cb);
    },
  };
}

function sendError(socket: net.Socket, id: string, e: unknown): void {
  const err = toCodexTeamError(e);
  const resp: IpcResponse = {
    kind: "response",
    id,
    error: {
      code: err.code,
      message: err.message,
      ...(err.data !== undefined ? { data: err.data } : {}),
    },
  };
  writeMessage(socket, resp);
}

function toCodexTeamError(e: unknown): CodexTeamError {
  if (e instanceof CodexTeamError) return e;
  if (e instanceof JsonRpcError) {
    return new CodexTeamError("codex_error", e.rpcMessage, {
      rpc_code: e.code,
      rpc_message: e.rpcMessage,
      codex_error_info: e.codexErrorInfo,
      additional_details: e.additionalDetails,
    });
  }
  if (e instanceof Error) return new CodexTeamError("internal", e.message);
  return new CodexTeamError("internal", String(e));
}
