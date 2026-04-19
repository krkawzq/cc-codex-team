import readline from "node:readline";

import { AsyncQueue } from "../asyncQueue";
import { Config, resolveCodexBin } from "../config";
import { TransportError } from "../errors";
import { ManagedChild, spawnManaged } from "../platform";
import { isObject } from "../protocol";

export interface RpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface AppServerClientLike {
  readonly pid: number | null;
  start(): Promise<void>;
  isAlive(): boolean;
  stderrSnapshot(): string[];
  stderrTail(limit?: number): string;
  nextNotification(timeoutMs?: number, timeoutMessage?: string): Promise<RpcNotification>;
  threadStart(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  threadResume(threadId: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  threadRead(threadId: string, includeTurns?: boolean): Promise<Record<string, unknown>>;
  threadArchive(threadId: string): Promise<Record<string, unknown>>;
  threadCompactStart(threadId: string): Promise<Record<string, unknown>>;
  turnStart(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  turnInterrupt(threadId: string, turnId: string): Promise<Record<string, unknown>>;
  kill(): void;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  method: string;
}

const BUFFERED_NOTIFICATION_METHODS = new Set([
  "item/started",
  "item/completed",
  "turn/started",
  "turn/completed",
  "thread/tokenUsageUpdated",
  "thread/tokenUsage/updated",
]);

const OPT_OUT_NOTIFICATION_METHODS = [
  "item/agentMessage/delta",
  "item/reasoning/delta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "turn/diff/updated",
  "turn/plan/updated",
];

function responseErrorMessage(error: unknown): string {
  if (isObject(error)) {
    const code = error.code == null ? "" : `code=${String(error.code)} `;
    return `${code}${String(error.message ?? "unknown error")}`.trim();
  }
  return String(error);
}

export class AppServerClient implements AppServerClientLike {
  private proc: ManagedChild | null = null;
  private readonly notifications = new AsyncQueue<RpcNotification>(1000);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stderrLines: string[] = [];
  private nextRequestId = 0;
  private readLoopStarted = false;
  private closeError: Error | null = null;
  private initialized = false;

  constructor(private readonly cfg: Config) {}

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  isAlive(): boolean {
    return !!this.proc && this.proc.exitCode == null && !this.proc.killed;
  }

  stderrSnapshot(): string[] {
    return [...this.stderrLines];
  }

  stderrTail(limit = 40): string {
    return this.stderrLines.slice(Math.max(0, this.stderrLines.length - limit)).join("\n");
  }

  async start(): Promise<void> {
    if (this.proc) {
      return;
    }
    const args = this.buildArgs();
    const env = { ...process.env };
    if (this.cfg.daemon.codexHome) {
      env.CODEX_HOME = this.cfg.daemon.codexHome;
    }
    this.proc = spawnManaged({
      command: resolveCodexBin(this.cfg),
      args,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: undefined,
      env,
      detached: true,
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) {
          continue;
        }
        this.stderrLines.push(line);
        if (this.stderrLines.length > 400) {
          this.stderrLines.splice(0, this.stderrLines.length - 400);
        }
      }
    });
    this.proc.once("error", (error) => {
      this.failAll(new TransportError(`failed to start app-server: ${error.message}`));
    });
    this.proc.once("exit", (code, signal) => {
      this.failAll(
        new TransportError(
          `app-server exited${signal ? ` via ${signal}` : ` with code ${String(code ?? 1)}`}: ${this.stderrTail(20)}`,
        ),
      );
    });
    this.startReadLoop();
    await this.initialize();
  }

  private buildArgs(): string[] {
    if (this.cfg.daemon.launchArgsOverride.length > 0) {
      return [...this.cfg.daemon.launchArgsOverride];
    }
    const args: string[] = [];
    for (const override of this.cfg.daemon.configOverrides) {
      args.push("--config", override);
    }
    args.push("app-server", "--listen", "stdio://");
    return args;
  }

  private startReadLoop(): void {
    if (this.readLoopStarted || !this.proc) {
      return;
    }
    this.readLoopStarted = true;
    this.proc.stdout.setEncoding("utf8");
    const rl = readline.createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });
    void (async () => {
      try {
        for await (const line of rl) {
          if (!line) {
            continue;
          }
          this.handleLine(line);
        }
        this.failAll(new TransportError(`app-server closed stdout: ${this.stderrTail(20)}`));
      } catch (error) {
        this.failAll(new TransportError(`failed to read app-server stream: ${(error as Error).message}`));
      } finally {
        rl.close();
      }
    })();
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.failAll(new TransportError(`invalid JSON-RPC line: ${(error as Error).message}`));
      return;
    }
    if (!isObject(message)) {
      return;
    }
    const id = message.id;
    const method = message.method;
    if (typeof method === "string" && id !== undefined) {
      void this.handleServerRequest(String(id), method, isObject(message.params) ? message.params : {}).catch((error) => {
        this.failAll(new TransportError(`failed to handle server request ${method}: ${(error as Error).message}`));
      });
      return;
    }
    if (typeof method === "string") {
      if (!BUFFERED_NOTIFICATION_METHODS.has(method)) {
        return;
      }
      this.notifications.push({
        method,
        params: isObject(message.params) ? message.params : {},
      });
      return;
    }
    if (id === undefined) {
      return;
    }
    const pending = this.pending.get(String(id));
    if (!pending) {
      return;
    }
    this.pending.delete(String(id));
    if (message.error !== undefined) {
      pending.reject(new TransportError(`${pending.method}: ${responseErrorMessage(message.error)}`));
      return;
    }
    pending.resolve(isObject(message.result) ? message.result : {});
  }

  private async handleServerRequest(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    let result: Record<string, unknown> = {};
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      result = { decision: "accept" };
    } else if (method === "item/tool/call") {
      result = { success: false, content: [], structuredContent: null };
    } else if (method === "item/commandExecution/requestCallback") {
      result = { decision: "accept" };
    } else {
      void params;
      result = {};
    }
    this.write({ id, result });
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const payload = await this.request("initialize", {
      clientInfo: {
        name: "codex-team",
        title: "Codex Team",
        version: "0.3.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: OPT_OUT_NOTIFICATION_METHODS,
      },
    });
    validateInitializeResponse(payload);
    this.notify("initialized", {});
    this.initialized = true;
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.proc || this.closeError) {
      throw this.closeError ?? new TransportError("app-server is not running");
    }
    const id = `rpc-${++this.nextRequestId}`;
    return awaitResponse<Record<string, unknown>>(
      () =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pending.delete(id);
            reject(new TransportError(`${method}: timed out after ${this.cfg.daemon.rpcTimeoutSeconds}s`));
          }, this.cfg.daemon.rpcTimeoutSeconds * 1000);
          this.pending.set(id, {
            method,
            resolve: (value) => {
              clearTimeout(timeout);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timeout);
              reject(error);
            },
          });
          try {
            this.write({ id, method, params });
          } catch (error) {
            this.pending.delete(id);
            clearTimeout(timeout);
            reject(error as Error);
          }
        }),
    );
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc || this.closeError) {
      return;
    }
    this.write({ method, params });
  }

  async nextNotification(timeoutMs = 0, timeoutMessage = "timed out waiting for notification"): Promise<RpcNotification> {
    return await this.notifications.shift(timeoutMs, timeoutMessage);
  }

  async threadStart(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request("thread/start", params);
    requireThreadId(response, "thread/start");
    return response;
  }

  async threadResume(threadId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request("thread/resume", { threadId, ...params });
    requireThreadId(response, "thread/resume");
    return response;
  }

  async threadRead(threadId: string, includeTurns = false): Promise<Record<string, unknown>> {
    const response = await this.request("thread/read", { threadId, includeTurns });
    requireThreadId(response, "thread/read");
    return response;
  }

  async threadArchive(threadId: string): Promise<Record<string, unknown>> {
    return await this.request("thread/archive", { threadId });
  }

  async threadCompactStart(threadId: string): Promise<Record<string, unknown>> {
    return await this.request("thread/compact/start", { threadId });
  }

  async turnStart(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request("turn/start", params);
    const turn = isObject(response.turn) ? response.turn : null;
    if (!turn || typeof turn.id !== "string" || !turn.id) {
      throw new TransportError("turn/start response missing turn.id");
    }
    return response;
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    return await this.request("turn/interrupt", { threadId, turnId });
  }

  kill(): void {
    const proc = this.proc;
    if (proc?.pid != null) {
      void proc.killTree(0);
    }
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.initialized = false;
    this.failAll(new TransportError("app-server client closed"));
    if (!proc) {
      return;
    }
    const exitPromise = new Promise<void>((resolve) => {
      if (proc.exitCode != null || proc.killed) {
        resolve();
        return;
      }
      proc.once("exit", () => resolve());
    });
    if (proc.stdin.writable) {
      proc.stdin.end();
    }
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    await Promise.race([exitPromise, timeout]);
    if (proc.exitCode == null && !proc.killed) {
      await proc.killTree(1500);
      await exitPromise.catch(() => undefined);
    }
  }

  private write(payload: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new TransportError("app-server stdin is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private failAll(error: Error): void {
    if (this.closeError) {
      return;
    }
    this.closeError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.notifications.close(error);
  }
}

async function awaitResponse<T>(factory: () => Promise<T>): Promise<T> {
  return await factory();
}

function requireThreadId(response: Record<string, unknown>, method: string): void {
  const thread = isObject(response.thread) ? response.thread : null;
  if (!thread || typeof thread.id !== "string" || !thread.id) {
    throw new TransportError(`${method} response missing thread.id`);
  }
}

function validateInitializeResponse(response: Record<string, unknown>): void {
  const userAgent = typeof response.userAgent === "string" ? response.userAgent.trim() : "";
  const server = isObject(response.serverInfo) ? response.serverInfo : null;
  let serverName = server && typeof server.name === "string" ? server.name.trim() : "";
  let serverVersion = server && typeof server.version === "string" ? server.version.trim() : "";
  if ((!serverName || !serverVersion) && userAgent) {
    const parsed = splitUserAgent(userAgent);
    serverName ||= parsed.name || "";
    serverVersion ||= parsed.version || "";
  }
  if (!userAgent || !serverName || !serverVersion) {
    throw new TransportError(
      `initialize response missing required metadata (userAgent=${JSON.stringify(userAgent)}, serverName=${JSON.stringify(serverName)}, serverVersion=${JSON.stringify(serverVersion)})`,
    );
  }
}

function splitUserAgent(userAgent: string): { name: string | null; version: string | null } {
  const raw = userAgent.trim();
  if (!raw) {
    return { name: null, version: null };
  }
  if (raw.includes("/")) {
    const [name, ...rest] = raw.split("/");
    return { name: name || null, version: rest.join("/") || null };
  }
  const parts = raw.split(/\s+/, 2);
  if (parts.length === 2) {
    return { name: parts[0] || null, version: parts[1] || null };
  }
  return { name: raw, version: null };
}
