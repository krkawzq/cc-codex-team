import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configFilePath } from "../src/paths";
import { ConfigStore } from "../src/daemon/config";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-config-"));
}

describe("ConfigStore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads only valid persisted values", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    fs.mkdirSync(path.dirname(configFilePath(dir)), { recursive: true });
    fs.writeFileSync(configFilePath(dir), JSON.stringify({
      "daemon.log_level": "verbose",
      "monitor.event_log_retention": "oops",
      "retry.max_attempts": 5,
      "codex.default_model": "gpt-5.4",
    }));

    const store = new ConfigStore(dir);

    expect(store.getEffective("retry.max_attempts")).toBe(5);
    expect(store.getEffective("codex.default_model")).toBe("gpt-5.4");
    expect(store.getEffective("daemon.log_level")).toBe("info");
    expect(store.getEffective("monitor.event_log_retention")).toBe(10000);
  });

  it("parses and persists typed values via set/unset/reset", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const store = new ConfigStore(dir);

    expect(store.set("retry.max_attempts", "4")).toEqual({
      ok: true,
      value: 4,
      needs_restart: false,
    });
    expect(store.set("daemon.log_level", "debug")).toEqual({
      ok: true,
      value: "debug",
      needs_restart: false,
    });
    expect(store.set("daemon.log_level", "bad")).toEqual({
      ok: false,
      error: expect.stringContaining("expected one of"),
    });

    expect(store.getEffective("retry.max_attempts")).toBe(4);
    expect(store.unset("retry.max_attempts")).toEqual({
      ok: true,
      needs_restart: false,
    });
    expect(store.getEffective("retry.max_attempts")).toBe(3);

    store.reset();
    expect(store.snapshot().explicit).toEqual({});
  });

  it("expands leading ~ in resolved configured paths", () => {
    const dir = mkTmpDir();
    const home = mkTmpDir();
    dirs.push(dir, home);
    fs.mkdirSync(path.dirname(configFilePath(dir)), { recursive: true });
    fs.writeFileSync(configFilePath(dir), JSON.stringify({
      "daemon.data_dir": "~/.codex-team-data",
      "daemon.log_path": "~/logs/daemon.log",
      "daemon.sock_path": "~/.codex-team.sock",
    }));

    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const store = new ConfigStore(dir);
      expect(store.resolvedDataDir()).toBe(path.join(home, ".codex-team-data"));
      expect(store.resolvedLogPath()).toBe(path.join(home, "logs/daemon.log"));
      expect(store.resolvedSockPath()).toBe(path.join(home, ".codex-team.sock"));
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
