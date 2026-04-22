import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type net from "node:net";

import { connectSock, probeSock, writeMessage, onMessages } from "../ipc/sock";
import type { IpcMessage, IpcRequest } from "../ipc/protocol";
import { defaultSockPath } from "../paths";
import { parseArgs, commandKey, supportsShort, type ParsedArgs } from "./args";
import { renderHelp } from "./help";
import { err, ok } from "../result";
import { ConfigStore } from "../daemon/config";
import { formatShort } from "../format/short";

const DAEMON_POLL_INTERVAL_MS = 100;
const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15000;
const DEFAULT_DAEMON_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_DAEMON_CONNECT_RETRY_ATTEMPTS = 3;
const DEFAULT_DAEMON_CONNECT_RETRY_DELAY_MS = 250;

export async function readStdinAll(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.once("end", () => resolve(buf));
    process.stdin.once("error", reject);
  });
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.unknown) {
    process.stdout.write(JSON.stringify(err("invalid_params", parsed.unknown)) + "\n");
    return 1;
  }

  if (parsed.help || parsed.commandPath.length === 0) {
    process.stdout.write(renderHelp(parsed.commandPath));
    return 0;
  }

  const method = commandKey(parsed.commandPath);
  const short = truthy(parsed.flags.short);
  const format = flagString(parsed.flags.format);
  if (short && !supportsShort(method)) {
    process.stdout.write(JSON.stringify(err("invalid_params", `--short is not supported for '${method}'`)) + "\n");
    return 1;
  }
  if (short && (format === "markdown" || format === "table")) {
    process.stdout.write(JSON.stringify(err("invalid_params", "--short cannot be used with --format markdown or --format table")) + "\n");
    return 1;
  }
  const sockPath = parsed.daemonSock || defaultSockPath();

  if (method === "version") {
    return await runVersion(sockPath);
  }

  const needsBearer = !isDaemonLevel(method);
  if (needsBearer && !parsed.bearer) {
    process.stdout.write(
      JSON.stringify(err("invalid_params", `bearer token required for '${method}'; pass -b <token>`)) + "\n",
    );
    return 1;
  }

  const ready = await ensureDaemon(sockPath);
  if (!ready) {
    process.stdout.write(JSON.stringify(err("daemon_unreachable", "daemon did not become ready in time")) + "\n");
    return 1;
  }

  return await dispatchCommand(sockPath, parsed, method);
}

function isDaemonLevel(method: string): boolean {
  return method === "version" || method === "daemon:status" || method.startsWith("daemon:");
}

async function runVersion(sockPath: string): Promise<number> {
  const cliVersion = getCliVersion();
  const alive = await probeSock(sockPath, 200);
  const cliConfig = readCliConfig();
  let daemonVersion: string | null = null;
  if (alive) {
    try {
      const resp = await requestOnceWithRetry(sockPath, { method: "version", bearer: null, params: {} }, cliConfig, true);
      if ("result" in resp && resp.result && typeof resp.result === "object") {
        const d = resp.result as { daemon_version?: string };
        daemonVersion = d.daemon_version || null;
      }
    } catch {
      // ignore
    }
  }
  process.stdout.write(
    JSON.stringify(ok({ cli_version: cliVersion, daemon_version: daemonVersion })) + "\n",
  );
  return 0;
}

async function dispatchCommand(sockPath: string, parsed: ParsedArgs, method: string): Promise<number> {
  const cliConfig = readCliConfig();
  const needsStreaming =
    method === "monitor:events" ||
    method === "monitor:alarm" ||
    method === "daemon:logs" ||
    (method === "message:tail" && truthy(parsed.flags["follow"] ?? parsed.flags["f"]));

  // Forward stdin if caller used --stdin
  if (truthy(parsed.flags["stdin"]) && !("stdin_content" in parsed.flags)) {
    try {
      const content = await readStdinAll();
      parsed.flags["stdin_content"] = content;
    } catch (e) {
      process.stdout.write(
        JSON.stringify(err("invalid_params", `failed to read stdin: ${(e as Error).message}`)) + "\n",
      );
      return 1;
    }
  }

  if (needsStreaming) {
    const sock = await connectSockWithRetry(sockPath, cliConfig.connectTimeoutMs, cliConfig.connectRetryAttempts, cliConfig.connectRetryDelayMs);
    return await runStream(sock, parsed, method);
  }

  try {
    const params: Record<string, unknown> = {
      positionals: parsed.positionals,
      flags: parsed.flags,
    };
    const stdinContent = parsed.flags["stdin_content"];
    if (typeof stdinContent === "string") params.stdin_content = stdinContent;
    const resp = await requestOnceWithRetry(sockPath, {
      method,
      bearer: parsed.bearer,
      params,
    }, cliConfig, isReadOnlyMethod(method));
    if ("error" in resp && resp.error) {
      process.stdout.write(JSON.stringify({ ok: false, error: resp.error }) + "\n");
      return 1;
    }
    if (truthy(parsed.flags.short)) {
      process.stdout.write(formatShort(method, resp.result) + "\n");
      return 0;
    }
    const markdown = extractMarkdownResult(resp.result, parsed.flags.format);
    if (markdown !== null) {
      process.stdout.write(markdown + "\n");
      return 0;
    }
    process.stdout.write(JSON.stringify({ ok: true, data: resp.result }) + "\n");
    return 0;
  } catch (e) {
    process.stdout.write(
      JSON.stringify(err("internal", (e as Error).message ?? "rpc failed")) + "\n",
    );
    return 1;
  }
}

async function runStream(sock: net.Socket, parsed: ParsedArgs, method: string): Promise<number> {
  return await new Promise<number>((resolve) => {
    let finished = false;
    const stdoutQueue: Array<{ line: string; afterWrite?: () => void }> = [];
    const pendingFinalizers: Array<() => void> = [];
    let stdoutBlocked = false;
    let socketPaused = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      process.off("SIGBREAK", onInterrupt);
      resolve(code);
    };
    const maybeResumeSocket = () => {
      if (!socketPaused) return;
      socketPaused = false;
      if (typeof sock.resume === "function") sock.resume();
    };
    const flushFinalizers = () => {
      if (stdoutBlocked || stdoutQueue.length > 0) return;
      while (pendingFinalizers.length > 0) pendingFinalizers.shift()?.();
    };
    const flushStdout = () => {
      if (stdoutBlocked) return;
      while (stdoutQueue.length > 0) {
        const next = stdoutQueue[0]!;
        const ok = process.stdout.write(next.line);
        if (!ok) {
          stdoutBlocked = true;
          if (!socketPaused && typeof sock.pause === "function") {
            socketPaused = true;
            sock.pause();
          }
          process.stdout.once("drain", () => {
            stdoutBlocked = false;
            const flushed = stdoutQueue.shift();
            flushed?.afterWrite?.();
            maybeResumeSocket();
            flushStdout();
            flushFinalizers();
          });
          return;
        }
        stdoutQueue.shift();
        next.afterWrite?.();
      }
      maybeResumeSocket();
      flushFinalizers();
    };
    const writeStdout = (line: string, afterWrite?: () => void) => {
      stdoutQueue.push({ line, afterWrite });
      flushStdout();
    };
    const afterStdout = (cb: () => void) => {
      pendingFinalizers.push(cb);
      flushFinalizers();
    };
    const reqId = randomId();
    const params: Record<string, unknown> = {
      positionals: parsed.positionals,
      flags: parsed.flags,
      streaming: true,
    };
    const stdinContent = parsed.flags["stdin_content"];
    if (typeof stdinContent === "string") params.stdin_content = stdinContent;
    const req: IpcRequest = {
      kind: "request",
      id: reqId,
      method,
      bearer: parsed.bearer ?? undefined,
      params,
    };

    onMessages(sock, (msg) => {
      if (msg.kind === "stream_chunk" && msg.id === reqId) {
        const markdown = extractMarkdownResult(msg.data, parsed.flags.format);
        if (markdown !== null) {
          writeStdout(markdown + "\n");
        } else {
          writeStdout(JSON.stringify(msg.data) + "\n");
        }
      } else if (msg.kind === "stream_end" && msg.id === reqId) {
        if (msg.error) {
          writeStdout(JSON.stringify({ ok: false, error: msg.error }) + "\n", () => {
            finish(1);
            sock.end();
          });
        } else {
          afterStdout(() => {
            finish(0);
            sock.end();
          });
        }
      } else if (msg.kind === "response" && msg.id === reqId) {
        if (msg.error) {
          writeStdout(JSON.stringify({ ok: false, error: msg.error }) + "\n", () => {
            finish(1);
            sock.end();
          });
        } else {
          afterStdout(() => {
            finish(0);
            sock.end();
          });
        }
      }
    }, () => {
      finish(finished ? 0 : 1);
    });

    const onInterrupt = () => {
      sock.end();
      finish(130);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    if (process.platform === "win32") process.once("SIGBREAK", onInterrupt);

    writeMessage(sock, req);
  });
}

interface OneShotOpts {
  method: string;
  bearer: string | null;
  params: Record<string, unknown>;
}

function requestOnce(sock: net.Socket, opts: OneShotOpts): Promise<{ id: string; result?: unknown; error?: { code: string; message: string; data?: unknown } }> {
  return new Promise((resolve, reject) => {
    const id = randomId();
    const req: IpcRequest = {
      kind: "request",
      id,
      method: opts.method,
      bearer: opts.bearer ?? undefined,
      params: opts.params,
    };
    let resolved = false;
    onMessages(sock, (msg: IpcMessage) => {
      if (resolved) return;
      if (msg.kind === "response" && msg.id === id) {
        resolved = true;
        resolve({ id: msg.id, result: msg.result, error: msg.error });
      }
    }, () => {
      if (!resolved) reject(new Error("daemon closed connection"));
    });
    sock.once("error", (e) => {
      if (!resolved) reject(e);
    });
    writeMessage(sock, req);
  });
}

async function requestOnceWithRetry(
  sockPath: string,
  opts: OneShotOpts,
  cliConfig: ReturnType<typeof readCliConfig>,
  allowRetry: boolean,
): Promise<{ id: string; result?: unknown; error?: { code: string; message: string; data?: unknown } }> {
  let attempt = 0;
  let lastError: Error | null = null;
  while (attempt < cliConfig.connectRetryAttempts) {
    attempt++;
    let sock: net.Socket | null = null;
    try {
      sock = await connectSock(sockPath, cliConfig.connectTimeoutMs);
      const resp = await requestOnce(sock, opts);
      sock.end();
      return resp;
    } catch (e) {
      lastError = e as Error;
      if (sock) sock.destroy();
      if (!allowRetry || !isTransientRequestError(lastError) || attempt >= cliConfig.connectRetryAttempts) {
        throw lastError;
      }
      await sleep(cliConfig.connectRetryDelayMs);
    }
  }
  throw lastError ?? new Error("request failed");
}

async function ensureDaemon(sockPath: string): Promise<boolean> {
  const cliConfig = readCliConfig();
  if (await probeSock(sockPath, 200)) return true;
  spawnDaemon();
  const deadline = Date.now() + cliConfig.readyTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL_MS);
    if (await probeSock(sockPath, 200)) return true;
  }
  return false;
}

async function connectSockWithRetry(
  sockPath: string,
  timeoutMs: number,
  retryAttempts: number,
  retryDelayMs: number,
): Promise<net.Socket> {
  let attempt = 0;
  let lastError: Error | null = null;
  while (attempt < retryAttempts) {
    attempt++;
    try {
      return await connectSock(sockPath, timeoutMs);
    } catch (e) {
      const err = e as Error & { code?: string };
      lastError = err;
      if (!isTransientConnectError(err) || attempt >= retryAttempts) break;
      await sleep(retryDelayMs);
    }
  }
  throw lastError ?? new Error("connect failed");
}

function spawnDaemon(): void {
  const child = spawn(process.execPath, [process.argv[1], "--daemon-internal"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true,
  });
  child.unref();
}

function getCliVersion(): string {
  try {
    const pkg = require("../../package.json");
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function flagString(v: unknown): string | null {
  if (Array.isArray(v)) return flagString(v[v.length - 1]);
  return typeof v === "string" ? v : null;
}

function extractMarkdownResult(result: unknown, format: unknown): string | null {
  if (format !== "markdown" || !result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }

  const markdown = (result as { markdown?: unknown }).markdown;
  return typeof markdown === "string" ? markdown : null;
}

function isTransientConnectError(err: Error & { code?: string }): boolean {
  return err.message === "connect timeout" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ENOENT" ||
    err.code === "EPIPE" ||
    err.code === "ECONNRESET";
}

function isTransientRequestError(err: Error & { code?: string }): boolean {
  return isTransientConnectError(err) || err.message === "daemon closed connection";
}

function isReadOnlyMethod(method: string): boolean {
  return method === "version" ||
    method === "status" ||
    method === "daemon:status" ||
    method === "daemon:user:list" ||
    method === "daemon:config:get" ||
    method === "daemon:config:list" ||
    method === "session:info" ||
    method === "session:context" ||
    method === "session:list" ||
    method === "message:history";
}

function readCliConfig(): {
  readyTimeoutMs: number;
  connectTimeoutMs: number;
  connectRetryAttempts: number;
  connectRetryDelayMs: number;
} {
  const config = new ConfigStore();
  return {
    readyTimeoutMs: toMs(config.getEffective("daemon.ready_timeout_seconds"), DEFAULT_DAEMON_READY_TIMEOUT_MS),
    connectTimeoutMs: toMs(config.getEffective("daemon.connect_timeout_seconds"), DEFAULT_DAEMON_CONNECT_TIMEOUT_MS),
    connectRetryAttempts: toInt(config.getEffective("daemon.connect_retry_attempts"), DEFAULT_DAEMON_CONNECT_RETRY_ATTEMPTS),
    connectRetryDelayMs: toMs(config.getEffective("daemon.connect_retry_delay_seconds"), DEFAULT_DAEMON_CONNECT_RETRY_DELAY_MS),
  };
}

function toInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : fallback;
}

function toMs(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v * 1000)) : fallback;
}
