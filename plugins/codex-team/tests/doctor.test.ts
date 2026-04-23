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
  type DoctorDeps,
} from "../src/cli/doctor";
import { runCli } from "../src/cli/run";

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
    pluginRoot: overrides.pluginRoot,
    invokedAs: overrides.invokedAs,
  });
}

function createDoctorPackageRoot(tempDirs: string[]): string {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-pkg-"));
  tempDirs.push(packageRoot);
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "dist", "main.js"), "dist");
  fs.writeFileSync(path.join(packageRoot, "src", "main.ts"), "src");
  fs.utimesSync(path.join(packageRoot, "src", "main.ts"), new Date(0), new Date(0));
  return packageRoot;
}

function createLauncherDir(tempDirs: string[]): { launcherDir: string; launcherPath: string } {
  const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-bin-"));
  tempDirs.push(launcherDir);
  const launcherPath = path.join(launcherDir, "codex-team");
  fs.writeFileSync(launcherPath, "#!/bin/sh\n");
  fs.chmodSync(launcherPath, 0o755);
  return { launcherDir, launcherPath };
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

  it("warns when the plugin launcher is not on PATH outside plugin mode", () => {
    const previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const ctx = makeContext({ pathEnv: "" });
    tempDirs.push(ctx.dataDir);

    try {
      const result = checkLauncherOnPath(ctx, makeDeps());

      expect(result).toMatchObject({
        status: "warn",
        name: "launcher_on_path",
      });
      expect(result.message).toContain("codex-team not on PATH");
      expect(result.message).toContain(path.join(path.resolve("plugins/codex-team"), "bin", "codex-team"));
    } finally {
      if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
    }
  });

  it("treats the bundled launcher as OK in plugin mode", () => {
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-root-"));
    tempDirs.push(pluginRoot);
    const packageRoot = path.join(pluginRoot, "plugins", "codex-team");
    fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
    const launcherPath = path.join(packageRoot, "bin", "codex-team");
    fs.writeFileSync(launcherPath, "#!/bin/sh\n");
    fs.chmodSync(launcherPath, 0o755);

    const previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const previousArgv1 = process.argv[1];
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    process.argv[1] = launcherPath;

    try {
      const ctx = makeContext({ packageRoot, pathEnv: "" });
      tempDirs.push(ctx.dataDir);

      const result = checkLauncherOnPath(ctx, makeDeps());

      expect(result).toMatchObject({
        status: "ok",
        name: "launcher_on_path",
        message: `launcher=${path.resolve(launcherPath)} (plugin mode)`,
      });
    } finally {
      process.argv[1] = previousArgv1;
      if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
    }
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

  it("prints a writable tmpdir suggestion when data_dir is not writable", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-data-"));
    tempDirs.push(dataDir);
    const packageRoot = createDoctorPackageRoot(tempDirs);
    const { launcherDir } = createLauncherDir(tempDirs);

    const lines: string[] = [];
    const code = await runDoctor({
      packageRoot,
      dataDir,
      pathEnv: launcherDir,
      write: (line) => { lines.push(line); },
    }, makeDeps({
      fs: {
        ...fs,
        writeFileSync: ((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
          if (typeof target === "string" && target.endsWith(".doctor-write-test")) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return fs.writeFileSync(target as never, data as never, options as never);
        }) as typeof fs.writeFileSync,
      },
    }));

    expect(code).toBe(2);
    expect(lines.join("")).toContain(`[FAIL] data_dir=${dataDir} not writable`);
    expect(lines.join("")).toMatch(/Try: CODEX_TEAM_DATA_DIR=.*codex-team doctor/);
  });

  it("fails doctor when local socket listen is denied", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-data-"));
    tempDirs.push(dataDir);
    const packageRoot = createDoctorPackageRoot(tempDirs);
    const { launcherDir } = createLauncherDir(tempDirs);

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
    expect(lines.join("")).toContain("[FAIL] socket_bind EPERM - sandbox forbids listen()");
    expect(lines.join("")).toContain("Hint: no workaround here; this environment cannot host the daemon.");
    expect(lines.join("")).toContain("codex-team version");
    expect(lines.join("")).toContain("=== BROKEN ===");
  });

  it("hints to attach to an existing host daemon when bind is denied but daemon.sock already exists", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-home-"));
    tempDirs.push(homeDir);
    const dataDir = path.join(homeDir, ".codex-team");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "daemon.sock"), "");
    const packageRoot = createDoctorPackageRoot(tempDirs);
    const { launcherDir } = createLauncherDir(tempDirs);
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
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
      expect(lines.join("")).toContain(
        "Hint: a daemon is already running on this host. Set CODEX_TEAM_DAEMON_SOCK=$HOME/.codex-team/daemon.sock and retry.",
      );
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("surfaces socket bind probe setup errors instead of aborting doctor", async () => {
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);

    const result = await checkSocketBind(ctx, makeDeps({
      fs: {
        ...fs,
        mkdirSync: (() => {
          throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
        }) as typeof fs.mkdirSync,
      },
    }));

    expect(result).toMatchObject({
      status: "fail",
      message: expect.stringContaining("socket_bind ENOENT - probe setup failed"),
    });
  });

  it("reports stale pidfiles with the auto-cleanup hint", () => {
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
    expect(result.hint).toContain("auto-cleans stale daemon.pid and daemon.sock");
  });

  it("surfaces daemon socket connect errors with the code and interpretation", async () => {
    const ctx = makeContext();
    tempDirs.push(ctx.dataDir);
    const result = await checkDaemonSocket(ctx, {
      id: "daemon_pid",
      name: "daemon_pid",
      status: "ok",
      message: "daemon running, pid=10",
      detail: "daemon running, pid=10",
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
    tempDirs.push(dataDir);
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-pkg-"));
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-bin-"));
    tempDirs.push(packageRoot, launcherDir);

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

  it("emits structured JSON for doctor --json", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-doctor-data-"));
    tempDirs.push(dataDir);
    const packageRoot = createDoctorPackageRoot(tempDirs);
    const { launcherDir } = createLauncherDir(tempDirs);

    const lines: string[] = [];
    const code = await runDoctor({
      json: true,
      packageRoot,
      dataDir,
      pathEnv: launcherDir,
      write: (line) => { lines.push(line); },
    }, makeDeps());

    expect(code).toBe(0);
    const payload = JSON.parse(lines.join(""));
    expect(payload).toMatchObject({
      ok: true,
      data: {
        verdict: "HEALTHY",
        exit_code: 0,
      },
    });
    expect(payload.data.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "node",
        status: "OK",
        detail: expect.stringContaining("node="),
      }),
      expect.objectContaining({
        name: "launcher_on_path",
        status: "OK",
      }),
    ]));
  });

  it("rejects doctor --short with --json", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await runCli(["doctor", "--short", "--json"]);

    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("\"invalid_params\""));
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("--short and --json are mutually exclusive"));
  });
});
