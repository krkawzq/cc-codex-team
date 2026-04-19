import { AsyncQueue } from "../../src/asyncQueue";
import { AppServerClientLike, RpcNotification } from "../../src/codex/appServerClient";

export function turnDoneNotificationSet(
  turnId: string,
  text: string,
  usageTotal = 42,
): RpcNotification[] {
  return [
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thr_test",
        turnId,
        tokenUsage: {
          last: { totalTokens: usageTotal },
          total: { totalTokens: usageTotal },
        },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thr_test",
        turnId,
        item: {
          type: "agentMessage",
          id: `msg_${turnId}`,
          text,
          phase: "final_answer",
        },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thr_test",
        turn: {
          id: turnId,
          status: "completed",
          error: null,
        },
      },
    },
  ];
}

export class FakeAppServerClient implements AppServerClientLike {
  pid: number | null = 12345;
  started = false;
  alive = true;
  closed = false;
  killed = false;
  readonly notifications = new AsyncQueue<RpcNotification>(1000);
  readonly turnInterrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly turnStarts: Record<string, unknown>[] = [];
  readonly threadStarts: Record<string, unknown>[] = [];
  readonly threadArchives: string[] = [];
  readonly threadReads: Array<{ threadId: string; includeTurns: boolean }> = [];
  readonly threadResumes: Array<{ threadId: string; params: Record<string, unknown> }> = [];
  nextThreadId = "thr_test";
  nextResumeThreadId: string | null = null;
  nextTurnId = "tr_test";
  queuedTurnNotifications: RpcNotification[][] = [];
  queuedCompactNotifications: RpcNotification[][] = [];
  threadReadError: Error | null = null;
  threadReadResult: Record<string, unknown> | null = null;

  async start(): Promise<void> {
    this.started = true;
  }

  isAlive(): boolean {
    return this.alive;
  }

  stderrSnapshot(): string[] {
    return [];
  }

  stderrTail(): string {
    return "";
  }

  async nextNotification(timeoutMs = 0, timeoutMessage = "timed out waiting for fake notification"): Promise<RpcNotification> {
    return await this.notifications.shift(timeoutMs, timeoutMessage);
  }

  async threadStart(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.threadStarts.push(params);
    return {
      thread: {
        id: this.nextThreadId,
      },
    };
  }

  async threadResume(threadId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.threadResumes.push({ threadId, params });
    return {
      thread: {
        id: this.nextResumeThreadId || threadId,
      },
    };
  }

  async threadRead(threadId: string, includeTurns = false): Promise<Record<string, unknown>> {
    this.threadReads.push({ threadId, includeTurns });
    if (this.threadReadError) {
      throw this.threadReadError;
    }
    if (this.threadReadResult) {
      return this.threadReadResult;
    }
    return {
      thread: {
        id: threadId,
        turns: includeTurns ? [{ id: "tr_prev" }] : [],
      },
    };
  }

  async threadArchive(threadId: string): Promise<Record<string, unknown>> {
    this.threadArchives.push(threadId);
    return {};
  }

  async threadCompactStart(threadId: string): Promise<Record<string, unknown>> {
    const burst = this.queuedCompactNotifications.shift() || [
      {
        method: "item/started",
        params: {
          threadId,
          turnId: "compact_turn",
          item: { type: "contextCompaction", id: "compact_1" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId,
          turnId: "compact_turn",
          item: { type: "contextCompaction", id: "compact_1" },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: "compact_turn", status: "completed", error: null },
        },
      },
    ];
    queueMicrotask(() => {
      for (const note of burst) {
        this.notifications.push(note);
      }
    });
    return {};
  }

  async turnStart(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.turnStarts.push(params);
    const turnId = this.nextTurnId;
    const burst = this.queuedTurnNotifications.shift() || turnDoneNotificationSet(turnId, "OK");
    queueMicrotask(() => {
      for (const note of burst) {
        this.notifications.push(note);
      }
    });
    return {
      turn: {
        id: turnId,
      },
    };
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    this.turnInterrupts.push({ threadId, turnId });
    return {};
  }

  kill(): void {
    this.killed = true;
    this.alive = false;
    this.pid = null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.alive = false;
    this.pid = null;
    this.notifications.close(new Error("closed"));
  }
}
