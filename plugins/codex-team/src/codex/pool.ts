import { EventEmitter } from "node:events";

import {
  AppServerClient,
  type AppServerLogLine,
  type AppServerOptions,
  type ServerNotification,
  type ServerRequest,
} from "./appServerClient";
import { logger } from "../logger";

export interface PoolOptions {
  maxSessionsPerProcess: number;
  clientDefaults?: AppServerOptions;
  onSpawn?: (pid: number) => void;
  onExit?: (pid: number) => void;
}

export interface ClientTag {
  id: string;
  user: string;
  sessions: Set<string>;
}

export interface PoolNotification {
  user: string;
  clientId: string;
  notification: ServerNotification;
}

export interface PoolServerRequest {
  user: string;
  clientId: string;
  request: ServerRequest;
  respond(result: unknown): void;
  respondError(code: number, message: string, data?: unknown): void;
}

export interface PoolClientClose {
  user: string;
  clientId: string;
  sessions: string[];
  exitCode: number | null;
  reason: "unexpected" | "user_close" | "shutdown";
}

interface PoolEvents {
  notification: (e: PoolNotification) => void;
  server_request: (e: PoolServerRequest) => void;
  client_close: (e: PoolClientClose) => void;
}

export declare interface AppServerPool {
  on<E extends keyof PoolEvents>(event: E, listener: PoolEvents[E]): this;
  emit<E extends keyof PoolEvents>(event: E, ...args: Parameters<PoolEvents[E]>): boolean;
}

interface Managed {
  id: string;
  user: string;
  client: AppServerClient;
  sessions: Set<string>;
  closeReason: PoolClientClose["reason"] | null;
}

export interface SessionClientBinding {
  appServerId: string;
  pid: number | null;
}

export interface ClosedSessionLogs extends SessionClientBinding {
  closedAt: string;
  stderrTail: AppServerLogLine[];
  stdoutTail: AppServerLogLine[];
}

export class AppServerPool extends EventEmitter {
  private readonly options: PoolOptions;
  private readonly byUser = new Map<string, Managed[]>();
  private readonly byClient = new Map<string, Managed>();
  private readonly bySession = new Map<string, Managed>();
  private readonly closedLogsBySession = new Map<string, ClosedSessionLogs>();
  private readonly inFlightAcquireBySession = new Map<string, Promise<AppServerClient>>();
  private nextClientId = 1;
  private shuttingDown = false;

  constructor(options: PoolOptions) {
    super();
    this.options = options;
  }

  async acquire(user: string, sessionKey: string, clientOptions?: AppServerOptions): Promise<AppServerClient> {
    if (this.shuttingDown) throw new Error("pool is shutting down");

    const existing = this.bySession.get(sessionKey);
    if (existing) {
      if (existing.user !== user) {
        throw new Error(`session ${sessionKey} is already held by another user`);
      }
      return existing.client;
    }

    const inFlight = this.inFlightAcquireBySession.get(sessionKey);
    if (inFlight) return await inFlight;

    const acquirePromise = this.acquireSlow(user, sessionKey, clientOptions);
    this.inFlightAcquireBySession.set(sessionKey, acquirePromise);
    try {
      return await acquirePromise;
    } finally {
      if (this.inFlightAcquireBySession.get(sessionKey) === acquirePromise) {
        this.inFlightAcquireBySession.delete(sessionKey);
      }
    }
  }

  private async acquireSlow(user: string, sessionKey: string, clientOptions?: AppServerOptions): Promise<AppServerClient> {
    const existing = this.bySession.get(sessionKey);
    if (existing) {
      if (existing.user !== user) {
        throw new Error(`session ${sessionKey} is already held by another user`);
      }
      return existing.client;
    }

    const managed = this.findAvailableForUser(user, false);
    if (managed) {
      managed.sessions.add(sessionKey);
      this.bySession.set(sessionKey, managed);
      this.closedLogsBySession.delete(sessionKey);
      return managed.client;
    }

    const fresh = await this.spawn(user, clientOptions);
    fresh.sessions.add(sessionKey);
    this.bySession.set(sessionKey, fresh);
    this.closedLogsBySession.delete(sessionKey);
    return fresh.client;
  }

  release(sessionKey: string): void {
    const m = this.bySession.get(sessionKey);
    if (!m) return;
    m.sessions.delete(sessionKey);
    this.bySession.delete(sessionKey);
    this.closedLogsBySession.delete(sessionKey);
  }

  rekeySession(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return;
    const m = this.bySession.get(oldKey);
    if (!m) return;
    m.sessions.delete(oldKey);
    m.sessions.add(newKey);
    this.bySession.delete(oldKey);
    this.bySession.set(newKey, m);
    const closed = this.closedLogsBySession.get(oldKey);
    if (closed) {
      this.closedLogsBySession.delete(oldKey);
      this.closedLogsBySession.set(newKey, cloneClosedSessionLogs(closed));
    }
  }

  async acquireForAdhoc(user: string, clientOptions?: AppServerOptions): Promise<AppServerClient> {
    if (this.shuttingDown) throw new Error("pool is shutting down");
    const existing = this.findAvailableForUser(user, true);
    if (existing) return existing.client;
    // No existing client with room — spawn a transient one; do not bind to any session.
    const fresh = await this.spawn(user, clientOptions);
    return fresh.client;
  }

  sessionsForClient(clientId: string): string[] {
    const m = this.byClient.get(clientId);
    return m ? Array.from(m.sessions) : [];
  }

  clientForSession(sessionKey: string): AppServerClient | null {
    const m = this.bySession.get(sessionKey);
    return m ? m.client : null;
  }

  sessionBinding(sessionKey: string): SessionClientBinding | null {
    const m = this.bySession.get(sessionKey);
    return m ? { appServerId: m.id, pid: m.client.pid() } : null;
  }

  clientById(clientId: string): AppServerClient | null {
    return this.byClient.get(clientId)?.client ?? null;
  }

  closedLogsForSession(sessionKey: string): ClosedSessionLogs | null {
    const snapshot = this.closedLogsBySession.get(sessionKey);
    return snapshot ? cloneClosedSessionLogs(snapshot) : null;
  }

  listClients(): ClientTag[] {
    return Array.from(this.byClient.values()).map((m) => ({
      id: m.id,
      user: m.user,
      sessions: new Set(m.sessions),
    }));
  }

  processCount(): number {
    return this.byClient.size;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const closes = Array.from(this.byClient.values()).map((m) => {
      m.closeReason = "shutdown";
      return m.client.close().catch(() => undefined);
    });
    await Promise.all(closes);
    this.inFlightAcquireBySession.clear();
    this.byUser.clear();
    this.byClient.clear();
    this.bySession.clear();
    this.closedLogsBySession.clear();
  }

  async closeUser(user: string): Promise<void> {
    const managed = [...(this.byUser.get(user) ?? [])];
    await Promise.all(managed.map((m) => {
      m.closeReason = "user_close";
      return m.client.close().catch(() => undefined);
    }));
  }

  private findAvailableForUser(user: string, allowBoundSessions: boolean): Managed | null {
    const list = this.byUser.get(user);
    if (!list) return null;
    for (const m of list) {
      if (!m.client.isAlive()) continue;
      if (!allowBoundSessions && m.sessions.size > 0) continue;
      if (m.sessions.size < this.options.maxSessionsPerProcess) return m;
    }
    return null;
  }

  private async spawn(user: string, override?: AppServerOptions): Promise<Managed> {
    const clientOptions = { ...(this.options.clientDefaults ?? {}), ...(override ?? {}) };
    const client = new AppServerClient(clientOptions);
    const id = `as-${this.nextClientId++}`;
    const managed: Managed = { id, user, client, sessions: new Set(), closeReason: null };

    client.on("notification", (n) => {
      this.emit("notification", { user, clientId: id, notification: n });
    });
    client.on("server_request", (r) => {
      this.emit("server_request", {
        user,
        clientId: id,
        request: r,
        respond: (result) => client.respond(r.id, result as never),
        respondError: (code, message, data) => client.respondError(r.id, code, message, data as never),
      });
    });
    client.on("close", (code) => {
      const sessions = Array.from(managed.sessions);
      const reason = managed.closeReason ?? (this.shuttingDown ? "shutdown" : "unexpected");
      managed.closeReason = null;
      const closedLogs = {
        appServerId: id,
        pid: client.pid(),
        closedAt: new Date().toISOString(),
        stderrTail: client.stderrTail(),
        stdoutTail: client.stdoutTail(),
      };
      for (const s of sessions) this.bySession.delete(s);
      managed.sessions.clear();
      if (reason === "unexpected") {
        for (const sessionKey of sessions) {
          this.closedLogsBySession.set(sessionKey, cloneClosedSessionLogs(closedLogs));
        }
      } else {
        for (const sessionKey of sessions) this.closedLogsBySession.delete(sessionKey);
      }
      const list = this.byUser.get(user);
      if (list) {
        const idx = list.indexOf(managed);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this.byUser.delete(user);
      }
      this.byClient.delete(id);
      const pid = client.pid();
      if (pid !== null && this.options.onExit) this.options.onExit(pid);
      this.emit("client_close", { user, clientId: id, sessions, exitCode: code, reason });
    });
    client.on("error", (err) => {
      logger.error("app-server client error", { user, clientId: id, err: err.message });
    });

    try {
      await client.start();
    } catch (e) {
      try { await client.close(); } catch { /* ignore */ }
      throw e;
    }
    const pid = client.pid();
    if (pid !== null && this.options.onSpawn) this.options.onSpawn(pid);

    const list = this.byUser.get(user) ?? [];
    list.push(managed);
    this.byUser.set(user, list);
    this.byClient.set(id, managed);
    return managed;
  }
}

function cloneClosedSessionLogs(value: ClosedSessionLogs): ClosedSessionLogs {
  return {
    appServerId: value.appServerId,
    pid: value.pid,
    closedAt: value.closedAt,
    stderrTail: value.stderrTail.map((entry) => ({ ...entry })),
    stdoutTail: value.stdoutTail.map((entry) => ({ ...entry })),
  };
}
