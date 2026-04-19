import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import os from "node:os";

import { Config, loadConfig } from "./config";
import { ClientRecord, ClientStore } from "./clients";
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
import {
  clientsDir,
  ipcAddressFromPath,
  ipcArtifactExists,
  ipcListen,
  ipcReady,
  removeStaleIpcArtifact,
  sessionDir,
} from "./platform";
import { RuntimeAlarmStore, runtimeAlarmToWire } from "./runtimeAlarms";
import { DEFAULT_WORKSPACE, makeClientId, validateSessionName, validateWorkspace, workspaceSessionKey } from "./workspace";

type RequestContext = {
  id: string;
  cmd: string;
  workspace: string;
  clientId: string | null;
  allWorkspaces: boolean;
  params: Record<string, unknown>;
};

type RequestHandler = (message: RequestContext) => Promise<Record<string, unknown>>;

function asString(value: unknown): string {
  return String(value ?? "");
}

function optionalString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function threadIdFromParams(params: Record<string, unknown>): string {
  return asString(params.threadId ?? params.thread_id).trim();
}

function sessionOptionsFromParams(params: Record<string, unknown>): {
  cwd: string | null;
  model: string | null;
  modelProvider: string | null;
  sandbox: string | null;
  approvalPolicy: string | null;
  serviceTier: string | null;
  reasoningEffort: string | null;
  personality: string | null;
  baseInstructions: string | null;
  developerInstructions: string | null;
  profile: string | null;
  ephemeral: boolean;
} {
  return {
    cwd: optionalString(params.cwd),
    model: optionalString(params.model),
    modelProvider: optionalString(params.modelProvider),
    sandbox: optionalString(params.sandbox),
    approvalPolicy: optionalString(params.approvalPolicy),
    serviceTier: optionalString(params.serviceTier),
    reasoningEffort: optionalString(params.reasoningEffort),
    personality: optionalString(params.personality),
    baseInstructions: optionalString(params.baseInstructions),
    developerInstructions: optionalString(params.developerInstructions),
    profile: optionalString(params.profile),
    ephemeral: Boolean(params.ephemeral),
  };
}

function sessionKey(workspace: string, name: string): string {
  return workspaceSessionKey(workspace, name);
}

function targetEntries(registry: RegistryStore, workspace: string, allWorkspaces: boolean) {
  return registry.list(workspace, allWorkspaces);
}

export class DaemonServer {
  readonly eventBus: EventBus;
  readonly registry: RegistryStore;
  readonly clients: ClientStore;
  readonly runtimeAlarms: RuntimeAlarmStore;
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
  private clientSweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: Config,
    private readonly socketPath: string,
    private readonly shutdownCallback?: () => void,
    private readonly clientFactory: (cfg: Config) => AppServerClientLike = (cfg) => new AppServerClient(cfg),
  ) {
    this.eventBus = new EventBus(cfg.monitor.eventsMaxBuffer, cfg.monitor.subscriberQueueMax);
    this.registry = new RegistryStore(path.join(cfg.daemon.dataDir, "registry.json"));
    this.clients = new ClientStore(cfg.daemon.dataDir);
    this.runtimeAlarms = new RuntimeAlarmStore(cfg.daemon.dataDir);
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
    const address = ipcAddressFromPath(this.socketPath);
    await removeStaleIpcArtifact(address);
    this.server = await ipcListen(address, (socket) => {
      void this.handleSocket(socket);
    });
    this.restartBackgroundLoops();
    for (const workspace of this.activeWorkspaces()) {
      await this.watchdog.tickOnce({ force: true, alarmName: "default", workspace });
    }
    for (const item of this.scheduledAlarms()) {
      await this.watchdog.tickOnce({
        force: true,
        alarmName: item.name,
        alarm: item.alarm,
        workspace: item.workspace,
      });
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
    await removeStaleIpcArtifact(ipcAddressFromPath(this.socketPath));
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
    if (this.clientSweepTimer) {
      clearInterval(this.clientSweepTimer);
      this.clientSweepTimer = null;
    }
  }

  private restartBackgroundLoops(): void {
    this.stopBackgroundLoops();
    this.watchdogTimers.push(
      setInterval(() => {
        for (const workspace of this.activeWorkspaces()) {
          void this.watchdog.tickOnce({ alarmName: "default", workspace });
        }
      }, this.cfg.monitor.watchdogIntervalSeconds * 1000),
    );
    for (const item of this.scheduledAlarms()) {
      this.watchdogTimers.push(
        setInterval(() => {
          void this.watchdog.tickOnce({
            alarmName: item.name,
            alarm: item.alarm,
            workspace: item.workspace,
          });
        }, item.alarm.intervalSeconds * 1000),
      );
    }
    this.heartbeatTimer = setInterval(() => {
      void this.health.tickOnce();
    }, this.cfg.heartbeat.intervalSeconds * 1000);
    this.clientSweepTimer = setInterval(() => {
      void this.sweepStaleClients();
    }, 60_000);
  }

  private installHandlers(): void {
    this.handlers.set("session.create", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      if (!name) {
        throw new InvalidRequest("name required");
      }
      const options = sessionOptionsFromParams(message.params);
      const threadId = threadIdFromParams(message.params);
      return await this.withSessionAttachLock(name, threadId, async () => {
        const session = threadId
          ? await this.factory.attach(name, threadId, options, {
              workspace: message.workspace,
              clientId: message.clientId,
            })
          : await this.factory.create(name, options, {
              workspace: message.workspace,
              clientId: message.clientId,
            });
        this.setLiveSession(session);
        const entry = this.registry.get(session.name, session.workspace);
        return { workspace: session.workspace, name: session.name, thread_id: entry.threadId, attached: Boolean(threadId) };
      });
    });

    this.handlers.set("session.attach", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      if (!name) {
        throw new InvalidRequest("name required");
      }
      const threadId = threadIdFromParams(message.params);
      if (!threadId) {
        throw new InvalidRequest("thread_id required");
      }
      return await this.withSessionAttachLock(name, threadId, async () => {
        const session = await this.factory.attach(name, threadId, sessionOptionsFromParams(message.params), {
          workspace: message.workspace,
          clientId: message.clientId,
        });
        this.setLiveSession(session);
        const entry = this.registry.get(session.name, session.workspace);
        return { workspace: session.workspace, name: session.name, thread_id: entry.threadId, attached: true };
      });
    });

    this.handlers.set("session.list", async (message) => ({
      workspace: message.allWorkspaces ? "*" : message.workspace,
      sessions: targetEntries(this.registry, message.workspace, message.allWorkspaces),
    }));

    this.handlers.set("session.status", async (message) => {
      const entry = this.registry.find(asString(message.params.name), message.workspace, message.allWorkspaces);
      return { ...entry };
    });

    this.handlers.set("session.read", async (message) => {
      const name = asString(message.params.name);
      const includeTurns = Boolean(message.params.includeTurns);
      const entry = this.registry.find(name, message.workspace, message.allWorkspaces);
      const live = this.getLiveSession(entry.workspace, name);
      if (live) {
        return await live.read(includeTurns);
      }
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
        const entry = this.registry.find(name, message.workspace, message.allWorkspaces);
        const session = this.getLiveSession(entry.workspace, name);
        if (session) {
          await session.close();
          this.deleteLiveSession(entry.workspace, name);
        } else {
          this.registry.update(name, { status: "closed", appServerPid: null, queueLength: 0 }, entry.workspace);
        }
        return { workspace: entry.workspace, name, closed: true };
      });
    });

    this.handlers.set("session.ack_error", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const entry = this.registry.find(name, message.workspace, message.allWorkspaces);
        const session = this.getLiveSession(entry.workspace, name);
        if (session) {
          await session.ackError();
        } else {
          this.registry.update(name, { status: "idle", errorMessage: null }, entry.workspace);
        }
        return { workspace: entry.workspace, name, acked: true };
      });
    });

    this.handlers.set("session.dump", async (message) => {
      const name = asString(message.params.name);
      const entry = this.registry.find(name, message.workspace, message.allWorkspaces);
      const session = this.getLiveSession(entry.workspace, name);
      if (session) {
        return session.dumpState();
      }
      const stderrPath = sessionFilePath(this.cfg.daemon.dataDir, entry.workspace, name, "app-server.stderr.log");
      const stderrTail = readLastLines(stderrPath, 20);
      return {
        session: entry,
        queue: [],
        transport_alive: false,
        stderr_tail: stderrTail,
        history_path: historyFilePath(this.cfg.daemon.dataDir, entry.workspace, name, "md"),
        turns_path: historyFilePath(this.cfg.daemon.dataDir, entry.workspace, name, "jsonl"),
      };
    });

    this.handlers.set("session.resume", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const entry = this.registry.find(name, message.workspace, message.allWorkspaces);
        const session = await this.factory.resume(name, entry.workspace);
        this.setLiveSession(session);
        return { workspace: session.workspace, name, resumed: true };
      });
    });

    this.handlers.set("session.restart", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const entry = this.registry.find(name, message.workspace, message.allWorkspaces);
        const existing = this.getLiveSession(entry.workspace, name);
        if (entry.ephemeral) {
          if (!existing) {
            throw new InvalidRequest(
              `session ${name} is ephemeral and cannot be restarted after its app-server exits`,
            );
          }
          await existing.kill("restarting ephemeral session");
          this.deleteLiveSession(entry.workspace, name);
          this.registry.delete(name, entry.workspace);
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
          }, { workspace: entry.workspace, clientId: message.clientId });
          this.setLiveSession(recreated);
          return { workspace: entry.workspace, name, restarted: true, recreated: true, ephemeral: true };
        }
        if (existing) {
          await existing.close();
          this.deleteLiveSession(entry.workspace, name);
        }
        const session = await this.factory.resume(name, entry.workspace);
        this.setLiveSession(session);
        return { workspace: entry.workspace, name, restarted: true };
      });
    });

    this.handlers.set("session.kill", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const entry = this.registry.find(name, message.workspace, message.allWorkspaces);
        const session = this.getLiveSession(entry.workspace, name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        await session.kill("killed by operator");
        this.deleteLiveSession(entry.workspace, name);
        return { workspace: entry.workspace, name, killed: true };
      });
    });

    this.handlers.set("session.forget", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const entry = this.registry.find(name, message.workspace, message.allWorkspaces);
        const session = this.getLiveSession(entry.workspace, name);
        let archived = false;
        if (session) {
          if (!entry.ephemeral) {
            try {
              await session.archiveThread();
              archived = true;
            } catch {
              // best effort; forgetting local ownership still matters
            }
          }
          await session.close();
          this.deleteLiveSession(entry.workspace, name);
        } else {
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
          this.registry.delete(name, entry.workspace);
        } catch {
          // ignore
        }
        return { workspace: entry.workspace, name, forgotten: true, archived_thread: archived };
      });
    });

    this.handlers.set("send", async (message) => {
      const name = asString(message.params.name);
      const session = this.getLiveSession(message.workspace, name);
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
        return { workspace: message.workspace, name, queued_or_turn_id: result };
      }
      return { workspace: message.workspace, name, summary: result };
    });

    this.handlers.set("interrupt", async (message) => {
      const name = asString(message.params.name);
      const session = this.getLiveSession(message.workspace, name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      await session.interrupt();
      return { workspace: message.workspace, name, interrupted: true };
    });

    this.handlers.set("compact", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.getLiveSession(message.workspace, name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        const before = this.registry.get(name, message.workspace).tokenUsageInput;
        await session.compact();
        const after = this.registry.get(name, message.workspace).tokenUsageInput;
        this.eventBus.publish("events", {
          workspace: message.workspace,
          kind: "compact-done",
          session: name,
          before,
          after,
        });
        return { workspace: message.workspace, name, compacted: true };
      });
    });

    this.handlers.set("history.get", async (message) => {
      const name = asString(message.params.name);
      let workspace = message.workspace;
      try {
        workspace = this.registry.find(name, message.workspace, message.allWorkspaces).workspace;
      } catch {
        // History files may exist before a session is registered in focused tests or manual recovery.
      }
      const format = message.params.format === "jsonl" ? "jsonl" : "md";
      const filePath = historyFilePath(this.cfg.daemon.dataDir, workspace, name, format);
      if (!fs.existsSync(filePath)) {
        return { workspace, name, content: "" };
      }
      const sinceTurnId = message.params.sinceTurnId == null ? "" : asString(message.params.sinceTurnId);
      if (format === "md") {
        const filtered = filterHistoryMarkdown(fs.readFileSync(filePath, "utf8"), {
          lastN: Number(message.params.lastN || 0),
          sinceTurnId: sinceTurnId || undefined,
        });
        return {
          name,
          workspace,
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
        workspace,
        content: filtered.content,
        matched_since_turn_id: filtered.matchedSinceTurnId,
      };
    });

    this.handlers.set("history.tail_stderr", async (message) => {
      const name = asString(message.params.name);
      const lines = Number(message.params.lines || 200);
      let workspace = message.workspace;
      try {
        workspace = this.registry.find(name, message.workspace, message.allWorkspaces).workspace;
      } catch {
        // Allow stderr history inspection of orphaned session dirs.
      }
      const filePath = sessionFilePath(this.cfg.daemon.dataDir, workspace, name, "app-server.stderr.log");
      if (!fs.existsSync(filePath)) {
        return { workspace, name, content: "" };
      }
      return {
        workspace,
        name,
        content: readLastLines(filePath, lines),
      };
    });

    this.handlers.set("queue.show", async (message) => {
      const name = asString(message.params.name);
      const session = this.getLiveSession(message.workspace, name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      const items = session.snapshotQueueJson();
      return { workspace: message.workspace, name, length: items.length, items };
    });

    this.handlers.set("queue.clear", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.getLiveSession(message.workspace, name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        session.clearQueue();
        return { workspace: message.workspace, name, cleared: true };
      });
    });

    this.handlers.set("queue.drop_oldest", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.getLiveSession(message.workspace, name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        const dropped = session.dropOldest();
        return { workspace: message.workspace, name, dropped: dropped?.id ?? null };
      });
    });

    this.handlers.set("queue.retry_last", async (message) => {
      const name = asString(message.params.name);
      const session = this.getLiveSession(message.workspace, name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      const entry = this.registry.get(name, message.workspace);
      if (!entry.lastPromptText) {
        throw new InvalidRequest(`session ${name} has no last prompt to retry`);
      }
      const result = await session.send(entry.lastPromptText, { wait: Boolean(message.params.wait) });
      return { workspace: message.workspace, name, retried: true, result };
    });

    this.handlers.set("health.check", async (message) => {
      await this.health.tickOnce();
      return {
        workspace: message.allWorkspaces ? "*" : message.workspace,
        checked: true,
        sessions: targetEntries(this.registry, message.workspace, message.allWorkspaces).length,
      };
    });

    this.handlers.set("health.issues", async (message) => ({
      workspace: message.allWorkspaces ? "*" : message.workspace,
      issues: collectIssues(targetEntries(this.registry, message.workspace, message.allWorkspaces), this.sessions),
    }));

    this.handlers.set("health.report", async (message) => ({
      workspace: message.allWorkspaces ? "*" : message.workspace,
      summary: summarizeEntries(targetEntries(this.registry, message.workspace, message.allWorkspaces)),
      issues: collectIssues(targetEntries(this.registry, message.workspace, message.allWorkspaces), this.sessions),
      sessions: targetEntries(this.registry, message.workspace, message.allWorkspaces).map((entry) => ({
        workspace: entry.workspace,
        name: entry.name,
        status: entry.status,
        queue_length: entry.queueLength,
        app_server_pid: entry.appServerPid,
        last_turn_id: entry.lastTurnId,
        last_error: entry.errorMessage,
        transport_alive: this.getLiveSession(entry.workspace, entry.name)?.isTransportAlive() || false,
        ephemeral: Boolean(entry.ephemeral),
      })),
    }));

    this.handlers.set("health.repair", async (message) => {
      this.refreshConfigFromDisk();
      for (const entry of targetEntries(this.registry, message.workspace, message.allWorkspaces)) {
        await this.withSessionOperationLock(entry.name, async () => {
          const latest = this.registry.get(entry.name, entry.workspace);
          if (latest.status !== "errored") {
            return;
          }
          if (latest.ephemeral) {
            this.registry.update(latest.name, {
              errorMessage: "ephemeral session cannot be repaired after its app-server exits",
            }, latest.workspace);
            return;
          }
          try {
            const session = await this.factory.resume(latest.name, latest.workspace);
            this.setLiveSession(session);
          } catch (error) {
            this.registry.update(latest.name, { errorMessage: (error as Error).message }, latest.workspace);
          }
        });
      }
      return { workspace: message.allWorkspaces ? "*" : message.workspace, repaired: true };
    });

    this.handlers.set("daemon.status", async () => ({
      sessions: this.registry.list(null, true).length,
      summary: summarizeEntries(this.registry.list(null, true)),
      workspaces: summarizeWorkspaces(this.registry, this.clients.list(), this.runtimeAlarms, this.cfg),
      clients: this.clients.list().length,
      pid: process.pid,
      socket_path: this.socketPath,
      data_dir: this.cfg.daemon.dataDir,
      events_last_seq: this.eventBus.lastSeq("events"),
      watchdog_last_seq: this.eventBus.lastSeq("watchdog"),
    }));

    this.handlers.set("daemon.doctor", async () => {
      const ipc = ipcAddressFromPath(this.socketPath);
      return {
        pid: process.pid,
        socket_path: this.socketPath,
        socket_exists: ipcArtifactExists(ipc),
        ipc_kind: ipc.kind,
        ipc_endpoint: ipc.display,
        ipc_ready: await ipcReady(ipc),
        data_dir: this.cfg.daemon.dataDir,
        registry_path: path.join(this.cfg.daemon.dataDir, "registry.json"),
        log_path: path.join(this.cfg.daemon.dataDir, "daemon.log"),
        uptime_seconds: Math.floor(process.uptime()),
        summary: summarizeEntries(this.registry.list(null, true)),
        workspaces: summarizeWorkspaces(this.registry, this.clients.list(), this.runtimeAlarms, this.cfg),
        clients_path: clientsDir(this.cfg.daemon.dataDir),
        clients: this.clients.list(),
        sessions: this.registry.list(null, true).map((entry) => ({
          workspace: entry.workspace,
          name: entry.name,
          status: entry.status,
          thread_id: entry.threadId,
          ephemeral: Boolean(entry.ephemeral),
          transport_alive: this.getLiveSession(entry.workspace, entry.name)?.isTransportAlive() || false,
        })),
      };
    });

    this.handlers.set("daemon.stop", async (message) => {
      const active = this.registry
        .list(null, true)
        .filter((entry) => entry.status !== "closed");
      if (active.length > 0 && !message.params.force) {
        throw new InvalidRequest(
          `daemon stop would affect ${active.length} non-closed session(s) across workspaces; rerun with --force after confirming`,
          {
            active_sessions: active.map((entry) => ({
              workspace: entry.workspace,
              name: entry.name,
              status: entry.status,
              queue_length: entry.queueLength,
            })),
          },
        );
      }
      return { stopping: true, active_sessions: active.length, forced: Boolean(message.params.force) };
    });

    this.handlers.set("daemon.logs", async () => {
      const filePath = path.join(this.cfg.daemon.dataDir, "daemon.log");
      return { content: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "" };
    });

    this.handlers.set("daemon.reload_config", async () => {
      this.refreshConfigFromDisk();
      return { reloaded: true };
    });

    this.handlers.set("workspace.list", async () => ({
      workspaces: summarizeWorkspaces(this.registry, this.clients.list(), this.runtimeAlarms, this.cfg),
    }));

    this.handlers.set("workspace.show", async (message) => {
      const workspace = asString(message.params.name || message.workspace) || message.workspace;
      const sessions = this.registry.list(workspace);
      const clients = this.clients.list().filter((client) => client.workspace === workspace);
      return {
        workspace,
        sessions,
        clients,
        alarms: alarmsForWorkspace(workspace, this.runtimeAlarms, this.cfg),
      };
    });

    this.handlers.set("client.register", async (message) => {
      const now = new Date().toISOString();
      const requestedId = asString(message.params.clientId || message.clientId);
      const record: ClientRecord = {
        clientId:
          requestedId ||
          makeClientId({
            workspace: message.workspace,
            sessionId: optionalString(message.params.sessionId),
            hostname: optionalString(message.params.hostname),
            pid: message.params.pid == null ? null : Number(message.params.pid),
            startedAtMs: Date.now(),
          }),
        workspace: message.workspace,
        hostname: optionalString(message.params.hostname) || os.hostname(),
        pid: message.params.pid == null ? null : Number(message.params.pid),
        startedAt: optionalString(message.params.startedAt) || now,
        claudeProjectDir: optionalString(message.params.claudeProjectDir),
        sessionId: optionalString(message.params.sessionId),
      };
      this.clients.register(record);
      return recordToWire(record);
    });

    this.handlers.set("client.list", async () => ({ clients: this.clients.list().map(recordToWire) }));

    this.handlers.set("client.detach", async (message) => {
      const clientId = asString(message.params.clientId || message.clientId);
      const sessionId = asString(message.params.sessionId || message.params.session_id);
      if (!clientId && sessionId) {
        const result = await this.detachClientBySession(message.workspace, sessionId);
        return {
          session_id: sessionId,
          workspace: message.workspace,
          detached: true,
          detached_clients: result.clients,
          detached_subscribers: result.subscribers,
        };
      }
      if (!clientId) {
        throw new InvalidRequest("client_id or session_id required");
      }
      const detached_subscribers = await this.detachClient(clientId);
      return { client_id: clientId, detached: true, detached_subscribers };
    });

    this.handlers.set("watch.alarm.create", async (message) => {
      const name = asString(message.params.name).trim();
      if (!name) {
        throw new InvalidRequest("alarm name required");
      }
      const now = new Date().toISOString();
      const record = this.runtimeAlarms.upsert({
        workspace: message.workspace,
        name,
        clientId: message.clientId,
        createdAt: now,
        updatedAt: now,
        alarm: {
          enabled: message.params.enabled == null ? true : Boolean(message.params.enabled),
          intervalSeconds: positiveNumber(message.params.intervalSeconds ?? message.params.interval_seconds, 1200),
          taskBriefFile: asString(message.params.taskBriefFile ?? message.params.task_brief_file),
          taskBriefHeadLines: positiveNumber(message.params.taskBriefHeadLines ?? message.params.task_brief_head_lines, 30),
          emitIdle: Boolean(message.params.emitIdle ?? message.params.emit_idle),
          template: asString(message.params.template),
          templateFile: asString(message.params.templateFile ?? message.params.template_file),
        },
      });
      if (this.server) {
        this.restartBackgroundLoops();
      }
      return { alarm: runtimeAlarmToWire(record) };
    });

    this.handlers.set("watch.alarm.list", async (message) => ({
      workspace: message.allWorkspaces ? "*" : message.workspace,
      alarms: this.runtimeAlarms
        .list(message.workspace, message.allWorkspaces)
        .map(runtimeAlarmToWire),
    }));

    this.handlers.set("watch.alarm.delete", async (message) => {
      const name = asString(message.params.name).trim();
      if (!name) {
        throw new InvalidRequest("alarm name required");
      }
      const deleted = this.runtimeAlarms.delete(message.workspace, name);
      if (deleted && this.server) {
        this.restartBackgroundLoops();
      }
      return { workspace: message.workspace, name, deleted };
    });
  }

  private refreshConfigFromDisk(): void {
    const reloaded = loadConfig();
    reloaded.daemon.dataDir = this.cfg.daemon.dataDir;
    reloaded.daemon.socketPath = this.cfg.daemon.socketPath;
    this.replaceConfig(reloaded);
  }

  private getLiveSession(workspace: string, name: string): Session | undefined {
    return this.sessions.get(sessionKey(workspace, name));
  }

  private setLiveSession(session: Session): void {
    this.sessions.set(sessionKey(session.workspace, session.name), session);
  }

  private deleteLiveSession(workspace: string, name: string): void {
    this.sessions.delete(sessionKey(workspace, name));
  }

  private activeWorkspaces(): string[] {
    const names = new Set<string>(this.registry.workspaces());
    for (const client of this.clients.list()) {
      names.add(client.workspace);
    }
    if (names.size === 0) {
      names.add(DEFAULT_WORKSPACE);
    }
    return [...names].sort();
  }

  private scheduledAlarms(): Array<{ workspace: string; name: string; alarm: ReturnType<RuntimeAlarmStore["list"]>[number]["alarm"] }> {
    const items: Array<{ workspace: string; name: string; alarm: ReturnType<RuntimeAlarmStore["list"]>[number]["alarm"] }> = [];
    for (const [workspace, alarms] of Object.entries(this.cfg.monitor.watchdogWorkspaceAlarms)) {
      for (const [name, alarm] of Object.entries(alarms)) {
        if (alarm.enabled) {
          items.push({ workspace, name, alarm });
        }
      }
    }
    for (const record of this.runtimeAlarms.list(null, true)) {
      if (record.alarm.enabled) {
        items.push({ workspace: record.workspace, name: record.name, alarm: record.alarm });
      }
    }
    return items;
  }

  private async sweepStaleClients(): Promise<void> {
    for (const record of this.clients.sweepStale()) {
      await this.detachClient(record.clientId);
    }
  }

  private async detachClient(clientId: string): Promise<number> {
    this.clients.detach(clientId);
    const detached = await this.eventBus.detachClient(clientId);
    const deletedAlarms = this.runtimeAlarms.deleteByClient(clientId);
    if (deletedAlarms > 0 && this.server) {
      this.restartBackgroundLoops();
    }
    if (!hasNonClosedSessions(this.registry)) {
      setImmediate(() => this.shutdownCallback?.());
    }
    return detached;
  }

  private async detachClientBySession(workspace: string, sessionId: string): Promise<{ clients: string[]; subscribers: number }> {
    const records = this.clients.detachBySession(workspace, sessionId);
    let subscribers = 0;
    for (const record of records) {
      subscribers += await this.eventBus.detachClient(record.clientId);
      const deletedAlarms = this.runtimeAlarms.deleteByClient(record.clientId);
      if (deletedAlarms > 0 && this.server) {
        this.restartBackgroundLoops();
      }
    }
    if (!hasNonClosedSessions(this.registry)) {
      setImmediate(() => this.shutdownCallback?.());
    }
    return { clients: records.map((record) => record.clientId), subscribers };
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

  private async withSessionAttachLock<T>(
    name: string,
    threadId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!threadId) {
      return await this.withSessionOperationLock(name, fn);
    }
    return await this.withSessionOperationLock(`thread:${threadId}`, async () => {
      return await this.withSessionOperationLock(name, fn);
    });
  }

  async handleMonitorSubscribe(
    stream: "events" | "watchdog",
    sinceSeq: number,
    options: { workspace: string; clientId: string | null; allWorkspaces: boolean },
    socket: net.Socket,
  ): Promise<void> {
    const queue = await this.eventBus.subscribe(stream, sinceSeq, options);
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
    options: { workspace: string; clientId: string | null; allWorkspaces: boolean },
    socket: net.Socket,
  ): Promise<void> {
    const name = asString(params.name);
    let workspace = options.workspace;
    try {
      workspace = this.registry.find(name, options.workspace, options.allWorkspaces).workspace;
    } catch {
      // Allow following orphaned history dirs.
    }
    const format = params.format === "jsonl" ? "jsonl" : "md";
    const filePath = historyFilePath(this.cfg.daemon.dataDir, workspace, name, format);
    const queue = await this.eventBus.subscribe("events", this.eventBus.lastSeq("events"), {
      ...options,
      workspace,
    });
    const snapshot = this.readHistorySnapshot(workspace, name, filePath, format, params);
    let seq = 0;
    socket.write(
      JSON.stringify({
        kind: "event",
        stream: "history",
        seq,
        payload: {
          kind: "history-snapshot",
          workspace,
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
        if (event.payload.session !== name || String(event.payload.workspace ?? DEFAULT_WORKSPACE) !== workspace) {
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
              workspace,
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
    workspace: string,
    name: string,
    filePath: string,
    format: "md" | "jsonl",
    params: Record<string, unknown>,
  ): { cursor: number; payload: Record<string, unknown> } {
    if (!fs.existsSync(filePath)) {
      return { cursor: 0, payload: { workspace, name, content: "", matched_since_turn_id: true } };
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
          workspace,
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
        workspace,
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
          await this.handleMonitorSubscribe("events", Number(request.params.sinceSeq || 0), {
            workspace: request.workspace,
            clientId: request.clientId,
            allWorkspaces: request.allWorkspaces,
          }, socket);
          return;
        }
        if (request.cmd === "monitor.watchdog.subscribe") {
          await this.handleMonitorSubscribe("watchdog", Number(request.params.sinceSeq || 0), {
            workspace: request.workspace,
            clientId: request.clientId,
            allWorkspaces: request.allWorkspaces,
          }, socket);
          return;
        }
        if (request.cmd === "history.subscribe") {
          await this.handleHistorySubscribe(request.params, {
            workspace: request.workspace,
            clientId: request.clientId,
            allWorkspaces: request.allWorkspaces,
          }, socket);
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
          socket.write(encodeMessage({ v: 2, id: request.id, ok: true, workspace: request.workspace, data }));
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
              workspace: request.workspace,
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

function historyFilePath(dataDir: string, workspace: string, name: string, format: "md" | "jsonl"): string {
  return sessionFilePath(dataDir, workspace, name, format === "md" ? "history.md" : "turns.jsonl");
}

function sessionFilePath(dataDir: string, workspace: string, name: string, file: string): string {
  return path.join(sessionDir(dataDir, validateWorkspace(workspace), validateSessionName(name)), file);
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasNonClosedSessions(registry: RegistryStore): boolean {
  return registry.list(null, true).some((entry) => entry.status !== "closed");
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

function summarizeWorkspaces(
  registry: RegistryStore,
  clients: ClientRecord[],
  runtimeAlarms: RuntimeAlarmStore,
  cfg: Config,
): Array<Record<string, unknown>> {
  const names = new Set<string>(registry.workspaces());
  for (const client of clients) {
    names.add(client.workspace);
  }
  for (const alarm of runtimeAlarms.list(null, true)) {
    names.add(alarm.workspace);
  }
  for (const workspace of Object.keys(cfg.monitor.watchdogWorkspaceAlarms)) {
    names.add(workspace);
  }
  return [...names].sort().map((workspace) => {
    const sessions = registry.list(workspace);
    const alarms = alarmsForWorkspace(workspace, runtimeAlarms, cfg);
    return {
      workspace,
      sessions: sessions.length,
      clients: clients.filter((client) => client.workspace === workspace).length,
      alarms: alarms.length,
      summary: summarizeEntries(sessions),
    };
  });
}

function alarmsForWorkspace(
  workspace: string,
  runtimeAlarms: RuntimeAlarmStore,
  cfg: Config,
): Array<Record<string, unknown>> {
  const configured = Object.entries(cfg.monitor.watchdogWorkspaceAlarms[workspace] || {}).map(([name, alarm]) => ({
    source: "config",
    workspace,
    name,
    ...runtimeAlarmToWire({
      workspace,
      name,
      clientId: null,
      createdAt: "",
      updatedAt: "",
      alarm,
    }),
  }));
  const runtime = runtimeAlarms.list(workspace).map((record) => ({
    source: "runtime",
    ...runtimeAlarmToWire(record),
  }));
  return [...configured, ...runtime];
}

function recordToWire(record: ClientRecord): Record<string, unknown> {
  return {
    client_id: record.clientId,
    workspace: record.workspace,
    hostname: record.hostname,
    pid: record.pid,
    started_at: record.startedAt,
    claude_project_dir: record.claudeProjectDir,
    session_id: record.sessionId,
  };
}

function collectIssues(
  entries: Array<{
    workspace?: string;
    name: string;
    status: string;
    queueLength: number;
    errorMessage: string | null;
    lastTurnId: string | null;
  }>,
  sessions: Map<string, Session>,
): Array<Record<string, unknown>> {
  const issues: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const workspace = entry.workspace || DEFAULT_WORKSPACE;
    const live = sessions.get(sessionKey(workspace, entry.name));
    if (entry.status === "errored") {
      issues.push({
        workspace,
        session: entry.name,
        kind: "errored",
        last_error: entry.errorMessage,
      });
      continue;
    }
    if (entry.queueLength > 0) {
      issues.push({
        workspace,
        session: entry.name,
        kind: "queue-backlog",
        queue_length: entry.queueLength,
      });
    }
    if (live && live.isRunning()) {
      const ageMs = live.currentTurnAgeMs();
      if (ageMs != null) {
        issues.push({
          workspace,
          session: entry.name,
          kind: "running",
          turn_id: live.currentTurnId(),
          age_ms: ageMs,
          last_turn_id: entry.lastTurnId,
        });
      }
    } else if (live && !live.isTransportAlive()) {
      issues.push({
        workspace,
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
