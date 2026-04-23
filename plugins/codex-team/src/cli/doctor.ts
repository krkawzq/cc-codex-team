import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ConfigStore } from "../daemon/config";
import { isLikelyCodexTeamDaemonProcess } from "../daemon/processes";
import { probeSocketBind } from "../ipc/socket-bind-probe";
import { defaultSockPath, formatPathForEnvHint, normalizeSockPath, pidFilePath } from "../paths";
import { PACKAGE_ROOT } from "../version";

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";
export type DoctorVerdict = "HEALTHY" | "DEGRADED" | "BROKEN";

export interface DoctorCheckResult {
  id: string;
  name: string;
  status: DoctorStatus;
  message: string;
  detail: string;
  hint?: string;
  showHintInText?: boolean;
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
  pluginRoot: string | undefined;
  invokedAs: string | undefined;
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
  json?: boolean;
  write?: (line: string) => void;
  packageRoot?: string;
  dataDir?: string;
  sockPath?: string;
  pathEnv?: string | undefined;
  pluginRoot?: string | undefined;
  invokedAs?: string | undefined;
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
    pluginRoot: options.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT,
    invokedAs: options.invokedAs ?? process.argv[1],
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
    if (err.code === "ENOENT") {
      return fail("codex", "codex binary not found on PATH", {
        name: "codex_binary",
        detail: "codex binary not found on PATH",
      });
    }
    return fail("codex", `codex --version errored: ${err.message}`, {
      name: "codex_binary",
      detail: `codex --version errored: ${err.message}`,
    });
  }
  if (result.status !== 0) {
    return fail("codex", `codex --version errored: ${formatSpawnFailure(result)}`, {
      name: "codex_binary",
      detail: `codex --version errored: ${formatSpawnFailure(result)}`,
    });
  }
  const version = firstLine(result.stdout) || firstLine(result.stderr) || "unknown";
  return ok("codex", `codex=${version}`, {
    name: "codex_binary",
    detail: `codex=${version}`,
  });
}

export function checkLauncherOnPath(ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): DoctorCheckResult {
  const bundledLauncher = resolveBundledPluginLauncher(ctx);
  if (bundledLauncher) {
    return ok("path", `launcher=${bundledLauncher} (plugin mode)`, {
      name: "launcher_on_path",
      detail: `launcher=${bundledLauncher} (plugin mode)`,
    });
  }

  const resolved = resolveOnPath("codex-team", ctx.pathEnv, deps.fs);
  if (resolved) {
    return ok("path", `codex-team=${resolved}`, {
      name: "launcher_on_path",
      detail: `codex-team=${resolved}`,
    });
  }
  return warn("path", `codex-team not on PATH; use ${ctx.launcherPath}`, {
    name: "launcher_on_path",
    detail: "codex-team not on PATH",
    hint: `use ${ctx.launcherPath}`,
  });
}

export function checkDataDirWritable(ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): DoctorCheckResult {
  const testPath = path.join(ctx.dataDir, ".doctor-write-test");
  try {
    deps.fs.mkdirSync(ctx.dataDir, { recursive: true });
    deps.fs.writeFileSync(testPath, "ok");
    deps.fs.unlinkSync(testPath);
    return ok("data_dir", `data_dir=${ctx.dataDir} writable`, {
      name: "data_dir_writable",
      detail: `data_dir=${ctx.dataDir} writable`,
    });
  } catch (e) {
    try { deps.fs.unlinkSync(testPath); } catch { /* ignore */ }
    const error = e as NodeJS.ErrnoException;
    const hint = shouldSuggestWritableTmpDir(error.code)
      ? `Try: CODEX_TEAM_DATA_DIR=${suggestWritableTmpDir()} codex-team doctor`
      : undefined;
    return fail("data_dir", `data_dir=${ctx.dataDir} not writable`, {
      name: "data_dir_writable",
      detail: `${ctx.dataDir} not writable`,
      hint,
      showHintInText: Boolean(hint),
    });
  }
}

export async function checkSocketBind(ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): Promise<DoctorCheckResult> {
  let result: Awaited<ReturnType<typeof probeSocketBind>>;
  try {
    result = await probeSocketBind(ctx.sockPath, {
      fs: deps.fs,
      createServer: deps.createServer,
    });
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    const code = error.code ?? "UNKNOWN";
    return fail("socket_bind", `socket_bind ${code} - probe setup failed: ${error.message}`, {
      name: "socket_bind",
      detail: `socket_bind ${code} - probe setup failed: ${error.message}`,
    });
  }

  if (!result.ok) {
    const code = result.error?.code ?? "UNKNOWN";
    if (code === "EPERM" || code === "EACCES") {
      const existingDaemonSock = findExistingDaemonSockHintPath(ctx, deps.fs);
      const hint = existingDaemonSock
        ? `Hint: a daemon is already running on this host. Set CODEX_TEAM_DAEMON_SOCK=${formatPathForEnvHint(existingDaemonSock)} and retry.`
        : "Hint: no workaround here; this environment cannot host the daemon. Sanity check: run `codex-team version`.";
      return fail("socket_bind", `socket_bind ${code} - sandbox forbids listen()`, {
        name: "socket_bind",
        detail: `socket_bind ${code} - sandbox forbids listen()`,
        hint,
        showHintInText: true,
      });
    }
    return fail("socket_bind", `socket_bind ${code} - listen() failed: ${result.error?.message ?? "unknown error"}`, {
      name: "socket_bind",
      detail: `socket_bind ${code} - listen() failed: ${result.error?.message ?? "unknown error"}`,
    });
  }

  return ok("socket_bind", "socket_bind permitted", {
    name: "socket_bind",
    detail: "socket_bind permitted",
  });
}

export function checkDaemonPid(ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): DoctorPidCheckResult {
  const record = readPidRecord(ctx.pidPath, deps.fs);
  if (!record) {
    return {
      ...ok("daemon_pid", "daemon not running (will auto-spawn on first `-b` call)", {
        name: "daemon_pid",
        detail: "daemon not running (will auto-spawn on first `-b` call)",
      }),
      daemonState: "not_running",
      pid: null,
    };
  }

  const alive = isPidReachable(record.pid, deps.kill);
  const isDaemon = alive && deps.isLikelyCodexTeamDaemonProcess(record.pid);
  if (isDaemon) {
    return {
      ...ok("daemon_pid", `daemon running, pid=${record.pid}`, {
        name: "daemon_pid",
        detail: `daemon running, pid=${record.pid}`,
      }),
      daemonState: "running",
      pid: record.pid,
    };
  }

  const reason = alive
    ? `pid ${record.pid} is not a codex-team daemon`
    : `pid ${record.pid} is not running`;
  return {
    ...warn("daemon_pid", `stale pidfile: ${reason}`, {
      name: "daemon_pid",
      detail: `stale pidfile: ${reason}`,
      hint: "Hint: the next `codex-team -b <token> ...` call auto-cleans stale daemon.pid and daemon.sock when needed; no manual `rm` is required.",
      showHintInText: true,
    }),
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
    return skip("daemon_socket", "daemon_socket (daemon not running)", {
      name: "daemon_socket",
      detail: "daemon_socket (daemon not running)",
    });
  }

  const result = await connectSockOnce(ctx.sockPath, 2000, deps.createConnection);
  if (result.ok) {
    return ok("daemon_socket", "daemon_socket reachable", {
      name: "daemon_socket",
      detail: "daemon_socket reachable",
    });
  }

  const code = result.code ?? "UNKNOWN";
  return fail("daemon_socket", `daemon_socket ${code} - ${interpretSocketConnectError(code, result.message)}`, {
    name: "daemon_socket",
    detail: `daemon_socket ${code} - ${interpretSocketConnectError(code, result.message)}`,
  });
}

export function checkDistFreshness(ctx: DoctorContext, deps: DoctorDeps = DEFAULT_DEPS): DoctorCheckResult {
  const distPath = path.join(ctx.packageRoot, "dist", "main.js");
  const distStat = statIfExists(distPath, deps.fs);
  if (!distStat) {
    return warn("dist", "dist missing; run `npm run build` in plugins/codex-team", {
      name: "dist_freshness",
      detail: "dist missing",
      hint: "run `npm run build` in plugins/codex-team",
    });
  }

  const sourceNewest = newestMtime(path.join(ctx.packageRoot, "src"), deps.fs);
  if (sourceNewest !== null && sourceNewest > distStat.mtimeMs) {
    return warn("dist", "source newer than dist; run `npm run build` in plugins/codex-team", {
      name: "dist_freshness",
      detail: "source newer than dist",
      hint: "run `npm run build` in plugins/codex-team",
    });
  }
  return ok("dist", "dist current", {
    name: "dist_freshness",
    detail: "dist current",
  });
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

  if (options.json) {
    write(`${JSON.stringify({
      verdict,
      checks: results.map((result) => ({
        name: result.name,
        status: renderStatus(result.status),
        detail: result.detail,
        ...(result.hint ? { hint: result.hint } : {}),
      })),
      exit_code: exitCodeForVerdict(verdict),
    })}\n`);
    return exitCodeForVerdict(verdict);
  }

  for (const result of results) {
    write(`[${renderStatus(result.status)}] ${result.message}\n`);
    if (result.showHintInText && result.hint) {
      write(`       ${result.hint}\n`);
    }
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

function ok(
  id: string,
  message: string,
  options: { name?: string; detail?: string; hint?: string; showHintInText?: boolean } = {},
): DoctorCheckResult {
  return {
    id,
    name: options.name ?? id,
    status: "ok",
    message,
    detail: options.detail ?? message,
    hint: options.hint,
    showHintInText: options.showHintInText,
  };
}

function warn(
  id: string,
  message: string,
  options: { name?: string; detail?: string; hint?: string; showHintInText?: boolean } = {},
): DoctorCheckResult {
  return {
    id,
    name: options.name ?? id,
    status: "warn",
    message,
    detail: options.detail ?? message,
    hint: options.hint,
    showHintInText: options.showHintInText,
  };
}

function fail(
  id: string,
  message: string,
  options: { name?: string; detail?: string; hint?: string; showHintInText?: boolean } = {},
): DoctorCheckResult {
  return {
    id,
    name: options.name ?? id,
    status: "fail",
    message,
    detail: options.detail ?? message,
    hint: options.hint,
    showHintInText: options.showHintInText,
  };
}

function skip(
  id: string,
  message: string,
  options: { name?: string; detail?: string; hint?: string; showHintInText?: boolean } = {},
): DoctorCheckResult {
  return {
    id,
    name: options.name ?? id,
    status: "skip",
    message,
    detail: options.detail ?? message,
    hint: options.hint,
    showHintInText: options.showHintInText,
  };
}

function resolveBundledPluginLauncher(ctx: DoctorContext): string | null {
  if (!ctx.invokedAs) return null;
  const invokedAs = path.resolve(ctx.invokedAs);
  const candidates = new Set<string>();
  candidates.add(path.join(path.resolve(ctx.packageRoot), "bin", "codex-team"));
  if (ctx.pluginRoot) {
    const pluginRoot = path.resolve(ctx.pluginRoot);
    candidates.add(path.join(pluginRoot, "bin", "codex-team"));
    candidates.add(path.join(pluginRoot, "plugins", "codex-team", "bin", "codex-team"));
  }

  return candidates.has(invokedAs) ? invokedAs : null;
}

function findExistingDaemonSockHintPath(ctx: DoctorContext, doctorFs: DoctorFs): string | null {
  const candidate = path.join(ctx.dataDir, "daemon.sock");
  try {
    if (doctorFs.existsSync(candidate)) return candidate;
  } catch {
    // ignore broken filesystem probes
  }

  return null;
}

function shouldSuggestWritableTmpDir(code: string | undefined): boolean {
  return code === "EROFS" || code === "EACCES" || code === "ENOENT";
}

function suggestWritableTmpDir(): string {
  const baseTmp = process.env.TMPDIR?.trim() || os.tmpdir();
  const userLabel = typeof process.getuid === "function"
    ? String(process.getuid())
    : process.env.USER?.trim() || process.env.USERNAME?.trim() || "data";
  return path.join(baseTmp, `codex-team-${userLabel}`);
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
