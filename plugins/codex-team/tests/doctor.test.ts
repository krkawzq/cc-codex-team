import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import type net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDoctorContext,
  checkCodexBin,
  checkDaemonPid,
  checkDaemonSocket,
  checkDataDirWritable,
  checkDistFreshness,
  checkLauncherOnPath,
  checkNode,
  checkSocketBind,
  runDoctor,
  type DoctorCheckResult,
  type DoctorDeps,
} from "../src/cli/doctor";

class FakeServer extends EventEmitter {
  private readonly mode: "success" | "error";
  private readonly error?: NodeJS.ErrnoException;

  constructor(mode: "success" | "error", error?: NodeJS.ErrnoException) {
    super();
    this.mode = mode;
    this.error = error;
  }

  listen(_path: string): this {
    queueMicrotask(() => {
      if (this.mode === "error") this.emit("error", this.error);
      else this.emit("listening");
    });
    return this;
  }

  close(callback?: (err?: Error) => void): this {
    callback?.();
    return this;
  }
}

class FakeSocket extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function spawnSyncResult(partial: Partial<ReturnType<typeof spawnSync>> = {}): ReturnType<typeof spawnSync> {
  return {
    pid: 123,
    output: ["", "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...partial,
  } as ReturnType<typeof spawnSync>;
}

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    fs,
    spawnSync: (() => spawnSyncResult({ stdout: "1.2.3\n" })) as typeof spawnSync,
    createServer: (() => new FakeServer("success") as unknown as net.Server) as typeof net.createServer,
    createConnection: (() => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as net.Socket;
    }) as typeof net.createConnection,
    kill: (() => true) as typeof process.kill,
    isLikelyCodexTeamDaemonProcess: (() => true) as typeof import("../src/daemon/processes").isLikelyCodexTeamDaemonProcess,
    ...overrides,
  };
}

function makeContext(overrides: Partial<Parameters<typeof buildDoctorContext>[0]> = {}) {
  return buildDoctorContext({
    packageRoot: overrides.packageRoot ?? path.resolve("plugins/codex-team"),
    dataDir: overrides.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-data-")),
    sockPath: overrides.sockPath ?? path.join(os.tmpdir(), `codex-team-${Date.now()}.sock`),
    pathEnv: overrides.pathEnv ?? process.env.PATH,
  });
}

describe("doctor", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks the current Node version", () => {
    const result = checkNode();

    expect(result.status).toBe("ok");
    expect(result.message).toContain("node=");
  });

  it("reports codex when --version succeeds", () => {
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);
    const result = checkCodexBin(ctx, makeDeps({
      spawnSync: (() => spawnSyncResult({ stdout: "codex 9.9.9\n" })) as typeof spawnSync,
    }));

    expect(result).toMatchObject({
      status: "ok",
      message: "codex=codex 9.9.9",
    });
  });

  it("warns when the plugin launcher is not on PATH", () => {
    const ctx = makeContext({ pathEnv: "" });
    tempDirs.push(ctx.dataDir);

    const result = checkLauncherOnPath(ctx, makeDeps());

    expect(result).toMatchObject({
      status: "warn",
    });
    expect(result.message).toContain("codex-team not on PATH");
    expect(result.message).toContain(path.join(path.resolve("plugins/codex-team"), "bin", "codex-team"));
  });

  it("verifies daemon.data_dir is writable", () => {
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);

    const result = checkDataDirWritable(ctx, makeDeps());

    expect(result).toMatchObject({
      status: "ok",
      message: `data_dir=${ctx.dataDir} writable`,
    });
  });

  it("fails doctor when local socket listen is denied", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-data-"));
    tempDirs.push(dataDir);
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-pkg-"));
    tempDirs.push(packageRoot);
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "dist", "main.js"), "dist");
    fs.writeFileSync(path.join(packageRoot, "src", "main.ts"), "src");
    fs.utimesSync(path.join(packageRoot, "src", "main.ts"), new Date(0), new Date(0));

    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-bin-"));
    tempDirs.push(launcherDir);
    const launcherPath = path.join(launcherDir, "codex-team");
    fs.writeFileSync(launcherPath, "#!/bin/sh\n");
    fs.chmodSync(launcherPath, 0o755);

    const lines: string[] = [];
    const code = await runDoctor({
      packageRoot,
      dataDir,
      pathEnv: launcherDir,
      write: (line) => { lines.push(line); },
    }, makeDeps({
      createServer: (() => new FakeServer(
        "error",
        Object.assign(new Error("permission denied"), { code: "EPERM" }),
      ) as unknown as net.Server) as typeof net.createServer,
    }));

    expect(code).toBe(2);
    expect(lines.join("")).toContain("[FAIL] socket_bind EPERM - sandbox forbids listen(); codex-team won't work here");
    expect(lines.join("")).toContain("=== BROKEN ===");
  });

  it("reports stale pidfiles with a manual recovery hint", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-data-"));
    tempDirs.push(dataDir);
    const ctx = makeContext({ dataDir });
    fs.writeFileSync(ctx.pidPath, JSON.stringify({ pid: 424242 }));

    const result = checkDaemonPid(ctx, makeDeps({
      kill: ((pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === 424242 && signal === 0) {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        return true;
      }) as typeof process.kill,
    }));

    expect(result.status).toBe("warn");
    expect(result.message).toContain("stale pidfile");
    expect(result.message).toContain("Safe to remove manually");
  });

  it("surfaces daemon socket connect errors with the code and interpretation", async () => {
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);
    const result = await checkDaemonSocket(ctx, {
      id: "daemon_pid",
      status: "ok",
      message: "daemon running, pid=10",
      daemonState: "running",
      pid: 10,
    }, makeDeps({
      createConnection: (() => {
        const socket = new FakeSocket();
        queueMicrotask(() => socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
        return socket as unknown as net.Socket;
      }) as typeof net.createConnection,
    }));

    expect(result).toMatchObject({
      status: "fail",
      message: "daemon_socket ECONNREFUSED - sock exists but nothing is accepting connections",
    });
  });

  it("warns when source is newer than dist", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-pkg-"));
    tempDirs.push(packageRoot);
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });

    const distPath = path.join(packageRoot, "dist", "main.js");
    const srcPath = path.join(packageRoot, "src", "main.ts");
    fs.writeFileSync(distPath, "dist");
    fs.writeFileSync(srcPath, "src");
    fs.utimesSync(distPath, new Date("2026-04-23T00:00:00.000Z"), new Date("2026-04-23T00:00:00.000Z"));
    fs.utimesSync(srcPath, new Date("2026-04-23T00:00:10.000Z"), new Date("2026-04-23T00:00:10.000Z"));

    const ctx = makeContext({ packageRoot });
    tempDirs.push(ctx.dataDir);
    const result = checkDistFreshness(ctx, makeDeps());

    expect(result).toMatchObject({
      status: "warn",
      message: "source newer than dist; run `npm run build` in plugins/codex-team",
    });
  });

  it("runs the full doctor suite and returns HEALTHY on the happy path", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-data-"));
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-pkg-"));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-bin-"));
    tempDirs.push(dataDir, packageRoot, launcherDir);

    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    const distPath = path.join(packageRoot, "dist", "main.js");
    const srcPath = path.join(packageRoot, "src", "main.ts");
    fs.writeFileSync(distPath, "dist");
    fs.writeFileSync(srcPath, "src");
    fs.utimesSync(srcPath, new Date("2026-04-23T00:00:00.000Z"), new Date("2026-04-23T00:00:00.000Z"));
    fs.utimesSync(distPath, new Date("2026-04-23T00:01:00.000Z"), new Date("2026-04-23T00:01:00.000Z"));

    const launcherPath = path.join(launcherDir, "codex-team");
    fs.writeFileSync(launcherPath, "#!/bin/sh\n");
    fs.chmodSync(launcherPath, 0o755);

    const lines: string[] = [];
    const code = await runDoctor({
      packageRoot,
      dataDir,
      pathEnv: launcherDir,
      write: (line) => { lines.push(line); },
    }, makeDeps());

    expect(code).toBe(0);
    expect(lines.join("")).toContain("[OK] node=");
    expect(lines.join("")).toContain("[OK] codex=1.2.3");
    expect(lines.join("")).toContain("[OK] daemon not running (will auto-spawn on first `-b` call)");
    expect(lines.join("")).toContain("[SKIP] daemon_socket (daemon not running)");
    expect(lines.join("")).toContain("=== HEALTHY ===");
  });
});
