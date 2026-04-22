import crypto from "node:crypto";

import type { JsonValue } from "../codex/errors";
import type { AppServerClient } from "../codex/appServerClient";
import type { RetryOptions } from "../codex/retry";
import { turnStart } from "../codex/rpc";
import { logger } from "../logger";

interface QueuedInput {
  id: string;
  input: JsonValue;
  enqueuedAt: string;
}

interface QueueState {
  pending: QueuedInput[];
  currentTurnId: string | null;
  draining: boolean;
  serial: Promise<void>;
  tearingDown: boolean;
  disposed: boolean;
  generation: number;
  idleWaiters: Set<() => void>;
}

type QueueDrainResult =
  | { turn_id: string; queue_id: string; failed: false }
  | { turn_id: null; queue_id: string | null; failed: false }
  | { turn_id: null; queue_id: string; failed: true; error_message: string };

export class QueueTeardownError extends Error {
  constructor(message = "session queue is tearing down") {
    super(message);
    this.name = "QueueTeardownError";
  }
}

export class TurnQueues {
  private states = new Map<string, QueueState>();

  async sendOrQueue(
    sessionKey: string,
    client: AppServerClient,
    threadId: string,
    input: JsonValue,
    retry?: RetryOptions,
  ): Promise<{ started: boolean; turn_id: string | null; queue_id: string | null; queued_depth: number }> {
    return await this.withSessionLock(sessionKey, async (state) => {
      assertActive(state);
      if (state.currentTurnId || state.draining) {
        const queued = { id: queueId(), input, enqueuedAt: new Date().toISOString() };
        state.pending.push(queued);
        return { started: false, turn_id: state.currentTurnId, queue_id: queued.id, queued_depth: state.pending.length };
      }

      const generation = state.generation;
      assertActive(state);
      const res = await turnStart(client, threadId, input, retry);
      if (!isStateUsable(state, generation)) throw new QueueTeardownError();
      state.currentTurnId = res.turnId;
      return { started: true, turn_id: res.turnId, queue_id: null, queued_depth: state.pending.length };
    });
  }

  getCurrentTurn(sessionKey: string): string | null {
    return this.states.get(sessionKey)?.currentTurnId ?? null;
  }

  setCurrentTurn(sessionKey: string, turnId: string | null): void {
    const existing = this.states.get(sessionKey);
    if (!existing && turnId === null) return;
    const state = existing ?? this.getOrInit(sessionKey);
    if (state.disposed) return;
    state.currentTurnId = turnId;
    this.resolveIdleWaiters(state);
  }

  isTeardown(sessionKey: string): boolean {
    return this.states.get(sessionKey)?.tearingDown ?? false;
  }

  async beginTeardown(sessionKey: string): Promise<{ currentTurnId: string | null }> {
    const state = this.getOrInit(sessionKey);
    state.tearingDown = true;
    await state.serial;
    return { currentTurnId: state.currentTurnId };
  }

  async waitForIdle(sessionKey: string): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state) return;
    if (this.isIdle(state)) return;
    await new Promise<void>((resolve) => {
      state.idleWaiters.add(resolve);
    });
  }

  onClientClosed(sessionKey: string): void {
    const state = this.states.get(sessionKey);
    if (!state) return;
    state.currentTurnId = null;
    state.draining = false;
    this.resolveIdleWaiters(state);
  }

  clearTeardown(sessionKey: string): void {
    const state = this.states.get(sessionKey);
    if (!state) return;
    state.tearingDown = false;
    this.resolveIdleWaiters(state);
  }

  depth(sessionKey: string): number {
    return this.states.get(sessionKey)?.pending.length ?? 0;
  }

  rekey(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return;
    const state = this.states.get(oldKey);
    if (!state) return;
    this.states.delete(oldKey);
    this.states.set(newKey, state);
  }

  async onTurnCompleted(
    sessionKey: string,
    client: AppServerClient | null,
    threadId: string,
    retry?: RetryOptions,
  ): Promise<QueueDrainResult> {
    return await this.withSessionLock(sessionKey, async (state) => {
      state.draining = true;
      state.currentTurnId = null;
      this.resolveIdleWaiters(state);

      if (state.pending.length === 0 || !client || state.disposed || state.tearingDown) {
        state.draining = false;
        this.resolveIdleWaiters(state);
        return { turn_id: null, queue_id: null, failed: false };
      }

      const next = state.pending[0]!;
      const generation = state.generation;
      try {
        if (!isStateUsable(state, generation)) {
          return { turn_id: null, queue_id: null, failed: false };
        }
        const res = await turnStart(client, threadId, next.input, retry);
        if (!isStateUsable(state, generation)) {
          return { turn_id: null, queue_id: null, failed: false };
        }
        state.pending.shift();
        state.currentTurnId = res.turnId;
        return { turn_id: res.turnId, queue_id: next.id, failed: false };
      } catch (e) {
        if (!isStateUsable(state, generation)) {
          return { turn_id: null, queue_id: null, failed: false };
        }
        const err = e as Error;
        logger.warn("failed to dispatch queued turn", { session: sessionKey, err: err.message, queue_id: next.id });
        return {
          turn_id: null,
          queue_id: next.id,
          failed: true,
          error_message: err.message,
        };
      } finally {
        if (isSameGeneration(state, generation)) {
          state.draining = false;
          this.resolveIdleWaiters(state);
        }
      }
    });
  }

  dispose(sessionKey: string): { dropped: number } {
    const state = this.states.get(sessionKey);
    if (!state) return { dropped: 0 };
    state.disposed = true;
    state.tearingDown = true;
    state.generation += 1;
    const dropped = state.pending.length;
    state.pending = [];
    state.currentTurnId = null;
    state.draining = false;
    this.resolveIdleWaiters(state);
    this.states.delete(sessionKey);
    return { dropped };
  }

  private getOrInit(sessionKey: string): QueueState {
    let state = this.states.get(sessionKey);
    if (!state) {
      state = {
        pending: [],
        currentTurnId: null,
        draining: false,
        serial: Promise.resolve(),
        tearingDown: false,
        disposed: false,
        generation: 0,
        idleWaiters: new Set(),
      };
      this.states.set(sessionKey, state);
    }
    return state;
  }

  private async withSessionLock<T>(sessionKey: string, fn: (state: QueueState) => Promise<T>): Promise<T> {
    const state = this.getOrInit(sessionKey);
    const prev = state.serial;
    let release!: () => void;
    state.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      if (state.disposed) throw new QueueTeardownError();
      return await fn(state);
    } finally {
      release();
    }
  }

  private isIdle(state: QueueState): boolean {
    return state.currentTurnId === null && !state.draining;
  }

  private resolveIdleWaiters(state: QueueState): void {
    if (!this.isIdle(state)) return;
    for (const resolve of state.idleWaiters) resolve();
    state.idleWaiters.clear();
  }
}

function queueId(): string {
  return `q-${crypto.randomBytes(4).toString("hex")}`;
}

function assertActive(state: QueueState): void {
  if (state.disposed || state.tearingDown) {
    throw new QueueTeardownError();
  }
}

function isSameGeneration(state: QueueState, generation: number): boolean {
  return state.generation === generation;
}

function isStateUsable(state: QueueState, generation: number): boolean {
  return !state.disposed && !state.tearingDown && isSameGeneration(state, generation);
}
