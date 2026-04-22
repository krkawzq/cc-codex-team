import type net from "node:net";

import { CodexTeamError } from "../errors";
import { JsonRpcError } from "../codex/errors";
import type { DaemonContext } from "./context";
import type { IpcMessage, IpcNotification, IpcRequest, IpcResponse, IpcStreamChunk, IpcStreamEnd } from "../ipc/protocol";
import { listenSock, onMessages, writeMessage } from "../ipc/sock";
import { getHandler, type StreamAck, type StreamHandle } from "./dispatch";
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
  const activeStreams = new Map<string, ActiveStream>();

  onMessages(
    socket,
    async (msg: IpcMessage) => {
      if (msg.kind === "notification") {
        handleNotification(msg, activeStreams);
        return;
      }
      if (msg.kind !== "request") return;
      try {
        await handleRequest(ctx, socket, msg, closeCallbacks, activeStreams);
      } catch (e) {
        sendError(socket, msg.id, e);
      }
    },
    () => {
      for (const cb of closeCallbacks) {
        try { cb(); } catch { /* ignore */ }
      }
      activeStreams.clear();
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
  activeStreams: Map<string, ActiveStream>,
): Promise<void> {
  ctx.activity.touch();
  const handler = getHandler(req.method);
  const streaming = req.params?.streaming === true;

  if (streaming) {
    const stream = createStreamHandle(socket, req.id, closeCallbacks, () => activeStreams.delete(req.id));
    activeStreams.set(req.id, stream);
    try {
      await handler(ctx, req, stream.handle);
    } catch (e) {
      stream.handle.end(toCodexTeamError(e));
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

interface ActiveStream {
  handle: StreamHandle;
  ack(params: Record<string, unknown>): void;
}

function createStreamHandle(
  socket: net.Socket,
  id: string,
  closeCallbacks: Set<() => void>,
  onRetire: () => void,
): ActiveStream {
  let ended = false;
  let retired = false;
  let blocked = false;
  let queuedBytes = 0;
  const queuedFrames: string[] = [];
  const ackCallbacks = new Set<(ack: StreamAck) => void>();

  const retire = (): void => {
    if (retired) return;
    retired = true;
    ackCallbacks.clear();
    onRetire();
  };

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
  closeCallbacks.add(() => {
    retire();
    socket.off("drain", onDrain);
  });

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
      retire();
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
    handle: {
      chunk(data: unknown): void {
        if (ended) return;
        const msg: IpcStreamChunk = { kind: "stream_chunk", id, data };
        enqueueFrame(JSON.stringify(msg) + "\n");
      },
      end(error?: CodexTeamError): void {
        if (ended) return;
        ended = true;
        retire();
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
      onAck(cb: (ack: StreamAck) => void): void {
        ackCallbacks.add(cb);
      },
    },
    ack(params: Record<string, unknown>): void {
      if (ended || retired) return;
      const ack = normalizeStreamAck(params);
      if (!ack) return;
      for (const cb of ackCallbacks) cb(ack);
    },
  };
}

function handleNotification(msg: IpcNotification, activeStreams: Map<string, ActiveStream>): void {
  if (msg.method !== "stream_ack") return;
  const streamId = asString(msg.params?.id);
  if (!streamId) return;
  const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
    ? msg.params as Record<string, unknown>
    : {};
  activeStreams.get(streamId)?.ack(params);
}

function normalizeStreamAck(params: Record<string, unknown>): StreamAck | null {
  const eventId = asString(params.event_id);
  if (!eventId) return null;
  return { event_id: eventId };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
