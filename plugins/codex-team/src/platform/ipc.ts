import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { Config } from "../config";
import { isWindows } from "./os";
import { resolveDataDir, resolveRuntimeDir } from "./paths";

export interface IpcAddress {
  kind: "uds" | "pipe";
  address: string;
  display: string;
}

export function ipcAddressForConfig(cfg: Config): IpcAddress {
  const configured = cfg.daemon.socketPath.trim();
  if (configured) {
    return ipcAddressFromPath(configured);
  }
  const dataDir = resolveDataDir(cfg.daemon.dataDir);
  if (isWindows) {
    const digest = crypto
      .createHash("sha1")
      .update(path.resolve(dataDir))
      .digest("hex")
      .slice(0, 12);
    return ipcAddressFromPath(`\\\\.\\pipe\\codex-team-${digest}`);
  }
  const runtimeDir = resolveRuntimeDir(dataDir);
  return ipcAddressFromPath(path.join(runtimeDir || dataDir, "daemon.sock"));
}

export function ipcAddressFromPath(socketPath: string): IpcAddress {
  const pipe = isWindows || socketPath.startsWith("\\\\.\\pipe\\");
  return {
    kind: pipe ? "pipe" : "uds",
    address: socketPath,
    display: socketPath,
  };
}

export async function ipcListen(address: IpcAddress, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  if (address.kind === "uds") {
    fs.mkdirSync(path.dirname(address.address), { recursive: true });
  }
  const server = net.createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address.address);
  });
  return server;
}

export function ipcConnect(address: IpcAddress): net.Socket {
  return net.createConnection(address.address);
}

export async function ipcReady(address: IpcAddress, timeoutMs = 100): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = ipcConnect(address);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(false);
    });
  });
}

export async function removeStaleIpcArtifact(address: IpcAddress): Promise<void> {
  if (address.kind !== "uds") {
    return;
  }
  if (fs.existsSync(address.address)) {
    fs.unlinkSync(address.address);
  }
}

export function ipcArtifactExists(address: IpcAddress): boolean {
  return address.kind === "uds" && fs.existsSync(address.address);
}
