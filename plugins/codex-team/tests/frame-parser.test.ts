import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import { FrameTooLargeError, createLineParser } from "../src/ipc/frameParser";

describe("frameParser", () => {
  it("processes large single-chunk line batches without leaving buffered data behind", () => {
    const seen: string[] = [];
    const parser = createLineParser({
      peer: "test-peer",
      maxFrameBytes: 1024,
      onError: vi.fn(),
      onLine: (line) => {
        seen.push(line);
      },
    });

    const chunk = Array.from({ length: 10_000 }, (_value, index) => `line-${index}\n`).join("");
    const start = performance.now();
    parser.push(chunk);
    const elapsedMs = performance.now() - start;

    expect(seen).toHaveLength(10_000);
    expect(seen[0]).toBe("line-0");
    expect(seen[9_999]).toBe("line-9999");
    expect(parser.bufferedBytes()).toBe(0);
    expect(elapsedMs).toBeLessThan(750);
  });

  it("reports oversized unterminated frames as protocol violations", () => {
    const onError = vi.fn();
    const parser = createLineParser({
      peer: "test-peer",
      maxFrameBytes: 8,
      onError,
      onLine: vi.fn(),
    });

    parser.push("123456789");

    expect(onError).toHaveBeenCalledWith(expect.any(FrameTooLargeError));
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      peer: "test-peer",
      frameBytes: 9,
      maxFrameBytes: 8,
    });
  });

  it("stops at a completed frame boundary and resumes later", () => {
    const seen: string[] = [];
    let shouldPause = true;
    const parser = createLineParser({
      peer: "test-peer",
      maxFrameBytes: 64,
      onError: vi.fn(),
      onLine: (line) => {
        seen.push(line);
        if (shouldPause && seen.length === 2) {
          shouldPause = false;
          return false;
        }
        return true;
      },
    });

    parser.push("one\ntwo\nthree\nfour\n");

    expect(seen).toEqual(["one", "two"]);
    expect(parser.bufferedBytes()).toBeGreaterThan(0);

    parser.resume();

    expect(seen).toEqual(["one", "two", "three", "four"]);
    expect(parser.bufferedBytes()).toBe(0);
  });
});
