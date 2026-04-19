"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/cli.ts
var import_node_fs2 = __toESM(require("fs"));
var import_node_net = __toESM(require("net"));
var import_node_path3 = __toESM(require("path"));
var import_node_readline = __toESM(require("readline"));
var import_node_child_process = require("child_process");

// src/config.ts
var import_node_fs = __toESM(require("fs"));
var import_node_path2 = __toESM(require("path"));
var import_smol_toml = require("smol-toml");

// src/errors.ts
var CodexTeamError = class extends Error {
  code = "E_INTERNAL";
  exitCode = 1;
  detail;
  constructor(message = "", detail = {}) {
    super(message);
    this.name = this.constructor.name;
    this.detail = detail;
  }
};
var ConfigError = class extends CodexTeamError {
  code = "E_CONFIG";
  exitCode = 2;
};
var InvalidRequest = class extends CodexTeamError {
  code = "E_INVALID";
  exitCode = 2;
};
var DaemonNotRunning = class extends CodexTeamError {
  code = "E_DAEMON_DOWN";
  exitCode = 4;
};
var DaemonAlreadyRunning = class extends CodexTeamError {
  code = "E_DAEMON_UP";
  exitCode = 4;
};
var SessionNotFound = class extends CodexTeamError {
  code = "E_NOT_FOUND";
  exitCode = 3;
};
var SessionExists = class extends CodexTeamError {
  code = "E_EXISTS";
  exitCode = 3;
};
var SessionBusy = class extends CodexTeamError {
  code = "E_BUSY";
  exitCode = 3;
};
var SessionErrored = class extends CodexTeamError {
  code = "E_ERRORED";
  exitCode = 3;
};
var QueueFull = class extends CodexTeamError {
  code = "E_QUEUE_FULL";
  exitCode = 3;
};
var TransportError = class extends CodexTeamError {
  code = "E_TRANSPORT";
  exitCode = 5;
};
var TurnTimeout = class extends CodexTeamError {
  code = "E_TIMEOUT";
  exitCode = 5;
};
var CodexCliMissing = class extends CodexTeamError {
  code = "E_NO_CODEX_BIN";
  exitCode = 4;
};
var errorClasses = {
  E_CONFIG: ConfigError,
  E_INVALID: InvalidRequest,
  E_DAEMON_DOWN: DaemonNotRunning,
  E_DAEMON_UP: DaemonAlreadyRunning,
  E_NOT_FOUND: SessionNotFound,
  E_EXISTS: SessionExists,
  E_BUSY: SessionBusy,
  E_ERRORED: SessionErrored,
  E_QUEUE_FULL: QueueFull,
  E_TRANSPORT: TransportError,
  E_TIMEOUT: TurnTimeout,
  E_NO_CODEX_BIN: CodexCliMissing
};
function errorToWire(error) {
  return {
    code: error.code,
    msg: error.message,
    detail: { ...error.detail }
  };
}
function wireToError(wire) {
  const ErrorClass = errorClasses[String(wire?.code ?? "")] ?? CodexTeamError;
  return new ErrorClass(String(wire?.msg ?? ""), { ...wire?.detail ?? {} });
}
function asCodexTeamError(error) {
  if (error instanceof CodexTeamError) {
    return error;
  }
  if (error instanceof Error) {
    return new CodexTeamError(error.message);
  }
  return new CodexTeamError(String(error));
}

// src/paths.ts
var import_node_os = __toESM(require("os"));
var import_node_path = __toESM(require("path"));
var APP = "codex-team";
function homeDir() {
  return process.env.HOME || import_node_os.default.homedir() || "/";
}
function xdgConfigDir() {
  return import_node_path.default.join(process.env.XDG_CONFIG_HOME || import_node_path.default.join(homeDir(), ".config"), APP);
}
function xdgDataDir() {
  return import_node_path.default.join(process.env.XDG_DATA_HOME || import_node_path.default.join(homeDir(), ".local", "share"), APP);
}
function xdgRuntimeDir() {
  return import_node_path.default.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || import_node_os.default.tmpdir(), APP);
}
function defaultSocketPath() {
  return import_node_path.default.join(xdgRuntimeDir(), "daemon.sock");
}
function sessionDir(dataDir, name) {
  return import_node_path.default.join(dataDir, "sessions", name);
}

// src/protocol.ts
function encodeMessage(message) {
  return `${JSON.stringify(message)}
`;
}
function decodeRequest(line) {
  const payload = decodeJsonObject(line);
  if (typeof payload.id !== "string" || typeof payload.cmd !== "string") {
    throw new InvalidRequest("request must include string id and cmd");
  }
  return {
    id: payload.id,
    cmd: payload.cmd,
    params: isObject(payload.params) ? payload.params : {}
  };
}
function decodeJsonObject(line) {
  const payload = line.replace(/\n$/, "");
  if (!payload) {
    throw new InvalidRequest("empty line");
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new InvalidRequest(`bad JSON: ${error.message}`);
  }
  if (!isObject(parsed)) {
    throw new InvalidRequest("message is not an object");
  }
  return parsed;
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/config.ts
var DEFAULT_CONFIG = {
  daemon: {
    socketPath: "",
    dataDir: "",
    logLevel: "info",
    codexBin: "",
    codexHome: "",
    launchArgsOverride: [],
    configOverrides: [],
    rpcTimeoutSeconds: 60
  },
  defaults: {
    model: "gpt-5.4",
    modelProvider: "",
    sandbox: "danger_full_access",
    approvalPolicy: "never",
    cwd: "",
    autoResumeOnDaemonStart: true,
    serviceTier: "",
    reasoningEffort: "",
    personality: "",
    baseInstructions: "",
    developerInstructions: "",
    profile: ""
  },
  digest: {
    historyMdEnabled: true,
    turnsJsonlEnabled: true,
    commandTruncateChars: 120,
    agentMessageFull: true,
    reasoningCapture: false,
    stderrTailLinesOnFail: 20,
    maxFilesListed: 8,
    toolArgsTruncateChars: 80,
    historyRotationMb: 32
  },
  compaction: {
    thresholdTokens: 5e5,
    mode: "manual",
    progressDocTemplate: "",
    retryAttempts: 2,
    retryDelayMs: 1500,
    timeoutSeconds: 600
  },
  monitor: {
    eventsMaxBuffer: 1e3,
    watchdogIntervalSeconds: 1200,
    watchdogTaskBriefFile: "",
    watchdogTaskBriefHeadLines: 30,
    watchdogStaleMinutes: 30,
    subscriberQueueMax: 200,
    watchdogEmitIdle: false,
    watchdogTemplate: "",
    watchdogTemplateFile: "",
    watchdogAlarms: {}
  },
  heartbeat: {
    intervalSeconds: 60,
    turnStuckSeconds: 600,
    selfHealOnce: true,
    healthTimeoutSeconds: 15,
    healthCheckConcurrency: 8,
    resumeTimeoutSeconds: 30,
    selfHealBackoffSeconds: 30
  },
  queue: {
    maxPerSession: 5,
    overflowPolicy: "warn"
  },
  profiles: {}
};
function defaultConfigPath() {
  return import_node_path2.default.join(xdgConfigDir(), "config.toml");
}
function loadConfig(configPath = defaultConfigPath()) {
  let cfg = cloneDefaultConfig();
  if (import_node_fs.default.existsSync(configPath)) {
    let raw;
    try {
      raw = (0, import_smol_toml.parse)(import_node_fs.default.readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new ConfigError(`Invalid TOML in ${configPath}: ${error.message}`);
    }
    if (!isObject(raw)) {
      throw new ConfigError(`Config root must be an object: ${configPath}`);
    }
    cfg = mergeConfig(cfg, raw);
  }
  applyEnvOverrides(cfg);
  validateConfig(cfg);
  return cfg;
}
function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
function mergeConfig(base, raw) {
  applySection(base.daemon, raw.daemon, daemonFieldKinds);
  applySection(base.defaults, raw.defaults, defaultsFieldKinds);
  applySection(base.digest, raw.digest, digestFieldKinds);
  applySection(base.compaction, raw.compaction, compactionFieldKinds);
  applySection(base.monitor, raw.monitor, monitorFieldKinds);
  if (isObject(raw.monitor)) {
    const alarmsRaw = isObject(raw.monitor.watchdog_alarms) ? raw.monitor.watchdog_alarms : isObject(raw.monitor.watchdogAlarms) ? raw.monitor.watchdogAlarms : null;
    if (alarmsRaw) {
      for (const [name, value] of Object.entries(alarmsRaw)) {
        const alarm = cloneAlarm();
        applySection(alarm, value, watchdogAlarmFieldKinds);
        base.monitor.watchdogAlarms[name] = alarm;
      }
    }
  }
  applySection(base.heartbeat, raw.heartbeat, heartbeatFieldKinds);
  applySection(base.queue, raw.queue, queueFieldKinds);
  if (isObject(raw.profiles)) {
    for (const [name, value] of Object.entries(raw.profiles)) {
      const profile = cloneProfile();
      applySection(profile, value, profileFieldKinds);
      base.profiles[name] = profile;
    }
  }
  return base;
}
function cloneProfile() {
  return {
    model: "",
    modelProvider: "",
    sandbox: "",
    approvalPolicy: "",
    cwd: "",
    serviceTier: "",
    reasoningEffort: "",
    personality: "",
    baseInstructions: "",
    developerInstructions: "",
    ephemeral: false
  };
}
function cloneAlarm() {
  return {
    enabled: true,
    intervalSeconds: 1200,
    taskBriefFile: "",
    taskBriefHeadLines: 30,
    emitIdle: false,
    template: "",
    templateFile: ""
  };
}
var daemonFieldKinds = {
  socketPath: "string",
  dataDir: "string",
  logLevel: "string",
  codexBin: "string",
  codexHome: "string",
  launchArgsOverride: "string[]",
  configOverrides: "string[]",
  rpcTimeoutSeconds: "number"
};
var defaultsFieldKinds = {
  model: "string",
  modelProvider: "string",
  sandbox: "string",
  approvalPolicy: "string",
  cwd: "string",
  autoResumeOnDaemonStart: "boolean",
  serviceTier: "string",
  reasoningEffort: "string",
  personality: "string",
  baseInstructions: "string",
  developerInstructions: "string",
  profile: "string"
};
var profileFieldKinds = {
  model: "string",
  modelProvider: "string",
  sandbox: "string",
  approvalPolicy: "string",
  cwd: "string",
  serviceTier: "string",
  reasoningEffort: "string",
  personality: "string",
  baseInstructions: "string",
  developerInstructions: "string",
  ephemeral: "boolean"
};
var digestFieldKinds = {
  historyMdEnabled: "boolean",
  turnsJsonlEnabled: "boolean",
  commandTruncateChars: "number",
  agentMessageFull: "boolean",
  reasoningCapture: "boolean",
  stderrTailLinesOnFail: "number",
  maxFilesListed: "number",
  toolArgsTruncateChars: "number",
  historyRotationMb: "number"
};
var compactionFieldKinds = {
  thresholdTokens: "number",
  mode: "string",
  progressDocTemplate: "string",
  retryAttempts: "number",
  retryDelayMs: "number",
  timeoutSeconds: "number"
};
var monitorFieldKinds = {
  eventsMaxBuffer: "number",
  watchdogIntervalSeconds: "number",
  watchdogTaskBriefFile: "string",
  watchdogTaskBriefHeadLines: "number",
  watchdogStaleMinutes: "number",
  subscriberQueueMax: "number",
  watchdogEmitIdle: "boolean",
  watchdogTemplate: "string",
  watchdogTemplateFile: "string",
  watchdogAlarms: "object"
};
var watchdogAlarmFieldKinds = {
  enabled: "boolean",
  intervalSeconds: "number",
  taskBriefFile: "string",
  taskBriefHeadLines: "number",
  emitIdle: "boolean",
  template: "string",
  templateFile: "string"
};
var heartbeatFieldKinds = {
  intervalSeconds: "number",
  turnStuckSeconds: "number",
  selfHealOnce: "boolean",
  healthTimeoutSeconds: "number",
  healthCheckConcurrency: "number",
  resumeTimeoutSeconds: "number",
  selfHealBackoffSeconds: "number"
};
var queueFieldKinds = {
  maxPerSession: "number",
  overflowPolicy: "string"
};
function applySection(target, source, fieldKinds) {
  if (!isObject(source)) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = resolveFieldKey(key, fieldKinds);
    if (!normalizedKey) {
      continue;
    }
    const kind = fieldKinds[normalizedKey];
    target[normalizedKey] = coerceValue(
      value,
      kind,
      `.${String(normalizedKey)}`
    );
  }
}
function resolveFieldKey(rawKey, fieldKinds) {
  if (rawKey in fieldKinds) {
    return rawKey;
  }
  const camelKey = rawKey.replace(/_([a-z])/g, (_match, char) => char.toUpperCase());
  if (camelKey in fieldKinds) {
    return camelKey;
  }
  return null;
}
function coerceValue(value, kind, label) {
  switch (kind) {
    case "string":
      if (typeof value !== "string") {
        throw new ConfigError(`Expected string at ${label}`);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ConfigError(`Expected finite number at ${label}`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new ConfigError(`Expected boolean at ${label}`);
      }
      return value;
    case "string[]":
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new ConfigError(`Expected string[] at ${label}`);
      }
      return value;
    case "object":
      if (!isObject(value)) {
        throw new ConfigError(`Expected object at ${label}`);
      }
      return value;
  }
}
var BOOL_TRUE = /* @__PURE__ */ new Set(["1", "true", "yes", "on"]);
var BOOL_FALSE = /* @__PURE__ */ new Set(["0", "false", "no", "off"]);
function applyEnvOverrides(cfg) {
  applyEnvSection("daemon", cfg.daemon, daemonFieldKinds);
  applyEnvSection("defaults", cfg.defaults, defaultsFieldKinds);
  applyEnvSection("digest", cfg.digest, digestFieldKinds);
  applyEnvSection("compaction", cfg.compaction, compactionFieldKinds);
  applyEnvSection("monitor", cfg.monitor, monitorFieldKinds);
  applyEnvSection("heartbeat", cfg.heartbeat, heartbeatFieldKinds);
  applyEnvSection("queue", cfg.queue, queueFieldKinds);
}
function applyEnvSection(sectionName, target, fieldKinds) {
  for (const [fieldName, rawKind] of Object.entries(fieldKinds)) {
    const kind = rawKind;
    const envKeys = [
      `CODEX_TEAM_${sectionName.toUpperCase()}_${camelToEnvKey(fieldName)}`,
      `CODEX_TEAM_${sectionName.toUpperCase()}_${fieldName.toUpperCase()}`
    ];
    const raw = envKeys.map((key) => process.env[key]).find((value) => value !== void 0);
    if (raw === void 0) {
      continue;
    }
    target[fieldName] = coerceEnvValue(raw, kind);
  }
}
function camelToEnvKey(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}
function validateConfig(cfg) {
  assertOneOf(cfg.daemon.logLevel, ["debug", "info", "warn", "error"], "daemon.log_level");
  assertPositiveInt(cfg.daemon.rpcTimeoutSeconds, "daemon.rpc_timeout_seconds");
  assertOneOf(cfg.compaction.mode, ["manual"], "compaction.mode");
  assertOneOf(cfg.queue.overflowPolicy, ["warn", "reject", "drop_oldest"], "queue.overflow_policy");
  assertPositiveInt(cfg.digest.commandTruncateChars, "digest.command_truncate_chars");
  assertPositiveInt(cfg.digest.stderrTailLinesOnFail, "digest.stderr_tail_lines_on_fail");
  assertPositiveInt(cfg.digest.maxFilesListed, "digest.max_files_listed");
  assertPositiveInt(cfg.digest.toolArgsTruncateChars, "digest.tool_args_truncate_chars");
  assertPositiveInt(cfg.digest.historyRotationMb, "digest.history_rotation_mb");
  assertPositiveInt(cfg.compaction.thresholdTokens, "compaction.threshold_tokens");
  assertNonNegativeInt(cfg.compaction.retryAttempts, "compaction.retry_attempts");
  assertNonNegativeInt(cfg.compaction.retryDelayMs, "compaction.retry_delay_ms");
  assertPositiveInt(cfg.compaction.timeoutSeconds, "compaction.timeout_seconds");
  assertPositiveInt(cfg.monitor.eventsMaxBuffer, "monitor.events_max_buffer");
  assertPositiveInt(cfg.monitor.watchdogIntervalSeconds, "monitor.watchdog_interval_seconds");
  assertPositiveInt(cfg.monitor.watchdogTaskBriefHeadLines, "monitor.watchdog_task_brief_head_lines");
  assertPositiveInt(cfg.monitor.watchdogStaleMinutes, "monitor.watchdog_stale_minutes");
  assertPositiveInt(cfg.monitor.subscriberQueueMax, "monitor.subscriber_queue_max");
  for (const [name, alarm] of Object.entries(cfg.monitor.watchdogAlarms)) {
    if (!name.trim()) {
      throw new ConfigError("watchdog alarm name cannot be empty");
    }
    if (name === "default") {
      throw new ConfigError("watchdog alarm name 'default' is reserved");
    }
    assertPositiveInt(alarm.intervalSeconds, `monitor.watchdog_alarms.${name}.interval_seconds`);
    assertPositiveInt(alarm.taskBriefHeadLines, `monitor.watchdog_alarms.${name}.task_brief_head_lines`);
  }
  assertPositiveInt(cfg.heartbeat.intervalSeconds, "heartbeat.interval_seconds");
  assertPositiveInt(cfg.heartbeat.turnStuckSeconds, "heartbeat.turn_stuck_seconds");
  assertPositiveInt(cfg.heartbeat.healthTimeoutSeconds, "heartbeat.health_timeout_seconds");
  assertPositiveInt(cfg.heartbeat.healthCheckConcurrency, "heartbeat.health_check_concurrency");
  assertPositiveInt(cfg.heartbeat.resumeTimeoutSeconds, "heartbeat.resume_timeout_seconds");
  assertNonNegativeInt(cfg.heartbeat.selfHealBackoffSeconds, "heartbeat.self_heal_backoff_seconds");
  assertPositiveInt(cfg.queue.maxPerSession, "queue.max_per_session");
  for (const [name, profile] of Object.entries(cfg.profiles)) {
    if (!name.trim()) {
      throw new ConfigError("profile name cannot be empty");
    }
    validateOptionalSandbox(profile.sandbox, `profiles.${name}.sandbox`);
    validateOptionalApproval(profile.approvalPolicy, `profiles.${name}.approval_policy`);
  }
  validateOptionalSandbox(cfg.defaults.sandbox, "defaults.sandbox");
  validateOptionalApproval(cfg.defaults.approvalPolicy, "defaults.approval_policy");
}
function assertOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new ConfigError(`${label} must be one of ${allowed.join(", ")}`);
  }
}
function assertPositiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer`);
  }
}
function assertNonNegativeInt(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${label} must be a non-negative integer`);
  }
}
function validateOptionalSandbox(value, label) {
  const normalized = normalizeSandboxMode(value);
  if (!normalized) {
    return;
  }
  assertOneOf(normalized, ["read-only", "workspace-write", "danger-full-access"], label);
}
function validateOptionalApproval(value, label) {
  const normalized = normalizeApprovalPolicy(value);
  if (!normalized) {
    return;
  }
  assertOneOf(normalized, ["never", "on-request", "on-failure", "untrusted"], label);
}
function coerceEnvValue(value, kind) {
  switch (kind) {
    case "string":
      return value;
    case "number": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new ConfigError(`Cannot coerce ${JSON.stringify(value)} to number`);
      }
      return parsed;
    }
    case "boolean": {
      const lowered = value.trim().toLowerCase();
      if (BOOL_TRUE.has(lowered)) {
        return true;
      }
      if (BOOL_FALSE.has(lowered)) {
        return false;
      }
      throw new ConfigError(`Cannot coerce ${JSON.stringify(value)} to bool`);
    }
    case "string[]":
      return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    case "object":
      throw new ConfigError("Cannot override object fields via env");
  }
}
function resolveDataDir(cfg) {
  return cfg.daemon.dataDir || xdgDataDir();
}
function resolveSocketPath(cfg) {
  return cfg.daemon.socketPath || defaultSocketPath();
}
function resolveCodexBin(cfg) {
  const configured = cfg.daemon.codexBin.trim();
  if (configured) {
    if (!import_node_fs.default.existsSync(configured)) {
      throw new CodexCliMissing(`codex binary not found at configured path: ${configured}`);
    }
    return configured;
  }
  const fromEnv = (process.env.CODEX_TEAM_CODEX_BIN || "").trim();
  if (fromEnv) {
    if (!import_node_fs.default.existsSync(fromEnv)) {
      throw new CodexCliMissing(`codex binary not found at CODEX_TEAM_CODEX_BIN path: ${fromEnv}`);
    }
    return fromEnv;
  }
  const pathValue = which("codex");
  if (pathValue) {
    return pathValue;
  }
  throw new CodexCliMissing("unable to resolve codex binary");
}
function which(name) {
  const pathEntries = (process.env.PATH || "").split(import_node_path2.default.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = import_node_path2.default.join(entry, name);
    if (import_node_fs.default.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
function normalizeSandboxMode(value) {
  if (value === void 0 || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.replace(/_/g, "-") : null;
}
function normalizeApprovalPolicy(value) {
  if (value === void 0 || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.replace(/_/g, "-") : null;
}

// src/cli.ts
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function diagnoseStalePid(dataDir) {
  const pidPath = import_node_path3.default.join(dataDir, "daemon.pid");
  if (!import_node_fs2.default.existsSync(pidPath)) {
    return { stale: false, pid: null, pidPath };
  }
  const raw = import_node_fs2.default.readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0 || !pidAlive(pid)) {
    return { stale: true, pid: Number.isFinite(pid) ? pid : null, pidPath };
  }
  return { stale: false, pid, pidPath };
}
async function socketReady(socketPath) {
  if (!import_node_fs2.default.existsSync(socketPath)) {
    return false;
  }
  return await new Promise((resolve) => {
    const socket = import_node_net.default.createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 100);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(false);
    });
  });
}
async function sendRequest(socketPath, cmd, params) {
  return await new Promise((resolve, reject) => {
    const socket = import_node_net.default.createConnection(socketPath);
    socket.setEncoding("utf8");
    const rl = import_node_readline.default.createInterface({ input: socket, crlfDelay: Infinity });
    socket.once("error", (error) => {
      rl.close();
      reject(new DaemonNotRunning(`no daemon at ${socketPath}: ${error.message}`));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: cryptoId(), cmd, params })}
`);
    });
    void (async () => {
      try {
        const iterator = rl[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done || !first.value) {
          reject(new DaemonNotRunning("daemon closed connection"));
          return;
        }
        resolve(JSON.parse(first.value));
      } catch (error) {
        reject(error);
      } finally {
        rl.close();
        socket.end();
      }
    })();
  });
}
async function streamSubscribe(socketPath, cmd) {
  return await new Promise((resolve) => {
    const socket = import_node_net.default.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.once("error", () => {
      process.stderr.write("daemon not running\n");
      resolve(4);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: cryptoId(), cmd, params: {} })}
`);
    });
    socket.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    socket.once("close", () => resolve(0));
  });
}
async function streamHistorySubscribe(socketPath, params) {
  return await new Promise((resolve) => {
    const socket = import_node_net.default.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.once("error", () => {
      process.stderr.write("daemon not running\n");
      resolve(4);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: cryptoId(), cmd: "history.subscribe", params })}
`);
    });
    const rl = import_node_readline.default.createInterface({ input: socket, crlfDelay: Infinity });
    void (async () => {
      try {
        for await (const line of rl) {
          if (!line) {
            continue;
          }
          try {
            const event = JSON.parse(line);
            const content = event.payload?.content;
            if (typeof content === "string" && content) {
              process.stdout.write(content);
            }
          } catch {
            process.stdout.write(`${line}
`);
          }
        }
      } finally {
        rl.close();
      }
    })();
    socket.once("close", () => resolve(0));
  });
}
async function followFile(filePath, startAtEnd = false) {
  import_node_fs2.default.mkdirSync(import_node_path3.default.dirname(filePath), { recursive: true });
  if (!import_node_fs2.default.existsSync(filePath)) {
    import_node_fs2.default.writeFileSync(filePath, "", "utf8");
  }
  let offset = startAtEnd ? import_node_fs2.default.statSync(filePath).size : 0;
  while (true) {
    const size = import_node_fs2.default.statSync(filePath).size;
    if (size > offset) {
      const fd = import_node_fs2.default.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        import_node_fs2.default.readSync(fd, buffer, 0, buffer.length, offset);
        process.stdout.write(buffer.toString("utf8"));
      } finally {
        import_node_fs2.default.closeSync(fd);
      }
      offset = size;
    }
    await sleep(250);
  }
}
function parseOptions(args, spec = {}) {
  const options = { _: [] };
  const booleanFlags = new Set(spec.boolean || []);
  const stringFlags = new Set(spec.string || []);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const eqIndex = token.indexOf("=");
    const rawFlag = token.slice(2, eqIndex >= 0 ? eqIndex : void 0);
    const key = flagToCamel(rawFlag);
    if (booleanFlags.has(rawFlag)) {
      options[key] = true;
      continue;
    }
    if (stringFlags.has(rawFlag)) {
      if (eqIndex >= 0) {
        options[key] = token.slice(eqIndex + 1);
      } else {
        index += 1;
        options[key] = args[index] ?? "";
      }
      continue;
    }
    throw new Error(`unknown option: --${rawFlag}`);
  }
  return options;
}
function flagToCamel(flag) {
  return flag.replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}
function parseCli(argv) {
  const [group, action, ...rest] = argv;
  if (!group) {
    throw new Error("usage: codex-team <group> ...");
  }
  if (group === "session") {
    const opts = parseOptions(rest, {
      boolean: ["ephemeral", "include-turns"],
      string: [
        "cwd",
        "model",
        "model-provider",
        "sandbox",
        "approval-policy",
        "service-tier",
        "reasoning-effort",
        "personality",
        "profile",
        "thread-id",
        "base-instructions-file",
        "developer-instructions-file"
      ]
    });
    const name = opts._[0];
    return { group, action, args: { ...opts, name } };
  }
  if (group === "send") {
    const opts = parseOptions([action || "", ...rest].filter(Boolean), {
      boolean: ["stdin", "wait"],
      string: [
        "prompt-file",
        "model",
        "cwd",
        "effort",
        "personality",
        "service-tier",
        "summary",
        "output-schema-file"
      ]
    });
    return { group, args: { ...opts, name: opts._[0], text: opts._[1] || "" } };
  }
  if (group === "interrupt" || group === "compact") {
    return { group, name: action || "" };
  }
  if (group === "history") {
    const opts = parseOptions([action || "", ...rest].filter(Boolean), {
      boolean: ["follow"],
      string: ["last-n", "since", "since-turn-id", "format"]
    });
    return {
      group,
      args: {
        ...opts,
        name: opts._[0],
        lastN: Number(opts.lastN || 0)
      }
    };
  }
  if (group === "tail") {
    const opts = parseOptions([action || "", ...rest].filter(Boolean), {
      boolean: ["stderr"],
      string: ["lines"]
    });
    return { group, args: { ...opts, name: opts._[0] } };
  }
  if (group === "queue") {
    const opts = parseOptions(rest, {
      boolean: ["wait"]
    });
    return { group, action, args: { ...opts, name: opts._[0] } };
  }
  if (group === "health") {
    return { group, action };
  }
  if (group === "daemon") {
    const opts = parseOptions(rest, {
      boolean: ["follow"]
    });
    return { group, action, args: opts };
  }
  if (group === "monitor" && (action === "events" || action === "watchdog")) {
    return { group, action };
  }
  throw new Error(`unknown command group: ${group}`);
}
function cryptoId() {
  return `cli-${Math.random().toString(16).slice(2)}`;
}
function textContentForResponse(parsed, data) {
  const content = data.content;
  if (typeof content !== "string") {
    return null;
  }
  if (parsed.group === "history" || parsed.group === "tail") {
    return content;
  }
  if (parsed.group === "daemon" && parsed.action === "logs") {
    return content;
  }
  return null;
}
function writeTextContent(content) {
  process.stdout.write(content);
  if (content && !content.endsWith("\n")) {
    process.stdout.write("\n");
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var CliClient = class {
  socketPath;
  constructor(socketPath) {
    this.socketPath = socketPath || resolveSocketPath(loadConfig());
  }
  async ensureDaemon() {
    if (await socketReady(this.socketPath)) {
      return;
    }
    if (import_node_fs2.default.existsSync(this.socketPath)) {
      import_node_fs2.default.unlinkSync(this.socketPath);
    }
    const cfg = loadConfig();
    const dataDir = resolveDataDir(cfg);
    cfg.daemon.dataDir = dataDir;
    import_node_fs2.default.mkdirSync(dataDir, { recursive: true });
    const stale = diagnoseStalePid(dataDir);
    if (stale.stale) {
      try {
        import_node_fs2.default.unlinkSync(stale.pidPath);
      } catch (error) {
        throw new DaemonNotRunning(
          `stale pid file at ${stale.pidPath} could not be removed automatically: ${error.message}`,
          { pid_path: stale.pidPath, stale_pid: stale.pid }
        );
      }
    }
    const errPath = import_node_path3.default.join(dataDir, "daemon-startup.err");
    const errFd = import_node_fs2.default.openSync(errPath, "a");
    try {
      const child = (0, import_node_child_process.spawn)(process.execPath, [process.argv[1] || "", "__daemon"], {
        detached: true,
        stdio: ["ignore", "ignore", errFd]
      });
      child.unref();
    } finally {
      import_node_fs2.default.closeSync(errFd);
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await socketReady(this.socketPath)) {
        return;
      }
      await sleep(100);
    }
    const tail = import_node_fs2.default.existsSync(errPath) ? import_node_fs2.default.readFileSync(errPath, "utf8").split(/\r?\n/).slice(-40).join("\n") : "";
    let hint = `daemon did not become ready at ${this.socketPath}. Check ${errPath} for the daemon stderr.`;
    if (tail) {
      hint += `
--- last stderr lines ---
${tail}
--- end ---`;
    }
    throw new DaemonNotRunning(hint, {
      socket_path: this.socketPath,
      startup_err_path: errPath,
      startup_err_tail: tail
    });
  }
  async readPrompt(args) {
    if (args.stdin) {
      return await new Promise((resolve) => {
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          body += chunk;
        });
        process.stdin.on("end", () => resolve(body));
      });
    }
    if (typeof args.promptFile === "string" && args.promptFile) {
      return import_node_fs2.default.readFileSync(args.promptFile, "utf8");
    }
    return String(args.text || "");
  }
  readOptionalFile(value) {
    if (typeof value !== "string" || !value) {
      return null;
    }
    return import_node_fs2.default.readFileSync(value, "utf8");
  }
  async run(argv = process.argv.slice(2)) {
    const parsed = parseCli(argv);
    if (parsed.group === "monitor") {
      await this.ensureDaemon();
      return await streamSubscribe(this.socketPath, `monitor.${parsed.action}.subscribe`);
    }
    if (!(parsed.group === "daemon" && (parsed.action === "start" || parsed.action === "restart"))) {
      await this.ensureDaemon();
    }
    let response;
    if (parsed.group === "daemon" && parsed.action === "start") {
      await this.ensureDaemon();
      response = { ok: true, data: { started: true } };
    } else if (parsed.group === "daemon" && parsed.action === "restart") {
      try {
        await sendRequest(this.socketPath, "daemon.stop", {});
      } catch {
      }
      await sleep(300);
      await this.ensureDaemon();
      response = { ok: true, data: { restarted: true } };
    } else if (parsed.group === "daemon" && parsed.action === "logs" && parsed.args.follow) {
      const cfg = loadConfig();
      return await followFile(import_node_path3.default.join(resolveDataDir(cfg), "daemon.log"));
    } else {
      response = await this.handle(parsed);
    }
    if (typeof response === "number") {
      return response;
    }
    if (response.ok) {
      const data = response.data || {};
      const textContent = textContentForResponse(parsed, data);
      if (textContent !== null) {
        writeTextContent(textContent);
      } else {
        process.stdout.write(`${JSON.stringify(data, null, 2)}
`);
      }
      return 0;
    }
    const error = wireToError(response.error || {});
    process.stderr.write(`codex-team: ${error.code}: ${error.message}
`);
    if (Object.keys(error.detail).length > 0) {
      process.stderr.write(`  detail: ${JSON.stringify(error.detail)}
`);
    }
    return error.exitCode;
  }
  async handle(parsed) {
    if (parsed.group === "session") {
      const args = parsed.args;
      const cmd = `session.${parsed.action.replace(/-/g, "_")}`;
      const params = {};
      if (args.name) {
        params.name = String(args.name);
      }
      if (parsed.action === "create" || parsed.action === "attach") {
        for (const key of [
          "cwd",
          "model",
          "modelProvider",
          "sandbox",
          "approvalPolicy",
          "serviceTier",
          "reasoningEffort",
          "personality",
          "profile",
          "threadId"
        ]) {
          if (args[key] !== void 0) {
            params[key] = args[key];
          }
        }
        params.baseInstructions = this.readOptionalFile(args.baseInstructionsFile);
        params.developerInstructions = this.readOptionalFile(args.developerInstructionsFile);
        params.ephemeral = Boolean(args.ephemeral);
      } else if (parsed.action === "read") {
        params.includeTurns = Boolean(args.includeTurns);
      }
      return await sendRequest(this.socketPath, cmd, params);
    }
    if (parsed.group === "send") {
      const outputSchema = typeof parsed.args.outputSchemaFile === "string" && parsed.args.outputSchemaFile ? JSON.parse(import_node_fs2.default.readFileSync(parsed.args.outputSchemaFile, "utf8")) : null;
      return await sendRequest(this.socketPath, "send", {
        name: parsed.args.name,
        text: await this.readPrompt(parsed.args),
        wait: Boolean(parsed.args.wait),
        model: parsed.args.model,
        cwd: parsed.args.cwd,
        effort: parsed.args.effort,
        personality: parsed.args.personality,
        serviceTier: parsed.args.serviceTier,
        summary: parsed.args.summary,
        outputSchema
      });
    }
    if (parsed.group === "interrupt") {
      return await sendRequest(this.socketPath, "interrupt", { name: parsed.name });
    }
    if (parsed.group === "compact") {
      return await sendRequest(this.socketPath, "compact", { name: parsed.name });
    }
    if (parsed.group === "history") {
      if (parsed.args.follow) {
        return await streamHistorySubscribe(this.socketPath, {
          name: parsed.args.name,
          lastN: parsed.args.lastN,
          since: parsed.args.since,
          sinceTurnId: parsed.args.sinceTurnId,
          format: parsed.args.format || "md"
        });
      }
      return await sendRequest(this.socketPath, "history.get", {
        name: parsed.args.name,
        lastN: parsed.args.lastN,
        since: parsed.args.since,
        sinceTurnId: parsed.args.sinceTurnId,
        format: parsed.args.format || "md"
      });
    }
    if (parsed.group === "tail") {
      return await sendRequest(this.socketPath, "history.tail_stderr", {
        name: parsed.args.name,
        lines: Number(parsed.args.lines || 200)
      });
    }
    if (parsed.group === "queue") {
      return await sendRequest(this.socketPath, `queue.${parsed.action.replace(/-/g, "_")}`, {
        name: parsed.args.name,
        wait: Boolean(parsed.args.wait)
      });
    }
    if (parsed.group === "health") {
      return await sendRequest(this.socketPath, `health.${parsed.action}`, {});
    }
    if (parsed.group === "daemon") {
      return await sendRequest(this.socketPath, `daemon.${parsed.action.replace(/-/g, "_")}`, {});
    }
    throw new Error("unreachable");
  }
};

// src/daemon.ts
var import_node_fs9 = __toESM(require("fs"));
var import_node_path8 = __toESM(require("path"));

// src/server.ts
var import_node_fs8 = __toESM(require("fs"));
var import_node_net2 = __toESM(require("net"));
var import_node_path7 = __toESM(require("path"));
var import_node_readline3 = __toESM(require("readline"));
var import_node_events = require("events");

// src/compaction.ts
var CompactionMonitor = class {
  constructor(cfg, registry, eventBus) {
    this.cfg = cfg;
    this.registry = registry;
    this.eventBus = eventBus;
    void this.registry;
  }
  cfg;
  registry;
  eventBus;
  suggestedLevel = /* @__PURE__ */ new Map();
  async observeUsage(name, usage) {
    const metric = usage.contextTokensEstimate ?? usage.cumulativeUsageTokens ?? 0;
    const threshold = this.cfg.compaction.thresholdTokens;
    if (metric < threshold) {
      return;
    }
    const level = Math.max(1, Math.floor(metric / threshold));
    const previousLevel = this.suggestedLevel.get(name) || 0;
    if (level <= previousLevel) {
      return;
    }
    this.suggestedLevel.set(name, level);
    this.eventBus.publish("events", {
      kind: "compact-suggest",
      session: name,
      tokens: metric,
      level,
      metric_kind: usage.contextTokensEstimate != null ? "context_estimate" : "cumulative_usage",
      context_tokens_estimate: usage.contextTokensEstimate,
      model_context_window: usage.modelContextWindow,
      cumulative_usage_tokens: usage.cumulativeUsageTokens,
      threshold
    });
  }
  clear(name) {
    this.suggestedLevel.delete(name);
  }
};

// src/asyncQueue.ts
var AsyncQueue = class {
  constructor(maxSize = 0) {
    this.maxSize = maxSize;
  }
  maxSize;
  items = [];
  waiters = [];
  closed = false;
  closeError = new Error("queue closed");
  push(item) {
    if (this.closed) {
      return;
    }
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve(item);
      return;
    }
    if (this.maxSize > 0 && this.items.length >= this.maxSize) {
      this.items.shift();
    }
    this.items.push(item);
  }
  shiftNow() {
    return this.items.shift();
  }
  async shift(timeoutMs = 0, timeoutMessage = "queue shift timed out") {
    if (this.items.length > 0) {
      return this.items.shift();
    }
    if (this.closed) {
      throw this.closeError;
    }
    return await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      if (timeoutMs > 0) {
        setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
            reject(new Error(timeoutMessage));
          }
        }, timeoutMs);
      }
    });
  }
  get length() {
    return this.items.length;
  }
  close(error = new Error("queue closed")) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(this.closeError);
    }
  }
};

// src/eventBus.ts
var EventBus = class {
  constructor(maxBuffer = 1e3, subscriberQueueMax = 200) {
    this.maxBuffer = maxBuffer;
    this.subscriberQueueMax = subscriberQueueMax;
  }
  maxBuffer;
  subscriberQueueMax;
  buffers = /* @__PURE__ */ new Map();
  seqs = /* @__PURE__ */ new Map();
  subs = /* @__PURE__ */ new Map();
  replaceLimits(maxBuffer, subscriberQueueMax) {
    this.maxBuffer = maxBuffer;
    this.subscriberQueueMax = subscriberQueueMax;
  }
  publish(stream, payload) {
    const seq = (this.seqs.get(stream) || 0) + 1;
    this.seqs.set(stream, seq);
    const event = { seq, stream, payload };
    const buffer = this.buffers.get(stream) || [];
    buffer.push(event);
    if (buffer.length > this.maxBuffer) {
      buffer.splice(0, buffer.length - this.maxBuffer);
    }
    this.buffers.set(stream, buffer);
    for (const queue of this.subs.get(stream) || []) {
      queue.push(event);
    }
    return event;
  }
  async subscribe(stream, sinceSeq = 0) {
    const queue = new AsyncQueue(this.subscriberQueueMax);
    for (const event of this.buffers.get(stream) || []) {
      if (event.seq > sinceSeq) {
        queue.push(event);
      }
    }
    let subs = this.subs.get(stream);
    if (!subs) {
      subs = /* @__PURE__ */ new Set();
      this.subs.set(stream, subs);
    }
    subs.add(queue);
    return queue;
  }
  async unsubscribe(stream, queue) {
    this.subs.get(stream)?.delete(queue);
    queue.close();
  }
  lastSeq(stream) {
    return this.seqs.get(stream) || 0;
  }
};

// src/fileIO.ts
var import_node_fs3 = __toESM(require("fs"));
var import_node_path4 = __toESM(require("path"));
function ensureDirFor(filePath) {
  import_node_fs3.default.mkdirSync(import_node_path4.default.dirname(filePath), { recursive: true });
}
function rotateFileIfNeeded(filePath, maxMb) {
  if (maxMb <= 0 || !import_node_fs3.default.existsSync(filePath)) {
    return;
  }
  const maxBytes = maxMb * 1024 * 1024;
  const stat = import_node_fs3.default.statSync(filePath);
  if (stat.size < maxBytes) {
    return;
  }
  const rotated = `${filePath}.1`;
  if (import_node_fs3.default.existsSync(rotated)) {
    import_node_fs3.default.unlinkSync(rotated);
  }
  import_node_fs3.default.renameSync(filePath, rotated);
}
function readLastLines(filePath, lineCount) {
  if (lineCount <= 0 || !import_node_fs3.default.existsSync(filePath)) {
    return "";
  }
  const fd = import_node_fs3.default.openSync(filePath, "r");
  try {
    const stat = import_node_fs3.default.fstatSync(fd);
    if (stat.size === 0) {
      return "";
    }
    const chunkSize = 64 * 1024;
    let position = stat.size;
    let buffer = "";
    let lines = [];
    while (position > 0 && lines.length <= lineCount) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      import_node_fs3.default.readSync(fd, chunk, 0, size, position);
      buffer = `${chunk.toString("utf8")}${buffer}`;
      lines = buffer.split(/\r?\n/);
    }
    const trimmed = lines.filter((line) => line.length > 0);
    return trimmed.slice(Math.max(0, trimmed.length - lineCount)).join("\n");
  } finally {
    import_node_fs3.default.closeSync(fd);
  }
}
function readJsonlTail(filePath, lineCount) {
  const tail = readLastLines(filePath, lineCount);
  return tail ? tail.split(/\r?\n/).filter(Boolean) : [];
}

// src/health.ts
var HealthMonitor = class {
  constructor(cfg, registry, sessions, eventBus, factory) {
    this.cfg = cfg;
    this.registry = registry;
    this.sessions = sessions;
    this.eventBus = eventBus;
    this.factory = factory;
  }
  cfg;
  registry;
  sessions;
  eventBus;
  factory;
  healedAt = /* @__PURE__ */ new Map();
  stuckTurnNotified = /* @__PURE__ */ new Map();
  replaceConfig(cfg) {
    this.cfg = cfg;
  }
  async tickOnce() {
    const entries = this.registry.list();
    const concurrency = Math.max(1, this.cfg.heartbeat.healthCheckConcurrency);
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, entries.length || 1) }, async () => {
      while (index < entries.length) {
        const current = entries[index];
        index += 1;
        await this.checkEntry(current);
      }
    });
    await Promise.all(workers);
  }
  async checkEntry(entry) {
    if (entry.status === "closed") {
      this.stuckTurnNotified.delete(entry.name);
      return;
    }
    const session = this.sessions.get(entry.name);
    if (!session) {
      this.stuckTurnNotified.delete(entry.name);
      await this.onDown(entry.name);
      return;
    }
    this.maybeEmitTurnStuck(entry.name, session);
    try {
      if (!session.isTransportAlive()) {
        throw new Error("transport is not alive");
      }
      await withTimeout(session.healthCheck(), this.cfg.heartbeat.healthTimeoutSeconds * 1e3);
    } catch (error) {
      this.registry.update(entry.name, {
        status: "errored",
        errorMessage: error.message
      });
      await this.onDown(entry.name, session);
    }
  }
  maybeEmitTurnStuck(name, session) {
    if (!session.isRunning()) {
      this.stuckTurnNotified.delete(name);
      return;
    }
    const turnId = session.currentTurnId();
    const ageMs = session.currentTurnAgeMs();
    if (!turnId || ageMs == null) {
      this.stuckTurnNotified.delete(name);
      return;
    }
    const thresholdMs = this.cfg.heartbeat.turnStuckSeconds * 1e3;
    if (ageMs < thresholdMs) {
      if (this.stuckTurnNotified.get(name) !== turnId) {
        this.stuckTurnNotified.delete(name);
      }
      return;
    }
    if (this.stuckTurnNotified.get(name) === turnId) {
      return;
    }
    this.stuckTurnNotified.set(name, turnId);
    this.eventBus.publish("events", {
      kind: "turn-stuck",
      session: name,
      turn_id: turnId,
      age_ms: ageMs,
      threshold_ms: thresholdMs
    });
  }
  async onDown(name, session) {
    const entry = this.registry.get(name);
    const lastHealedAt = this.healedAt.get(name);
    const duringTurn = session?.isRunning() || entry.status === "running";
    const activeTurnId = session?.currentTurnId() || entry.lastTurnId || null;
    const turnAgeMs = session?.currentTurnAgeMs() ?? null;
    const migratedQueue = session ? await session.detachForRecovery("auto-heal queue migration") : [];
    if (session) {
      this.sessions.delete(name);
    }
    const canAttemptHeal = this.cfg.heartbeat.selfHealOnce && !entry.ephemeral && (lastHealedAt == null || Date.now() - lastHealedAt >= this.cfg.heartbeat.selfHealBackoffSeconds * 1e3);
    if (canAttemptHeal) {
      this.healedAt.set(name, Date.now());
      try {
        const resumed = await withTimeout(
          this.factory.resume(name),
          this.cfg.heartbeat.resumeTimeoutSeconds * 1e3
        );
        await resumed.absorbQueue(migratedQueue);
        this.sessions.set(name, resumed);
        this.registry.update(name, {
          status: "idle",
          errorMessage: null
        });
        this.eventBus.publish("events", {
          kind: duringTurn ? "auto-heal-after-crash" : "subprocess-recycled",
          session: name,
          heal_reason: duringTurn ? "transport_down_during_turn" : "transport_down_idle",
          was_during_turn: duringTurn,
          turn_id: activeTurnId,
          turn_age_ms: turnAgeMs,
          legacy_kind: "auto-heal"
        });
        return;
      } catch (error) {
        for (const item of migratedQueue) {
          item.waitRejecter?.(new Error(`auto-heal failed for ${name}: ${error.message}`));
        }
        this.registry.update(name, {
          status: "errored",
          errorMessage: error.message
        });
      }
    }
    if (!canAttemptHeal) {
      for (const item of migratedQueue) {
        item.waitRejecter?.(new Error(`session ${name} went down and could not be auto-healed`));
      }
    }
    this.eventBus.publish("events", {
      kind: "session-down",
      session: name,
      reason: duringTurn ? "transport_down_during_turn" : "transport_down_idle",
      was_during_turn: duringTurn,
      turn_id: activeTurnId,
      turn_age_ms: turnAgeMs,
      queued_items_migrated: migratedQueue.length,
      lastError: entry.errorMessage || "",
      stderrTail: session?.stderrTail(20) || ""
    });
  }
};
async function withTimeout(promise, timeoutMs) {
  return await Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

// src/registry.ts
var import_node_fs4 = __toESM(require("fs"));
var import_node_path5 = __toESM(require("path"));
var RegistryStore = class {
  constructor(filePath) {
    this.filePath = filePath;
    this.load();
  }
  filePath;
  entries = /* @__PURE__ */ new Map();
  load() {
    if (!import_node_fs4.default.existsSync(this.filePath)) {
      return;
    }
    const raw = import_node_fs4.default.readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) {
      return;
    }
    const sessions = isObject(parsed.sessions) ? parsed.sessions : {};
    for (const [name, value] of Object.entries(sessions)) {
      if (isObject(value)) {
        this.entries.set(name, normalizeEntry(name, value));
      }
    }
  }
  save() {
    import_node_fs4.default.mkdirSync(import_node_path5.default.dirname(this.filePath), { recursive: true });
    const payload = { sessions: Object.fromEntries(this.entries.entries()) };
    const tmpPath = `${this.filePath}.tmp`;
    import_node_fs4.default.writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
    import_node_fs4.default.renameSync(tmpPath, this.filePath);
  }
  create(entry) {
    if (this.entries.has(entry.name)) {
      throw new SessionExists(`session ${JSON.stringify(entry.name)} already exists`);
    }
    this.entries.set(entry.name, cloneEntry(entry));
    this.save();
  }
  get(name) {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new SessionNotFound(`session ${JSON.stringify(name)} not found`);
    }
    return cloneEntry(entry);
  }
  list() {
    return [...this.entries.values()].map(cloneEntry);
  }
  update(name, fields) {
    const current = this.entries.get(name);
    if (!current) {
      throw new SessionNotFound(`session ${JSON.stringify(name)} not found`);
    }
    const updated = { ...current, ...fields };
    this.entries.set(name, updated);
    this.save();
    return cloneEntry(updated);
  }
  delete(name) {
    if (!this.entries.has(name)) {
      throw new SessionNotFound(`session ${JSON.stringify(name)} not found`);
    }
    this.entries.delete(name);
    this.save();
  }
};
function cloneEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}
function normalizeEntry(name, raw) {
  return {
    name,
    threadId: String(raw.threadId ?? ""),
    ephemeral: raw.ephemeral == null ? false : Boolean(raw.ephemeral),
    cwd: String(raw.cwd ?? ""),
    model: String(raw.model ?? ""),
    modelProvider: raw.modelProvider == null ? null : String(raw.modelProvider),
    sandbox: String(raw.sandbox ?? ""),
    approvalPolicy: String(raw.approvalPolicy ?? "never"),
    serviceTier: raw.serviceTier == null ? null : String(raw.serviceTier),
    reasoningEffort: raw.reasoningEffort == null ? null : String(raw.reasoningEffort),
    personality: raw.personality == null ? null : String(raw.personality),
    profile: raw.profile == null ? null : String(raw.profile),
    createdAt: String(raw.createdAt ?? ""),
    lastTurnId: raw.lastTurnId == null ? null : String(raw.lastTurnId),
    lastTurnEndedAt: raw.lastTurnEndedAt == null ? null : String(raw.lastTurnEndedAt),
    lastPromptText: raw.lastPromptText == null ? null : String(raw.lastPromptText),
    status: raw.status || "idle",
    appServerPid: raw.appServerPid == null ? null : Number(raw.appServerPid),
    queueLength: Number(raw.queueLength ?? 0),
    tokenUsageInput: Number(raw.tokenUsageInput ?? 0),
    contextTokensEstimate: raw.contextTokensEstimate == null ? null : Number(raw.contextTokensEstimate),
    modelContextWindow: raw.modelContextWindow == null ? null : Number(raw.modelContextWindow),
    errorMessage: raw.errorMessage == null ? null : String(raw.errorMessage)
  };
}

// src/session.ts
var import_node_fs6 = __toESM(require("fs"));
var import_node_path6 = __toESM(require("path"));
var import_node_crypto = __toESM(require("crypto"));

// src/digest.ts
var import_node_fs5 = __toESM(require("fs"));
var FENCED_BLOCK = /```.*?```/gs;
function truncate(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  const indicator = ` ... (truncated, ${text.length} chars)`;
  return `${text.slice(0, Math.max(0, limit - indicator.length))}${indicator}`;
}
function firstLine(text) {
  return text.split(/\r?\n/, 1)[0] || "";
}
function tailLines(text, count) {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}
function digestItem(item, cfg) {
  const itemType = String(item.type ?? "");
  if (itemType === "commandExecution") {
    return digestCommand(item, cfg);
  }
  if (itemType === "fileChange") {
    return digestFileChange(item);
  }
  if (itemType === "agentMessage") {
    return { kind: "agent_message", text: String(item.text ?? "") };
  }
  if (itemType === "reasoning") {
    if (!cfg.reasoningCapture) {
      return null;
    }
    const summary = Array.isArray(item.summary) ? item.summary.map(String).join(" ") : String(item.summary ?? "");
    return { kind: "agent_message", text: summary };
  }
  if (itemType === "webSearch") {
    return { kind: "web_search", text: String(item.query ?? "") };
  }
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    return digestToolCall(item, cfg);
  }
  if (itemType === "collabAgentToolCall") {
    return { kind: "collab_agent", text: `subagent=${String(item.tool ?? "subagent")}` };
  }
  return null;
}
function digestCommand(item, cfg) {
  const raw = String(item.command ?? "");
  let shown = firstLine(raw);
  if (raw.length > cfg.commandTruncateChars || raw.includes("\n")) {
    shown = truncate(shown, cfg.commandTruncateChars);
  }
  const exitCode = item.exitCode == null ? null : Number(item.exitCode);
  const stderr = String(item.aggregatedOutput ?? "");
  return {
    kind: "command",
    text: shown,
    exitCode,
    durationMs: item.durationMs == null ? null : Number(item.durationMs),
    stderrTail: exitCode == null || exitCode === 0 ? null : tailLines(stderr, cfg.stderrTailLinesOnFail)
  };
}
function digestFileChange(item) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const first = changes[0] || {};
  const pathValue = String(first.path ?? "");
  const linesAdded = Number(first.linesAdded ?? first.lines_added ?? 0);
  const linesRemoved = Number(first.linesRemoved ?? first.lines_removed ?? 0);
  return {
    kind: "file_change",
    text: `${pathValue} (+${linesAdded}/-${linesRemoved})`,
    path: pathValue,
    linesAdded,
    linesRemoved
  };
}
function digestToolCall(item, cfg) {
  const server = String(item.server ?? "");
  const tool = String(item.tool ?? "");
  const argsRaw = item.arguments ?? item.args ?? "";
  let argsText = "";
  try {
    argsText = typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw);
  } catch {
    argsText = String(argsRaw);
  }
  const argsHead = argsText ? truncate(argsText, cfg.toolArgsTruncateChars) : "";
  const label = server ? `${server}/${tool}` : tool;
  return {
    kind: "tool_call",
    text: argsHead ? `${label}(${argsHead})` : label,
    toolName: label
  };
}
function hasQuestion(message) {
  const stripped = message.replace(FENCED_BLOCK, "").trimEnd();
  return stripped.endsWith("?");
}
function classifyTier(lines, status, finalMessage) {
  if (!["ok", "completed"].includes(status)) {
    return "attn";
  }
  if (lines.some((line) => line.kind === "command" && line.exitCode != null && line.exitCode !== 0)) {
    return "attn";
  }
  if (finalMessage && hasQuestion(finalMessage)) {
    return "attn";
  }
  if (lines.some((line) => line.kind === "file_change")) {
    return "normal";
  }
  return "trivial";
}
function buildTurnSummary(input) {
  const filesAdded = input.lines.filter((line) => line.kind === "file_change").reduce((sum, line) => sum + Number(line.linesAdded || 0), 0);
  const filesRemoved = input.lines.filter((line) => line.kind === "file_change").reduce((sum, line) => sum + Number(line.linesRemoved || 0), 0);
  return {
    ...input,
    filesAdded,
    filesRemoved,
    tier: classifyTier(input.lines, input.status, input.finalMessage)
  };
}
function formatLine(line) {
  if (line.kind === "command") {
    const status = line.exitCode === 0 ? "ok" : `FAIL exit=${line.exitCode}`;
    const suffix = line.stderrTail ? `
    stderr: ${line.stderrTail}` : "";
    return `- [${status} ${line.durationMs || 0}ms] ${line.text}${suffix}`;
  }
  if (line.kind === "file_change") {
    return `- M ${line.path || ""} (+${line.linesAdded || 0}/-${line.linesRemoved || 0})`;
  }
  if (line.kind === "agent_message") {
    return `- msg: ${line.text}`;
  }
  if (line.kind === "tool_call") {
    return `- tool: ${line.text}`;
  }
  if (line.kind === "web_search") {
    return `- search: ${line.text}`;
  }
  return `- ${line.text}`;
}
function writeHistoryMd(filePath, summary, cfg) {
  ensureDirFor(filePath);
  if (cfg) {
    rotateFileIfNeeded(filePath, cfg.historyRotationMb);
  }
  const parts = [
    `
## Turn ${summary.turnId} \xB7 ${summary.elapsedMs}ms \xB7 status=${summary.status} \xB7 tier=${summary.tier}
`
  ];
  const fileLines = summary.lines.filter((line) => line.kind === "file_change");
  if (fileLines.length > 0) {
    parts.push("\n### File changes\n");
    parts.push(fileLines.map(formatLine).join("\n"));
    parts.push("\n");
  }
  const commandLines = summary.lines.filter((line) => line.kind === "command");
  if (commandLines.length > 0) {
    parts.push("\n### Commands\n");
    parts.push(commandLines.map(formatLine).join("\n"));
    parts.push("\n");
  }
  const messageLines = summary.lines.filter((line) => line.kind === "agent_message");
  if (messageLines.length > 0) {
    parts.push("\n### Messages\n");
    parts.push(messageLines.map(formatLine).join("\n"));
    parts.push("\n");
  }
  if (summary.finalMessage) {
    parts.push("\n### Final answer\n");
    parts.push(`> ${summary.finalMessage.replace(/\n/g, "\n> ")}
`);
  }
  import_node_fs5.default.appendFileSync(filePath, parts.join(""), "utf8");
}
function writeTurnsJsonl(filePath, summary, cfg) {
  ensureDirFor(filePath);
  if (cfg) {
    rotateFileIfNeeded(filePath, cfg.historyRotationMb);
  }
  import_node_fs5.default.appendFileSync(filePath, `${JSON.stringify(summary)}
`, "utf8");
}

// src/queue.ts
var SendQueue = class {
  constructor(maxSize, policy) {
    this.maxSize = maxSize;
    this.policy = policy;
  }
  maxSize;
  policy;
  items = [];
  enqueue(item) {
    if (this.items.length < this.maxSize) {
      this.items.push(item);
      return { overflowed: false };
    }
    if (this.policy === "reject") {
      throw new QueueFull(`queue full (max=${this.maxSize})`, { size: this.maxSize });
    }
    if (this.policy === "drop_oldest") {
      const dropped2 = this.items.shift();
      this.items.push(item);
      return { overflowed: false, dropped: dropped2 };
    }
    const dropped = this.items.shift();
    this.items.push(item);
    return { overflowed: true, dropped };
  }
  pop() {
    return this.items.shift();
  }
  snapshot() {
    return [...this.items];
  }
  clear() {
    this.items.length = 0;
  }
  dropOldest() {
    return this.items.shift();
  }
  get length() {
    return this.items.length;
  }
};

// src/codex/appServerClient.ts
var import_node_child_process2 = require("child_process");
var import_node_readline2 = __toESM(require("readline"));
var BUFFERED_NOTIFICATION_METHODS = /* @__PURE__ */ new Set([
  "item/started",
  "item/completed",
  "turn/started",
  "turn/completed",
  "thread/tokenUsageUpdated",
  "thread/tokenUsage/updated"
]);
var OPT_OUT_NOTIFICATION_METHODS = [
  "item/agentMessage/delta",
  "item/reasoning/delta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "turn/diff/updated",
  "turn/plan/updated"
];
function responseErrorMessage(error) {
  if (isObject(error)) {
    const code = error.code == null ? "" : `code=${String(error.code)} `;
    return `${code}${String(error.message ?? "unknown error")}`.trim();
  }
  return String(error);
}
var AppServerClient = class {
  constructor(cfg) {
    this.cfg = cfg;
  }
  cfg;
  proc = null;
  notifications = new AsyncQueue(1e3);
  pending = /* @__PURE__ */ new Map();
  stderrLines = [];
  nextRequestId = 0;
  readLoopStarted = false;
  closeError = null;
  initialized = false;
  get pid() {
    return this.proc?.pid ?? null;
  }
  isAlive() {
    return !!this.proc && this.proc.exitCode == null && !this.proc.killed;
  }
  stderrSnapshot() {
    return [...this.stderrLines];
  }
  stderrTail(limit = 40) {
    return this.stderrLines.slice(Math.max(0, this.stderrLines.length - limit)).join("\n");
  }
  async start() {
    if (this.proc) {
      return;
    }
    const args = this.buildArgs();
    const env = { ...process.env };
    if (this.cfg.daemon.codexHome) {
      env.CODEX_HOME = this.cfg.daemon.codexHome;
    }
    this.proc = (0, import_node_child_process2.spawn)(resolveCodexBin(this.cfg), args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: void 0,
      env
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line) {
          continue;
        }
        this.stderrLines.push(line);
        if (this.stderrLines.length > 400) {
          this.stderrLines.splice(0, this.stderrLines.length - 400);
        }
      }
    });
    this.proc.once("error", (error) => {
      this.failAll(new TransportError(`failed to start app-server: ${error.message}`));
    });
    this.proc.once("exit", (code, signal) => {
      this.failAll(
        new TransportError(
          `app-server exited${signal ? ` via ${signal}` : ` with code ${String(code ?? 1)}`}: ${this.stderrTail(20)}`
        )
      );
    });
    this.startReadLoop();
    await this.initialize();
  }
  buildArgs() {
    if (this.cfg.daemon.launchArgsOverride.length > 0) {
      return [...this.cfg.daemon.launchArgsOverride];
    }
    const args = [];
    for (const override of this.cfg.daemon.configOverrides) {
      args.push("--config", override);
    }
    args.push("app-server", "--listen", "stdio://");
    return args;
  }
  startReadLoop() {
    if (this.readLoopStarted || !this.proc) {
      return;
    }
    this.readLoopStarted = true;
    this.proc.stdout.setEncoding("utf8");
    const rl = import_node_readline2.default.createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity
    });
    void (async () => {
      try {
        for await (const line of rl) {
          if (!line) {
            continue;
          }
          this.handleLine(line);
        }
        this.failAll(new TransportError(`app-server closed stdout: ${this.stderrTail(20)}`));
      } catch (error) {
        this.failAll(new TransportError(`failed to read app-server stream: ${error.message}`));
      } finally {
        rl.close();
      }
    })();
  }
  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.failAll(new TransportError(`invalid JSON-RPC line: ${error.message}`));
      return;
    }
    if (!isObject(message)) {
      return;
    }
    const id = message.id;
    const method = message.method;
    if (typeof method === "string" && id !== void 0) {
      void this.handleServerRequest(String(id), method, isObject(message.params) ? message.params : {}).catch((error) => {
        this.failAll(new TransportError(`failed to handle server request ${method}: ${error.message}`));
      });
      return;
    }
    if (typeof method === "string") {
      if (!BUFFERED_NOTIFICATION_METHODS.has(method)) {
        return;
      }
      this.notifications.push({
        method,
        params: isObject(message.params) ? message.params : {}
      });
      return;
    }
    if (id === void 0) {
      return;
    }
    const pending = this.pending.get(String(id));
    if (!pending) {
      return;
    }
    this.pending.delete(String(id));
    if (message.error !== void 0) {
      pending.reject(new TransportError(`${pending.method}: ${responseErrorMessage(message.error)}`));
      return;
    }
    pending.resolve(isObject(message.result) ? message.result : {});
  }
  async handleServerRequest(id, method, params) {
    let result = {};
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/permissions/requestApproval") {
      result = { decision: "accept" };
    } else if (method === "item/tool/call") {
      result = { success: false, content: [], structuredContent: null };
    } else if (method === "item/commandExecution/requestCallback") {
      result = { decision: "accept" };
    } else {
      void params;
      result = {};
    }
    this.write({ id, result });
  }
  async initialize() {
    if (this.initialized) {
      return;
    }
    const payload = await this.request("initialize", {
      clientInfo: {
        name: "codex-team",
        title: "Codex Team",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: OPT_OUT_NOTIFICATION_METHODS
      }
    });
    validateInitializeResponse(payload);
    this.notify("initialized", {});
    this.initialized = true;
  }
  request(method, params) {
    if (!this.proc || this.closeError) {
      throw this.closeError ?? new TransportError("app-server is not running");
    }
    const id = `rpc-${++this.nextRequestId}`;
    return awaitResponse(
      () => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new TransportError(`${method}: timed out after ${this.cfg.daemon.rpcTimeoutSeconds}s`));
        }, this.cfg.daemon.rpcTimeoutSeconds * 1e3);
        this.pending.set(id, {
          method,
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          }
        });
        try {
          this.write({ id, method, params });
        } catch (error) {
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(error);
        }
      })
    );
  }
  notify(method, params) {
    if (!this.proc || this.closeError) {
      return;
    }
    this.write({ method, params });
  }
  async nextNotification(timeoutMs = 0, timeoutMessage = "timed out waiting for notification") {
    return await this.notifications.shift(timeoutMs, timeoutMessage);
  }
  async threadStart(params) {
    const response = await this.request("thread/start", params);
    requireThreadId(response, "thread/start");
    return response;
  }
  async threadResume(threadId, params) {
    const response = await this.request("thread/resume", { threadId, ...params });
    requireThreadId(response, "thread/resume");
    return response;
  }
  async threadRead(threadId, includeTurns = false) {
    const response = await this.request("thread/read", { threadId, includeTurns });
    requireThreadId(response, "thread/read");
    return response;
  }
  async threadArchive(threadId) {
    return await this.request("thread/archive", { threadId });
  }
  async threadCompactStart(threadId) {
    return await this.request("thread/compact/start", { threadId });
  }
  async turnStart(params) {
    const response = await this.request("turn/start", params);
    const turn = isObject(response.turn) ? response.turn : null;
    if (!turn || typeof turn.id !== "string" || !turn.id) {
      throw new TransportError("turn/start response missing turn.id");
    }
    return response;
  }
  async turnInterrupt(threadId, turnId) {
    return await this.request("turn/interrupt", { threadId, turnId });
  }
  kill() {
    this.proc?.kill("SIGKILL");
  }
  async close() {
    const proc = this.proc;
    this.proc = null;
    this.initialized = false;
    this.failAll(new TransportError("app-server client closed"));
    if (!proc) {
      return;
    }
    const exitPromise = new Promise((resolve) => {
      if (proc.exitCode != null || proc.killed) {
        resolve();
        return;
      }
      proc.once("exit", () => resolve());
    });
    if (proc.stdin.writable) {
      proc.stdin.end();
    }
    if (proc.exitCode == null && !proc.killed) {
      proc.kill("SIGTERM");
    }
    const timeout = new Promise((resolve) => {
      setTimeout(resolve, 1500);
    });
    await Promise.race([exitPromise, timeout]);
    if (proc.exitCode == null && !proc.killed) {
      proc.kill("SIGKILL");
      await exitPromise.catch(() => void 0);
    }
  }
  write(payload) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new TransportError("app-server stdin is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}
`);
  }
  failAll(error) {
    if (this.closeError) {
      return;
    }
    this.closeError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.notifications.close(error);
  }
};
async function awaitResponse(factory) {
  return await factory();
}
function requireThreadId(response, method) {
  const thread = isObject(response.thread) ? response.thread : null;
  if (!thread || typeof thread.id !== "string" || !thread.id) {
    throw new TransportError(`${method} response missing thread.id`);
  }
}
function validateInitializeResponse(response) {
  const userAgent = typeof response.userAgent === "string" ? response.userAgent.trim() : "";
  const server = isObject(response.serverInfo) ? response.serverInfo : null;
  let serverName = server && typeof server.name === "string" ? server.name.trim() : "";
  let serverVersion = server && typeof server.version === "string" ? server.version.trim() : "";
  if ((!serverName || !serverVersion) && userAgent) {
    const parsed = splitUserAgent(userAgent);
    serverName ||= parsed.name || "";
    serverVersion ||= parsed.version || "";
  }
  if (!userAgent || !serverName || !serverVersion) {
    throw new TransportError(
      `initialize response missing required metadata (userAgent=${JSON.stringify(userAgent)}, serverName=${JSON.stringify(serverName)}, serverVersion=${JSON.stringify(serverVersion)})`
    );
  }
}
function splitUserAgent(userAgent) {
  const raw = userAgent.trim();
  if (!raw) {
    return { name: null, version: null };
  }
  if (raw.includes("/")) {
    const [name, ...rest] = raw.split("/");
    return { name: name || null, version: rest.join("/") || null };
  }
  const parts = raw.split(/\s+/, 2);
  if (parts.length === 2) {
    return { name: parts[0] || null, version: parts[1] || null };
  }
  return { name: raw, version: null };
}

// src/session.ts
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function pendingId() {
  return `pending-${import_node_crypto.default.randomUUID().slice(0, 8)}`;
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
var Session = class {
  constructor(name, cfg, dataDir, registry, eventBus, compaction, client, threadId) {
    this.name = name;
    this.cfg = cfg;
    this.dataDir = dataDir;
    this.registry = registry;
    this.eventBus = eventBus;
    this.compaction = compaction;
    this.client = client;
    this.threadId = threadId;
    this.queue = new SendQueue(cfg.queue.maxPerSession, cfg.queue.overflowPolicy);
  }
  name;
  cfg;
  dataDir;
  registry;
  eventBus;
  compaction;
  client;
  threadId;
  queue;
  activeTurnId = null;
  activeTurnStartedAtMs = null;
  closed = false;
  active = true;
  running = false;
  stateLock = Promise.resolve();
  stderrFlushedCount = 0;
  replaceConfig(cfg) {
    this.cfg = cfg;
  }
  async send(text, options = {}) {
    const placeholderId = pendingId();
    let waitPromise;
    let resolveWait;
    let rejectWait;
    if (options.wait) {
      waitPromise = new Promise((resolve, reject) => {
        resolveWait = resolve;
        rejectWait = reject;
      });
    }
    await this.withStateLock(async () => {
      if (this.closed) {
        throw new SessionNotFound(this.name);
      }
      if (this.running) {
        const enqueueResult = this.queue.enqueue({
          id: placeholderId,
          text,
          waitResolver: resolveWait,
          waitRejecter: rejectWait,
          overrides: options.overrides || null
        });
        if (enqueueResult.dropped) {
          this.rejectPending(enqueueResult.dropped, new Error(`queued send ${enqueueResult.dropped.id} was dropped`));
        }
        this.registry.update(this.name, { queueLength: this.queue.length });
        if (enqueueResult.overflowed) {
          this.eventBus.publish("events", {
            kind: "queue-overflow",
            session: this.name,
            policy: this.cfg.queue.overflowPolicy,
            dropped_id: enqueueResult.dropped?.id ?? null
          });
        }
        return;
      }
      this.running = true;
      this.registry.update(this.name, { status: "running" });
      void this.runTurn(placeholderId, text, resolveWait, rejectWait, options.overrides || null);
    });
    if (waitPromise) {
      return await waitPromise;
    }
    return placeholderId;
  }
  async interrupt() {
    if (this.activeTurnId) {
      await this.client.turnInterrupt(this.threadId, this.activeTurnId);
    }
  }
  async kill(reason = "killed by operator") {
    await this.withStateLock(async () => {
      this.active = false;
      this.closed = true;
      this.running = false;
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
      this.rejectQueuedWaiters(new Error(reason));
      this.queue.clear();
      this.registry.update(this.name, { queueLength: 0, appServerPid: null });
    });
    this.client.kill();
    await this.client.close();
    this.registry.update(this.name, {
      status: "errored",
      appServerPid: null,
      queueLength: 0,
      errorMessage: reason
    });
  }
  async ackError() {
    this.registry.update(this.name, { status: "idle", errorMessage: null });
  }
  async compact() {
    await this.withStateLock(async () => {
      if (this.running) {
        throw new SessionBusy(`session ${this.name} is running; compact after the active turn finishes`);
      }
      this.running = true;
      this.registry.update(this.name, { status: "compacting" });
    });
    const attempts = Math.max(1, this.cfg.compaction.retryAttempts + 1);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await this.runCompactAttempt();
        this.compaction?.clear(this.name);
        this.registry.update(this.name, {
          status: "idle",
          tokenUsageInput: result.usageTotal ?? 0,
          contextTokensEstimate: result.contextTokensEstimate ?? 0,
          modelContextWindow: result.modelContextWindow ?? this.registry.get(this.name).modelContextWindow ?? null,
          errorMessage: null
        });
        await this.dispatchNextQueued();
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= attempts) {
          break;
        }
        this.eventBus.publish("events", {
          kind: "compact-retry",
          session: this.name,
          attempt,
          max_attempts: attempts,
          error: lastError.message
        });
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, this.cfg.compaction.retryDelayMs)));
      }
    }
    this.registry.update(this.name, {
      status: "errored",
      errorMessage: lastError?.message || "compact failed"
    });
    await this.withStateLock(async () => {
      this.running = false;
    });
    throw lastError || new Error("compact failed");
  }
  async runCompactAttempt() {
    await this.client.threadCompactStart(this.threadId);
    let sawCompaction = false;
    let usageTotal = null;
    let contextTokensEstimate = null;
    let modelContextWindow = null;
    while (true) {
      const note = await this.client.nextNotification(
        this.cfg.compaction.timeoutSeconds * 1e3,
        `compact timed out after ${this.cfg.compaction.timeoutSeconds}s`
      );
      this.handleUsageNotification(note, String(note.params.turnId ?? ""), (payload) => {
        usageTotal = payload.usageTotalTokens;
        contextTokensEstimate = payload.contextTokensEstimate;
        modelContextWindow = payload.modelContextWindow;
      });
      if (note.method === "item/started" || note.method === "item/completed") {
        const item = asRecord(note.params.item);
        if (String(item.type ?? "") === "contextCompaction") {
          sawCompaction = true;
          if (note.method === "item/completed") {
            continue;
          }
        }
      }
      if (sawCompaction && note.method === "turn/completed") {
        const turn = asRecord(note.params.turn);
        const status = String(turn.status ?? "completed");
        if (!["completed", "ok"].includes(status)) {
          const turnError = asRecord(turn.error);
          throw new Error(String(turnError.message ?? `compact turn ended with status ${status}`));
        }
        return {
          usageTotal,
          contextTokensEstimate,
          modelContextWindow
        };
      }
    }
  }
  snapshotQueue() {
    return this.queue.snapshot();
  }
  snapshotQueueJson() {
    return this.queue.snapshot().map((item) => ({
      id: item.id,
      text: item.text,
      hasWaiter: !!item.waitResolver,
      overrides: item.overrides || {}
    }));
  }
  dumpState() {
    const sessionPath = sessionDir(this.dataDir, this.name);
    return {
      session: this.registry.get(this.name),
      queue: this.snapshotQueueJson(),
      transport_alive: this.isTransportAlive(),
      stderr_tail: this.stderrTail(20),
      history_path: import_node_path6.default.join(sessionPath, "history.md"),
      turns_path: import_node_path6.default.join(sessionPath, "turns.jsonl")
    };
  }
  async read(includeTurns = false) {
    return await this.client.threadRead(this.threadId, includeTurns);
  }
  async archiveThread() {
    await this.client.threadArchive(this.threadId);
  }
  async detachForRecovery(reason = "detached for recovery") {
    let queued = [];
    await this.withStateLock(async () => {
      this.active = false;
      this.closed = true;
      this.running = false;
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
      queued = this.queue.snapshot();
      this.queue.clear();
      this.registry.update(this.name, {
        queueLength: 0,
        appServerPid: null
      });
    });
    await this.client.close();
    return queued;
  }
  async absorbQueue(items) {
    if (items.length === 0) {
      return;
    }
    await this.withStateLock(async () => {
      for (const item of items) {
        const enqueueResult = this.queue.enqueue(item);
        if (enqueueResult.dropped) {
          this.rejectPending(enqueueResult.dropped, new Error(`queued send ${enqueueResult.dropped.id} was dropped`));
        }
      }
      this.registry.update(this.name, { queueLength: this.queue.length });
      if (!this.running) {
        const next = this.queue.pop();
        this.registry.update(this.name, { queueLength: this.queue.length });
        if (!next) {
          return;
        }
        this.running = true;
        this.registry.update(this.name, { status: "running" });
        void this.runTurn(next.id, next.text, next.waitResolver, next.waitRejecter, next.overrides || null);
      }
    });
  }
  clearQueue() {
    this.rejectQueuedWaiters(new Error(`queue for ${this.name} was cleared`));
    this.queue.clear();
    this.registry.update(this.name, { queueLength: 0 });
  }
  dropOldest() {
    const dropped = this.queue.dropOldest();
    if (dropped) {
      this.rejectPending(dropped, new Error(`queued send ${dropped.id} was dropped`));
    }
    this.registry.update(this.name, { queueLength: this.queue.length });
    return dropped;
  }
  async close() {
    await this.withStateLock(async () => {
      this.active = false;
      this.closed = true;
      this.running = false;
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
      this.rejectQueuedWaiters(new Error(`session ${this.name} was closed`));
      this.queue.clear();
      this.registry.update(this.name, { queueLength: 0, appServerPid: null });
    });
    await this.shutdownTransport();
    this.registry.update(this.name, { status: "closed", appServerPid: null, queueLength: 0 });
  }
  async shutdown() {
    await this.withStateLock(async () => {
      this.active = false;
      this.closed = true;
      this.running = false;
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
      this.rejectQueuedWaiters(new Error(`session ${this.name} is shutting down`));
      this.queue.clear();
      this.registry.update(this.name, { queueLength: 0, appServerPid: null });
    });
    await this.shutdownTransport();
    const current = this.registry.get(this.name);
    if (current.status === "closed") {
      return;
    }
    this.registry.update(this.name, {
      status: current.errorMessage ? "errored" : "idle",
      appServerPid: null,
      queueLength: 0
    });
  }
  async healthCheck() {
    await this.read(false);
  }
  isTransportAlive() {
    return this.client.isAlive();
  }
  isRunning() {
    return this.running;
  }
  currentTurnId() {
    return this.activeTurnId;
  }
  currentTurnAgeMs() {
    if (!this.running || this.activeTurnStartedAtMs == null) {
      return null;
    }
    return Date.now() - this.activeTurnStartedAtMs;
  }
  stderrTail(limit = 40) {
    return this.client.stderrTail(limit);
  }
  async shutdownTransport() {
    this.persistStderrLog();
    await this.client.close();
  }
  persistStderrLog() {
    const lines = this.client.stderrSnapshot();
    if (lines.length === 0) {
      return;
    }
    if (this.stderrFlushedCount > lines.length) {
      this.stderrFlushedCount = 0;
    }
    const pending = lines.slice(this.stderrFlushedCount);
    if (pending.length === 0) {
      return;
    }
    const filePath = import_node_path6.default.join(sessionDir(this.dataDir, this.name), "app-server.stderr.log");
    ensureDirFor(filePath);
    import_node_fs6.default.appendFileSync(filePath, `${pending.join("\n")}
`, "utf8");
    this.stderrFlushedCount = lines.length;
  }
  rejectQueuedWaiters(error) {
    for (const item of this.queue.snapshot()) {
      this.rejectPending(item, error);
    }
  }
  rejectPending(item, error) {
    try {
      item.waitRejecter?.(error);
    } catch {
    }
  }
  async withStateLock(fn) {
    const previous = this.stateLock;
    let release;
    this.stateLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async runTurn(pendingTurnId, text, resolveWait, rejectWait, overrides) {
    const lines = [];
    let finalMessage = null;
    let status = "completed";
    let errorMessage = null;
    let turnId = "unknown";
    let usageLast = null;
    let usageTotal = null;
    let contextTokensEstimate = null;
    let modelContextWindow = null;
    const started = Date.now();
    let waitSettled = false;
    this.registry.update(this.name, { lastPromptText: text });
    try {
      const response = await this.client.turnStart(buildTurnStartParams(this.threadId, text, overrides));
      turnId = String(asRecord(response.turn).id ?? turnId);
      this.activeTurnId = turnId;
      this.activeTurnStartedAtMs = Date.now();
      this.eventBus.publish("events", {
        kind: "turn-start",
        session: this.name,
        queued_or_turn_id: pendingTurnId,
        turn_id: turnId
      });
      while (true) {
        const notification = await this.client.nextNotification();
        this.handleUsageNotification(notification, turnId, (payload) => {
          usageLast = payload.usageLastTokens;
          usageTotal = payload.usageTotalTokens;
          contextTokensEstimate = payload.contextTokensEstimate;
          modelContextWindow = payload.modelContextWindow;
        });
        if (notification.method === "item/completed") {
          const params = notification.params;
          if (String(params.turnId ?? "") !== turnId) {
            continue;
          }
          const item = asRecord(params.item);
          const line = digestItem(item, this.cfg.digest);
          if (line) {
            lines.push(line);
            if (line.kind === "agent_message") {
              const phase = item.phase == null ? null : String(item.phase);
              if (phase === "final_answer" || phase === null) {
                finalMessage = line.text;
              }
            }
          }
          continue;
        }
        if (notification.method === "turn/completed") {
          const params = notification.params;
          const turn = asRecord(params.turn);
          if (String(turn.id ?? "") !== turnId) {
            continue;
          }
          status = String(turn.status ?? status);
          const turnError = asRecord(turn.error);
          errorMessage = turn.error == null ? null : String(turnError.message ?? "turn failed");
          break;
        }
      }
    } catch (error) {
      status = "failed";
      errorMessage = error.message;
      if (rejectWait) {
        rejectWait(error);
        waitSettled = true;
      }
    } finally {
      this.activeTurnId = null;
      this.activeTurnStartedAtMs = null;
    }
    const completedAt = nowIso();
    const summary = buildTurnSummary({
      session: this.name,
      turnId,
      elapsedMs: Date.now() - started,
      status: status === "completed" ? "ok" : status,
      lines,
      finalMessage,
      usageLastTokens: usageLast,
      usageTotalTokens: usageTotal,
      contextTokensEstimate,
      modelContextWindow,
      errorMessage,
      completedAt
    });
    const sessionPath = sessionDir(this.dataDir, this.name);
    if (this.cfg.digest.historyMdEnabled) {
      writeHistoryMd(import_node_path6.default.join(sessionPath, "history.md"), summary, this.cfg.digest);
    }
    if (this.cfg.digest.turnsJsonlEnabled) {
      writeTurnsJsonl(import_node_path6.default.join(sessionPath, "turns.jsonl"), summary, this.cfg.digest);
    }
    if (usageTotal != null || contextTokensEstimate != null) {
      await this.compaction?.observeUsage(this.name, {
        contextTokensEstimate,
        modelContextWindow,
        cumulativeUsageTokens: usageTotal
      });
    }
    this.persistStderrLog();
    if (!this.active) {
      if (rejectWait && !waitSettled) {
        rejectWait(new Error(`session ${this.name} is no longer active`));
      }
      return;
    }
    this.registry.update(this.name, {
      status: summary.status === "ok" ? "idle" : "errored",
      lastTurnId: turnId,
      lastTurnEndedAt: completedAt,
      queueLength: this.queue.length,
      tokenUsageInput: usageTotal || 0,
      contextTokensEstimate,
      modelContextWindow,
      errorMessage,
      appServerPid: this.client.pid
    });
    this.eventBus.publish("events", {
      kind: summary.tier === "attn" ? "turn-attn" : "turn-done",
      session: this.name,
      ...summaryToWire(summary)
    });
    if (resolveWait && summary.status === "ok") {
      resolveWait(summaryToWire(summary));
      waitSettled = true;
    } else if (rejectWait && !waitSettled) {
      rejectWait(new Error(summary.errorMessage || `turn ${summary.turnId} finished with status ${summary.status}`));
      waitSettled = true;
    }
    await this.dispatchNextQueued();
  }
  async dispatchNextQueued() {
    let next;
    await this.withStateLock(async () => {
      next = this.queue.pop();
      this.registry.update(this.name, { queueLength: this.queue.length });
      if (!next) {
        this.running = false;
      } else {
        this.running = true;
        this.registry.update(this.name, { status: "running" });
      }
    });
    if (next) {
      void this.runTurn(next.id, next.text, next.waitResolver, next.waitRejecter, next.overrides || null);
    }
    return next;
  }
  handleUsageNotification(notification, turnId, setUsage) {
    if (notification.method !== "thread/tokenUsageUpdated" && notification.method !== "thread/tokenUsage/updated") {
      return;
    }
    if (String(notification.params.turnId ?? "") !== turnId) {
      return;
    }
    const tokenUsage = asRecord(notification.params.tokenUsage);
    const last = asRecord(tokenUsage.last);
    const total = asRecord(tokenUsage.total);
    const inputTokens = last.inputTokens == null ? null : Number(last.inputTokens);
    const cachedInputTokens = last.cachedInputTokens == null ? null : Number(last.cachedInputTokens);
    setUsage({
      usageLastTokens: last.totalTokens == null ? null : Number(last.totalTokens),
      usageTotalTokens: total.totalTokens == null ? null : Number(total.totalTokens),
      contextTokensEstimate: inputTokens == null && cachedInputTokens == null ? null : (inputTokens || 0) + (cachedInputTokens || 0),
      modelContextWindow: tokenUsage.modelContextWindow == null ? null : Number(tokenUsage.modelContextWindow)
    });
  }
};
var SessionFactory = class {
  constructor(cfg, registry, eventBus, compaction = null, clientFactory = (cfg2) => new AppServerClient(cfg2)) {
    this.cfg = cfg;
    this.registry = registry;
    this.eventBus = eventBus;
    this.compaction = compaction;
    this.clientFactory = clientFactory;
  }
  cfg;
  registry;
  eventBus;
  compaction;
  clientFactory;
  replaceConfig(cfg) {
    this.cfg = cfg;
  }
  dataDir() {
    return this.cfg.daemon.dataDir;
  }
  async create(name, options = {}) {
    this.ensureNameAvailable(name);
    const resolved = this.resolveOptions(options);
    const client = this.clientFactory(this.cfg);
    await client.start();
    let threadId = "";
    try {
      const response = await client.threadStart(buildThreadStartParams(resolved));
      const thread = asRecord(response.thread);
      threadId = String(thread.id ?? "");
      if (threadId) {
        await client.threadRead(threadId, false);
      }
    } catch (error) {
      await client.close();
      throw error;
    }
    const entry = buildRegistryEntry(name, threadId, resolved, client.pid);
    this.registry.create(entry);
    return new Session(
      name,
      this.cfg,
      this.dataDir(),
      this.registry,
      this.eventBus,
      this.compaction,
      client,
      threadId
    );
  }
  async attach(name, threadId, options = {}) {
    const targetThreadId = threadId.trim();
    if (!targetThreadId) {
      throw new InvalidRequest("thread_id required");
    }
    if (options.ephemeral) {
      throw new InvalidRequest("session attach cannot use --ephemeral for an existing thread");
    }
    this.ensureNameAvailable(name);
    this.ensureThreadUnclaimed(targetThreadId);
    const resolved = this.resolveOptions({ ...options, ephemeral: false }, { forcePersistent: true });
    const client = this.clientFactory(this.cfg);
    await client.start();
    let resumedThreadId = targetThreadId;
    try {
      const response = await client.threadResume(targetThreadId, buildThreadResumeParams(resolved));
      const thread = asRecord(response.thread);
      resumedThreadId = String(thread.id ?? targetThreadId);
      this.ensureThreadUnclaimed(resumedThreadId);
      await client.threadRead(resumedThreadId, false);
    } catch (error) {
      await client.close();
      throw error;
    }
    const entry = buildRegistryEntry(name, resumedThreadId, resolved, client.pid);
    this.registry.create(entry);
    return new Session(
      name,
      this.cfg,
      this.dataDir(),
      this.registry,
      this.eventBus,
      this.compaction,
      client,
      resumedThreadId
    );
  }
  async resume(name) {
    const entry = this.registry.get(name);
    if (entry.ephemeral) {
      throw new InvalidRequest(
        `session ${name} is ephemeral and cannot be resumed after its app-server exits`
      );
    }
    const client = this.clientFactory(this.cfg);
    await client.start();
    let resumedThreadId = entry.threadId;
    try {
      const resolved = sessionOptionsFromRegistryEntry(entry, this.cfg, this.dataDir());
      const response = await client.threadResume(entry.threadId, buildThreadResumeParams(resolved));
      const thread = asRecord(response.thread);
      resumedThreadId = String(thread.id ?? entry.threadId);
      this.ensureThreadUnclaimed(resumedThreadId, name);
      await client.threadRead(resumedThreadId, false);
      if (resumedThreadId !== entry.threadId) {
        this.registry.update(name, { threadId: resumedThreadId });
      }
    } catch (error) {
      await client.close();
      throw error;
    }
    this.registry.update(name, {
      status: "idle",
      errorMessage: null,
      appServerPid: client.pid
    });
    return new Session(
      name,
      this.cfg,
      this.dataDir(),
      this.registry,
      this.eventBus,
      this.compaction,
      client,
      resumedThreadId
    );
  }
  ensureNameAvailable(name) {
    try {
      this.registry.get(name);
      throw new SessionExists(name);
    } catch (error) {
      if (!(error instanceof SessionNotFound)) {
        throw error;
      }
    }
  }
  ensureThreadUnclaimed(threadId, ownerName = null) {
    const existing = this.registry.list().find((entry) => entry.threadId === threadId && entry.name !== ownerName);
    if (existing) {
      throw new InvalidRequest(
        `thread ${JSON.stringify(threadId)} is already registered as session ${JSON.stringify(existing.name)}`
      );
    }
  }
  resolveOptions(options, behavior = {}) {
    const requestedProfile = options.profile || this.cfg.defaults.profile || "";
    const selectedProfile = requestedProfile ? this.cfg.profiles[requestedProfile] : void 0;
    if (requestedProfile && !selectedProfile) {
      throw new InvalidRequest(`unknown profile: ${requestedProfile}`);
    }
    return {
      cwd: options.cwd || selectedProfile?.cwd || this.cfg.defaults.cwd || this.dataDir(),
      model: options.model || selectedProfile?.model || this.cfg.defaults.model,
      modelProvider: options.modelProvider || selectedProfile?.modelProvider || this.cfg.defaults.modelProvider || null,
      sandbox: normalizeSandboxMode(
        options.sandbox || selectedProfile?.sandbox || this.cfg.defaults.sandbox
      ),
      approvalPolicy: normalizeApprovalPolicy(
        options.approvalPolicy || selectedProfile?.approvalPolicy || this.cfg.defaults.approvalPolicy
      ),
      serviceTier: options.serviceTier || selectedProfile?.serviceTier || this.cfg.defaults.serviceTier || null,
      reasoningEffort: options.reasoningEffort || selectedProfile?.reasoningEffort || this.cfg.defaults.reasoningEffort || null,
      personality: options.personality || selectedProfile?.personality || this.cfg.defaults.personality || null,
      baseInstructions: options.baseInstructions || selectedProfile?.baseInstructions || this.cfg.defaults.baseInstructions || null,
      developerInstructions: options.developerInstructions || selectedProfile?.developerInstructions || this.cfg.defaults.developerInstructions || null,
      ephemeral: behavior.forcePersistent ? false : options.ephemeral ?? selectedProfile?.ephemeral ?? false,
      profile: requestedProfile || null
    };
  }
};
function buildThreadStartParams(resolved) {
  const params = buildThreadConfigParams(resolved);
  params.ephemeral = resolved.ephemeral;
  params.experimentalRawEvents = false;
  params.persistExtendedHistory = false;
  params.serviceName = "codex-team";
  return params;
}
function buildThreadResumeParams(resolved) {
  const params = buildThreadConfigParams(resolved);
  params.persistExtendedHistory = false;
  return params;
}
function buildThreadConfigParams(resolved) {
  const params = {
    model: resolved.model,
    cwd: resolved.cwd
  };
  if (resolved.modelProvider) {
    params.modelProvider = resolved.modelProvider;
  }
  if (resolved.sandbox) {
    params.sandbox = resolved.sandbox;
  }
  if (resolved.approvalPolicy) {
    params.approvalPolicy = resolved.approvalPolicy;
  }
  if (resolved.serviceTier) {
    params.serviceTier = resolved.serviceTier;
  }
  if (resolved.personality) {
    params.personality = resolved.personality;
  }
  if (resolved.baseInstructions) {
    params.baseInstructions = resolved.baseInstructions;
  }
  if (resolved.developerInstructions) {
    params.developerInstructions = resolved.developerInstructions;
  }
  if (resolved.reasoningEffort) {
    params.config = { model_reasoning_effort: resolved.reasoningEffort };
  }
  return params;
}
function buildRegistryEntry(name, threadId, resolved, appServerPid) {
  return {
    name,
    threadId,
    cwd: resolved.cwd,
    model: resolved.model,
    modelProvider: resolved.modelProvider,
    sandbox: resolved.sandbox || "danger-full-access",
    approvalPolicy: resolved.approvalPolicy || "never",
    serviceTier: resolved.serviceTier,
    reasoningEffort: resolved.reasoningEffort,
    personality: resolved.personality,
    profile: resolved.profile,
    createdAt: nowIso(),
    lastTurnId: null,
    lastTurnEndedAt: null,
    lastPromptText: null,
    status: "idle",
    appServerPid,
    ephemeral: resolved.ephemeral,
    queueLength: 0,
    tokenUsageInput: 0,
    contextTokensEstimate: 0,
    modelContextWindow: null,
    errorMessage: null
  };
}
function sessionOptionsFromRegistryEntry(entry, cfg, fallbackDataDir) {
  const selectedProfile = entry.profile ? cfg.profiles[entry.profile] : void 0;
  return {
    cwd: entry.cwd || selectedProfile?.cwd || cfg.defaults.cwd || fallbackDataDir,
    model: entry.model || selectedProfile?.model || cfg.defaults.model,
    modelProvider: entry.modelProvider || selectedProfile?.modelProvider || cfg.defaults.modelProvider || null,
    sandbox: normalizeSandboxMode(entry.sandbox || selectedProfile?.sandbox || cfg.defaults.sandbox),
    approvalPolicy: normalizeApprovalPolicy(
      entry.approvalPolicy || selectedProfile?.approvalPolicy || cfg.defaults.approvalPolicy
    ),
    serviceTier: entry.serviceTier || selectedProfile?.serviceTier || cfg.defaults.serviceTier || null,
    reasoningEffort: entry.reasoningEffort || selectedProfile?.reasoningEffort || cfg.defaults.reasoningEffort || null,
    personality: entry.personality || selectedProfile?.personality || cfg.defaults.personality || null,
    baseInstructions: selectedProfile?.baseInstructions || cfg.defaults.baseInstructions || null,
    developerInstructions: selectedProfile?.developerInstructions || cfg.defaults.developerInstructions || null,
    ephemeral: false,
    profile: entry.profile
  };
}
function buildTurnStartParams(threadId, text, overrides) {
  const params = {
    threadId,
    input: [{ type: "text", text }]
  };
  if (!overrides) {
    return params;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === void 0 || value === null || value === "") {
      continue;
    }
    if (key === "outputSchema") {
      params.outputSchema = value;
      continue;
    }
    params[key] = value;
  }
  return params;
}
function summaryToWire(summary) {
  return {
    session: summary.session,
    turn_id: summary.turnId,
    elapsed_ms: summary.elapsedMs,
    status: summary.status,
    tier: summary.tier,
    final_message: summary.finalMessage,
    files_added: summary.filesAdded,
    files_removed: summary.filesRemoved,
    lines: summary.lines,
    usage_last_tokens: summary.usageLastTokens ?? null,
    usage_total_tokens: summary.usageTotalTokens ?? null,
    context_tokens_estimate: summary.contextTokensEstimate ?? null,
    model_context_window: summary.modelContextWindow ?? null,
    error_message: summary.errorMessage ?? null,
    completed_at: summary.completedAt ?? null
  };
}

// src/watchdog.ts
var import_node_fs7 = __toESM(require("fs"));
var WatchdogTimer = class {
  constructor(cfg, registry, eventBus, sessions) {
    this.cfg = cfg;
    this.registry = registry;
    this.eventBus = eventBus;
    this.sessions = sessions;
  }
  cfg;
  registry;
  eventBus;
  sessions;
  readBrief(alarm) {
    const filePath = alarm?.taskBriefFile || this.cfg.monitor.watchdogTaskBriefFile;
    if (!filePath || !import_node_fs7.default.existsSync(filePath)) {
      return "";
    }
    const headLines = alarm?.taskBriefHeadLines || this.cfg.monitor.watchdogTaskBriefHeadLines;
    return import_node_fs7.default.readFileSync(filePath, "utf8").split(/\r?\n/).slice(0, headLines).join("\n");
  }
  readTemplate(alarm) {
    const filePath = alarm?.templateFile || this.cfg.monitor.watchdogTemplateFile;
    if (filePath && import_node_fs7.default.existsSync(filePath)) {
      return import_node_fs7.default.readFileSync(filePath, "utf8");
    }
    return alarm?.template || this.cfg.monitor.watchdogTemplate || defaultWatchdogTemplate();
  }
  async tickOnce(options = {}) {
    const now = /* @__PURE__ */ new Date();
    const sentAt = now.toISOString();
    const localTime = formatLocalTime(now);
    const sessions = this.registry.list().map((entry) => {
      const advisories = [];
      const compactionMetric = entry.contextTokensEstimate ?? entry.tokenUsageInput;
      if (compactionMetric >= this.cfg.compaction.thresholdTokens) {
        advisories.push("crossed compaction threshold");
      }
      if (entry.status === "errored") {
        advisories.push("errored");
      }
      if (entry.queueLength > 0) {
        advisories.push(`queue=${entry.queueLength}`);
      }
      const live = this.sessions.get(entry.name);
      if (live) {
        if (!live.isTransportAlive()) {
          advisories.push("transport-down");
        }
        if (live.isRunning()) {
          const turnAgeMs = live.currentTurnAgeMs();
          if (turnAgeMs != null) {
            advisories.push(`running=${Math.floor(turnAgeMs / 1e3)}s`);
            if (turnAgeMs >= this.cfg.heartbeat.turnStuckSeconds * 1e3) {
              advisories.push("turn-stuck-threshold");
            }
          }
        }
      }
      if (entry.lastTurnEndedAt) {
        const last = new Date(entry.lastTurnEndedAt);
        if (!Number.isNaN(last.getTime())) {
          const idleMinutes = (now.getTime() - last.getTime()) / 6e4;
          if (idleMinutes > this.cfg.monitor.watchdogStaleMinutes) {
            advisories.push(`idle > ${this.cfg.monitor.watchdogStaleMinutes}m`);
          }
        }
      }
      return {
        name: entry.name,
        status: entry.status,
        threadIdShort: entry.threadId.slice(0, 8),
        tokens: compactionMetric,
        metricKind: entry.contextTokensEstimate != null ? "context_estimate" : "cumulative_usage",
        queue: entry.queueLength,
        transportAlive: live ? live.isTransportAlive() : false,
        currentTurnId: live?.currentTurnId() || null,
        currentTurnAgeMs: live?.currentTurnAgeMs() || null,
        advisories
      };
    });
    const taskBrief = this.readBrief(options.alarm) || null;
    const emitIdle = options.alarm?.emitIdle ?? this.cfg.monitor.watchdogEmitIdle;
    const hasSignal = options.force || Boolean(taskBrief) || sessions.some((session) => session.advisories.length > 0 || session.status === "running");
    if (!hasSignal && !emitIdle) {
      return;
    }
    const summary = {
      total: sessions.length,
      running: sessions.filter((session) => session.status === "running").length,
      errored: sessions.filter((session) => session.status === "errored").length,
      queued: sessions.reduce((sum, session) => sum + Number(session.queue || 0), 0)
    };
    const alarmName = options.alarmName || "default";
    const message = renderWatchdogTemplate(this.readTemplate(options.alarm), {
      at: sentAt,
      sentAt,
      localTime,
      alarm: alarmName,
      taskBrief,
      summary,
      sessions
    });
    this.eventBus.publish("watchdog", {
      kind: "watchdog-tick",
      at: sentAt,
      sentAt,
      localTime,
      alarm: alarmName,
      taskBrief,
      message,
      summary,
      sessions
    });
  }
};
function defaultWatchdogTemplate() {
  return [
    "Codex team watchdog",
    "alarm={{alarm}}",
    "sent_at={{sentAt}}",
    "local_time={{localTime}}",
    "sessions={{summary.total}} running={{summary.running}} errored={{summary.errored}} queued={{summary.queued}}",
    "{{#if taskBrief}}",
    "",
    "Task brief:",
    "{{taskBrief}}",
    "{{/if}}",
    "{{#if sessionsText}}",
    "",
    "Sessions:",
    "{{sessionsText}}",
    "{{/if}}"
  ].join("\n");
}
function renderWatchdogTemplate(template, input) {
  const sessionsText = input.sessions.map((session) => {
    const advisory = session.advisories.length > 0 ? ` [${session.advisories.join(", ")}]` : "";
    const turn = session.currentTurnId ? ` turn=${session.currentTurnId}${session.currentTurnAgeMs == null ? "" : ` age=${Math.floor(session.currentTurnAgeMs / 1e3)}s`}` : "";
    return `- ${session.name}: ${session.status} queue=${session.queue} tokens=${session.tokens} ${session.metricKind}${turn}${advisory}`;
  }).join("\n");
  const variables = {
    at: input.at,
    sentAt: input.sentAt,
    localTime: input.localTime,
    alarm: input.alarm,
    taskBrief: input.taskBrief || "",
    sessionsText,
    "summary.total": String(input.summary.total),
    "summary.running": String(input.summary.running),
    "summary.errored": String(input.summary.errored),
    "summary.queued": String(input.summary.queued)
  };
  let out = template.replace(/{{#if ([\w.]+)}}([\s\S]*?){{\/if}}/g, (_match, key, body) => {
    return variables[key] ? body : "";
  });
  out = out.replace(/{{\s*([\w.]+)\s*}}/g, (_match, key) => variables[key] ?? "");
  return out.trim();
}
function formatLocalTime(date) {
  return date.toLocaleString(void 0, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short"
  });
}

// src/history.ts
function filterHistoryMarkdown(content, options = {}) {
  const sections = splitMarkdownSections(content);
  let matchedSinceTurnId = true;
  let filtered = sections;
  if (options.sinceTurnId) {
    const index = sections.findIndex((section) => section.turnId === options.sinceTurnId);
    if (index < 0) {
      matchedSinceTurnId = false;
      filtered = [];
    } else {
      filtered = sections.slice(index + 1);
    }
  }
  if (options.lastN && options.lastN > 0) {
    filtered = filtered.slice(-options.lastN);
  }
  return {
    content: filtered.map((section) => section.block).join(""),
    matchedSinceTurnId
  };
}
function filterTurnsJsonl(content, options = {}) {
  const allLines = content.split(/\r?\n/).filter(Boolean);
  let matchedSinceTurnId = true;
  let started = !options.sinceTurnId;
  let lines = [];
  for (const line of allLines) {
    let payload = null;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    const turnId = String(payload.turnId ?? payload.turn_id ?? "");
    if (!started && options.sinceTurnId) {
      if (turnId === options.sinceTurnId) {
        started = true;
      }
      continue;
    }
    if (options.since) {
      const completedAt = String(payload.completedAt ?? payload.completed_at ?? "");
      if (completedAt && completedAt < options.since) {
        continue;
      }
    }
    lines.push(line);
  }
  if (options.sinceTurnId && !started) {
    matchedSinceTurnId = false;
    lines = [];
  }
  if (options.lastN && options.lastN > 0) {
    lines = lines.slice(-options.lastN);
  }
  return {
    content: lines.length > 0 ? `${lines.join("\n")}
` : "",
    matchedSinceTurnId
  };
}
function splitMarkdownSections(content) {
  const pattern = /^## Turn ([^\s]+).*$/gm;
  const matches = [...content.matchAll(pattern)];
  if (matches.length === 0) {
    return [];
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? content.length : content.length;
    return {
      turnId: match[1],
      block: content.slice(start, end)
    };
  });
}

// src/server.ts
function asString(value) {
  return String(value ?? "");
}
function optionalString(value) {
  return value == null ? null : String(value);
}
function threadIdFromParams(params) {
  return asString(params.threadId ?? params.thread_id).trim();
}
function sessionOptionsFromParams(params) {
  return {
    cwd: optionalString(params.cwd),
    model: optionalString(params.model),
    modelProvider: optionalString(params.modelProvider),
    sandbox: optionalString(params.sandbox),
    approvalPolicy: optionalString(params.approvalPolicy),
    serviceTier: optionalString(params.serviceTier),
    reasoningEffort: optionalString(params.reasoningEffort),
    personality: optionalString(params.personality),
    baseInstructions: optionalString(params.baseInstructions),
    developerInstructions: optionalString(params.developerInstructions),
    profile: optionalString(params.profile),
    ephemeral: Boolean(params.ephemeral)
  };
}
var DaemonServer = class {
  constructor(cfg, socketPath, shutdownCallback, clientFactory = (cfg2) => new AppServerClient(cfg2)) {
    this.cfg = cfg;
    this.socketPath = socketPath;
    this.shutdownCallback = shutdownCallback;
    this.clientFactory = clientFactory;
    this.eventBus = new EventBus(cfg.monitor.eventsMaxBuffer, cfg.monitor.subscriberQueueMax);
    this.registry = new RegistryStore(import_node_path7.default.join(cfg.daemon.dataDir, "registry.json"));
    this.compaction = new CompactionMonitor(cfg, this.registry, this.eventBus);
    this.factory = new SessionFactory(cfg, this.registry, this.eventBus, this.compaction, this.clientFactory);
    this.watchdog = new WatchdogTimer(cfg, this.registry, this.eventBus, this.sessions);
    this.health = new HealthMonitor(cfg, this.registry, this.sessions, this.eventBus, this.factory);
    this.installHandlers();
  }
  cfg;
  socketPath;
  shutdownCallback;
  clientFactory;
  eventBus;
  registry;
  factory;
  sessions = /* @__PURE__ */ new Map();
  compaction;
  watchdog;
  health;
  handlers = /* @__PURE__ */ new Map();
  sessionLocks = /* @__PURE__ */ new Map();
  server = null;
  watchdogTimers = [];
  heartbeatTimer = null;
  replaceConfig(cfg) {
    cfg.daemon.dataDir = cfg.daemon.dataDir || this.cfg.daemon.dataDir;
    cfg.daemon.socketPath = cfg.daemon.socketPath || this.cfg.daemon.socketPath;
    this.cfg = cfg;
    this.eventBus.replaceLimits(cfg.monitor.eventsMaxBuffer, cfg.monitor.subscriberQueueMax);
    this.factory.replaceConfig(cfg);
    this.health.replaceConfig(cfg);
    for (const session of this.sessions.values()) {
      session.replaceConfig(cfg);
    }
    if (this.server) {
      this.restartBackgroundLoops();
    }
  }
  async start() {
    import_node_fs8.default.mkdirSync(import_node_path7.default.dirname(this.socketPath), { recursive: true });
    if (import_node_fs8.default.existsSync(this.socketPath)) {
      import_node_fs8.default.unlinkSync(this.socketPath);
    }
    this.server = import_node_net2.default.createServer((socket) => {
      void this.handleSocket(socket);
    });
    await new Promise((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => resolve());
    });
    this.restartBackgroundLoops();
    await this.watchdog.tickOnce({ force: true, alarmName: "default" });
    for (const [name, alarm] of Object.entries(this.cfg.monitor.watchdogAlarms)) {
      if (alarm.enabled) {
        await this.watchdog.tickOnce({ force: true, alarmName: name, alarm });
      }
    }
  }
  async stop() {
    this.stopBackgroundLoops();
    if (this.server) {
      await new Promise((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
    for (const session of [...this.sessions.values()]) {
      await session.shutdown();
    }
    this.sessions.clear();
    if (import_node_fs8.default.existsSync(this.socketPath)) {
      import_node_fs8.default.unlinkSync(this.socketPath);
    }
  }
  stopBackgroundLoops() {
    for (const timer of this.watchdogTimers) {
      clearInterval(timer);
    }
    this.watchdogTimers = [];
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  restartBackgroundLoops() {
    this.stopBackgroundLoops();
    this.watchdogTimers.push(
      setInterval(() => {
        void this.watchdog.tickOnce({ alarmName: "default" });
      }, this.cfg.monitor.watchdogIntervalSeconds * 1e3)
    );
    for (const [name, alarm] of Object.entries(this.cfg.monitor.watchdogAlarms)) {
      if (!alarm.enabled) {
        continue;
      }
      this.watchdogTimers.push(
        setInterval(() => {
          void this.watchdog.tickOnce({ alarmName: name, alarm });
        }, alarm.intervalSeconds * 1e3)
      );
    }
    this.heartbeatTimer = setInterval(() => {
      void this.health.tickOnce();
    }, this.cfg.heartbeat.intervalSeconds * 1e3);
  }
  installHandlers() {
    this.handlers.set("session.create", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      if (!name) {
        throw new InvalidRequest("name required");
      }
      const options = sessionOptionsFromParams(message.params);
      const threadId = threadIdFromParams(message.params);
      return await this.withSessionAttachLock(name, threadId, async () => {
        const session = threadId ? await this.factory.attach(name, threadId, options) : await this.factory.create(name, options);
        this.sessions.set(session.name, session);
        const entry = this.registry.get(session.name);
        return { name: session.name, thread_id: entry.threadId, attached: Boolean(threadId) };
      });
    });
    this.handlers.set("session.attach", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      if (!name) {
        throw new InvalidRequest("name required");
      }
      const threadId = threadIdFromParams(message.params);
      if (!threadId) {
        throw new InvalidRequest("thread_id required");
      }
      return await this.withSessionAttachLock(name, threadId, async () => {
        const session = await this.factory.attach(name, threadId, sessionOptionsFromParams(message.params));
        this.sessions.set(session.name, session);
        const entry = this.registry.get(session.name);
        return { name: session.name, thread_id: entry.threadId, attached: true };
      });
    });
    this.handlers.set("session.list", async () => ({
      sessions: this.registry.list()
    }));
    this.handlers.set("session.status", async (message) => ({
      ...this.registry.get(asString(message.params.name))
    }));
    this.handlers.set("session.read", async (message) => {
      const name = asString(message.params.name);
      const includeTurns = Boolean(message.params.includeTurns);
      const live = this.sessions.get(name);
      if (live) {
        return await live.read(includeTurns);
      }
      const entry = this.registry.get(name);
      if (entry.ephemeral) {
        throw new InvalidRequest(
          `session ${name} is ephemeral and can only be read while its app-server is still alive`
        );
      }
      const temp = this.clientFactory(this.cfg);
      try {
        await temp.start();
        return await temp.threadRead(entry.threadId, includeTurns);
      } finally {
        await temp.close();
      }
    });
    this.handlers.set("session.close", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (session) {
          await session.close();
          this.sessions.delete(name);
        } else {
          this.registry.update(name, { status: "closed", appServerPid: null, queueLength: 0 });
        }
        return { name, closed: true };
      });
    });
    this.handlers.set("session.ack_error", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (session) {
          await session.ackError();
        } else {
          this.registry.update(name, { status: "idle", errorMessage: null });
        }
        return { name, acked: true };
      });
    });
    this.handlers.set("session.dump", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (session) {
        return session.dumpState();
      }
      const entry = this.registry.get(name);
      const base = import_node_path7.default.join(this.cfg.daemon.dataDir, "sessions", name);
      const stderrPath = import_node_path7.default.join(base, "app-server.stderr.log");
      const stderrTail = readLastLines(stderrPath, 20);
      return {
        session: entry,
        queue: [],
        transport_alive: false,
        stderr_tail: stderrTail,
        history_path: import_node_path7.default.join(base, "history.md"),
        turns_path: import_node_path7.default.join(base, "turns.jsonl")
      };
    });
    this.handlers.set("session.resume", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = await this.factory.resume(name);
        this.sessions.set(name, session);
        return { name, resumed: true };
      });
    });
    this.handlers.set("session.restart", async (message) => {
      this.refreshConfigFromDisk();
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const entry = this.registry.get(name);
        const existing = this.sessions.get(name);
        if (entry.ephemeral) {
          if (!existing) {
            throw new InvalidRequest(
              `session ${name} is ephemeral and cannot be restarted after its app-server exits`
            );
          }
          await existing.kill("restarting ephemeral session");
          this.sessions.delete(name);
          this.registry.delete(name);
          const recreated = await this.factory.create(name, {
            cwd: entry.cwd,
            model: entry.model,
            modelProvider: entry.modelProvider,
            sandbox: entry.sandbox,
            approvalPolicy: entry.approvalPolicy,
            serviceTier: entry.serviceTier,
            reasoningEffort: entry.reasoningEffort,
            personality: entry.personality,
            profile: entry.profile,
            ephemeral: true
          });
          this.sessions.set(name, recreated);
          return { name, restarted: true, recreated: true, ephemeral: true };
        }
        if (existing) {
          await existing.close();
          this.sessions.delete(name);
        }
        const session = await this.factory.resume(name);
        this.sessions.set(name, session);
        return { name, restarted: true };
      });
    });
    this.handlers.set("session.kill", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        await session.kill("killed by operator");
        this.sessions.delete(name);
        return { name, killed: true };
      });
    });
    this.handlers.set("session.forget", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        let archived = false;
        if (session) {
          const entry = this.registry.get(name);
          if (!entry.ephemeral) {
            try {
              await session.archiveThread();
              archived = true;
            } catch {
            }
          }
          await session.close();
          this.sessions.delete(name);
        } else {
          const entry = this.registry.get(name);
          if (!entry.ephemeral) {
            const temp = this.clientFactory(this.cfg);
            try {
              await temp.start();
              await temp.threadArchive(entry.threadId);
              archived = true;
            } catch {
            } finally {
              await temp.close();
            }
          }
        }
        try {
          this.registry.delete(name);
        } catch {
        }
        return { name, forgotten: true, archived_thread: archived };
      });
    });
    this.handlers.set("send", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      const wait = Boolean(message.params.wait);
      const overrides = compactObject({
        cwd: message.params.cwd,
        model: message.params.model,
        effort: message.params.effort,
        personality: message.params.personality,
        serviceTier: message.params.serviceTier,
        summary: message.params.summary,
        outputSchema: message.params.outputSchema
      });
      const result = await session.send(asString(message.params.text), { wait, overrides });
      if (typeof result === "string") {
        return { name, queued_or_turn_id: result };
      }
      return { name, summary: result };
    });
    this.handlers.set("interrupt", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      await session.interrupt();
      return { name, interrupted: true };
    });
    this.handlers.set("compact", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        const before = this.registry.get(name).tokenUsageInput;
        await session.compact();
        const after = this.registry.get(name).tokenUsageInput;
        this.eventBus.publish("events", {
          kind: "compact-done",
          session: name,
          before,
          after
        });
        return { name, compacted: true };
      });
    });
    this.handlers.set("history.get", async (message) => {
      const name = asString(message.params.name);
      const format = message.params.format === "jsonl" ? "jsonl" : "md";
      const filePath = import_node_path7.default.join(
        this.cfg.daemon.dataDir,
        "sessions",
        name,
        format === "md" ? "history.md" : "turns.jsonl"
      );
      if (!import_node_fs8.default.existsSync(filePath)) {
        return { name, content: "" };
      }
      const sinceTurnId = message.params.sinceTurnId == null ? "" : asString(message.params.sinceTurnId);
      if (format === "md") {
        const filtered2 = filterHistoryMarkdown(import_node_fs8.default.readFileSync(filePath, "utf8"), {
          lastN: Number(message.params.lastN || 0),
          sinceTurnId: sinceTurnId || void 0
        });
        return {
          name,
          content: filtered2.content,
          matched_since_turn_id: filtered2.matchedSinceTurnId
        };
      }
      const lastN = Number(message.params.lastN || 0);
      const since = message.params.since == null ? "" : asString(message.params.since);
      const source = lastN > 0 && !since && !sinceTurnId ? readJsonlTail(filePath, lastN).join("\n") : import_node_fs8.default.readFileSync(filePath, "utf8");
      const filtered = filterTurnsJsonl(source, {
        lastN,
        since: since || void 0,
        sinceTurnId: sinceTurnId || void 0
      });
      return {
        name,
        content: filtered.content,
        matched_since_turn_id: filtered.matchedSinceTurnId
      };
    });
    this.handlers.set("history.tail_stderr", async (message) => {
      const name = asString(message.params.name);
      const lines = Number(message.params.lines || 200);
      const filePath = import_node_path7.default.join(this.cfg.daemon.dataDir, "sessions", name, "app-server.stderr.log");
      if (!import_node_fs8.default.existsSync(filePath)) {
        return { name, content: "" };
      }
      return {
        name,
        content: readLastLines(filePath, lines)
      };
    });
    this.handlers.set("queue.show", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      const items = session.snapshotQueueJson();
      return { name, length: items.length, items };
    });
    this.handlers.set("queue.clear", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        session.clearQueue();
        return { name, cleared: true };
      });
    });
    this.handlers.set("queue.drop_oldest", async (message) => {
      const name = asString(message.params.name);
      return await this.withSessionOperationLock(name, async () => {
        const session = this.sessions.get(name);
        if (!session) {
          throw new SessionNotFound(name);
        }
        const dropped = session.dropOldest();
        return { name, dropped: dropped?.id ?? null };
      });
    });
    this.handlers.set("queue.retry_last", async (message) => {
      const name = asString(message.params.name);
      const session = this.sessions.get(name);
      if (!session) {
        throw new SessionNotFound(name);
      }
      const entry = this.registry.get(name);
      if (!entry.lastPromptText) {
        throw new InvalidRequest(`session ${name} has no last prompt to retry`);
      }
      const result = await session.send(entry.lastPromptText, { wait: Boolean(message.params.wait) });
      return { name, retried: true, result };
    });
    this.handlers.set("health.check", async () => {
      await this.health.tickOnce();
      return { checked: true, sessions: this.registry.list().length };
    });
    this.handlers.set("health.issues", async () => ({
      issues: collectIssues(this.registry.list(), this.sessions)
    }));
    this.handlers.set("health.report", async () => ({
      summary: summarizeEntries(this.registry.list()),
      issues: collectIssues(this.registry.list(), this.sessions),
      sessions: this.registry.list().map((entry) => ({
        name: entry.name,
        status: entry.status,
        queue_length: entry.queueLength,
        app_server_pid: entry.appServerPid,
        last_turn_id: entry.lastTurnId,
        last_error: entry.errorMessage,
        transport_alive: this.sessions.get(entry.name)?.isTransportAlive() || false,
        ephemeral: Boolean(entry.ephemeral)
      }))
    }));
    this.handlers.set("health.repair", async () => {
      this.refreshConfigFromDisk();
      for (const entry of this.registry.list()) {
        await this.withSessionOperationLock(entry.name, async () => {
          const latest = this.registry.get(entry.name);
          if (latest.status !== "errored") {
            return;
          }
          if (latest.ephemeral) {
            this.registry.update(latest.name, {
              errorMessage: "ephemeral session cannot be repaired after its app-server exits"
            });
            return;
          }
          try {
            const session = await this.factory.resume(latest.name);
            this.sessions.set(latest.name, session);
          } catch (error) {
            this.registry.update(latest.name, { errorMessage: error.message });
          }
        });
      }
      return { repaired: true };
    });
    this.handlers.set("daemon.status", async () => ({
      sessions: this.registry.list().length,
      summary: summarizeEntries(this.registry.list()),
      pid: process.pid,
      socket_path: this.socketPath,
      data_dir: this.cfg.daemon.dataDir,
      events_last_seq: this.eventBus.lastSeq("events"),
      watchdog_last_seq: this.eventBus.lastSeq("watchdog")
    }));
    this.handlers.set("daemon.doctor", async () => ({
      pid: process.pid,
      socket_path: this.socketPath,
      socket_exists: import_node_fs8.default.existsSync(this.socketPath),
      data_dir: this.cfg.daemon.dataDir,
      registry_path: import_node_path7.default.join(this.cfg.daemon.dataDir, "registry.json"),
      log_path: import_node_path7.default.join(this.cfg.daemon.dataDir, "daemon.log"),
      uptime_seconds: Math.floor(process.uptime()),
      summary: summarizeEntries(this.registry.list()),
      sessions: this.registry.list().map((entry) => ({
        name: entry.name,
        status: entry.status,
        thread_id: entry.threadId,
        ephemeral: Boolean(entry.ephemeral),
        transport_alive: this.sessions.get(entry.name)?.isTransportAlive() || false
      }))
    }));
    this.handlers.set("daemon.stop", async () => ({ stopping: true }));
    this.handlers.set("daemon.logs", async () => {
      const filePath = import_node_path7.default.join(this.cfg.daemon.dataDir, "daemon.log");
      return { content: import_node_fs8.default.existsSync(filePath) ? import_node_fs8.default.readFileSync(filePath, "utf8") : "" };
    });
    this.handlers.set("daemon.reload_config", async () => {
      this.refreshConfigFromDisk();
      return { reloaded: true };
    });
  }
  refreshConfigFromDisk() {
    const reloaded = loadConfig();
    reloaded.daemon.dataDir = this.cfg.daemon.dataDir;
    reloaded.daemon.socketPath = this.cfg.daemon.socketPath;
    this.replaceConfig(reloaded);
  }
  async withSessionOperationLock(name, fn) {
    const previous = this.sessionLocks.get(name) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.sessionLocks.set(name, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionLocks.get(name) === chained) {
        this.sessionLocks.delete(name);
      }
    }
  }
  async withSessionAttachLock(name, threadId, fn) {
    if (!threadId) {
      return await this.withSessionOperationLock(name, fn);
    }
    return await this.withSessionOperationLock(`thread:${threadId}`, async () => {
      return await this.withSessionOperationLock(name, fn);
    });
  }
  async handleMonitorSubscribe(stream, sinceSeq, socket) {
    const queue = await this.eventBus.subscribe(stream, sinceSeq);
    const onClosed = () => {
      queue.close(new Error("monitor socket closed"));
    };
    socket.once("close", onClosed);
    socket.once("error", onClosed);
    try {
      while (!socket.destroyed) {
        const event = await queue.shift();
        const writable = socket.write(
          encodeMessage({
            kind: "event",
            stream,
            seq: event.seq,
            payload: event.payload
          })
        );
        if (!writable && !socket.destroyed) {
          await Promise.race([
            (0, import_node_events.once)(socket, "drain"),
            (0, import_node_events.once)(socket, "close"),
            (0, import_node_events.once)(socket, "error")
          ]).catch(() => void 0);
        }
      }
    } catch {
    } finally {
      socket.off("close", onClosed);
      socket.off("error", onClosed);
      await this.eventBus.unsubscribe(stream, queue);
    }
  }
  async handleHistorySubscribe(params, socket) {
    const name = asString(params.name);
    const format = params.format === "jsonl" ? "jsonl" : "md";
    const filePath = import_node_path7.default.join(
      this.cfg.daemon.dataDir,
      "sessions",
      name,
      format === "md" ? "history.md" : "turns.jsonl"
    );
    const queue = await this.eventBus.subscribe("events", this.eventBus.lastSeq("events"));
    const snapshot = this.readHistorySnapshot(name, filePath, format, params);
    let seq = 0;
    socket.write(
      JSON.stringify({
        kind: "event",
        stream: "history",
        seq,
        payload: {
          kind: "history-snapshot",
          session: name,
          format,
          ...snapshot.payload
        }
      }) + "\n"
    );
    let cursor = snapshot.cursor;
    const onClosed = () => {
      queue.close(new Error("history socket closed"));
    };
    socket.once("close", onClosed);
    socket.once("error", onClosed);
    try {
      while (!socket.destroyed) {
        const event = await queue.shift();
        if (event.payload.session !== name) {
          continue;
        }
        if (!["turn-done", "turn-attn"].includes(String(event.payload.kind))) {
          continue;
        }
        let content = "";
        if (import_node_fs8.default.existsSync(filePath)) {
          const size = import_node_fs8.default.statSync(filePath).size;
          if (size < cursor) {
            cursor = 0;
          }
          if (size > cursor) {
            const fd = import_node_fs8.default.openSync(filePath, "r");
            try {
              const buffer = Buffer.alloc(size - cursor);
              import_node_fs8.default.readSync(fd, buffer, 0, buffer.length, cursor);
              content = buffer.toString("utf8");
            } finally {
              import_node_fs8.default.closeSync(fd);
            }
            cursor = size;
          }
        }
        seq += 1;
        const writable = socket.write(
          JSON.stringify({
            kind: "event",
            stream: "history",
            seq,
            payload: {
              kind: "history-append",
              session: name,
              format,
              content,
              event: event.payload
            }
          }) + "\n"
        );
        if (!writable && !socket.destroyed) {
          await Promise.race([
            (0, import_node_events.once)(socket, "drain"),
            (0, import_node_events.once)(socket, "close"),
            (0, import_node_events.once)(socket, "error")
          ]).catch(() => void 0);
        }
      }
    } catch {
    } finally {
      socket.off("close", onClosed);
      socket.off("error", onClosed);
      await this.eventBus.unsubscribe("events", queue);
    }
  }
  readHistorySnapshot(name, filePath, format, params) {
    if (!import_node_fs8.default.existsSync(filePath)) {
      return { cursor: 0, payload: { name, content: "", matched_since_turn_id: true } };
    }
    const cursor = import_node_fs8.default.statSync(filePath).size;
    const lastN = Number(params.lastN || 0);
    const sinceTurnId = params.sinceTurnId == null ? "" : asString(params.sinceTurnId);
    if (format === "md") {
      const filtered2 = filterHistoryMarkdown(import_node_fs8.default.readFileSync(filePath, "utf8"), {
        lastN,
        sinceTurnId: sinceTurnId || void 0
      });
      return {
        cursor,
        payload: {
          name,
          content: filtered2.content,
          matched_since_turn_id: filtered2.matchedSinceTurnId
        }
      };
    }
    const since = params.since == null ? "" : asString(params.since);
    const source = lastN > 0 && !since && !sinceTurnId ? readJsonlTail(filePath, lastN).join("\n") : import_node_fs8.default.readFileSync(filePath, "utf8");
    const filtered = filterTurnsJsonl(source, {
      lastN,
      since: since || void 0,
      sinceTurnId: sinceTurnId || void 0
    });
    return {
      cursor,
      payload: {
        name,
        content: filtered.content,
        matched_since_turn_id: filtered.matchedSinceTurnId
      }
    };
  }
  async handleSocket(socket) {
    socket.setEncoding("utf8");
    const rl = import_node_readline3.default.createInterface({
      input: socket,
      crlfDelay: Infinity
    });
    try {
      for await (const line of rl) {
        if (!line) {
          continue;
        }
        let request;
        try {
          request = decodeRequest(line);
        } catch (error) {
          socket.write(
            encodeMessage({
              id: "?",
              ok: false,
              error: errorToWire(asCodexTeamError(error))
            })
          );
          continue;
        }
        if (request.cmd === "monitor.events.subscribe") {
          await this.handleMonitorSubscribe("events", Number(request.params.sinceSeq || 0), socket);
          return;
        }
        if (request.cmd === "monitor.watchdog.subscribe") {
          await this.handleMonitorSubscribe("watchdog", Number(request.params.sinceSeq || 0), socket);
          return;
        }
        if (request.cmd === "history.subscribe") {
          await this.handleHistorySubscribe(request.params, socket);
          return;
        }
        const handler = this.handlers.get(request.cmd);
        if (!handler) {
          socket.write(
            encodeMessage({
              id: request.id,
              ok: false,
              error: errorToWire(new InvalidRequest(`unknown cmd: ${request.cmd}`))
            })
          );
          continue;
        }
        try {
          const data = await handler(request);
          socket.write(encodeMessage({ id: request.id, ok: true, data }));
          if (request.cmd === "daemon.stop") {
            setImmediate(() => {
              this.shutdownCallback?.();
            });
          }
        } catch (error) {
          socket.write(
            encodeMessage({
              id: request.id,
              ok: false,
              error: errorToWire(asCodexTeamError(error))
            })
          );
        }
      }
    } finally {
      rl.close();
      socket.end();
    }
  }
};
function compactObject(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== void 0 && value !== null && value !== "")
  );
}
function summarizeEntries(entries) {
  const summary = {
    total: entries.length,
    idle: 0,
    running: 0,
    errored: 0,
    closed: 0,
    compacting: 0,
    queued_items: 0
  };
  for (const entry of entries) {
    summary.queued_items += Number(entry.queueLength || 0);
    if (entry.status in summary) {
      summary[entry.status] += 1;
    }
  }
  return summary;
}
function collectIssues(entries, sessions) {
  const issues = [];
  for (const entry of entries) {
    const live = sessions.get(entry.name);
    if (entry.status === "errored") {
      issues.push({
        session: entry.name,
        kind: "errored",
        last_error: entry.errorMessage
      });
      continue;
    }
    if (entry.queueLength > 0) {
      issues.push({
        session: entry.name,
        kind: "queue-backlog",
        queue_length: entry.queueLength
      });
    }
    if (live && live.isRunning()) {
      const ageMs = live.currentTurnAgeMs();
      if (ageMs != null) {
        issues.push({
          session: entry.name,
          kind: "running",
          turn_id: live.currentTurnId(),
          age_ms: ageMs,
          last_turn_id: entry.lastTurnId
        });
      }
    } else if (live && !live.isTransportAlive()) {
      issues.push({
        session: entry.name,
        kind: "transport-down"
      });
    }
  }
  return issues;
}

// src/daemon.ts
function appendLogLine(logPath, message) {
  import_node_fs9.default.mkdirSync(import_node_path8.default.dirname(logPath), { recursive: true });
  import_node_fs9.default.appendFileSync(logPath, `${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`, "utf8");
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function acquirePidLock(pidPath) {
  import_node_fs9.default.mkdirSync(import_node_path8.default.dirname(pidPath), { recursive: true });
  if (import_node_fs9.default.existsSync(pidPath)) {
    const raw = import_node_fs9.default.readFileSync(pidPath, "utf8").trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) {
      throw new DaemonAlreadyRunning(
        `another daemon is already running (pid=${pid}, pid_file=${pidPath}).`
      );
    }
    import_node_fs9.default.unlinkSync(pidPath);
  }
  import_node_fs9.default.writeFileSync(pidPath, String(process.pid), "utf8");
}
function releasePidLock(pidPath) {
  if (import_node_fs9.default.existsSync(pidPath)) {
    import_node_fs9.default.unlinkSync(pidPath);
  }
}
async function runDaemon(configPath) {
  const cfg = loadConfig(configPath || import_node_path8.default.join(xdgConfigDir(), "config.toml"));
  const dataDir = resolveDataDir(cfg);
  const socketPath = resolveSocketPath(cfg);
  cfg.daemon.dataDir = dataDir;
  cfg.daemon.socketPath = socketPath;
  import_node_fs9.default.mkdirSync(dataDir, { recursive: true });
  const pidPath = import_node_path8.default.join(dataDir, "daemon.pid");
  const logPath = import_node_path8.default.join(dataDir, "daemon.log");
  acquirePidLock(pidPath);
  appendLogLine(logPath, "daemon starting");
  let stopResolve;
  const stopPromise = new Promise((resolve) => {
    stopResolve = resolve;
  });
  const server = new DaemonServer(cfg, socketPath, () => stopResolve());
  const signalHandler = () => stopResolve();
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    await server.start();
    if (cfg.defaults.autoResumeOnDaemonStart) {
      for (const entry of server.registry.list()) {
        if (!["idle", "running", "errored", "compacting"].includes(entry.status)) {
          continue;
        }
        if (entry.ephemeral) {
          appendLogLine(logPath, `skipping auto-resume for ephemeral session ${entry.name}`);
          server.registry.update(entry.name, {
            status: "closed",
            appServerPid: null,
            errorMessage: "ephemeral session expired when daemon stopped"
          });
          continue;
        }
        try {
          const session = await server.factory.resume(entry.name);
          server.sessions.set(entry.name, session);
        } catch (error) {
          server.registry.update(entry.name, {
            status: "errored",
            appServerPid: null,
            errorMessage: error.message
          });
          appendLogLine(logPath, `failed to auto-resume ${entry.name}: ${error.message}`);
        }
      }
    }
    await stopPromise;
    appendLogLine(logPath, "daemon stopping");
    await server.stop();
    appendLogLine(logPath, "daemon stopped");
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    releasePidLock(pidPath);
  }
  return 0;
}

// src/main.ts
async function main(argv) {
  if (argv[0] === "__daemon") {
    return await runDaemon();
  }
  return await new CliClient().run(argv);
}
void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error.message}
`);
  process.exitCode = 1;
});
