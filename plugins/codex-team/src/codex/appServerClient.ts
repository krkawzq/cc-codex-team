import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { logger } from "../logger";
import {
  JsonValue,
  JsonRpcError,
  RequestTimeoutError,
  TransportClosedError,
  mapJsonRpcError,
} from "./errors";

const STDERR_TAIL_LINES = 400;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface AppServerOptions {
  bin?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  configOverrides?: string[];
  clientInfo?: { name: string; title?: string; version: string };
  experimentalApi?: boolean;
  stderrTailLines?: number;
  requestTimeoutMs?: number;
}

export interface ServerNotification {
  method: string;
  params: JsonValue;
}

export interface ServerRequest {
  id: string | number;
  method: string;
  params: JsonValue;
}

export interface InitializeResponse extends Record<string, unknown> {}

interface PendingRequest {
  resolve(value: JsonValue): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export interface AppServerEvents {
  notification: (n: ServerNotification) => void;
  server_request: (r: ServerRequest) => void;
  close: (code: number | null) => void;
  error: (err: Error) => void;
}

export declare interface AppServerClient {
  on<E extends keyof AppServerEvents>(event: E, listener: AppServerEvents[E]): this;
  once<E extends keyof AppServerEvents>(event: E, listener: AppServerEvents[E]): this;
  off<E extends keyof AppServerEvents>(event: E, listener: AppServerEvents[E]): this;
  emit<E extends keyof AppServerEvents>(event: E, ...args: Parameters<AppServerEvents[E]>): boolean;
}

export class AppServerClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private pending = new Map<string, PendingRequest>();
  private stderrTail: string[] = [];
  private lastPid: number | null = null;
  private readonly options: Required<Omit<AppServerOptions, "env" | "cwd" | "clientInfo">> &
    Pick<AppServerOptions, "env" | "cwd" | "clientInfo">;
  private initialized = false;

  constructor(options: AppServerOptions = {}) {
    super();
    this.options = {
      bin: options.bin ?? "codex",
      args: options.args ?? [],
      cwd: options.cwd,
      env: options.env,
      configOverrides: options.configOverrides ?? [],
      clientInfo: options.clientInfo,
      experimentalApi: options.experimentalApi ?? true,
      stderrTailLines: options.stderrTailLines ?? STDERR_TAIL_LINES,
      requestTimeoutMs: Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    };
  }

  isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  pid(): number | null {
    return this.proc?.pid ?? this.lastPid;
  }

  stderrTailText(): string {
    return this.stderrTail.join("\n");
  }

  async start(): Promise<InitializeResponse> {
    if (this.proc) throw new Error("app-server already started");

    const args = [...this.options.args];
    for (const kv of this.options.configOverrides) args.push("--config", kv);
    args.push("app-server", "--listen", "stdio://");
    const launch = resolveLaunch(this.options.bin, args);

    const env = { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv;

    logger.debug("spawning app-server", { bin: launch.command, args: launch.args });
    this.proc = spawn(launch.command, launch.args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.lastPid = this.proc.pid ?? null;

    this.proc.on("error", (err) => {
      logger.error("app-server spawn error", { err: err.message });
      this.failAllPending(new TransportClosedError(`spawn error: ${err.message}`));
      this.emit("error", err);
    });
    this.proc.on("exit", (code, signal) => {
      logger.info("app-server exited", { code, signal });
      this.failAllPending(new TransportClosedError(`app-server exited (code=${code}, signal=${signal})`));
      this.emit("close", code);
      this.proc = null;
      this.initialized = false;
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => this.onStderr(chunk));

    const init = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? { name: "codex-team", title: "codex-team", version: "0.5.0" },
      capabilities: { experimentalApi: this.options.experimentalApi },
    });
    this.notify("initialized", {});
    this.initialized = true;
    return init as InitializeResponse;
  }

  async close(graceMs = 2000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.initialized = false;

    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    requestProcessShutdown(proc);
    const timer = setTimeout(() => forceKillProcess(proc), graceMs);
    timer.unref();

    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
    this.failAllPending(new TransportClosedError("app-server closed"));
  }

  request(method: string, params: JsonValue = {}): Promise<JsonValue> {
    if (!this.proc) return Promise.reject(new TransportClosedError("app-server is not running"));
    if (this.proc.exitCode !== null) return Promise.reject(new TransportClosedError("app-server already exited"));

    const id = randomUUID();
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        void this.close().catch(() => undefined);
        pending.reject(new RequestTimeoutError(`${method} timed out after ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });
      try {
        this.writeMessage({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params: JsonValue = {}): void {
    if (!this.proc) throw new TransportClosedError("app-server is not running");
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: JsonValue): void {
    if (!this.proc) return;
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  respondAck(id: string | number, result: JsonValue): Promise<{ backpressured: boolean }> {
    if (!this.proc) return Promise.reject(new TransportClosedError("app-server is not running"));
    return this.writeMessageAck({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number, code: number, message: string, data?: JsonValue): void {
    if (!this.proc) return;
    const error: { code: number; message: string; data?: JsonValue } = { code, message };
    if (data !== undefined) error.data = data;
    this.writeMessage({ jsonrpc: "2.0", id, error });
  }

  respondErrorAck(id: string | number, code: number, message: string, data?: JsonValue): Promise<{ backpressured: boolean }> {
    if (!this.proc) return Promise.reject(new TransportClosedError("app-server is not running"));
    const error: { code: number; message: string; data?: JsonValue } = { code, message };
    if (data !== undefined) error.data = data;
    return this.writeMessageAck({ jsonrpc: "2.0", id, error });
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private writeMessage(msg: Record<string, unknown>): void {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) {
      throw new TransportClosedError("app-server stdin closed");
    }
    const line = JSON.stringify(msg) + "\n";
    proc.stdin.write(line);
  }

  private writeMessageAck(msg: Record<string, unknown>): Promise<{ backpressured: boolean }> {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) {
      return Promise.reject(new TransportClosedError("app-server stdin closed"));
    }
    const line = JSON.stringify(msg) + "\n";
    return new Promise((resolve, reject) => {
      const onExit = () => {
        reject(new TransportClosedError("app-server exited during stdin write"));
      };
      proc.once("exit", onExit);
      try {
        const backpressured = !proc.stdin.write(line, (err?: Error | null) => {
          proc.off("exit", onExit);
          if (err) {
            reject(new TransportClosedError(`app-server stdin write failed: ${err.message}`));
            return;
          }
          resolve({ backpressured });
        });
      } catch (e) {
        proc.off("exit", onExit);
        reject(e as Error);
      }
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        logger.warn("malformed line from app-server", { snippet: line.slice(0, 200) });
        continue;
      }
      this.dispatchIncoming(parsed);
    }
  }

  private onStderr(chunk: string): void {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (!line) continue;
      this.stderrTail.push(line);
      if (this.stderrTail.length > this.options.stderrTailLines) this.stderrTail.shift();
    }
  }

  private dispatchIncoming(msg: Record<string, unknown>): void {
    const hasId = "id" in msg;
    const hasMethod = typeof msg.method === "string";
    const method = typeof msg.method === "string" ? msg.method : null;

    if (hasMethod && hasId) {
      this.emit("server_request", {
        id: msg.id as string | number,
        method: method!,
        params: (msg.params as JsonValue) ?? null,
      });
      return;
    }

    if (hasMethod && !hasId) {
      this.emit("notification", { method: method!, params: (msg.params as JsonValue) ?? null });
      return;
    }

    if (hasId) {
      const id = String(msg.id);
      const pending = this.pending.get(id);
      if (!pending) {
        logger.debug("unmatched response id", { id });
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in msg && msg.error && typeof msg.error === "object") {
        const errObj = msg.error as { code?: number; message?: string; data?: JsonValue };
        const code = typeof errObj.code === "number" ? errObj.code : -32000;
        const message = typeof errObj.message === "string" ? errObj.message : "unknown";
        pending.reject(mapJsonRpcError(code, message, errObj.data));
      } else {
        pending.resolve((msg.result as JsonValue) ?? null);
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

export function isJsonRpcError(e: unknown): e is JsonRpcError {
  return e instanceof JsonRpcError;
}

function resolveLaunch(bin: string, args: string[]): { command: string; args: string[] } {
  if (isNodeScript(bin)) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  if (process.platform !== "win32") {
    return { command: bin, args };
  }

  const resolved = resolveWindowsCommand(bin) ?? bin;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", quoteWindowsCommand(resolved, args)],
    };
  }
  return { command: resolved, args };
}

function resolveWindowsCommand(bin: string): string | null {
  if (bin.includes("\\") || bin.includes("/") || path.extname(bin).length > 0) return bin;
  try {
    const raw = execFileSync("where", [bin], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function isNodeScript(bin: string): boolean {
  return /\.(cjs|mjs|js)$/i.test(bin);
}

function quoteWindowsCommand(bin: string, args: string[]): string {
  return [bin, ...args].map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return "\"\"";
  if (!/[ \t"&()^<>|]/.test(arg)) return arg;
  return `"${arg.replace(/(["])/g, "\\$1")}"`;
}

function requestProcessShutdown(proc: ChildProcessWithoutNullStreams): void {
  try { proc.stdin.end(); } catch { /* ignore */ }
  if (process.platform === "win32") {
    // Node maps signal-based child termination to a forceful shutdown on Windows.
    // Give the app-server a chance to exit cleanly after stdin closes before falling
    // back to kill() on the grace timer.
    return;
  }
  try { proc.kill("SIGTERM"); } catch { /* ignore */ }
}

function forceKillProcess(proc: ChildProcessWithoutNullStreams): void {
  try {
    if (process.platform === "win32") proc.kill();
    else proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
