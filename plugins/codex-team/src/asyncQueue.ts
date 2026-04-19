export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<{ resolve: (value: T) => void; reject: (error: Error) => void }> = [];
  private closed = false;
  private closeError = new Error("queue closed");

  constructor(private readonly maxSize = 0) {}

  push(item: T): void {
    if (this.closed) {
      return;
    }
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve(item);
      return;
    }
    if (this.maxSize > 0 && this.items.length >= this.maxSize) {
      this.items.shift();
    }
    this.items.push(item);
  }

  shiftNow(): T | undefined {
    return this.items.shift();
  }

  async shift(timeoutMs = 0, timeoutMessage = "queue shift timed out"): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift() as T;
    }
    if (this.closed) {
      throw this.closeError;
    }
    return await new Promise<T>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      if (timeoutMs > 0) {
        setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
            reject(new Error(timeoutMessage));
          }
        }, timeoutMs);
      }
    });
  }

  get length(): number {
    return this.items.length;
  }

  close(error: Error = new Error("queue closed")): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(this.closeError);
    }
  }
}
