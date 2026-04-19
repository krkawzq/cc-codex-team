import { AsyncQueue } from "./asyncQueue";

export type StreamName = "events" | "watchdog";

export interface BusEvent {
  seq: number;
  stream: StreamName;
  payload: Record<string, unknown>;
}

export interface SubscriptionOptions {
  workspace?: string | null;
  clientId?: string | null;
  allWorkspaces?: boolean;
}

interface Subscriber {
  queue: AsyncQueue<BusEvent>;
  workspace: string | null;
  clientId: string | null;
  allWorkspaces: boolean;
}

export class EventBus {
  private readonly buffers = new Map<StreamName, BusEvent[]>();
  private readonly seqs = new Map<StreamName, number>();
  private readonly subs = new Map<StreamName, Set<Subscriber>>();

  constructor(
    private maxBuffer = 1000,
    private subscriberQueueMax = 200,
  ) {}

  replaceLimits(maxBuffer: number, subscriberQueueMax: number): void {
    this.maxBuffer = maxBuffer;
    this.subscriberQueueMax = subscriberQueueMax;
  }

  publish(stream: StreamName, payload: Record<string, unknown>): BusEvent {
    const seq = (this.seqs.get(stream) || 0) + 1;
    this.seqs.set(stream, seq);
    const event: BusEvent = { seq, stream, payload };
    const buffer = this.buffers.get(stream) || [];
    buffer.push(event);
    if (buffer.length > this.maxBuffer) {
      buffer.splice(0, buffer.length - this.maxBuffer);
    }
    this.buffers.set(stream, buffer);
    for (const sub of this.subs.get(stream) || []) {
      if (eventMatchesSubscriber(event, sub)) {
        sub.queue.push(event);
      }
    }
    return event;
  }

  async subscribe(
    stream: StreamName,
    sinceSeq = 0,
    options: SubscriptionOptions = {},
  ): Promise<AsyncQueue<BusEvent>> {
    const queue = new AsyncQueue<BusEvent>(this.subscriberQueueMax);
    const sub: Subscriber = {
      queue,
      workspace: options.workspace || null,
      clientId: options.clientId || null,
      allWorkspaces: Boolean(options.allWorkspaces),
    };
    for (const event of this.buffers.get(stream) || []) {
      if (event.seq > sinceSeq && eventMatchesSubscriber(event, sub)) {
        queue.push(event);
      }
    }
    let subs = this.subs.get(stream);
    if (!subs) {
      subs = new Set();
      this.subs.set(stream, subs);
    }
    subs.add(sub);
    return queue;
  }

  async unsubscribe(stream: StreamName, queue: AsyncQueue<BusEvent>): Promise<void> {
    const subs = this.subs.get(stream);
    if (subs) {
      for (const sub of subs) {
        if (sub.queue === queue) {
          subs.delete(sub);
          break;
        }
      }
    }
    queue.close();
  }

  async detachClient(clientId: string): Promise<number> {
    let detached = 0;
    for (const subs of this.subs.values()) {
      for (const sub of [...subs]) {
        if (sub.clientId === clientId) {
          subs.delete(sub);
          sub.queue.close(new Error(`client ${clientId} detached`));
          detached += 1;
        }
      }
    }
    return detached;
  }

  lastSeq(stream: StreamName): number {
    return this.seqs.get(stream) || 0;
  }
}

function eventMatchesSubscriber(event: BusEvent, sub: Subscriber): boolean {
  if (sub.allWorkspaces || !sub.workspace) {
    return true;
  }
  const eventWorkspace = String(event.payload.workspace ?? "default");
  return eventWorkspace === sub.workspace;
}
