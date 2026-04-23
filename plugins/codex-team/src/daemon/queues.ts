import crypto from "node:crypto";

import type { JsonValue } from "../codex/errors";
import type { AppServerClient } from "../codex/appServerClient";
import type { RetryOptions } from "../codex/retry";
import { turnStart } from "../codex/rpc";
import { logger } from "../logger";

// Queue contract:
// - `currentTurnId` tracks the single in-flight turn for a session.
// - Any queued head keeps FIFO ownership until it either starts successfully or
//   is dropped after repeated dispatch failures.
// - `turn.error` with `willRetry=true` preserves `currentTurnId` so the retry
//   path can continue the same logical turn; `willRetry=false` releases the
//   turn and drains the queued head.
// - Teardown is tombstoned before the session record is removed so late
//   app-server requests are rejected until the queue is finally disposed.

interface QueuedInput {
  id: string;
  input: JsonValue;
  enqueuedAt: string;
  failedAttempts: number;
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

export interface QueueDropResult {
  queue_id: string;
  error_message: string;
  failure_count: number;
}

export interface QueueDrainResult {
  turn_id: string | null;
  queue_id: string | null;
  failed: boolean;
  error_message?: string;
  dropped: QueueDropResult[];
}

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
      if (state.currentTurnId || state.draining || state.pending.length > 0) {
        const queued = { id: queueId(), input, enqueuedAt: new Date().toISOString(), failedAttempts: 0 };
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
    const state = this.states.get(sessionKey);
    if (!state) return true;
    return state.tearingDown;
  }

  markTeardown(sessionKey: string): void {
    const state = this.getOrInit(sessionKey);
    state.tearingDown = true;
  }

  async beginTeardown(sessionKey: string): Promise<{ currentTurnId: string | null }> {
    this.markTeardown(sessionKey);
    const state = this.getOrInit(sessionKey);
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
      return await this.releaseCurrentTurnAndDrain(state, sessionKey, client, threadId, retry);
    });
  }

  async onTurnErrored(
    sessionKey: string,
    turnId: string | null,
    options: { willRetry: boolean },
    client: AppServerClient | null,
    threadId: string,
    retry?: RetryOptions,
  ): Promise<QueueDrainResult> {
    return await this.withSessionLock(sessionKey, async (state) => {
      if (options.willRetry) {
        return { turn_id: null, queue_id: null, failed: false, dropped: [] };
      }

      if (state.currentTurnId && turnId && state.currentTurnId !== turnId) {
        return { turn_id: null, queue_id: null, failed: false, dropped: [] };
      }

      return await this.releaseCurrentTurnAndDrain(state, sessionKey, client, threadId, retry);
    });
  }

  finalDispose(sessionKey: string): { dropped: number } {
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

  dispose(sessionKey: string): { dropped: number } {
    return this.finalDispose(sessionKey);
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

  private async releaseCurrentTurnAndDrain(
    state: QueueState,
    sessionKey: string,
    client: AppServerClient | null,
    threadId: string,
    retry?: RetryOptions,
  ): Promise<QueueDrainResult> {
    state.draining = true;
    state.currentTurnId = null;
    this.resolveIdleWaiters(state);

    const generation = state.generation;
    const dropped: QueueDropResult[] = [];
    try {
      while (state.pending.length > 0 && client && !state.disposed && !state.tearingDown) {
        const next = state.pending[0]!;
        try {
          if (!isStateUsable(state, generation)) {
            return { turn_id: null, queue_id: null, failed: false, dropped };
          }
          const res = await turnStart(client, threadId, next.input, retry);
          if (!isStateUsable(state, generation)) {
            return { turn_id: null, queue_id: null, failed: false, dropped };
          }
          state.pending.shift();
          state.currentTurnId = res.turnId;
          return { turn_id: res.turnId, queue_id: next.id, failed: false, dropped };
        } catch (e) {
          if (!isStateUsable(state, generation)) {
            return { turn_id: null, queue_id: null, failed: false, dropped };
          }
          const err = e as Error;
          next.failedAttempts += 1;
          logger.warn("failed to dispatch queued turn", {
            session: sessionKey,
            err: err.message,
            queue_id: next.id,
            failure_count: next.failedAttempts,
          });
          if (next.failedAttempts < queueHeadRetryMax(retry)) {
            return {
              turn_id: null,
              queue_id: next.id,
              failed: true,
              error_message: err.message,
              dropped,
            };
          }

          state.pending.shift();
          dropped.push({
            queue_id: next.id,
            error_message: err.message,
            failure_count: next.failedAttempts,
          });
          logger.warn("dropping queued turn after repeated dispatch failures", {
            session: sessionKey,
            err: err.message,
            queue_id: next.id,
            failure_count: next.failedAttempts,
          });
        }
      }

      return { turn_id: null, queue_id: null, failed: false, dropped };
    } finally {
      if (isSameGeneration(state, generation)) {
        state.draining = false;
        this.resolveIdleWaiters(state);
      }
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

function queueHeadRetryMax(retry?: RetryOptions): number {
  const candidate = retry?.maxAttempts;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }
  return 3;
}
