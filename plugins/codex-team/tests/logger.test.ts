import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Logger } from "../src/logger";

describe("Logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("writes to stderr when no log file is configured and respects levels", () => {
    const logger = new Logger();
    logger.setLevel("warn");

    logger.info("skip");
    logger.error("boom", { code: 1 });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("\"level\":\"error\""));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("\"code\":1"));
  });

  it("switches streams when reconfigured to a new path", () => {
    const logger = new Logger();
    const streamA = { write: vi.fn(), end: vi.fn() };
    const streamB = { write: vi.fn(), end: vi.fn() };
    const createWriteStream = vi.spyOn(fs, "createWriteStream")
      .mockReturnValueOnce(streamA as never)
      .mockReturnValueOnce(streamB as never);
    const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);

    logger.configure({ logPath: "/tmp/a.log", level: "debug" });
    logger.info("one");
    logger.configure({ logPath: "/tmp/b.log" });
    logger.info("two");

    expect(createWriteStream).toHaveBeenNthCalledWith(1, "/tmp/a.log", { flags: "a" });
    expect(createWriteStream).toHaveBeenNthCalledWith(2, "/tmp/b.log", { flags: "a" });
    expect(streamA.end).toHaveBeenCalledTimes(1);
    expect(streamA.write).toHaveBeenCalledWith(expect.stringContaining("\"msg\":\"one\""));
    expect(streamB.write).toHaveBeenCalledWith(expect.stringContaining("\"msg\":\"two\""));
    expect(mkdirSync).toHaveBeenCalled();
  });
});
