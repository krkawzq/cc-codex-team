import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { isFilesystemSockPath, normalizeSockPath } from "../paths";

export interface SocketBindProbeDeps {
  fs: Pick<typeof fs, "mkdirSync" | "unlinkSync">;
  createServer: typeof net.createServer;
}

export interface SocketBindProbeResult {
  ok: boolean;
  probedPath: string;
  error?: NodeJS.ErrnoException;
}

export function buildSocketBindProbePath(sockPath: string): string {
  const endpoint = normalizeSockPath(sockPath);
  if (!isFilesystemSockPath(sockPath)) {
    return `${endpoint}-probe-${process.pid}-${Date.now()}`;
  }

  const parentDir = path.dirname(endpoint);
  const baseName = path.basename(endpoint, path.extname(endpoint)) || "daemon";
  return path.join(parentDir, `${baseName}-probe-${process.pid}-${Date.now()}.sock`);
}

export async function probeSocketBind(
  sockPath: string,
  deps: SocketBindProbeDeps = {
    fs,
    createServer: net.createServer,
  },
): Promise<SocketBindProbeResult> {
  const probedPath = buildSocketBindProbePath(sockPath);
  const endpoint = normalizeSockPath(probedPath);
  const server = deps.createServer();
  const cleanup = async () => {
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    if (isFilesystemSockPath(probedPath)) {
      try { deps.fs.unlinkSync(endpoint); } catch { /* ignore */ }
    }
  };

  if (isFilesystemSockPath(probedPath)) {
    deps.fs.mkdirSync(path.dirname(endpoint), { recursive: true });
    try { deps.fs.unlinkSync(endpoint); } catch { /* ignore */ }
  }

  const listenResult = await new Promise<{ ok: true } | { ok: false; error: NodeJS.ErrnoException }>((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      resolve({ ok: false, error });
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({ ok: true });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(endpoint);
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      resolve({ ok: false, error: error as NodeJS.ErrnoException });
    }
  });

  if (!listenResult.ok) {
    await cleanup();
    return {
      ok: false,
      probedPath,
      error: listenResult.error,
    };
  }

  await cleanup();
  return {
    ok: true,
    probedPath,
  };
}
