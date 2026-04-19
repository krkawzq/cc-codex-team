import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";

import { Config, loadConfig } from "./config";
import { CompactionMonitor } from "./compaction";
import { EventBus } from "./eventBus";
import { readJsonlTail, readLastLines } from "./fileIO";
import { HealthMonitor } from "./health";
import { asCodexTeamError, InvalidRequest, SessionNotFound, errorToWire } from "./errors";
import { encodeMessage, decodeRequest } from "./protocol";
import { RegistryStore } from "./registry";
import { Session, SessionFactory } from "./session";
import { WatchdogTimer } from "./watchdog";
import { AsyncQueue } from "./asyncQueue";
import { AppServerClient, AppServerClientLike } from "./codex/appServerClient";
import { filterHistoryMarkdown, filterTurnsJsonl } from "./history";

type RequestHandler = (message: { id: string; cmd: string; params: Record<string, unknown> }) => Promise<Record<string, unknown>>;

function asString(value: unknown): string {
  return String(value ?? "");
}

export class DaemonServer {
  readonly eventBus: EventBus;
  readonly registry: RegistryStore;
  readonly factory: SessionFactory;
  readonly sessions = new Map<string, Session>();
  private readonly compaction: CompactionMonitor;
  private readonly watchdog: WatchdogTimer;
  private readonly health: HealthMonitor;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private server: net.Server | null = null;
  private watchdogTimers: NodeJS.Timeout[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: Config,
    private readonly socketPath: string,
    private readonly shutdownCallback?: () => void,
    private readonly clientFactory: (cfg: Config) => AppServerClientLike = (cfg) => new AppServerClient(cfg),
  ) {
    this.eventBus = new EventBus(cfg.monitor.eventsMaxBuffer, cfg.monitor.subscriberQueueMax);
    this.registry = new RegistryStore(path.join(cfg.daemon.dataDir, "registry.json"));
    this.compaction = new CompactionMonitor(cfg, this.registry, this.eventBus);
    this.factory = new SessionFactory(cfg, this.registry, this.eventBus, this.compaction, this.clientFactory);
    this.watchdog = new WatchdogTimer(cfg, this.registry, this.eventBus, this.sessions);
    this.health = new HealthMonitor(cfg, this.registry, this.sessions, this.eventBus, this.factory);
    this.installHandlers();
  }

  replaceConfig(cfg: Config): void {
    cfg.daemon.dataDir = cfg.daemon.dataDir || this.cfg.daemon.dataDir;
    cfg.daemon.socketPath = cfg.daemon.socketPath || this.cfg.daemon.socketPath;
    this.cfg = cfg;
    this.eventBus.replaceLimits(cfg.monitor.eventsMaxBuffer, cfg.monitor.subscriberQueueMax);
    this.factory.replaceConfig(cfg);
    this.health.replaceConfig(cfg);
    for (const session of this.sessions.values()) {
      session.replaceConfig(cfg);
    }
    if (this.server) {
      this.restartBackgroundLoops();
    }
  }

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
    this.server = net.createServer((socket) => {
      void this.handleSocket(socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => resolve());
    });
    this.restartBackgroundLoops();
    await this.watchdog.tickOnce({ force: true, alarmName: "default" });
    for (const [name, alarm] of Object.entries(this.cfg.monitor.watchdogAlarms)) {
      if (alarm.enabled) {
        await this.watchdog.tickOnce({ force: true, alarmName: name, alarm });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopBackgroundLoops();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
    for (const session of [...this.sessions.values()]) {
      await session.shutdown();
    }
    this.sessions.clear();
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
  }

  private stopBackgroundLoops(): void {
    for (const timer of this.watchdogTimers) {
      clearInterval(timer);
    }
    this.watchdogTimers = [];
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private restartBackgroundLoops(): void {
    this.stopBackgroundLoops();
    this.watchdogTimers.push(
      setInterval(() => {
        void this.watchdog.tickOnce({ alarmName: "default" });
      }, this.cfg.monitor.watchdogIntervalSeconds * 1000),
    );
    for (const [name, alarm] of Object.entries(this.cfg.monitor.watchdogAlarms)) {
      if (!alarm.enabled) {
        continue;
      }
      this.watchdogTimers.push(
        setInterval(() => {
          void this.watchdog.tickOnce({ alarmName: name, alarm });
        }, alarm.intervalSeconds * 1000),
      );
    }
    this.heartbeatTimer = setInterval(() => {
      void this.health.tickOnce();
    }, this.cfg.heartbeat.intervalSeconds * 1000);
  }

  private installHandlers(): void {
    this.handlers.set("session.create", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      if (!name) {
        throw new InvalidRequest("name required");
      }
      return await this.withSessionOperationLock(name, async () => {
        const session = await this.factory.create(name, {
          cwd: message.params.cwd == null ? null : asString(message.params.cwd),
          model: message.params.model == null ? null : asString(message.params.model),
          modelProvider:
            message.params.modelProvider == null ? null : asString(message.params.modelProvider),
          sandbox: message.params.sandbox == null ? null : asString(message.params.sandbox),
          approvalPolicy:
            message.params.approvalPolicy == null ? null : asString(message.params.approvalPolicy),
          serviceTier: message.params.serviceTier == null ? null : asString(message.params.serviceTier),
          reasoningEffort:
            message.params.reasoningEffort == null ? null : asString(message.params.reasoningEffort),
          personality: message.params.personality == null ? null : asString(message.params.personality),
          baseInstructions:
            message.params.baseInstructions == null ? null : asString(message.params.baseInstructions),
          developerInstructions:
            message.params.developerInstructions == null
              ? null
              : asString(message.params.developerInstructions),
          profile: message.params.profile == null ? null : asString(message.params.profile),
          ephemeral: Boolean(message.params.ephemeral),
        });
        this.sessions.set(session.name, session);
        const entry = this.registry.get(session.name);
        return { name: session.name, thread_id: entry.threadId };
      });
    });

    this.handlers.set("session.list", async () => ({
      sessions: this.registry.list(),
    }));

    this.handlers.set("session.status", async (message) => ({
      ...this.registry.get(asString(message.params.name)),
    }));

    this.handlers.set("session.read", async (message) => {
      const name = asString(message.params.name);
      const includeTurns = Boolean(message.params.includeTurns);
      const live = this.sessions.get(name);
      if (live) {
        return await live.read(includeTurns);
      }
      const entry = this.registry.get(name);
      if (entry.ephemeral) {
        throw new InvalidRequest(
          `session ${name} is ephemeral and can only be read while its app-server is still alive`,
        );
      }
      const temp = this.clientFactory(this.cfg);
      try {
        await temp.start();
        return await temp.threadRead(entry.threadId, includeTurns);
      } finally {
        await temp.close();
      }
    });

    this.handlers.set("session.close", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (session) {
          await session.close();
          this.sessions.delete(name);
        } else {
          this.registry.update(name, { status: "closed", appServerPid: null, queueLength: 0 });
        }
        return { name, closed: true };
      });
    });

    this.handlers.set("session.ack_error", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (session) {
          await session.ackError();
        } else {
          this.registry.update(name, { status: "idle", errorMessage: null });
        }
        return { name, acked: true };
      });
    });

    this.handlers.set("session.dump", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (session) {
        return session.dumpState();
      }
      const entry = this.registry.get(name);
      const base = path.join(this.cfg.daemon.dataDir, "sessions", name);
      const stderrPath = path.join(base, "app-server.stderr.log");
      const stderrTail = readLastLines(stderrPath, 20);
      return {
        session: entry,
        queue: [],
        transport_alive: false,
        stderr_tail: stderrTail,
        history_path: path.join(base, "history.md"),
        turns_path: path.join(base, "turns.jsonl"),
      };
    });

    this.handlers.set("session.resume", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = await this.factory.resume(name);
        this.sessions.set(name, session);
        return { name, resumed: true };
      });
    });

    this.handlers.set("session.restart", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const entry = this.registry.get(name);
        const existing = this.sessions.get(name);
        if (entry.ephemeral) {
          if (!existing) {
            throw new InvalidRequest(
              `session ${name} is ephemeral and cannot be restarted after its app-server exits`,
            );
          }
          await existing.kill("restarting ephemeral session");
          this.sessions.delete(name);
          this.registry.delete(name);
          const recreated = await this.factory.create(name, {
            cwd: entry.cwd,
            model: entry.model,
            modelProvider: entry.modelProvider,
            sandbox: entry.sandbox,
            approvalPolicy: entry.approvalPolicy,
            serviceTier: entry.serviceTier,
            reasoningEffort: entry.reasoningEffort,
            personality: entry.personality,
            profile: entry.profile,
            ephemeral: true,
          });
          this.sessions.set(name, recreated);
          return { name, restarted: true, recreated: true, ephemeral: true };
        }
        if (existing) {
          await existing.close();
          this.sessions.delete(name);
        }
        const session = await this.factory.resume(name);
        this.sessions.set(name, session);
        return { name, restarted: true };
      });
    });

    this.handlers.set("session.kill", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        await session.kill("killed by operator");
        this.sessions.delete(name);
        return { name, killed: true };
      });
    });

    this.handlers.set("session.forget", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        let archived = false;
        if (session) {
          const entry = this.registry.get(name);
          if (!entry.ephemeral) {
            try {
              await session.archiveThread();
              archived = true;
            } catch {
              // best effort; forgetting local ownership still matters
            }
          }
          await session.close();
          this.sessions.delete(name);
        } else {
          const entry = this.registry.get(name);
          if (!entry.ephemeral) {
            const temp = this.clientFactory(this.cfg);
            try {
              await temp.start();
              await temp.threadArchive(entry.threadId);
              archived = true;
            } catch {
              // best effort
            } finally {
              await temp.close();
            }
          }
        }
        try {
          this.registry.delete(name);
        } catch {
          // ignore
        }
        return { name, forgotten: true, archived_thread: archived };
      });
    });

    this.handlers.set("send", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      const wait = Boolean(message.params.wait);
      const overrides = compactObject({
        cwd: message.params.cwd,
        model: message.params.model,
        effort: message.params.effort,
        personality: message.params.personality,
        serviceTier: message.params.serviceTier,
        summary: message.params.summary,
        outputSchema: message.params.outputSchema,
      });
      const result = await session.send(asString(message.params.text), { wait, overrides });
      if (typeof result === "string") {
        return { name, queued_or_turn_id: result };
      }
      return { name, summary: result };
    });

    this.handlers.set("interrupt", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      await session.interrupt();
      return { name, interrupted: true };
    });

    this.handlers.set("compact", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        const before = this.registry.get(name).tokenUsageInput;
        await session.compact();
        const after = this.registry.get(name).tokenUsageInput;
        this.eventBus.publish("events", {
          kind: "compact-done",
          session: name,
          before,
          after,
        });
        return { name, compacted: true };
      });
    });

    this.handlers.set("history.get", async (message) => {
      const name = asString(message.params.name);
      const format = message.params.format === "jsonl" ? "jsonl" : "md";
      const filePath = path.join(
        this.cfg.daemon.dataDir,
        "sessions",
        name,
        format === "md" ? "history.md" : "turns.jsonl",
      );
      if (!fs.existsSync(filePath)) {
        return { name, content: "" };
      }
      const sinceTurnId = message.params.sinceTurnId == null ? "" : asString(message.params.sinceTurnId);
      if (format === "md") {
        const filtered = filterHistoryMarkdown(fs.readFileSync(filePath, "utf8"), {
          lastN: Number(message.params.lastN || 0),
          sinceTurnId: sinceTurnId || undefined,
        });
        return {
          name,
          content: filtered.content,
          matched_since_turn_id: filtered.matchedSinceTurnId,
        };
      }
      const lastN = Number(message.params.lastN || 0);
      const since = message.params.since == null ? "" : asString(message.params.since);
      const source =
        lastN > 0 && !since && !sinceTurnId
          ? readJsonlTail(filePath, lastN).join("\n")
          : fs.readFileSync(filePath, "utf8");
      const filtered = filterTurnsJsonl(source, {
        lastN,
        since: since || undefined,
        sinceTurnId: sinceTurnId || undefined,
      });
      return {
        name,
        content: filtered.content,
        matched_since_turn_id: filtered.matchedSinceTurnId,
      };
    });

    this.handlers.set("history.tail_stderr", async (message) => {
      const name = asString(message.params.name);
      const lines = Number(message.params.lines || 200);
      const filePath = path.join(this.cfg.daemon.dataDir, "sessions", name, "app-server.stderr.log");
      if (!fs.existsSync(filePath)) {
        return { name, content: "" };
      }
      return {
        name,
        content: readLastLines(filePath, lines),
      };
    });

    this.handlers.set("queue.show", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      const items = session.snapshotQueueJson();
      return { name, length: items.length, items };
    });

    this.handlers.set("queue.clear", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        session.clearQueue();
        return { name, cleared: true };
      });
    });

    this.handlers.set("queue.drop_oldest", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        const dropped = session.dropOldest();
        return { name, dropped: dropped?.id ?? null };
      });
    });

    this.handlers.set("queue.retry_last", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      const entry = this.registry.get(name);
      if (!entry.lastPromptText) {
        throw new InvalidRequest(`session ${name} has no last prompt to retry`);
      }
      const result = await session.send(entry.lastPromptText, { wait: Boolean(message.params.wait) });
      return { name, retried: true, result };
    });

    this.handlers.set("health.check", async () => {
      await this.health.tickOnce();
      return { checked: true, sessions: this.registry.list().length };
    });

    this.handlers.set("health.issues", async () => ({
      issues: collectIssues(this.registry.list(), this.sessions),
    }));

    this.handlers.set("health.report", async () => ({
      summary: summarizeEntries(this.registry.list()),
      issues: collectIssues(this.registry.list(), this.sessions),
      sessions: this.registry.list().map((entry) => ({
        name: entry.name,
        status: entry.status,
        queue_length: entry.queueLength,
        app_server_pid: entry.appServerPid,
        last_turn_id: entry.lastTurnId,
        last_error: entry.errorMessage,
        transport_alive: this.sessions.get(entry.name)?.isTransportAlive() || false,
        ephemeral: Boolean(entry.ephemeral),
      })),
    }));

    this.handlers.set("health.repair", async () => {
      this.refreshConfigFromDisk();
      for (const entry of this.registry.list()) {
        await this.withSessionOperationLock(entry.name, async () => {
          const latest = this.registry.get(entry.name);
          if (latest.status !== "errored") {
            return;
          }
          if (latest.ephemeral) {
            this.registry.update(latest.name, {
              errorMessage: "ephemeral session cannot be repaired after its app-server exits",
            });
            return;
          }
          try {
            const session = await this.factory.resume(latest.name);
            this.sessions.set(latest.name, session);
          } catch (error) {
            this.registry.update(latest.name, { errorMessage: (error as Error).message });
          }
        });
      }
      return { repaired: true };
    });

    this.handlers.set("daemon.status", async () => ({
      sessions: this.registry.list().length,
      summary: summarizeEntries(this.registry.list()),
      pid: process.pid,
      socket_path: this.socketPath,
      data_dir: this.cfg.daemon.dataDir,
      events_last_seq: this.eventBus.lastSeq("events"),
      watchdog_last_seq: this.eventBus.lastSeq("watchdog"),
    }));

    this.handlers.set("daemon.doctor", async () => ({
      pid: process.pid,
      socket_path: this.socketPath,
      socket_exists: fs.existsSync(this.socketPath),
      data_dir: this.cfg.daemon.dataDir,
      registry_path: path.join(this.cfg.daemon.dataDir, "registry.json"),
      log_path: path.join(this.cfg.daemon.dataDir, "daemon.log"),
      uptime_seconds: Math.floor(process.uptime()),
      summary: summarizeEntries(this.registry.list()),
      sessions: this.registry.list().map((entry) => ({
        name: entry.name,
        status: entry.status,
        thread_id: entry.threadId,
        ephemeral: Boolean(entry.ephemeral),
        transport_alive: this.sessions.get(entry.name)?.isTransportAlive() || false,
      })),
    }));

    this.handlers.set("daemon.stop", async () => ({ stopping: true }));

    this.handlers.set("daemon.logs", async () => {
      const filePath = path.join(this.cfg.daemon.dataDir, "daemon.log");
      return { content: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "" };
    });

    this.handlers.set("daemon.reload_config", async () => {
      this.refreshConfigFromDisk();
      return { reloaded: true };
    });
  }

  private refreshConfigFromDisk(): void {
    const reloaded = loadConfig();
    reloaded.daemon.dataDir = this.cfg.daemon.dataDir;
    reloaded.daemon.socketPath = this.cfg.daemon.socketPath;
    this.replaceConfig(reloaded);
  }

  private async withSessionOperationLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(name) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.sessionLocks.set(name, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionLocks.get(name) === chained) {
        this.sessionLocks.delete(name);
      }
    }
  }

  async handleMonitorSubscribe(
    stream: "events" | "watchdog",
    sinceSeq: number,
    socket: net.Socket,
  ): Promise<void> {
    const queue = await this.eventBus.subscribe(stream, sinceSeq);
    const onClosed = () => {
      queue.close(new Error("monitor socket closed"));
    };
    socket.once("close", onClosed);
    socket.once("error", onClosed);
    try {
      while (!socket.destroyed) {
        const event = await queue.shift();
        const writable = socket.write(
          encodeMessage({
            kind: "event",
            stream,
            seq: event.seq,
            payload: event.payload,
          }),
        );
        if (!writable && !socket.destroyed) {
          await Promise.race([
            once(socket, "drain"),
            once(socket, "close"),
            once(socket, "error"),
          ]).catch(() => undefined);
        }
      }
    } catch {
      // connection closed
    } finally {
      socket.off("close", onClosed);
      socket.off("error", onClosed);
      await this.eventBus.unsubscribe(stream, queue);
    }
  }

  async handleHistorySubscribe(
    params: Record<string, unknown>,
    socket: net.Socket,
  ): Promise<void> {
    const name = asString(params.name);
    const format = params.format === "jsonl" ? "jsonl" : "md";
    const filePath = path.join(
      this.cfg.daemon.dataDir,
      "sessions",
      name,
      format === "md" ? "history.md" : "turns.jsonl",
    );
    const queue = await this.eventBus.subscribe("events", this.eventBus.lastSeq("events"));
    const snapshot = this.readHistorySnapshot(name, filePath, format, params);
    let seq = 0;
    socket.write(
      JSON.stringify({
        kind: "event",
        stream: "history",
        seq,
        payload: {
          kind: "history-snapshot",
          session: name,
          format,
          ...snapshot.payload,
        },
      }) + "\n",
    );
    let cursor = snapshot.cursor;
    const onClosed = () => {
      queue.close(new Error("history socket closed"));
    };
    socket.once("close", onClosed);
    socket.once("error", onClosed);
    try {
      while (!socket.destroyed) {
        const event = await queue.shift();
        if (event.payload.session !== name) {
          continue;
        }
        if (!["turn-done", "turn-attn"].includes(String(event.payload.kind))) {
          continue;
        }
        let content = "";
        if (fs.existsSync(filePath)) {
          const size = fs.statSync(filePath).size;
          if (size < cursor) {
            cursor = 0;
          }
          if (size > cursor) {
            const fd = fs.openSync(filePath, "r");
            try {
              const buffer = Buffer.alloc(size - cursor);
              fs.readSync(fd, buffer, 0, buffer.length, cursor);
              content = buffer.toString("utf8");
            } finally {
              fs.closeSync(fd);
            }
            cursor = size;
          }
        }
        seq += 1;
        const writable = socket.write(
          JSON.stringify({
            kind: "event",
            stream: "history",
            seq,
            payload: {
              kind: "history-append",
              session: name,
              format,
              content,
              event: event.payload,
            },
          }) + "\n",
        );
        if (!writable && !socket.destroyed) {
          await Promise.race([
            once(socket, "drain"),
            once(socket, "close"),
            once(socket, "error"),
          ]).catch(() => undefined);
        }
      }
    } catch {
      // connection closed
    } finally {
      socket.off("close", onClosed);
      socket.off("error", onClosed);
      await this.eventBus.unsubscribe("events", queue);
    }
  }

  private readHistorySnapshot(
    name: string,
    filePath: string,
    format: "md" | "jsonl",
    params: Record<string, unknown>,
  ): { cursor: number; payload: Record<string, unknown> } {
    if (!fs.existsSync(filePath)) {
      return { cursor: 0, payload: { name, content: "", matched_since_turn_id: true } };
    }
    const cursor = fs.statSync(filePath).size;
    const lastN = Number(params.lastN || 0);
    const sinceTurnId = params.sinceTurnId == null ? "" : asString(params.sinceTurnId);
    if (format === "md") {
      const filtered = filterHistoryMarkdown(fs.readFileSync(filePath, "utf8"), {
        lastN,
        sinceTurnId: sinceTurnId || undefined,
      });
      return {
        cursor,
        payload: {
          name,
          content: filtered.content,
          matched_since_turn_id: filtered.matchedSinceTurnId,
        },
      };
    }
    const since = params.since == null ? "" : asString(params.since);
    const source =
      lastN > 0 && !since && !sinceTurnId
        ? readJsonlTail(filePath, lastN).join("\n")
        : fs.readFileSync(filePath, "utf8");
    const filtered = filterTurnsJsonl(source, {
      lastN,
      since: since || undefined,
      sinceTurnId: sinceTurnId || undefined,
    });
    return {
      cursor,
      payload: {
        name,
        content: filtered.content,
        matched_since_turn_id: filtered.matchedSinceTurnId,
      },
    };
  }

  private async handleSocket(socket: net.Socket): Promise<void> {
    socket.setEncoding("utf8");
    const rl = readline.createInterface({
      input: socket,
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (!line) {
          continue;
        }
        let request;
        try {
          request = decodeRequest(line);
        } catch (error) {
          socket.write(
            encodeMessage({
              id: "?",
              ok: false,
              error: errorToWire(asCodexTeamError(error)),
            }),
          );
          continue;
        }
        if (request.cmd === "monitor.events.subscribe") {
          await this.handleMonitorSubscribe("events", Number(request.params.sinceSeq || 0), socket);
          return;
        }
        if (request.cmd === "monitor.watchdog.subscribe") {
          await this.handleMonitorSubscribe("watchdog", Number(request.params.sinceSeq || 0), socket);
          return;
        }
        if (request.cmd === "history.subscribe") {
          await this.handleHistorySubscribe(request.params, socket);
          return;
        }
        const handler = this.handlers.get(request.cmd);
        if (!handler) {
          socket.write(
            encodeMessage({
              id: request.id,
              ok: false,
              error: errorToWire(new InvalidRequest(`unknown cmd: ${request.cmd}`)),
            }),
          );
          continue;
        }
        try {
          const data = await handler(request);
          socket.write(encodeMessage({ id: request.id, ok: true, data }));
          if (request.cmd === "daemon.stop") {
            setImmediate(() => {
              this.shutdownCallback?.();
            });
          }
        } catch (error) {
          socket.write(
            encodeMessage({
              id: request.id,
              ok: false,
              error: errorToWire(asCodexTeamError(error)),
            }),
          );
        }
      }
    } finally {
      rl.close();
      socket.end();
    }
  }
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function summarizeEntries(entries: Array<{ status: string; queueLength: number }>): Record<string, unknown> {
  const summary = {
    total: entries.length,
    idle: 0,
    running: 0,
    errored: 0,
    closed: 0,
    compacting: 0,
    queued_items: 0,
  };
  for (const entry of entries) {
    summary.queued_items += Number(entry.queueLength || 0);
    if (entry.status in summary) {
      (summary as Record<string, number>)[entry.status] += 1;
    }
  }
  return summary;
}

function collectIssues(
  entries: Array<{ name: string; status: string; queueLength: number; errorMessage: string | null; lastTurnId: string | null }>,
  sessions: Map<string, Session>,
): Array<Record<string, unknown>> {
  const issues: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const live = sessions.get(entry.name);
    if (entry.status === "errored") {
      issues.push({
        session: entry.name,
        kind: "errored",
        last_error: entry.errorMessage,
      });
      continue;
    }
    if (entry.queueLength > 0) {
      issues.push({
        session: entry.name,
        kind: "queue-backlog",
        queue_length: entry.queueLength,
      });
    }
    if (live && live.isRunning()) {
      const ageMs = live.currentTurnAgeMs();
      if (ageMs != null) {
        issues.push({
          session: entry.name,
          kind: "running",
          turn_id: live.currentTurnId(),
          age_ms: ageMs,
          last_turn_id: entry.lastTurnId,
        });
      }
    } else if (live && !live.isTransportAlive()) {
      issues.push({
        session: entry.name,
        kind: "transport-down",
      });
    }
  }
  return issues;
}

declare module "./session" {
  interface Session {
    replaceConfig(cfg: Config): void;
  }
}

declare module "./asyncQueue" {
  interface AsyncQueue<T> {
    shift(): Promise<T>;
  }
}
