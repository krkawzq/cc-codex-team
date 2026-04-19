import { AsyncQueue } from "./asyncQueue";

export type StreamName = "events" | "watchdog";

export interface BusEvent {
  seq: number;
  stream: StreamName;
  payload: Record<string, unknown>;
}

export class EventBus {
  private readonly buffers = new Map<StreamName, BusEvent[]>();
  private readonly seqs = new Map<StreamName, number>();
  private readonly subs = new Map<StreamName, Set<AsyncQueue<BusEvent>>>();

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
    for (const queue of this.subs.get(stream) || []) {
      queue.push(event);
    }
    return event;
  }

  async subscribe(stream: StreamName, sinceSeq = 0): Promise<AsyncQueue<BusEvent>> {
    const queue = new AsyncQueue<BusEvent>(this.subscriberQueueMax);
    for (const event of this.buffers.get(stream) || []) {
      if (event.seq > sinceSeq) {
        queue.push(event);
      }
    }
    let subs = this.subs.get(stream);
    if (!subs) {
      subs = new Set();
      this.subs.set(stream, subs);
    }
    subs.add(queue);
    return queue;
  }

  async unsubscribe(stream: StreamName, queue: AsyncQueue<BusEvent>): Promise<void> {
    this.subs.get(stream)?.delete(queue);
    queue.close();
  }

  lastSeq(stream: StreamName): number {
    return this.seqs.get(stream) || 0;
  }
}
