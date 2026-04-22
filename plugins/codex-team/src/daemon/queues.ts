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
}

export class TurnQueues {
  private states = new Map<string, QueueState>();

  /**
   * Either dispatch immediately or enqueue. Returns `{ started, queued_depth }`.
   * If no turn is active, starts a new turn and sets currentTurnId.
   */
  async sendOrQueue(
    sessionKey: string,
    client: AppServerClient,
    threadId: string,
    input: JsonValue,
    retry?: RetryOptions,
  ): Promise<{ started: boolean; turn_id: string | null; queue_id: string | null; queued_depth: number }> {
    return await this.withSessionLock(sessionKey, async (state) => {
      if (state.currentTurnId || state.draining) {
        const queued = { id: queueId(), input, enqueuedAt: new Date().toISOString() };
        state.pending.push(queued);
        return { started: false, turn_id: state.currentTurnId, queue_id: queued.id, queued_depth: state.pending.length };
      }
      const res = await turnStart(client, threadId, input, retry);
      state.currentTurnId = res.turnId;
      return { started: true, turn_id: res.turnId, queue_id: null, queued_depth: state.pending.length };
    });
  }

  getCurrentTurn(sessionKey: string): string | null {
    return this.states.get(sessionKey)?.currentTurnId ?? null;
  }

  setCurrentTurn(sessionKey: string, turnId: string | null): void {
    const s = this.getOrInit(sessionKey);
    s.currentTurnId = turnId;
  }

  async onTurnCompleted(
    sessionKey: string,
    client: AppServerClient | null,
    threadId: string,
    retry?: RetryOptions,
  ): Promise<{ turn_id: string | null; queue_id: string | null }> {
    return await this.withSessionLock(sessionKey, async (state) => {
      state.draining = true;
      state.currentTurnId = null;
      if (state.pending.length === 0 || !client) {
        state.draining = false;
        return { turn_id: null, queue_id: null };
      }
      const next = state.pending.shift()!;
      try {
        const res = await turnStart(client, threadId, next.input, retry);
        state.currentTurnId = res.turnId;
        return { turn_id: res.turnId, queue_id: next.id };
      } catch (e) {
        logger.warn("failed to dispatch queued turn", { session: sessionKey, err: (e as Error).message });
        return { turn_id: null, queue_id: next.id };
      } finally {
        state.draining = false;
      }
    });
  }

  dispose(sessionKey: string): { dropped: number } {
    const state = this.states.get(sessionKey);
    this.states.delete(sessionKey);
    return { dropped: state?.pending.length ?? 0 };
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

  private getOrInit(sessionKey: string): QueueState {
    let s = this.states.get(sessionKey);
    if (!s) {
      s = { pending: [], currentTurnId: null, draining: false, serial: Promise.resolve() };
      this.states.set(sessionKey, s);
    }
    return s;
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
      return await fn(state);
    } finally {
      release();
    }
  }
}

function queueId(): string {
  return `q-${crypto.randomBytes(4).toString("hex")}`;
}
