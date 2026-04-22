import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

describe("daemonStatus dist freshness", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("../src/version");
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports dist build metadata and whether source is newer", async () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-dist-age-"));
    tempDirs.push(packageRoot);
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src", "nested"), { recursive: true });

    const distPath = path.join(packageRoot, "dist", "main.js");
    const srcPath = path.join(packageRoot, "src", "nested", "feature.ts");
    fs.writeFileSync(distPath, "dist");
    fs.writeFileSync(srcPath, "src");

    const distBuiltAt = new Date("2025-01-01T00:00:00.000Z");
    const sourceUpdatedAt = new Date("2025-01-01T00:00:30.000Z");
    fs.utimesSync(distPath, distBuiltAt, distBuiltAt);
    fs.utimesSync(srcPath, sourceUpdatedAt, sourceUpdatedAt);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:05:00.000Z"));

    vi.doMock("../src/version", () => ({
      VERSION: "0.5.1",
      PACKAGE_ROOT: packageRoot,
    }));

    const { daemonStatus } = await import("../src/daemon/handlers/daemon");
    const result = await daemonStatus({
      startedAt: new Date("2025-01-01T00:04:00.000Z"),
      sockPath: "/tmp/codex-team.sock",
      dataDir: "/tmp/codex-team",
      logPath: "/tmp/codex-team.log",
      users: {
        list: () => [{ token: "user-1" }],
      },
      sessions: {
        listLive: () => [{ name: "sess-1" }],
      },
      pool: {
        processCount: () => 2,
      },
    } as never, {} as never);

    expect(result).toMatchObject({
      dist_built_at: distBuiltAt.toISOString(),
      dist_age_seconds: 300,
      source_newer_than_dist: true,
    });
  });
});
