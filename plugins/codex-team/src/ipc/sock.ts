import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { IpcMessage } from "./protocol";
import { createLineParser, readMaxFrameBytes } from "./frameParser";
import { isFilesystemSockPath, normalizeSockPath } from "../paths";

export function writeMessage(socket: net.Socket, msg: IpcMessage): void {
  socket.write(JSON.stringify(msg) + "\n");
}

export function onMessages(socket: net.Socket, handler: (msg: IpcMessage) => unknown, onClose?: () => void): { resume(): void } {
  const parser = createLineParser({
    maxFrameBytes: readMaxFrameBytes(),
    peer: socketPeer(socket),
    onError: (error) => {
      if (socket.listenerCount("error") === 0) {
        socket.once("error", () => undefined);
      }
      if (typeof socket.destroy === "function") socket.destroy(error);
      else socket.emit("error", error);
    },
    onLine: (line) => {
      try {
        const msg = JSON.parse(line) as IpcMessage;
        return handler(msg);
      } catch {
        return undefined;
      }
    },
  });

  socket.on("data", (chunk) => {
    parser.push(chunk);
  });
  if (onClose) {
    let closed = false;
    const onceClose = () => {
      if (closed) return;
      closed = true;
      onClose();
    };
    socket.on("close", onceClose);
    socket.on("end", onceClose);
  }
  return {
    resume(): void {
      parser.resume();
    },
  };
}

export async function listenSock(sockPath: string): Promise<net.Server> {
  const endpoint = normalizeSockPath(sockPath);
  if (isFilesystemSockPath(sockPath)) {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true });
  }
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
  return server;
}

export function connectSock(sockPath: string, timeoutMs = 2000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(normalizeSockPath(sockPath));
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    timer.unref();
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export function probeSock(sockPath: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const endpoint = normalizeSockPath(sockPath);
    if (isFilesystemSockPath(sockPath) && !fs.existsSync(endpoint)) {
      resolve(false);
      return;
    }
    const sock = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    timer.unref();
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(false);
    });
  });
}

export function unlinkSockIfStale(sockPath: string): void {
  if (!isFilesystemSockPath(sockPath)) return;
  const endpoint = normalizeSockPath(sockPath);
  try {
    fs.unlinkSync(endpoint);
  } catch {
    // ignore
  }
}

function socketPeer(socket: net.Socket): string {
  const remoteAddress = socket.remoteAddress;
  const remotePort = socket.remotePort;
  if (typeof remoteAddress === "string" && remoteAddress.length > 0) {
    return remotePort ? `${remoteAddress}:${remotePort}` : remoteAddress;
  }
  const maybePath = (socket as net.Socket & { path?: string }).path;
  if (typeof maybePath === "string" && maybePath.length > 0) return maybePath;
  return "ipc_socket";
}
