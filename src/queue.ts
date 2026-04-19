import { QueueFull } from "./errors";

export type OverflowPolicy = "warn" | "reject" | "drop_oldest";

export interface PendingSend {
  id: string;
  text: string;
  waitResolver?: (value: Record<string, unknown>) => void;
  waitRejecter?: (error: Error) => void;
  overrides?: Record<string, unknown> | null;
}

export interface EnqueueResult {
  overflowed: boolean;
  dropped?: PendingSend;
}

export class SendQueue {
  private readonly items: PendingSend[] = [];

  constructor(
    private readonly maxSize: number,
    private readonly policy: OverflowPolicy,
  ) {}

  enqueue(item: PendingSend): EnqueueResult {
    if (this.items.length < this.maxSize) {
      this.items.push(item);
      return { overflowed: false };
    }
    if (this.policy === "reject") {
      throw new QueueFull(`queue full (max=${this.maxSize})`, { size: this.maxSize });
    }
    if (this.policy === "drop_oldest") {
      const dropped = this.items.shift();
      this.items.push(item);
      return { overflowed: false, dropped };
    }
    const dropped = this.items.shift();
    this.items.push(item);
    return { overflowed: true, dropped };
  }

  pop(): PendingSend | undefined {
    return this.items.shift();
  }

  snapshot(): PendingSend[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
  }

  dropOldest(): PendingSend | undefined {
    return this.items.shift();
  }

  get length(): number {
    return this.items.length;
  }
}
