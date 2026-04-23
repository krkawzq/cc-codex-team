import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type net from "node:net";

import { connectSock, probeSock, writeMessage, onMessages } from "../ipc/sock";
import type { IpcMessage, IpcRequest } from "../ipc/protocol";
import {
  clientOnlyDaemonSock,
  defaultSockPath,
  formatPathForEnvHint,
  isFilesystemSockPath,
  normalizeSockPath,
  pidFilePath,
  warnLegacyWindowsDataDir,
} from "../paths";
import { parseArgs, commandKey, supportsShort, type ParsedArgs } from "./args";
import { renderHelp } from "./help";
import { err } from "../result";
import { ConfigStore } from "../daemon/config";
import { validateApprovalAction } from "./approval-validation";
import { VERSION } from "../version";
import { formatShort } from "../format/short";
import { formatCompact } from "../format/compact";
import { runDoctor } from "./doctor";
import { BUILTIN_PROFILES, findProfile, renderSessionNewCommand } from "../profiles/builtin";

const DAEMON_POLL_INTERVAL_MS = 100;
const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15000;
const DEFAULT_DAEMON_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_DAEMON_CONNECT_RETRY_ATTEMPTS = 3;
const DEFAULT_DAEMON_CONNECT_RETRY_DELAY_MS = 250;
const DEFAULT_CLI_STDOUT_MAX_BYTES = 4 * 1024 * 1024;
const DAEMON_STDERR_FLAG = "--stderr-to";
const DOCTOR_SUGGESTED_ACTION = "run `codex-team doctor` to diagnose";
const SOCKET_BIND_DENIED_SUGGESTED_ACTION =
  "codex-team cannot bind a local IPC socket here — run `codex-team doctor` for details";
const DATA_DIR_NOT_WRITABLE_SUGGESTED_ACTION =
  "set CODEX_TEAM_DATA_DIR to a writable path and retry, e.g. CODEX_TEAM_DATA_DIR=/tmp/codex-team-$USER. Run `codex-team doctor` to verify.";

interface CachedBootstrapFailure {
  sockPath: string;
  code: "daemon_unreachable" | "socket_bind_denied";
  message: string;
  data?: Record<string, unknown>;
}

let cachedBootstrapFailure: CachedBootstrapFailure | null = null;

export async function readStdinAll(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.once("end", () => resolve(buf));
    process.stdin.once("error", reject);
  });
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.unknown) {
    process.stdout.write(JSON.stringify(err("invalid_params", parsed.unknown)) + "\n");
    return 1;
  }

  if (parsed.help || parsed.commandPath.length === 0) {
    process.stdout.write(renderHelp(parsed.commandPath));
    return 0;
  }

  const method = commandKey(parsed.commandPath);
  if (method !== "doctor") {
    warnLegacyWindowsDataDir((warning) => {
      process.stderr.write(warning.message + "\n");
    });
  }
  const effectiveMethod = resolveMethod(method, parsed);
  if (method === "profiles") {
    process.stdout.write(renderHelp(parsed.commandPath));
    return 0;
  }
  const short = truthy(parsed.flags.short);
  const json = method === "doctor" && parsed.flags.json !== undefined;
  const format = flagString(parsed.flags.format);
  if (short && !supportsShort(effectiveMethod)) {
    process.stdout.write(JSON.stringify(err("invalid_params", `--short is not supported for '${method}'`)) + "\n");
    return 1;
  }
  if (method === "doctor" && short && json) {
    process.stdout.write(JSON.stringify(err("invalid_params", "--short and --json are mutually exclusive")) + "\n");
    return 1;
  }
  if (method === "doctor" && truthy(parsed.flags.full)) {
    process.stdout.write(JSON.stringify(err("invalid_params", `--full is not supported for '${method}'`)) + "\n");
    return 1;
  }
  if (short && (format === "markdown" || format === "table")) {
    process.stdout.write(JSON.stringify(err("invalid_params", "--short cannot be used with --format markdown or --format table")) + "\n");
    return 1;
  }
  const clientOnlySockPath = parsed.daemonSock || clientOnlyDaemonSock();
  const sockPath = clientOnlySockPath || defaultSockPath();

  if (method === "doctor") {
    return await runDoctor({ short, json, sockPath });
  }

  if (method === "version") {
    return await runVersion(sockPath, truthy(parsed.flags.full));
  }

  if (isBuiltinProfilesMethod(method)) {
    return runBuiltinProfiles(method, parsed);
  }

  const needsBearer = !isDaemonLevel(effectiveMethod);
  if (needsBearer && !parsed.bearer) {
    process.stdout.write(
      JSON.stringify(err("invalid_params", `bearer token required for '${method}'; pass -b <token>`)) + "\n",
    );
    return 1;
  }

  const cliValidationError = validateCliFlags(parsed, method, effectiveMethod);
  if (cliValidationError) {
    process.stdout.write(JSON.stringify(err("invalid_params", cliValidationError)) + "\n");
    return 1;
  }

  const approvalValidationError = validateApprovalHint(method, parsed);
  if (approvalValidationError) {
    process.stdout.write(JSON.stringify(err("invalid_decision", approvalValidationError)) + "\n");
    return 1;
  }

  const cwdPreflightError = validateCliCwdPreflight(method, parsed);
  if (cwdPreflightError) {
    process.stdout.write(JSON.stringify(err("invalid_params", cwdPreflightError)) + "\n");
    return 1;
  }
  canonicalizeCliCwdFlag(parsed);

  if (needsBearer && !clientOnlySockPath) {
    const cachedFailure = getCachedBootstrapFailure(sockPath);
    if (cachedFailure) {
      process.stdout.write(JSON.stringify(err(cachedFailure.code, cachedFailure.message, cachedFailure.data)) + "\n");
      return 1;
    }
  }

  const ready = await ensureDaemon(sockPath, { clientOnly: Boolean(clientOnlySockPath) });
  if (!ready.ok) {
    if (needsBearer && !clientOnlySockPath) {
      cacheBootstrapFailure(sockPath, ready);
    }
    process.stdout.write(JSON.stringify(err(ready.code, ready.message, ready.data)) + "\n");
    return 1;
  }

  return await dispatchCommand(sockPath, parsed, effectiveMethod);
}

function isDaemonLevel(method: string): boolean {
  return method === "version" || method === "daemon:status" || method.startsWith("daemon:");
}

function validateApprovalHint(method: string, parsed: ParsedArgs): string | null {
  if (method !== "message:approval") return null;
  const kindHint = asStringFlag(parsed.flags.kind);
  const action = parsed.positionals[2];
  if (!kindHint || typeof action !== "string" || action.length === 0) return null;
  const validation = validateApprovalAction(kindHint, action);
  return validation.ok ? null : validation.message;
}

async function runVersion(sockPath: string, full: boolean): Promise<number> {
  const cliVersion = getCliVersion();
  const alive = await probeSock(sockPath, 200);
  const cliConfig = readCliConfig();
  let daemonVersion: string | null = null;
  if (alive) {
    try {
      const resp = await requestOnceWithRetry(sockPath, { method: "version", bearer: null, params: {} }, cliConfig, true);
      if ("result" in resp && resp.result && typeof resp.result === "object") {
        const d = resp.result as { daemon_version?: string };
        daemonVersion = d.daemon_version || null;
      }
    } catch {
      // ignore
    }
  }
  process.stdout.write(
    renderJsonResult({ cli_version: cliVersion, daemon_version: daemonVersion }, full),
  );
  return 0;
}

async function dispatchCommand(sockPath: string, parsed: ParsedArgs, method: string): Promise<number> {
  const cliConfig = readCliConfig();
  const needsStreaming =
    method === "monitor:events" ||
    method === "session:events" ||
    method === "monitor:alarm" ||
    method === "daemon:logs" ||
    (method === "session:logs" && truthy(parsed.flags["follow"] ?? parsed.flags["f"])) ||
    (method === "message:tail" && truthy(parsed.flags["follow"] ?? parsed.flags["f"]));

  // Forward stdin if caller used --stdin
  if (truthy(parsed.flags["stdin"]) && !("stdin_content" in parsed.flags)) {
    try {
      const content = await readStdinAll();
      parsed.flags["stdin_content"] = content;
    } catch (e) {
      process.stdout.write(
        JSON.stringify(err("invalid_params", `failed to read stdin: ${(e as Error).message}`)) + "\n",
      );
      return 1;
    }
  }

  if (needsStreaming) {
    const sock = await connectSockWithRetry(sockPath, cliConfig.connectTimeoutMs, cliConfig.connectRetryAttempts, cliConfig.connectRetryDelayMs);
    return await runStream(sock, parsed, method);
  }

  try {
    const params: Record<string, unknown> = {
      positionals: parsed.positionals,
      flags: parsed.flags,
    };
    const stdinContent = parsed.flags["stdin_content"];
    if (typeof stdinContent === "string") params.stdin_content = stdinContent;
    const resp = await requestOnceWithRetry(sockPath, {
      method,
      bearer: parsed.bearer,
      params,
    }, cliConfig, isReadOnlyMethod(method));
    if ("error" in resp && resp.error) {
      process.stdout.write(forwardDaemonError(resp.error));
      return 1;
    }
    if (truthy(parsed.flags.short)) {
      process.stdout.write(formatShort(method, resp.result) + "\n");
      return 0;
    }
    const markdown = extractMarkdownResult(resp.result, parsed.flags.format);
    if (markdown !== null) {
      process.stdout.write(markdown + "\n");
      return exitCodeForResult(method, resp.result);
    }
    const rendered = truthy(parsed.flags.full) ? resp.result : formatCompact(method, resp.result);
    process.stdout.write(renderJsonResult(rendered, truthy(parsed.flags.full)));
    return exitCodeForResult(method, resp.result);
  } catch (e) {
    process.stdout.write(
      JSON.stringify(err("internal", (e as Error).message ?? "rpc failed")) + "\n",
    );
    return 1;
  }
}

function exitCodeForResult(method: string, result: unknown): number {
  if (!result || typeof result !== "object") return 0;

  if (method === "message:send-many" || method === "session:detach") {
    const results = (result as Record<string, unknown>).results;
    if (Array.isArray(results) && results.some((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).ok === false)) {
      return 1;
    }
    return 0;
  }

  if (method !== "message:wait") return 0;
  const value = result as Record<string, unknown>;
  const outcomes = Array.isArray(value.outcomes)
    ? value.outcomes
        .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).outcome : null)
        .filter((entry): entry is string => typeof entry === "string")
    : [];
  if (outcomes.length > 0) {
    if (outcomes.includes("error") || outcomes.includes("interrupted")) return 1;
    if (outcomes.includes("timeout")) return 124;
    return 0;
  }

  const outcome = value.outcome;
  if (outcome === "error" || outcome === "interrupted") return 1;
  if (outcome === "timeout") return 124;
  return 0;
}

async function runStream(sock: net.Socket, parsed: ParsedArgs, method: string): Promise<number> {
  return await new Promise<number>((resolve) => {
    let finished = false;
    const stdoutQueue: Array<{ line: string; bytes: number; afterWrite?: () => void }> = [];
    const pendingFinalizers: Array<() => void> = [];
    const stdoutMaxBytes = readCliStdoutMaxBytes();
    const stdoutResumeBytes = Math.max(1, Math.floor(stdoutMaxBytes / 2));
    let stdoutBlocked = false;
    let socketPaused = false;
    let queuePaused = false;
    let stdoutQueueBytes = 0;
    let parserControl: { resume(): void } | null = null;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      process.off("SIGBREAK", onInterrupt);
      resolve(code);
    };
    const pauseSocket = () => {
      if (socketPaused || typeof sock.pause !== "function") return;
      socketPaused = true;
      sock.pause();
    };
    const maybeResumeSocket = () => {
      if (!socketPaused || stdoutBlocked || queuePaused) return;
      socketPaused = false;
      if (typeof sock.resume === "function") sock.resume();
    };
    const maybeResumeParser = () => {
      if (!queuePaused || stdoutBlocked || stdoutQueueBytes >= stdoutResumeBytes) return;
      queuePaused = false;
      maybeResumeSocket();
      parserControl?.resume();
    };
    const flushFinalizers = () => {
      if (stdoutBlocked || stdoutQueue.length > 0) return;
      while (pendingFinalizers.length > 0) pendingFinalizers.shift()?.();
    };
    const flushStdout = () => {
      if (stdoutBlocked) return;
      while (stdoutQueue.length > 0) {
        const next = stdoutQueue[0]!;
        const ok = process.stdout.write(next.line);
        if (!ok) {
          stdoutBlocked = true;
          pauseSocket();
          process.stdout.once("drain", () => {
            stdoutBlocked = false;
            const flushed = stdoutQueue.shift();
            stdoutQueueBytes = Math.max(0, stdoutQueueBytes - (flushed?.bytes ?? 0));
            flushed?.afterWrite?.();
            maybeResumeParser();
            flushStdout();
            flushFinalizers();
          });
          return;
        }
        stdoutQueue.shift();
        stdoutQueueBytes = Math.max(0, stdoutQueueBytes - next.bytes);
        next.afterWrite?.();
      }
      maybeResumeParser();
      maybeResumeSocket();
      flushFinalizers();
    };
    const writeStdout = (line: string, afterWrite?: () => void): boolean => {
      const bytes = Buffer.byteLength(line);
      stdoutQueue.push({ line, bytes, afterWrite });
      stdoutQueueBytes += bytes;
      let shouldContinueParsing = true;
      if (stdoutQueueBytes > stdoutMaxBytes) {
        queuePaused = true;
        shouldContinueParsing = false;
        pauseSocket();
        queueMicrotask(() => {
          maybeResumeParser();
        });
      }
      flushStdout();
      return shouldContinueParsing;
    };
    const afterStdout = (cb: () => void) => {
      pendingFinalizers.push(cb);
      flushFinalizers();
    };
    const reqId = randomId();
    const params: Record<string, unknown> = {
      positionals: parsed.positionals,
      flags: parsed.flags,
      streaming: true,
    };
    const stdinContent = parsed.flags["stdin_content"];
    if (typeof stdinContent === "string") params.stdin_content = stdinContent;
    const req: IpcRequest = {
      kind: "request",
      id: reqId,
      method,
      bearer: parsed.bearer ?? undefined,
      params,
    };

    parserControl = onMessages(sock, (msg) => {
      if (msg.kind === "stream_chunk" && msg.id === reqId) {
        const ackAfterWrite = createStreamAckCallback(method, sock, reqId, msg.data);
        const markdown = extractMarkdownResult(msg.data, parsed.flags.format);
        if (truthy(parsed.flags.short)) {
          return writeStdout(formatShort(method, msg.data) + "\n", ackAfterWrite);
        } else if (markdown !== null) {
          return writeStdout(markdown + "\n", ackAfterWrite);
        } else {
          const rendered = truthy(parsed.flags.full) ? msg.data : formatCompact(method, msg.data);
          return writeStdout(renderJsonResult(rendered, truthy(parsed.flags.full)), ackAfterWrite);
        }
      } else if (msg.kind === "stream_end" && msg.id === reqId) {
        if (msg.error) {
          writeStdout(forwardDaemonError(msg.error), () => {
            finish(1);
            sock.end();
          });
        } else {
          afterStdout(() => {
            finish(0);
            sock.end();
          });
        }
      } else if (msg.kind === "response" && msg.id === reqId) {
        if (msg.error) {
          writeStdout(forwardDaemonError(msg.error), () => {
            finish(1);
            sock.end();
          });
        } else {
          afterStdout(() => {
            finish(0);
            sock.end();
          });
        }
      }
    }, () => {
      finish(finished ? 0 : 1);
    });

    const onInterrupt = () => {
      sock.end();
      finish(130);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    if (process.platform === "win32") process.once("SIGBREAK", onInterrupt);

    writeMessage(sock, req);
  });
}

interface OneShotOpts {
  method: string;
  bearer: string | null;
  params: Record<string, unknown>;
}

function requestOnce(sock: net.Socket, opts: OneShotOpts): Promise<{ id: string; result?: unknown; error?: { code: string; message: string; data?: unknown } }> {
  return new Promise((resolve, reject) => {
    const id = randomId();
    const req: IpcRequest = {
      kind: "request",
      id,
      method: opts.method,
      bearer: opts.bearer ?? undefined,
      params: opts.params,
    };
    let resolved = false;
    onMessages(sock, (msg: IpcMessage) => {
      if (resolved) return;
      if (msg.kind === "response" && msg.id === id) {
        resolved = true;
        resolve({ id: msg.id, result: msg.result, error: msg.error });
      }
    }, () => {
      if (!resolved) reject(new Error("daemon closed connection"));
    });
    sock.once("error", (e) => {
      if (!resolved) reject(e);
    });
    writeMessage(sock, req);
  });
}

async function requestOnceWithRetry(
  sockPath: string,
  opts: OneShotOpts,
  cliConfig: ReturnType<typeof readCliConfig>,
  allowRetry: boolean,
): Promise<{ id: string; result?: unknown; error?: { code: string; message: string; data?: unknown } }> {
  let attempt = 0;
  let lastError: Error | null = null;
  while (attempt < cliConfig.connectRetryAttempts) {
    attempt++;
    let sock: net.Socket | null = null;
    try {
      sock = await connectSock(sockPath, cliConfig.connectTimeoutMs);
      const resp = await requestOnce(sock, opts);
      sock.end();
      return resp;
    } catch (e) {
      lastError = e as Error;
      if (sock) sock.destroy();
      if (!allowRetry || !isTransientRequestError(lastError) || attempt >= cliConfig.connectRetryAttempts) {
        throw lastError;
      }
      await sleep(cliConfig.connectRetryDelayMs);
    }
  }
  throw lastError ?? new Error("request failed");
}

interface EnsureDaemonResult {
  ok: boolean;
  code: string;
  message: string;
  data?: unknown;
}

async function ensureDaemon(sockPath: string, options: { clientOnly?: boolean } = {}): Promise<EnsureDaemonResult> {
  const cliConfig = readCliConfig();
  if (options.clientOnly) {
    return await ensureClientOnlyDaemon(sockPath, cliConfig);
  }

  const config = new ConfigStore();
  const dataDir = config.resolvedDataDir();
  const pidPath = pidFilePath(dataDir);
  const stderrPath = daemonSpawnStderrPath(dataDir);
  if (await probeSock(sockPath, 200)) {
    return { ok: true, code: "", message: "" };
  }

  const staleState = detectStaleDaemonArtifacts(sockPath, pidPath);
  if (staleState) {
    // Pid is confirmed dead (detectStaleDaemonArtifacts verified isPidAlive is false).
    // Auto-clean the stale artefacts and proceed to spawn a fresh daemon — don't
    // require manual intervention for an obviously recoverable state. Log a notice
    // to stderr for visibility.
    process.stderr.write(
      `[codex-team] auto-cleanup: removed stale daemon.pid (pid ${staleState.pid} not running) + stale daemon.sock at ${staleState.sockPath}\n`,
    );
    try { fs.unlinkSync(pidPath); } catch { /* already gone */ }
    try { fs.unlinkSync(staleState.sockPath); } catch { /* already gone */ }
  }

  const dataDirFailure = validateDaemonDataDirWritable(dataDir);
  if (dataDirFailure) return dataDirFailure;

  try {
    const child = spawnDaemon();
    const firstAttempt = await waitForDaemonReady(sockPath, child, cliConfig.readyTimeoutMs);
    if (firstAttempt.ready) {
      return { ok: true, code: "", message: "" };
    }
  } catch (e) {
    return buildSpawnFailure(dataDir, sockPath, e, false);
  }

  try {
    const child = spawnDaemon(stderrPath);
    const secondAttempt = await waitForDaemonReady(sockPath, child, cliConfig.readyTimeoutMs);
    if (secondAttempt.ready) {
      return { ok: true, code: "", message: "" };
    }
    if (secondAttempt.exited) {
      return buildEarlyExitFailure(sockPath, stderrPath, secondAttempt);
    }
  } catch (e) {
    return buildSpawnFailure(dataDir, sockPath, e, true);
  }

  const stderrTail = readTail(stderrPath, 4096);
  const parsedBootstrap = parseBootstrapStderr(stderrTail);
  if (parsedBootstrap?.code === "socket_bind_denied") {
    return buildSocketBindDeniedFailure(sockPath, parsedBootstrap, stderrTail);
  }

  return {
    ok: false,
    code: "daemon_unreachable",
    message: `daemon failed to start within ${formatDuration(cliConfig.readyTimeoutMs)}. See ${stderrPath} for details`,
    data: withDaemonSockHint(buildDaemonUnreachableData(stderrPath, stderrTail), sockPath),
  };
}

async function ensureClientOnlyDaemon(
  sockPath: string,
  cliConfig: ReturnType<typeof readCliConfig>,
): Promise<EnsureDaemonResult> {
  try {
    const sock = await connectSockWithRetry(
      sockPath,
      cliConfig.connectTimeoutMs,
      cliConfig.connectRetryAttempts,
      cliConfig.connectRetryDelayMs,
    );
    sock.end();
    return { ok: true, code: "", message: "" };
  } catch (error) {
    return buildClientOnlyConnectFailure(sockPath, error);
  }
}

async function connectSockWithRetry(
  sockPath: string,
  timeoutMs: number,
  retryAttempts: number,
  retryDelayMs: number,
): Promise<net.Socket> {
  let attempt = 0;
  let lastError: Error | null = null;
  while (attempt < retryAttempts) {
    attempt++;
    try {
      return await connectSock(sockPath, timeoutMs);
    } catch (e) {
      const err = e as Error & { code?: string };
      lastError = err;
      if (!isTransientConnectError(err) || attempt >= retryAttempts) break;
      await sleep(retryDelayMs);
    }
  }
  throw lastError ?? new Error("connect failed");
}

interface WaitForDaemonReadyResult {
  ready: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

async function waitForDaemonReady(
  sockPath: string,
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<WaitForDaemonReadyResult> {
  let exited = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const onExit = (code: number | null, nextSignal: NodeJS.Signals | null) => {
    exited = true;
    exitCode = code;
    signal = nextSignal;
  };

  child.once("exit", onExit);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await sleep(DAEMON_POLL_INTERVAL_MS);
      if (await probeSock(sockPath, 200)) return { ready: true, exited, exitCode, signal };
      if (exited) return { ready: false, exited, exitCode, signal };
    }
  } finally {
    if (typeof child.off === "function") child.off("exit", onExit);
    else if (typeof child.removeListener === "function") child.removeListener("exit", onExit);
  }
  return { ready: false, exited, exitCode, signal };
}

function spawnDaemon(stderrPath?: string): ReturnType<typeof spawn> {
  const args = [process.argv[1], "--daemon-internal"];
  let stderrFd: number | null = null;

  try {
    if (stderrPath) {
      fs.mkdirSync(path.dirname(stderrPath), { recursive: true });
      stderrFd = fs.openSync(stderrPath, "w");
      args.push(DAEMON_STDERR_FLAG, stderrPath);
    }

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: stderrFd === null ? "ignore" : ["ignore", "ignore", stderrFd],
      env: process.env,
      windowsHide: true,
    });
    child.unref();
    return child;
  } finally {
    if (stderrFd !== null) fs.closeSync(stderrFd);
  }
}

function getCliVersion(): string {
  return VERSION;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function daemonSpawnStderrPath(dataDir: string): string {
  return path.join(dataDir, "daemon-spawn.stderr");
}

function detectStaleDaemonArtifacts(sockPath: string, pidPath: string): { pid: number; sockPath: string } | null {
  const pidRecord = readPidFile(pidPath);
  if (!pidRecord) return null;
  if (isPidAlive(pidRecord.pid)) return null;
  if (!isFilesystemSockPath(sockPath)) return null;

  const normalizedSockPath = normalizeSockPath(sockPath);
  if (!fs.existsSync(normalizedSockPath)) return null;
  return {
    pid: pidRecord.pid,
    sockPath: normalizedSockPath,
  };
}

function readPidFile(targetPath: string): { pid: number } | null {
  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: Math.floor(parsed.pid) };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface BootstrapPayload {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

function buildSocketBindDeniedFailure(
  sockPath: string,
  parsedBootstrap: BootstrapPayload,
  stderrTail: string | null,
): EnsureDaemonResult {
  return {
    ok: false,
    code: parsedBootstrap.code,
    message: parsedBootstrap.message,
    data: withDaemonSockHint({
      ...(parsedBootstrap.data ?? {}),
      ...(stderrTail ? { bootstrap_stderr: stderrTail } : {}),
    }, sockPath),
  };
}

function buildDaemonUnreachableData(
  stderrPath: string,
  stderrTail: string | null,
  result?: WaitForDaemonReadyResult,
): Record<string, unknown> {
  return {
    stderr_path: stderrPath,
    ...(typeof result?.exitCode === "number" ? { exit_code: result.exitCode } : {}),
    ...(result?.signal ? { signal: result.signal } : {}),
    ...(stderrTail ? { bootstrap_stderr: stderrTail } : {}),
    suggested_action: DOCTOR_SUGGESTED_ACTION,
  };
}

function buildEarlyExitFailure(sockPath: string, stderrPath: string, result: WaitForDaemonReadyResult): EnsureDaemonResult {
  const stderrTail = readTail(stderrPath, 4096);
  const parsedBootstrap = parseBootstrapStderr(stderrTail);
  if (parsedBootstrap?.code === "socket_bind_denied") {
    return buildSocketBindDeniedFailure(sockPath, parsedBootstrap, stderrTail);
  }

  return {
    ok: false,
    code: "daemon_unreachable",
    message: parsedBootstrap?.message ?? "daemon exited before becoming ready",
    data: withDaemonSockHint(buildDaemonUnreachableData(stderrPath, stderrTail, result), sockPath),
  };
}

function readTail(filePath: string, maxBytes: number): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (raw.length <= maxBytes) return raw.trim();
    return raw.slice(-maxBytes).trim();
  } catch {
    return null;
  }
}

function parseBootstrapStderr(stderrTail: string | null): BootstrapPayload | null {
  if (!stderrTail) return null;
  const prefix = "[codex-team-daemon-bootstrap] ";
  const lines = stderrTail.split(/\r?\n/).reverse();
  for (const line of lines) {
    const socketBindDenied = parseSocketBindDeniedLine(line);
    if (socketBindDenied) return socketBindDenied;
    if (!line.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(line.slice(prefix.length)) as {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      };
      if (typeof parsed.code !== "string" || typeof parsed.message !== "string") continue;
      return {
        code: parsed.code,
        message: parsed.message,
        data: parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
          ? parsed.data as Record<string, unknown>
          : undefined,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function parseSocketBindDeniedLine(line: string): BootstrapPayload | null {
  try {
    const parsed = JSON.parse(line) as {
      kind?: unknown;
      errno?: unknown;
      probed_path?: unknown;
    };
    if (parsed.kind !== "socket_bind_denied") return null;

    const errno = typeof parsed.errno === "string" && parsed.errno.length > 0
      ? parsed.errno
      : "UNKNOWN";
    return {
      code: "socket_bind_denied",
      message: `local socket bind denied by environment (${errno})`,
      data: {
        suggested_action: SOCKET_BIND_DENIED_SUGGESTED_ACTION,
        errno,
        ...(typeof parsed.probed_path === "string" && parsed.probed_path.length > 0
          ? { probed_path: parsed.probed_path }
          : {}),
      },
    };
  } catch {
    return null;
  }
}

function validateCliCwdPreflight(method: string, parsed: ParsedArgs): string | null {
  if (method !== "session:new" && method !== "session:fork" && method !== "session:heal") return null;
  const cwd = asStringFlag(parsed.flags.cwd);
  if (!cwd) return null;
  return validateRequestedCwd(cwd);
}

function validateRequestedCwd(rawCwd: string): string | null {
  if (!fs.existsSync(rawCwd)) {
    return `cwd '${rawCwd}' does not exist`;
  }

  try {
    const stat = fs.statSync(rawCwd);
    if (!stat.isDirectory()) {
      return `cwd '${rawCwd}' is not a directory`;
    }
  } catch (error) {
    return `cwd '${rawCwd}' could not be inspected: ${(error as Error).message}`;
  }

  return null;
}

function canonicalizeCliCwdFlag(parsed: ParsedArgs): void {
  const cwd = asStringFlag(parsed.flags.cwd);
  if (!cwd) return;
  parsed.flags.cwd = path.normalize(path.resolve(cwd));
}

function validateDaemonDataDirWritable(dataDir: string): EnsureDaemonResult | null {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    return null;
  } catch (error) {
    return buildDataDirNotWritableFailure(dataDir, error);
  }
}

function buildSpawnFailure(
  dataDir: string,
  sockPath: string,
  error: unknown,
  withStderrCapture: boolean,
): EnsureDaemonResult {
  const errorWithCode = error as Error & { code?: string };
  const errno = normalizeErrno(errorWithCode.code);
  if (errno && isDataDirWriteErrno(errno)) {
    const dataDirFailure = validateDaemonDataDirWritable(dataDir);
    if (dataDirFailure) return dataDirFailure;
  }

  return {
    ok: false,
    code: "daemon_unreachable",
    message: `failed to spawn daemon${withStderrCapture ? " with stderr capture" : ""}: ${errorWithCode.message}`,
    data: withDaemonSockHint({
      suggested_action: DOCTOR_SUGGESTED_ACTION,
    }, sockPath),
  };
}

function buildDataDirNotWritableFailure(
  dataDir: string,
  error: unknown,
): EnsureDaemonResult | null {
  const errno = extractErrno(error);
  if (!errno || !isDataDirWriteErrno(errno)) return null;
  return {
    ok: false,
    code: "data_dir_not_writable",
    message: `daemon data_dir is not writable: ${dataDir} (${errno})`,
    data: {
      data_dir: dataDir,
      errno,
      suggested_action: DATA_DIR_NOT_WRITABLE_SUGGESTED_ACTION,
    },
  };
}

function buildClientOnlyConnectFailure(sockPath: string, error: unknown): EnsureDaemonResult {
  const errorWithCode = error as Error & { code?: string };
  const errno = normalizeErrno(errorWithCode.code);
  return {
    ok: false,
    code: "daemon_unreachable",
    message: `failed to connect to daemon at ${sockPath}: ${errorWithCode.message || "connect failed"}`,
    data: withDaemonSockHint({
      sock_path: sockPath,
      ...(errno ? { errno } : {}),
    }, sockPath),
  };
}

function extractErrno(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  return normalizeErrno((error as { code?: unknown }).code);
}

function normalizeErrno(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isDataDirWriteErrno(errno: string): boolean {
  return errno === "EACCES" || errno === "ENOENT" || errno === "EROFS";
}

function cacheBootstrapFailure(sockPath: string, result: EnsureDaemonResult): void {
  if (result.code !== "daemon_unreachable" && result.code !== "socket_bind_denied") return;
  cachedBootstrapFailure = {
    sockPath,
    code: result.code,
    message: result.message,
    data: asRecord(withDaemonSockHint(result.data, sockPath)) ?? undefined,
  };
}

function getCachedBootstrapFailure(sockPath: string): CachedBootstrapFailure | null {
  if (!cachedBootstrapFailure) return null;
  if (cachedBootstrapFailure.sockPath !== sockPath) return null;
  return cachedBootstrapFailure;
}

function withDaemonSockHint(data: unknown, sockPath = defaultSockPath()): Record<string, unknown> {
  const hint = buildDaemonSockHint(sockPath);
  return {
    ...(asRecord(data) ?? {}),
    hint,
  };
}

function buildDaemonSockHint(sockPath: string): string {
  return `If a daemon is already running on this host, set CODEX_TEAM_DAEMON_SOCK=${formatPathForEnvHint(sockPath)} and retry.`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function flagString(v: unknown): string | null {
  if (Array.isArray(v)) return flagString(v[v.length - 1]);
  return typeof v === "string" ? v : null;
}

function extractMarkdownResult(result: unknown, format: unknown): string | null {
  if (format !== "markdown" || !result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }

  const markdown = (result as { markdown?: unknown }).markdown;
  return typeof markdown === "string" ? markdown : null;
}

function createStreamAckCallback(
  method: string,
  sock: net.Socket,
  reqId: string,
  data: unknown,
): (() => void) | undefined {
  if (method !== "monitor:events") return undefined;
  if (!isStreamChunkAckable(data)) return undefined;
  const eventId = extractStreamEventId(data);
  if (!eventId) return undefined;
  return () => sendStreamAck(sock, reqId, eventId);
}

function extractStreamEventId(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isStreamChunkAckable(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const ackable = (data as { ackable?: unknown }).ackable;
  return ackable !== false;
}

function sendStreamAck(sock: net.Socket, reqId: string, eventId: string): void {
  if (sock.destroyed) return;
  writeMessage(sock, {
    kind: "notification",
    method: "stream_ack",
    params: {
      id: reqId,
      event_id: eventId,
    },
  });
}

function forwardDaemonError(error: { code: string; message: string; data?: unknown }): string {
  return JSON.stringify(err(error.code, error.message, error.data)) + "\n";
}

function validateCliFlags(parsed: ParsedArgs, method: string, effectiveMethod: string): string | null {
  if (method === "monitor:events") {
    if (parsed.flags.cursor === true) return "--cursor requires a value";
    if (parsed.flags.since !== undefined && parsed.flags.cursor !== undefined) {
      return "--since and --cursor are mutually exclusive";
    }
    return null;
  }
  if (method === "message:wait") {
    if ((truthy(parsed.flags.all) || truthy(parsed.flags.any)) && parsed.flags.for !== undefined) {
      return "--for is only supported when waiting on a single session";
    }
    return null;
  }
  if (method === "session:detach") {
    if (parsed.flags.match !== undefined && !truthy(parsed.flags.all)) {
      return "--match requires --all";
    }
    return null;
  }

  if (method === "session:health" && effectiveMethod === "session:health") {
    if (parsed.flags["only-unhealthy"] !== undefined || parsed.flags.state !== undefined) {
      return "--only-unhealthy and --state require --all";
    }
  }

  if (effectiveMethod === "daemon:fleet:status" && parsed.flags.users === true) {
    return "--users requires a value";
  }

  if (effectiveMethod === "session:events") {
    if (parsed.flags.type === true) return "--type requires a value";
    if (parsed.flags.turn === true) return "--turn requires a value";
    if (parsed.flags.since === true) return "--since requires a value";
    if (parsed.flags.limit === true) return "--limit requires a value";
    if (truthy(parsed.flags["by-tool"]) && truthy(parsed.flags["by-item-kind"])) {
      return "--by-tool and --by-item-kind are mutually exclusive";
    }
    if (truthy(parsed.flags.follow) && (truthy(parsed.flags["by-tool"]) || truthy(parsed.flags["by-item-kind"]))) {
      return "--follow cannot be used with --by-tool or --by-item-kind";
    }
    if (truthy(parsed.flags.summary) && (truthy(parsed.flags["by-tool"]) || truthy(parsed.flags["by-item-kind"]))) {
      return "--summary cannot be used with --by-tool or --by-item-kind";
    }
  }
  if (effectiveMethod === "session:logs") {
    if (parsed.flags.n === true) return "-n requires a value";
    if (parsed.flags.stream === true) return "--stream requires a value";
    if (parsed.flags.truncate === true) return "--truncate requires a value";
  }
  return null;
}

function resolveMethod(method: string, parsed: ParsedArgs): string {
  if (method === "session:health" && truthy(parsed.flags.all)) {
    return "session:health:all";
  }
  return method;
}

function isBuiltinProfilesMethod(method: string): boolean {
  return method === "profiles:list" || method === "profiles:show";
}

function runBuiltinProfiles(method: string, parsed: ParsedArgs): number {
  if (method === "profiles:list") {
    if (parsed.positionals.length > 0) {
      process.stdout.write(JSON.stringify(err("invalid_params", "profiles list does not accept positional arguments")) + "\n");
      return 1;
    }

    return writeLocalResult(method, {
      profiles: BUILTIN_PROFILES,
    }, parsed);
  }

  if (parsed.positionals.length !== 1) {
    process.stdout.write(JSON.stringify(err("invalid_params", "profiles show requires exactly 1 positional: <name>")) + "\n");
    return 1;
  }

  const name = parsed.positionals[0]!;
  const profile = findProfile(name);
  if (!profile) {
    const known = BUILTIN_PROFILES.map((entry) => entry.name).join(", ");
    process.stdout.write(JSON.stringify(err("invalid_params", `profile '${name}' not found (known: ${known})`)) + "\n");
    return 1;
  }

  return writeLocalResult(method, {
    ...profile,
    command: renderSessionNewCommand(profile),
  }, parsed);
}

function writeLocalResult(method: string, result: unknown, parsed: ParsedArgs): number {
  if (truthy(parsed.flags.short)) {
    process.stdout.write(formatShort(method, result) + "\n");
    return 0;
  }

  const rendered = truthy(parsed.flags.full) ? result : formatCompact(method, result);
  process.stdout.write(renderJsonResult(rendered, truthy(parsed.flags.full)));
  return 0;
}

function renderJsonResult(result: unknown, full: boolean): string {
  const body = full
    ? JSON.stringify(result, null, 2)
    : JSON.stringify(result);
  return `${body}\n`;
}

function asStringFlag(value: string | boolean | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === "string" ? last : null;
  }
  return typeof value === "string" ? value : null;
}

function isTransientConnectError(err: Error & { code?: string }): boolean {
  return err.message === "connect timeout" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ENOENT" ||
    err.code === "EPIPE" ||
    err.code === "ECONNRESET";
}

function isTransientRequestError(err: Error & { code?: string }): boolean {
  return isTransientConnectError(err) || err.message === "daemon closed connection";
}

function isReadOnlyMethod(method: string): boolean {
  return method === "version" ||
    method === "status" ||
    method === "daemon:fleet:status" ||
    method === "daemon:status" ||
    method === "daemon:user:list" ||
    method === "daemon:config:get" ||
    method === "daemon:config:list" ||
    method === "cursor:list" ||
    method === "cursor:get" ||
    method === "session:health" ||
    method === "session:health:all" ||
    method === "session:logs" ||
    method === "session:events" ||
    method === "session:info" ||
    method === "session:context" ||
    method === "session:list" ||
    method === "message:history";
}

function readCliConfig(): {
  readyTimeoutMs: number;
  connectTimeoutMs: number;
  connectRetryAttempts: number;
  connectRetryDelayMs: number;
} {
  const config = new ConfigStore();
  return {
    readyTimeoutMs: toMs(config.getEffective("daemon.ready_timeout_seconds"), DEFAULT_DAEMON_READY_TIMEOUT_MS),
    connectTimeoutMs: toMs(config.getEffective("daemon.connect_timeout_seconds"), DEFAULT_DAEMON_CONNECT_TIMEOUT_MS),
    connectRetryAttempts: toInt(config.getEffective("daemon.connect_retry_attempts"), DEFAULT_DAEMON_CONNECT_RETRY_ATTEMPTS),
    connectRetryDelayMs: toMs(config.getEffective("daemon.connect_retry_delay_seconds"), DEFAULT_DAEMON_CONNECT_RETRY_DELAY_MS),
  };
}

function readCliStdoutMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODEX_TEAM_CLI_STDOUT_MAX_BYTES;
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_CLI_STDOUT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CLI_STDOUT_MAX_BYTES;
  return Math.max(1, Math.floor(parsed));
}

function toInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : fallback;
}

function toMs(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v * 1000)) : fallback;
}

function formatDuration(ms: number): string {
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export const __private__ = {
  resetBootstrapFailureCache(): void {
    cachedBootstrapFailure = null;
  },
};
