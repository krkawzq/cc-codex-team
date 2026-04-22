import { setTimeout as sleep } from "node:timers/promises";

import { RetryLimitExceededError, isRetryable } from "./errors";

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  jitterRatio: 0.2,
};

export async function retryOnOverload<T>(
  op: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY,
): Promise<T> {
  const { maxAttempts, initialDelayMs, maxDelayMs, jitterRatio } = options;
  if (maxAttempts < 1) throw new Error("maxAttempts must be >= 1");

  let delay = initialDelayMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await op();
    } catch (e) {
      if (attempt >= maxAttempts) throw e;
      if (!isRetryable(e)) throw e;
      if (e instanceof RetryLimitExceededError) throw e;
      const cap = Math.min(maxDelayMs, delay);
      const jitter = cap * jitterRatio;
      const sleepMs = Math.max(0, cap + (Math.random() * 2 - 1) * jitter);
      if (sleepMs > 0) await sleep(sleepMs);
      delay = Math.min(maxDelayMs, delay * 2);
    }
  }
}
