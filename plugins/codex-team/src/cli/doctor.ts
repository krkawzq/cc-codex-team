import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ConfigStore } from "../daemon/config";
import { isLikelyCodexTeamDaemonProcess } from "../daemon/processes";
import { defaultSockPath, isFilesystemSockPath, normalizeSockPath, pidFilePath } from "../paths";
import { PACKAGE_ROOT } from "../version";

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";
export type DoctorVerdict = "HEALTHY" | "DEGRADED" | "BROKEN";

export interface DoctorCheckResult {
  id: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorPidCheckResult extends DoctorCheckResult {
  daemonState: "running" | "not_running";
  pid: number | null;
}

export interface DoctorContext {
  packageRoot: string;
  dataDir: string;
  sockPath: string;
  pidPath: string;
  launcherPath: string;
  pathEnv: string | undefined;
}

export interface DoctorFs {
  existsSync: typeof fs.existsSync;
  mkdirSync: typeof fs.mkdirSync;
  writeFileSync: typeof fs.writeFileSync;
  unlinkSync: typeof fs.unlinkSync;
  readFileSync: typeof fs.readFileSync;
  statSync: typeof fs.statSync;
  readdirSync: typeof fs.readdirSync;
}

export interface DoctorDeps {
  fs: DoctorFs;
  spawnSync: typeof spawnSync;
  createServer: typeof net.createServer;
  createConnection: typeof net.createConnection;
  kill: typeof process.kill;
  isLikelyCodexTeamDaemonProcess: typeof isLikelyCodexTeamDaemonProcess;
}

export interface RunDoctorOptions {
  short?: boolean;
  write?: (line: string) => void;
  packageRoot?: string;
  dataDir?: string;
  sockPath?: string;
  pathEnv?: string | undefined;
}

const DEFAULT_DEPS: DoctorDeps = {
  fs,
  spawnSync,
  createServer: net.createServer,
  createConnection: net.createConnection,
  kill: process.kill.bind(process),
  isLikelyCodexTeamDaemonProcess,
};

export function buildDoctorContext(options: RunDoctorOptions = {}): DoctorContext {
  const config = new ConfigStore();
  const dataDir = options.dataDir ?? config.resolvedDataDir();
  const sockPath = options.sockPath ?? (options.dataDir ? defaultSockPath(dataDir) : config.resolvedSockPath());
  return {
    packageRoot: options.packageRoot ?? PACKAGE_ROOT,
    dataDir,
    sockPath,
    pidPath: pidFilePath(dataDir),
    launcherPath: path.join(options.packageRoot ?? PACKAGE_ROOT, "bin", "codex-team"),
    pathEnv: options.pathEnv ?? process.env.PATH,
  };
}

export function checkNode(): DoctorCheckResult {
  const version = process.versions.node || "unknown";
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 18) {
    return fail("node", `node version ${version}, need >=18`);
  }
  return ok("node", `node=${version}`);
}

export function checkCodexBin(_ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): DoctorCheckResult {
  const result = deps.spawnSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return fail("codex", "codex binary not found on PATH");
    return fail("codex", `codex --version errored: ${err.message}`);
  }
  if (result.status !== 0) {
    return fail("codex", `codex --version errored: ${formatSpawnFailure(result)}`);
  }
  const version = firstLine(result.stdout) || firstLine(result.stderr) || "unknown";
  return ok("codex", `codex=${version}`);
}

export function checkLauncherOnPath(ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): DoctorCheckResult {
  const resolved = resolveOnPath("codex-team", ctx.pathEnv, deps.fs);
  if (resolved) {
    return ok("path", `codex-team=${resolved}`);
  }
  return warn("path", `codex-team not on PATH; use ${ctx.launcherPath}`);
}

export function checkDataDirWritable(ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): DoctorCheckResult {
  const testPath = path.join(ctx.dataDir, ".doctor-write-test");
  try {
    deps.fs.mkdirSync(ctx.dataDir, { recursive: true });
    deps.fs.writeFileSync(testPath, "ok");
    deps.fs.unlinkSync(testPath);
    return ok("data_dir", `data_dir=${ctx.dataDir} writable`);
  } catch (e) {
    try { deps.fs.unlinkSync(testPath); } catch { /* ignore */ }
    return fail("data_dir", `data_dir not writable: ${ctx.dataDir}`);
  }
}

export async function checkSocketBind(_ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): Promise<DoctorCheckResult> {
  const sockPath = path.join(os.tmpdir(), `ct-doctor-${process.pid}-${Date.now()}.sock`);
  const endpoint = normalizeSockPath(sockPath);
  const server = deps.createServer();
  const cleanup = async () => {
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    if (isFilesystemSockPath(sockPath)) {
      try { deps.fs.unlinkSync(endpoint); } catch { /* ignore */ }
    }
  };

  if (isFilesystemSockPath(sockPath)) {
    try { deps.fs.unlinkSync(endpoint); } catch { /* ignore */ }
  }

  const listenResult = await new Promise<{ ok: true } | { ok: false; error: NodeJS.ErrnoException }>((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      resolve({ ok: false, error });
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({ ok: true });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });

  if (!listenResult.ok) {
    await cleanup();
    const code = listenResult.error.code ?? "UNKNOWN";
    if (code === "EPERM" || code === "EACCES") {
      return fail("socket_bind", `socket_bind ${code} - sandbox forbids listen(); codex-team won't work here`);
    }
    return fail("socket_bind", `socket_bind ${code} - listen() failed: ${listenResult.error.message}`);
  }

  await cleanup();
  return ok("socket_bind", "socket_bind permitted");
}

export function checkDaemonPid(ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): DoctorPidCheckResult {
  const record = readPidRecord(ctx.pidPath, deps.fs);
  if (!record) {
    return {
      ...ok("daemon_pid", "daemon not running (will auto-spawn on first `-b` call)"),
      daemonState: "not_running",
      pid: null,
    };
  }

  const alive = isPidReachable(record.pid, deps.kill);
  const isDaemon = alive && deps.isLikelyCodexTeamDaemonProcess(record.pid);
  if (isDaemon) {
    return {
      ...ok("daemon_pid", `daemon running, pid=${record.pid}`),
      daemonState: "running",
      pid: record.pid,
    };
  }

  const reason = alive
    ? `pid ${record.pid} is not a codex-team daemon`
    : `pid ${record.pid} is not running`;
  return {
    ...warn("daemon_pid", `stale pidfile: ${reason}. Safe to remove manually: \`rm ${ctx.pidPath}\``),
    daemonState: "not_running",
    pid: record.pid,
  };
}

export async function checkDaemonSocket(
  ctx: DoctorContext,
  pidResult: DoctorPidCheckResult,
  deps: DoctorDeps = DEFAULT_DEPS,
): Promise<DoctorCheckResult> {
  if (pidResult.daemonState !== "running") {
    return skip("daemon_socket", "daemon_socket (daemon not running)");
  }

  const result = await connectSockOnce(ctx.sockPath, 2000, deps.createConnection);
  if (result.ok) {
    return ok("daemon_socket", "daemon_socket reachable");
  }

  const code = result.code ?? "UNKNOWN";
  return fail("daemon_socket", `daemon_socket ${code} - ${interpretSocketConnectError(code, result.message)}`);
}

export function checkDistFreshness(ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): DoctorCheckResult {
  const distPath = path.join(ctx.packageRoot, "dist", "main.js");
  const distStat = statIfExists(distPath, deps.fs);
  if (!distStat) {
    return warn("dist", "dist missing; run `npm run build` in plugins/codex-team");
  }

  const sourceNewest = newestMtime(path.join(ctx.packageRoot, "src"), deps.fs);
  if (sourceNewest !== null && sourceNewest > distStat.mtimeMs) {
    return warn("dist", "source newer than dist; run `npm run build` in plugins/codex-team");
  }
  return ok("dist", "dist current");
}

export async function runDoctor(options: RunDoctorOptions = {}, deps: DoctorDeps = DEFAULT_DEPS): Promise<number> {
  const ctx = buildDoctorContext(options);
  const write = options.write ?? ((line: string) => process.stdout.write(line));

  const results: DoctorCheckResult[] = [];
  results.push(checkNode());
  results.push(checkCodexBin(ctx, deps));
  results.push(checkLauncherOnPath(ctx, deps));
  results.push(checkDataDirWritable(ctx, deps));
  results.push(await checkSocketBind(ctx, deps));
  const daemonPid = checkDaemonPid(ctx, deps);
  results.push(daemonPid);
  results.push(await checkDaemonSocket(ctx, daemonPid, deps));
  results.push(checkDistFreshness(ctx, deps));

  const verdict = summarizeVerdict(results);
  if (options.short) {
    const failed = summarizeIds(results, "fail");
    const warned = summarizeIds(results, "warn");
    write(`doctor=${verdict} failed=${failed} warned=${warned}\n`);
    return exitCodeForVerdict(verdict);
  }

  for (const result of results) {
    write(`[${renderStatus(result.status)}] ${result.message}\n`);
  }
  write(`=== ${verdict} ===\n`);
  return exitCodeForVerdict(verdict);
}

export function summarizeVerdict(results: DoctorCheckResult[]): DoctorVerdict {
  if (results.some((result) => result.status === "fail")) return "BROKEN";
  if (results.some((result) => result.status === "warn")) return "DEGRADED";
  return "HEALTHY";
}

function summarizeIds(results: DoctorCheckResult[], status: Extract<DoctorStatus, "fail" | "warn">): string {
  const ids = results.filter((result) => result.status === status).map((result) => result.id);
  return ids.length > 0 ? ids.join(",") : "none";
}

function exitCodeForVerdict(verdict: DoctorVerdict): number {
  if (verdict === "BROKEN") return 2;
  if (verdict === "DEGRADED") return 1;
  return 0;
}

function renderStatus(status: DoctorStatus): "OK" | "WARN" | "FAIL" | "SKIP" {
  switch (status) {
    case "warn":
      return "WARN";
    case "fail":
      return "FAIL";
    case "skip":
      return "SKIP";
    case "ok":
    default:
      return "OK";
  }
}

function ok(id: string, message: string): DoctorCheckResult {
  return { id, status: "ok", message };
}

function warn(id: string, message: string): DoctorCheckResult {
  return { id, status: "warn", message };
}

function fail(id: string, message: string): DoctorCheckResult {
  return { id, status: "fail", message };
}

function skip(id: string, message: string): DoctorCheckResult {
  return { id, status: "skip", message };
}

function resolveOnPath(command: string, pathEnv: string | undefined, doctorFs: DoctorFs): string | null {
  const segments = (pathEnv ?? "").split(path.delimiter).filter(Boolean);
  const candidates = process.platform === "win32"
    ? windowsExecutableCandidates(command)
    : [command];

  for (const segment of segments) {
    for (const candidate of candidates) {
      const target = path.join(segment, candidate);
      try {
        const stat = doctorFs.statSync(target);
        if (!stat.isFile()) continue;
        if (process.platform === "win32" || (stat.mode & 0o111) !== 0) return target;
      } catch {
        // ignore missing entries
      }
    }
  }

  return null;
}

function windowsExecutableCandidates(command: string): string[] {
  const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (/\.[^./\\]+$/.test(command)) return [command];
  return [command, ...pathext.map((ext) => `${command}${ext.toLowerCase()}`), ...pathext.map((ext) => `${command}${ext.toUpperCase()}`)];
}

function readPidRecord(pidPath: string, doctorFs: DoctorFs): { pid: number } | null {
  try {
    const raw = doctorFs.readFileSync(pidPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: Math.floor(parsed.pid) };
  } catch {
    return null;
  }
}

function isPidReachable(pid: number, kill: typeof process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statIfExists(target: string, doctorFs: DoctorFs): fs.Stats | null {
  try {
    return doctorFs.statSync(target);
  } catch {
    return null;
  }
}

function newestMtime(target: string, doctorFs: DoctorFs): number | null {
  const stat = statIfExists(target, doctorFs);
  if (!stat) return null;
  if (!stat.isDirectory()) return stat.mtimeMs;

  let newest: number | null = null;
  let entries: fs.Dirent[];
  try {
    entries = doctorFs.readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const childNewest = newestMtime(path.join(target, entry.name), doctorFs);
    if (childNewest !== null && (newest === null || childNewest > newest)) {
      newest = childNewest;
    }
  }
  return newest;
}

function firstLine(value: string | Buffer | null | undefined): string {
  const text = typeof value === "string" ? value : value ? value.toString("utf8") : "";
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
}

function formatSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  const signal = result.signal ? `signal ${result.signal}` : null;
  const status = typeof result.status === "number" ? `exit ${result.status}` : null;
  const detail = firstLine(result.stderr) || firstLine(result.stdout);
  return [status ?? signal ?? "unknown failure", detail].filter(Boolean).join(": ");
}

function connectSockOnce(
  sockPath: string,
  timeoutMs: number,
  createConnection: typeof net.createConnection,
): Promise<{ ok: true } | { ok: false; code?: string; message: string }> {
  return new Promise((resolve) => {
    const sock = createConnection(normalizeSockPath(sockPath));
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; code?: string; message: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, code: "ETIMEDOUT", message: `connect timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref();

    sock.once("connect", () => finish({ ok: true }));
    sock.once("error", (error: NodeJS.ErrnoException) => {
      finish({ ok: false, code: error.code, message: error.message });
    });
  });
}

function interpretSocketConnectError(code: string, message: string): string {
  switch (code) {
    case "ENOENT":
      return "sock file missing";
    case "ECONNREFUSED":
      return "sock exists but nothing is accepting connections";
    case "EACCES":
    case "EPERM":
      return "permission denied while connecting";
    case "ETIMEDOUT":
      return message;
    default:
      return message || "connect failed";
  }
}

export const __private__ = {
  DEFAULT_DEPS,
  firstLine,
  formatSpawnFailure,
  interpretSocketConnectError,
  newestMtime,
  readPidRecord,
  resolveOnPath,
};
