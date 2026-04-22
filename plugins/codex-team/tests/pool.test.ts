import { beforeEach, describe, expect, it, vi } from "vitest";

const poolState = vi.hoisted(() => {
  let releaseStart!: () => void;
  const makeStartPromise = () => new Promise<void>((resolve) => { releaseStart = resolve; });
  return {
    constructed: 0,
    started: 0,
    startPromise: makeStartPromise(),
    reset() {
      this.constructed = 0;
      this.started = 0;
      this.startPromise = makeStartPromise();
    },
    releaseStart() {
      releaseStart();
    },
  };
});

vi.mock("../src/codex/appServerClient", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeAppServerClient extends EventEmitter {
    constructor(_options?: unknown) {
      super();
      poolState.constructed++;
    }

    async start() {
      poolState.started++;
      await poolState.startPromise;
      return {};
    }

    isAlive() {
      return true;
    }

    async close() {}

    pid() {
      return 1234;
    }

    respond() {}

    respondError() {}
  }

  return {
    AppServerClient: FakeAppServerClient,
  };
});

import { AppServerPool } from "../src/codex/pool";

describe("AppServerPool", () => {
  beforeEach(() => {
    poolState.reset();
  });

  it("deduplicates concurrent acquires for the same session", async () => {
    const pool = new AppServerPool({
      maxSessionsPerProcess: 1,
    });

    const first = pool.acquire("user-1", "user-1::sess-1");
    const second = pool.acquire("user-1", "user-1::sess-1");

    poolState.releaseStart();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(poolState.constructed).toBe(1);
    expect(poolState.started).toBe(1);
  });

  it("keeps live sessions on separate clients even when reuse is allowed", async () => {
    const pool = new AppServerPool({
      maxSessionsPerProcess: 16,
    });

    const first = pool.acquire("user-1", "user-1::sess-1");
    poolState.releaseStart();
    const clientA = await first;

    poolState.reset();
    const second = pool.acquire("user-1", "user-1::sess-2");
    poolState.releaseStart();
    const clientB = await second;

    expect(clientA).not.toBe(clientB);
    expect(pool.processCount()).toBe(2);
  });
});
