import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../src/logger";
import { daemonConfigReset, daemonConfigUnset } from "../src/daemon/handlers/daemon";

function makeReq(positionals: string[], flags: Record<string, unknown> = {}) {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "daemon:config",
    params: {
      positionals,
      flags,
    },
  };
}

describe("daemon config handlers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reapplies hot config defaults on unset", async () => {
    const setLevel = vi.spyOn(logger, "setLevel").mockImplementation(() => {});
    const ctx = {
      config: {
        unset: vi.fn().mockReturnValue({ ok: true, needs_restart: false }),
        getEffective: vi.fn().mockImplementation((key: string) => {
          if (key === "daemon.log_level") return "info";
          return null;
        }),
      },
      events: {
        setRetention: vi.fn(),
      },
    };

    const result = await daemonConfigUnset(ctx as never, makeReq(["daemon.log_level"]) as never);

    expect(setLevel).toHaveBeenCalledWith("info");
    expect(result).toEqual({ key: "daemon.log_level", needs_restart: false });
  });

  it("reapplies hot config defaults on reset", async () => {
    const setLevel = vi.spyOn(logger, "setLevel").mockImplementation(() => {});
    const ctx = {
      config: {
        reset: vi.fn(),
        getEffective: vi.fn().mockImplementation((key: string) => {
          if (key === "daemon.log_level") return "info";
          if (key === "monitor.event_log_retention") return 10000;
          return null;
        }),
      },
      events: {
        setRetention: vi.fn(),
      },
    };

    const result = await daemonConfigReset(ctx as never, makeReq([], { yes: true }) as never);

    expect(ctx.config.reset).toHaveBeenCalled();
    expect(setLevel).toHaveBeenCalledWith("info");
    expect(ctx.events.setRetention).toHaveBeenCalledWith(10000);
    expect(result).toEqual({ reset: true });
  });
});
