import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  Config,
  normalizeApprovalPolicy,
  normalizeSandboxMode,
} from "./config";
import { CompactionMonitor } from "./compaction";
import { digestItem, buildTurnSummary, writeHistoryMd, writeTurnsJsonl } from "./digest";
import { EventBus } from "./eventBus";
import { InvalidRequest, SessionBusy, SessionExists, SessionNotFound } from "./errors";
import { ensureDirFor } from "./fileIO";
import { RegistryEntry, SessionStatus, TurnSummary } from "./models";
import { sessionDir } from "./paths";
import { OverflowPolicy, PendingSend, SendQueue } from "./queue";
import { RegistryStore } from "./registry";
import { AppServerClient, AppServerClientLike, RpcNotification } from "./codex/appServerClient";

function nowIso(): string {
  return new Date().toISOString();
}

function pendingId(): string {
  return `pending-${crypto.randomUUID().slice(0, 8)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class Session {
  private readonly queue: SendQueue;
  private activeTurnId: string | null = null;
  private activeTurnStartedAtMs: number | null = null;
  private closed = false;
  private active = true;
  private running = false;
  private stateLock: Promise<void> = Promise.resolve();
  private stderrFlushedCount = 0;

  constructor(
    readonly name: string,
    private cfg: Config,
    private readonly dataDir: string,
    private readonly registry: RegistryStore,
    private readonly eventBus: EventBus,
    private readonly compaction: CompactionMonitor | null,
    private readonly client: AppServerClientLike,
    readonly threadId: string,
  ) {
    this.queue = new SendQueue(cfg.queue.maxPerSession, cfg.queue.overflowPolicy as OverflowPolicy);
  }

  replaceConfig(cfg: Config): void {
    this.cfg = cfg;
  }

  async send(
    text: string,
    options: { wait?: boolean; overrides?: Record<string, unknown> | null } = {},
  ): Promise<string | Record<string, unknown>> {
    const placeholderId = pendingId();
    let waitPromise: Promise<Record<string, unknown>> | undefined;
    let resolveWait: ((value: Record<string, unknown>) => void) | undefined;
    let rejectWait: ((error: Error) => void) | undefined;
    if (options.wait) {
      waitPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        resolveWait = resolve;
        rejectWait = reject;
      });
    }

    await this.withStateLock(async () => {
      if (this.closed) {
        throw new SessionNotFound(this.name);
      }
      if (this.running) {
        const enqueueResult = this.queue.enqueue({
          id: placeholderId,
          text,
          waitResolver: resolveWait,
          waitRejecter: rejectWait,
          overrides: options.overrides || null,
        });
        if (enqueueResult.dropped) {
          this.rejectPending(enqueueResult.dropped, new Error(`queued send ${enqueueResult.dropped.id} was dropped`));
        }
        this.registry.update(this.name, { queueLength: this.queue.length });
        if (enqueueResult.overflowed) {
          this.eventBus.publish("events", {
            kind: "queue-overflow",
            session: this.name,
            policy: this.cfg.queue.overflowPolicy,
            dropped_id: enqueueResult.dropped?.id ?? null,
          });
        }
        return;
      }
      this.running = true;
      this.registry.update(this.name, { status: "running" });
      void this.runTurn(placeholderId, text, resolveWait, rejectWait, options.overrides || null);
    });

    if (waitPromise) {
      return await waitPromise;
    }
    return placeholderId;
  }

  async interrupt(): Promise<void> {
    if (this.activeTurnId) {
      await this.client.turnInterrupt(this.threadId, this.activeTurnId);
    }
  }

  async kill(reason = "killed by operator"): Promise<void> {
    await this.withStateLock(async () => {
      this.active = false;
      this.closed = true;
      this.running = false;
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
      this.rejectQueuedWaiters(new Error(reason));
      this.queue.clear();
      this.registry.update(this.name, { queueLength: 0, appServerPid: null });
    });
    this.client.kill();
    await this.client.close();
    this.registry.update(this.name, {
      status: "errored",
      appServerPid: null,
      queueLength: 0,
      errorMessage: reason,
    });
  }

  async ackError(): Promise<void> {
    this.registry.update(this.name, { status: "idle", errorMessage: null });
  }

  async compact(): Promise<void> {
    await this.withStateLock(async () => {
      if (this.running) {
        throw new SessionBusy(`session ${this.name} is running; compact after the active turn finishes`);
      }
      this.running = true;
      this.registry.update(this.name, { status: "compacting" });
    });
    const attempts = Math.max(1, this.cfg.compaction.retryAttempts + 1);
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await this.runCompactAttempt();
        this.compaction?.clear(this.name);
        this.registry.update(this.name, {
          status: "idle",
          tokenUsageInput: result.usageTotal ?? 0,
          contextTokensEstimate: result.contextTokensEstimate ?? 0,
          modelContextWindow: result.modelContextWindow ?? this.registry.get(this.name).modelContextWindow ?? null,
          errorMessage: null,
        });
        await this.dispatchNextQueued();
        return;
      } catch (error) {
        lastError = error as Error;
        if (attempt >= attempts) {
          break;
        }
        this.eventBus.publish("events", {
          kind: "compact-retry",
          session: this.name,
          attempt,
          max_attempts: attempts,
          error: lastError.message,
        });
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, this.cfg.compaction.retryDelayMs)));
      }
    }
    this.registry.update(this.name, {
      status: "errored",
      errorMessage: lastError?.message || "compact failed",
    });
    await this.withStateLock(async () => {
      this.running = false;
    });
    throw lastError || new Error("compact failed");
  }

  private async runCompactAttempt(): Promise<{
    usageTotal: number | null;
    contextTokensEstimate: number | null;
    modelContextWindow: number | null;
  }> {
    await this.client.threadCompactStart(this.threadId);
    let sawCompaction = false;
    let usageTotal: number | null = null;
    let contextTokensEstimate: number | null = null;
    let modelContextWindow: number | null = null;
    while (true) {
      const note = await this.client.nextNotification(
        this.cfg.compaction.timeoutSeconds * 1000,
        `compact timed out after ${this.cfg.compaction.timeoutSeconds}s`,
      );
      this.handleUsageNotification(note, String(note.params.turnId ?? ""), (payload) => {
        usageTotal = payload.usageTotalTokens;
        contextTokensEstimate = payload.contextTokensEstimate;
        modelContextWindow = payload.modelContextWindow;
      });
      if (note.method === "item/started" || note.method === "item/completed") {
        const item = asRecord(note.params.item);
        if (String(item.type ?? "") === "contextCompaction") {
          sawCompaction = true;
          if (note.method === "item/completed") {
            continue;
          }
        }
      }
      if (sawCompaction && note.method === "turn/completed") {
        const turn = asRecord(note.params.turn);
        const status = String(turn.status ?? "completed");
        if (!["completed", "ok"].includes(status)) {
          const turnError = asRecord(turn.error);
          throw new Error(String(turnError.message ?? `compact turn ended with status ${status}`));
        }
        return {
          usageTotal,
          contextTokensEstimate,
          modelContextWindow,
        };
      }
    }
  }

  snapshotQueue(): PendingSend[] {
    return this.queue.snapshot();
  }

  snapshotQueueJson(): Record<string, unknown>[] {
    return this.queue.snapshot().map((item) => ({
      id: item.id,
      text: item.text,
      hasWaiter: !!item.waitResolver,
      overrides: item.overrides || {},
    }));
  }

  dumpState(): Record<string, unknown> {
    const sessionPath = sessionDir(this.dataDir, this.name);
    return {
      session: this.registry.get(this.name),
      queue: this.snapshotQueueJson(),
      transport_alive: this.isTransportAlive(),
      stderr_tail: this.stderrTail(20),
      history_path: path.join(sessionPath, "history.md"),
      turns_path: path.join(sessionPath, "turns.jsonl"),
    };
  }

  async read(includeTurns = false): Promise<Record<string, unknown>> {
    return await this.client.threadRead(this.threadId, includeTurns);
  }

  async archiveThread(): Promise<void> {
    await this.client.threadArchive(this.threadId);
  }

  async detachForRecovery(reason = "detached for recovery"): Promise<PendingSend[]> {
    let queued: PendingSend[] = [];
    await this.withStateLock(async () => {
      this.active = false;
      this.closed = true;
      this.running = false;
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
      queued = this.queue.snapshot();
      this.queue.clear();
      this.registry.update(this.name, {
        queueLength: 0,
        appServerPid: null,
      });
    });
    await this.client.close();
    return queued;
  }

  async absorbQueue(items: PendingSend[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.withStateLock(async () => {
      for (const item of items) {
        const enqueueResult = this.queue.enqueue(item);
        if (enqueueResult.dropped) {
          this.rejectPending(enqueueResult.dropped, new Error(`queued send ${enqueueResult.dropped.id} was dropped`));
        }
      }
      this.registry.update(this.name, { queueLength: this.queue.length });
      if (!this.running) {
        const next = this.queue.pop();
        this.registry.update(this.name, { queueLength: this.queue.length });
        if (!next) {
          return;
        }
        this.running = true;
        this.registry.update(this.name, { status: "running" });
        void this.runTurn(next.id, next.text, next.waitResolver, next.waitRejecter, next.overrides || null);
      }
    });
  }

  clearQueue(): void {
    this.rejectQueuedWaiters(new Error(`queue for ${this.name} was cleared`));
    this.queue.clear();
    this.registry.update(this.name, { queueLength: 0 });
  }

  dropOldest(): PendingSend | undefined {
    const dropped = this.queue.dropOldest();
    if (dropped) {
      this.rejectPending(dropped, new Error(`queued send ${dropped.id} was dropped`));
    }
    this.registry.update(this.name, { queueLength: this.queue.length });
    return dropped;
  }

  async close(): Promise<void> {
    await this.withStateLock(async () => {
      this.active = false;
      this.closed = true;
      this.running = false;
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
      this.rejectQueuedWaiters(new Error(`session ${this.name} was closed`));
      this.queue.clear();
      this.registry.update(this.name, { queueLength: 0, appServerPid: null });
    });
    await this.shutdownTransport();
    this.registry.update(this.name, { status: "closed", appServerPid: null, queueLength: 0 });
  }

  async shutdown(): Promise<void> {
    await this.withStateLock(async () => {
      this.active = false;
      this.closed = true;
      this.running = false;
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
      this.rejectQueuedWaiters(new Error(`session ${this.name} is shutting down`));
      this.queue.clear();
      this.registry.update(this.name, { queueLength: 0, appServerPid: null });
    });
    await this.shutdownTransport();
    const current = this.registry.get(this.name);
    if (current.status === "closed") {
      return;
    }
    this.registry.update(this.name, {
      status: current.errorMessage ? "errored" : "idle",
      appServerPid: null,
      queueLength: 0,
    });
  }

  async healthCheck(): Promise<void> {
    await this.read(false);
  }

  isTransportAlive(): boolean {
    return this.client.isAlive();
  }

  isRunning(): boolean {
    return this.running;
  }

  currentTurnId(): string | null {
    return this.activeTurnId;
  }

  currentTurnAgeMs(): number | null {
    if (!this.running || this.activeTurnStartedAtMs == null) {
      return null;
    }
    return Date.now() - this.activeTurnStartedAtMs;
  }

  stderrTail(limit = 40): string {
    return this.client.stderrTail(limit);
  }

  private async shutdownTransport(): Promise<void> {
    this.persistStderrLog();
    await this.client.close();
  }

  private persistStderrLog(): void {
    const lines = this.client.stderrSnapshot();
    if (lines.length === 0) {
      return;
    }
    if (this.stderrFlushedCount > lines.length) {
      this.stderrFlushedCount = 0;
    }
    const pending = lines.slice(this.stderrFlushedCount);
    if (pending.length === 0) {
      return;
    }
    const filePath = path.join(sessionDir(this.dataDir, this.name), "app-server.stderr.log");
    ensureDirFor(filePath);
    fs.appendFileSync(filePath, `${pending.join("\n")}\n`, "utf8");
    this.stderrFlushedCount = lines.length;
  }

  private rejectQueuedWaiters(error: Error): void {
    for (const item of this.queue.snapshot()) {
      this.rejectPending(item, error);
    }
  }

  private rejectPending(item: PendingSend, error: Error): void {
    try {
      item.waitRejecter?.(error);
    } catch {
      // ignore waiter failures
    }
  }

  private async withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.stateLock;
    let release!: () => void;
    this.stateLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async runTurn(
    pendingTurnId: string,
    text: string,
    resolveWait?: (value: Record<string, unknown>) => void,
    rejectWait?: (error: Error) => void,
    overrides?: Record<string, unknown> | null,
  ): Promise<void> {
    const lines = [];
    let finalMessage: string | null = null;
    let status = "completed";
    let errorMessage: string | null = null;
    let turnId = "unknown";
    let usageLast: number | null = null;
    let usageTotal: number | null = null;
    let contextTokensEstimate: number | null = null;
    let modelContextWindow: number | null = null;
    const started = Date.now();
    let waitSettled = false;
    this.registry.update(this.name, { lastPromptText: text });
    try {
      const response = await this.client.turnStart(buildTurnStartParams(this.threadId, text, overrides));
      turnId = String(asRecord(response.turn).id ?? turnId);
      this.activeTurnId = turnId;
      this.activeTurnStartedAtMs = Date.now();
      this.eventBus.publish("events", {
        kind: "turn-start",
        session: this.name,
        queued_or_turn_id: pendingTurnId,
        turn_id: turnId,
      });
      while (true) {
        const notification = await this.client.nextNotification();
        this.handleUsageNotification(notification, turnId, (payload) => {
          usageLast = payload.usageLastTokens;
          usageTotal = payload.usageTotalTokens;
          contextTokensEstimate = payload.contextTokensEstimate;
          modelContextWindow = payload.modelContextWindow;
        });
        if (notification.method === "item/completed") {
          const params = notification.params;
          if (String(params.turnId ?? "") !== turnId) {
            continue;
          }
          const item = asRecord(params.item);
          const line = digestItem(item, this.cfg.digest);
          if (line) {
            lines.push(line);
            if (line.kind === "agent_message") {
              const phase = item.phase == null ? null : String(item.phase);
              if (phase === "final_answer" || phase === null) {
                finalMessage = line.text;
              }
            }
          }
          continue;
        }
        if (notification.method === "turn/completed") {
          const params = notification.params;
          const turn = asRecord(params.turn);
          if (String(turn.id ?? "") !== turnId) {
            continue;
          }
          status = String(turn.status ?? status);
          const turnError = asRecord(turn.error);
          errorMessage = turn.error == null ? null : String(turnError.message ?? "turn failed");
          break;
        }
      }
    } catch (error) {
      status = "failed";
      errorMessage = (error as Error).message;
      if (rejectWait) {
        rejectWait(error as Error);
        waitSettled = true;
      }
    } finally {
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
    }

    const completedAt = nowIso();
    const summary = buildTurnSummary({
      session: this.name,
      turnId,
      elapsedMs: Date.now() - started,
      status: status === "completed" ? "ok" : status,
      lines,
      finalMessage,
      usageLastTokens: usageLast,
      usageTotalTokens: usageTotal,
      contextTokensEstimate,
      modelContextWindow,
      errorMessage,
      completedAt,
    });

    const sessionPath = sessionDir(this.dataDir, this.name);
    if (this.cfg.digest.historyMdEnabled) {
      writeHistoryMd(path.join(sessionPath, "history.md"), summary, this.cfg.digest);
    }
    if (this.cfg.digest.turnsJsonlEnabled) {
      writeTurnsJsonl(path.join(sessionPath, "turns.jsonl"), summary, this.cfg.digest);
    }
    if (usageTotal != null || contextTokensEstimate != null) {
      await this.compaction?.observeUsage(this.name, {
        contextTokensEstimate,
        modelContextWindow,
        cumulativeUsageTokens: usageTotal,
      });
    }
    this.persistStderrLog();
    if (!this.active) {
      if (rejectWait && !waitSettled) {
        rejectWait(new Error(`session ${this.name} is no longer active`));
      }
      return;
    }
    this.registry.update(this.name, {
      status: summary.status === "ok" ? "idle" : "errored",
      lastTurnId: turnId,
      lastTurnEndedAt: completedAt,
      queueLength: this.queue.length,
      tokenUsageInput: usageTotal || 0,
      contextTokensEstimate,
      modelContextWindow,
      errorMessage,
      appServerPid: this.client.pid,
    });
    this.eventBus.publish("events", {
      kind: summary.tier === "attn" ? "turn-attn" : "turn-done",
      session: this.name,
      ...summaryToWire(summary),
    });
    if (resolveWait && summary.status === "ok") {
      resolveWait(summaryToWire(summary));
      waitSettled = true;
    } else if (rejectWait && !waitSettled) {
      rejectWait(new Error(summary.errorMessage || `turn ${summary.turnId} finished with status ${summary.status}`));
      waitSettled = true;
    }

    await this.dispatchNextQueued();
  }

  private async dispatchNextQueued(): Promise<PendingSend | undefined> {
    let next: PendingSend | undefined;
    await this.withStateLock(async () => {
      next = this.queue.pop();
      this.registry.update(this.name, { queueLength: this.queue.length });
      if (!next) {
        this.running = false;
      } else {
        this.running = true;
        this.registry.update(this.name, { status: "running" });
      }
    });
    if (next) {
      void this.runTurn(next.id, next.text, next.waitResolver, next.waitRejecter, next.overrides || null);
    }
    return next;
  }

  private handleUsageNotification(
    notification: RpcNotification,
    turnId: string,
    setUsage: (payload: {
      usageLastTokens: number | null;
      usageTotalTokens: number | null;
      contextTokensEstimate: number | null;
      modelContextWindow: number | null;
    }) => void,
  ): void {
    if (
      notification.method !== "thread/tokenUsageUpdated" &&
      notification.method !== "thread/tokenUsage/updated"
    ) {
      return;
    }
    if (String(notification.params.turnId ?? "") !== turnId) {
      return;
    }
    const tokenUsage = asRecord(notification.params.tokenUsage);
    const last = asRecord(tokenUsage.last);
    const total = asRecord(tokenUsage.total);
    const inputTokens = last.inputTokens == null ? null : Number(last.inputTokens);
    const cachedInputTokens = last.cachedInputTokens == null ? null : Number(last.cachedInputTokens);
    setUsage({
      usageLastTokens: last.totalTokens == null ? null : Number(last.totalTokens),
      usageTotalTokens: total.totalTokens == null ? null : Number(total.totalTokens),
      contextTokensEstimate:
        inputTokens == null && cachedInputTokens == null
          ? null
          : (inputTokens || 0) + (cachedInputTokens || 0),
      modelContextWindow:
        tokenUsage.modelContextWindow == null ? null : Number(tokenUsage.modelContextWindow),
    });
  }
}

export class SessionFactory {
  constructor(
    private cfg: Config,
    private readonly registry: RegistryStore,
    private readonly eventBus: EventBus,
    private readonly compaction: CompactionMonitor | null = null,
    private readonly clientFactory: (cfg: Config) => AppServerClientLike = (cfg) => new AppServerClient(cfg),
  ) {}

  replaceConfig(cfg: Config): void {
    this.cfg = cfg;
  }

  private dataDir(): string {
    return this.cfg.daemon.dataDir;
  }

  async create(
    name: string,
    options: {
      cwd?: string | null;
      model?: string | null;
      modelProvider?: string | null;
      sandbox?: string | null;
      approvalPolicy?: string | null;
      serviceTier?: string | null;
      reasoningEffort?: string | null;
      personality?: string | null;
      baseInstructions?: string | null;
      developerInstructions?: string | null;
      profile?: string | null;
      ephemeral?: boolean | null;
    } = {},
  ): Promise<Session> {
    try {
      this.registry.get(name);
      throw new SessionExists(name);
    } catch (error) {
      if (!(error instanceof SessionNotFound)) {
        throw error;
      }
    }

    const requestedProfile = options.profile || this.cfg.defaults.profile || "";
    const selectedProfile = requestedProfile ? this.cfg.profiles[requestedProfile] : undefined;
    if (requestedProfile && !selectedProfile) {
      throw new InvalidRequest(`unknown profile: ${requestedProfile}`);
    }
    const resolved = {
      cwd: options.cwd || selectedProfile?.cwd || this.cfg.defaults.cwd || this.dataDir(),
      model: options.model || selectedProfile?.model || this.cfg.defaults.model,
      modelProvider:
        options.modelProvider || selectedProfile?.modelProvider || this.cfg.defaults.modelProvider || null,
      sandbox: normalizeSandboxMode(
        options.sandbox || selectedProfile?.sandbox || this.cfg.defaults.sandbox,
      ),
      approvalPolicy: normalizeApprovalPolicy(
        options.approvalPolicy || selectedProfile?.approvalPolicy || this.cfg.defaults.approvalPolicy,
      ),
      serviceTier:
        options.serviceTier || selectedProfile?.serviceTier || this.cfg.defaults.serviceTier || null,
      reasoningEffort:
        options.reasoningEffort ||
        selectedProfile?.reasoningEffort ||
        this.cfg.defaults.reasoningEffort ||
        null,
      personality:
        options.personality || selectedProfile?.personality || this.cfg.defaults.personality || null,
      baseInstructions:
        options.baseInstructions ||
        selectedProfile?.baseInstructions ||
        this.cfg.defaults.baseInstructions ||
        null,
      developerInstructions:
        options.developerInstructions ||
        selectedProfile?.developerInstructions ||
        this.cfg.defaults.developerInstructions ||
        null,
      ephemeral: options.ephemeral ?? selectedProfile?.ephemeral ?? false,
      profile: requestedProfile || null,
    };

    const client = this.clientFactory(this.cfg);
    await client.start();
    let threadId = "";
    try {
      const response = await client.threadStart(buildThreadStartParams(resolved));
      const thread = asRecord(response.thread);
      threadId = String(thread.id ?? "");
      if (threadId) {
        await client.threadRead(threadId, false);
      }
    } catch (error) {
      await client.close();
      throw error;
    }
    const entry: RegistryEntry = {
      name,
      threadId,
      cwd: resolved.cwd,
      model: resolved.model,
      modelProvider: resolved.modelProvider,
      sandbox: resolved.sandbox || "danger-full-access",
      approvalPolicy: resolved.approvalPolicy || "never",
      serviceTier: resolved.serviceTier,
      reasoningEffort: resolved.reasoningEffort,
      personality: resolved.personality,
      profile: resolved.profile,
      createdAt: nowIso(),
      lastTurnId: null,
      lastTurnEndedAt: null,
      lastPromptText: null,
      status: "idle",
      appServerPid: client.pid,
      ephemeral: resolved.ephemeral,
      queueLength: 0,
      tokenUsageInput: 0,
      contextTokensEstimate: 0,
      modelContextWindow: null,
      errorMessage: null,
    };
    this.registry.create(entry);
    return new Session(
      name,
      this.cfg,
      this.dataDir(),
      this.registry,
      this.eventBus,
      this.compaction,
      client,
      threadId,
    );
  }

  async resume(name: string): Promise<Session> {
    const entry = this.registry.get(name);
    if (entry.ephemeral) {
      throw new InvalidRequest(
        `session ${name} is ephemeral and cannot be resumed after its app-server exits`,
      );
    }
    const client = this.clientFactory(this.cfg);
    await client.start();
    try {
      await client.threadResume(entry.threadId, { cwd: entry.cwd });
      await client.threadRead(entry.threadId, false);
    } catch (error) {
      await client.close();
      throw error;
    }
    this.registry.update(name, {
      status: "idle",
      errorMessage: null,
      appServerPid: client.pid,
    });
    return new Session(
      name,
      this.cfg,
      this.dataDir(),
      this.registry,
      this.eventBus,
      this.compaction,
      client,
      entry.threadId,
    );
  }
}

function buildThreadStartParams(resolved: {
  cwd: string;
  model: string;
  modelProvider: string | null;
  sandbox: string | null;
  approvalPolicy: string | null;
  serviceTier: string | null;
  reasoningEffort: string | null;
  personality: string | null;
  baseInstructions: string | null;
  developerInstructions: string | null;
  ephemeral: boolean;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: resolved.model,
    cwd: resolved.cwd,
    ephemeral: resolved.ephemeral,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
    serviceName: "codex-team",
  };
  if (resolved.modelProvider) {
    params.modelProvider = resolved.modelProvider;
  }
  if (resolved.sandbox) {
    params.sandbox = resolved.sandbox;
  }
  if (resolved.approvalPolicy) {
    params.approvalPolicy = resolved.approvalPolicy;
  }
  if (resolved.serviceTier) {
    params.serviceTier = resolved.serviceTier;
  }
  if (resolved.personality) {
    params.personality = resolved.personality;
  }
  if (resolved.baseInstructions) {
    params.baseInstructions = resolved.baseInstructions;
  }
  if (resolved.developerInstructions) {
    params.developerInstructions = resolved.developerInstructions;
  }
  if (resolved.reasoningEffort) {
    params.config = { model_reasoning_effort: resolved.reasoningEffort };
  }
  return params;
}

function buildTurnStartParams(
  threadId: string,
  text: string,
  overrides?: Record<string, unknown> | null,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    threadId,
    input: [{ type: "text", text }],
  };
  if (!overrides) {
    return params;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (key === "outputSchema") {
      params.outputSchema = value;
      continue;
    }
    params[key] = value;
  }
  return params;
}

function summaryToWire(summary: TurnSummary): Record<string, unknown> {
  return {
    session: summary.session,
    turn_id: summary.turnId,
    elapsed_ms: summary.elapsedMs,
    status: summary.status,
    tier: summary.tier,
    final_message: summary.finalMessage,
    files_added: summary.filesAdded,
    files_removed: summary.filesRemoved,
    lines: summary.lines,
    usage_last_tokens: summary.usageLastTokens ?? null,
    usage_total_tokens: summary.usageTotalTokens ?? null,
    context_tokens_estimate: summary.contextTokensEstimate ?? null,
    model_context_window: summary.modelContextWindow ?? null,
    error_message: summary.errorMessage ?? null,
    completed_at: summary.completedAt ?? null,
  };
}
