import { Config } from "./config";
import { EventBus } from "./eventBus";
import { RegistryStore } from "./registry";
import { Session } from "./session";

interface SessionFactoryLike {
  resume(name: string): Promise<Session>;
}

export class HealthMonitor {
  private readonly healedAt = new Map<string, number>();
  private readonly stuckTurnNotified = new Map<string, string>();

  constructor(
    private cfg: Config,
    private readonly registry: RegistryStore,
    private readonly sessions: Map<string, Session>,
    private readonly eventBus: EventBus,
    private readonly factory: SessionFactoryLike,
  ) {}

  replaceConfig(cfg: Config): void {
    this.cfg = cfg;
  }

  async tickOnce(): Promise<void> {
    const entries = this.registry.list();
    const concurrency = Math.max(1, this.cfg.heartbeat.healthCheckConcurrency);
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, entries.length || 1) }, async () => {
      while (index < entries.length) {
        const current = entries[index];
        index += 1;
        await this.checkEntry(current);
      }
    });
    await Promise.all(workers);
  }

  private async checkEntry(entry: ReturnType<RegistryStore["get"]>): Promise<void> {
    if (entry.status === "closed") {
      this.stuckTurnNotified.delete(entry.name);
      return;
    }
    const session = this.sessions.get(entry.name);
    if (!session) {
      this.stuckTurnNotified.delete(entry.name);
      await this.onDown(entry.name);
      return;
    }

    this.maybeEmitTurnStuck(entry.name, session);

    try {
      if (!session.isTransportAlive()) {
        throw new Error("transport is not alive");
      }
      await withTimeout(session.healthCheck(), this.cfg.heartbeat.healthTimeoutSeconds * 1000);
    } catch (error) {
      this.registry.update(entry.name, {
        status: "errored",
        errorMessage: (error as Error).message,
      });
      await this.onDown(entry.name, session);
    }
  }

  private maybeEmitTurnStuck(name: string, session: Session): void {
    if (!session.isRunning()) {
      this.stuckTurnNotified.delete(name);
      return;
    }
    const turnId = session.currentTurnId();
    const ageMs = session.currentTurnAgeMs();
    if (!turnId || ageMs == null) {
      this.stuckTurnNotified.delete(name);
      return;
    }
    const thresholdMs = this.cfg.heartbeat.turnStuckSeconds * 1000;
    if (ageMs < thresholdMs) {
      if (this.stuckTurnNotified.get(name) !== turnId) {
        this.stuckTurnNotified.delete(name);
      }
      return;
    }
    if (this.stuckTurnNotified.get(name) === turnId) {
      return;
    }
    this.stuckTurnNotified.set(name, turnId);
    this.eventBus.publish("events", {
      kind: "turn-stuck",
      session: name,
      turn_id: turnId,
      age_ms: ageMs,
      threshold_ms: thresholdMs,
    });
  }

  private async onDown(name: string, session?: Session): Promise<void> {
    const entry = this.registry.get(name);
    const lastHealedAt = this.healedAt.get(name);
    const duringTurn = session?.isRunning() || entry.status === "running";
    const activeTurnId = session?.currentTurnId() || entry.lastTurnId || null;
    const turnAgeMs = session?.currentTurnAgeMs() ?? null;
    const migratedQueue = session ? await session.detachForRecovery("auto-heal queue migration") : [];
    if (session) {
      this.sessions.delete(name);
    }
    const canAttemptHeal =
      this.cfg.heartbeat.selfHealOnce &&
      !entry.ephemeral &&
      (lastHealedAt == null ||
        Date.now() - lastHealedAt >= this.cfg.heartbeat.selfHealBackoffSeconds * 1000);
    if (canAttemptHeal) {
      this.healedAt.set(name, Date.now());
      try {
        const resumed = await withTimeout(
          this.factory.resume(name),
          this.cfg.heartbeat.resumeTimeoutSeconds * 1000,
        );
        await resumed.absorbQueue(migratedQueue);
        this.sessions.set(name, resumed);
        this.registry.update(name, {
          status: "idle",
          errorMessage: null,
        });
        this.eventBus.publish("events", {
          kind: duringTurn ? "auto-heal-after-crash" : "subprocess-recycled",
          session: name,
          heal_reason: duringTurn ? "transport_down_during_turn" : "transport_down_idle",
          was_during_turn: duringTurn,
          turn_id: activeTurnId,
          turn_age_ms: turnAgeMs,
          legacy_kind: "auto-heal",
        });
        return;
      } catch (error) {
        for (const item of migratedQueue) {
          item.waitRejecter?.(new Error(`auto-heal failed for ${name}: ${(error as Error).message}`));
        }
        this.registry.update(name, {
          status: "errored",
          errorMessage: (error as Error).message,
        });
      }
    }
    if (!canAttemptHeal) {
      for (const item of migratedQueue) {
        item.waitRejecter?.(new Error(`session ${name} went down and could not be auto-healed`));
      }
    }
    this.eventBus.publish("events", {
      kind: "session-down",
      session: name,
      reason: duringTurn ? "transport_down_during_turn" : "transport_down_idle",
      was_during_turn: duringTurn,
      turn_id: activeTurnId,
      turn_age_ms: turnAgeMs,
      queued_items_migrated: migratedQueue.length,
      lastError: entry.errorMessage || "",
      stderrTail: session?.stderrTail(20) || "",
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}
