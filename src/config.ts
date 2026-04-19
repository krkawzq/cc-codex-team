import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

import { CodexCliMissing, ConfigError } from "./errors";
import { defaultSocketPath, xdgConfigDir, xdgDataDir } from "./paths";
import { isObject } from "./protocol";

export interface DaemonConfig {
  socketPath: string;
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  codexBin: string;
  codexHome: string;
  launchArgsOverride: string[];
  configOverrides: string[];
  rpcTimeoutSeconds: number;
}

export interface DefaultsConfig {
  model: string;
  modelProvider: string;
  sandbox: string;
  approvalPolicy: string;
  cwd: string;
  autoResumeOnDaemonStart: boolean;
  serviceTier: string;
  reasoningEffort: string;
  personality: string;
  baseInstructions: string;
  developerInstructions: string;
  profile: string;
}

export interface ProfileConfig {
  model: string;
  modelProvider: string;
  sandbox: string;
  approvalPolicy: string;
  cwd: string;
  serviceTier: string;
  reasoningEffort: string;
  personality: string;
  baseInstructions: string;
  developerInstructions: string;
  ephemeral: boolean;
}

export interface DigestConfig {
  historyMdEnabled: boolean;
  turnsJsonlEnabled: boolean;
  commandTruncateChars: number;
  agentMessageFull: boolean;
  reasoningCapture: boolean;
  stderrTailLinesOnFail: number;
  maxFilesListed: number;
  toolArgsTruncateChars: number;
  historyRotationMb: number;
}

export interface CompactionConfig {
  thresholdTokens: number;
  mode: "manual";
  progressDocTemplate: string;
  retryAttempts: number;
  retryDelayMs: number;
  timeoutSeconds: number;
}

export interface MonitorConfig {
  eventsMaxBuffer: number;
  watchdogIntervalSeconds: number;
  watchdogTaskBriefFile: string;
  watchdogTaskBriefHeadLines: number;
  watchdogStaleMinutes: number;
  subscriberQueueMax: number;
  watchdogEmitIdle: boolean;
  watchdogTemplate: string;
  watchdogTemplateFile: string;
  watchdogAlarms: Record<string, WatchdogAlarmConfig>;
}

export interface WatchdogAlarmConfig {
  enabled: boolean;
  intervalSeconds: number;
  taskBriefFile: string;
  taskBriefHeadLines: number;
  emitIdle: boolean;
  template: string;
  templateFile: string;
}

export interface HeartbeatConfig {
  intervalSeconds: number;
  turnStuckSeconds: number;
  selfHealOnce: boolean;
  healthTimeoutSeconds: number;
  healthCheckConcurrency: number;
  resumeTimeoutSeconds: number;
  selfHealBackoffSeconds: number;
}

export interface QueueConfig {
  maxPerSession: number;
  overflowPolicy: "warn" | "reject" | "drop_oldest";
}

export interface Config {
  daemon: DaemonConfig;
  defaults: DefaultsConfig;
  digest: DigestConfig;
  compaction: CompactionConfig;
  monitor: MonitorConfig;
  heartbeat: HeartbeatConfig;
  queue: QueueConfig;
  profiles: Record<string, ProfileConfig>;
}

const DEFAULT_CONFIG: Config = {
  daemon: {
    socketPath: "",
    dataDir: "",
    logLevel: "info",
    codexBin: "",
    codexHome: "",
    launchArgsOverride: [],
    configOverrides: [],
    rpcTimeoutSeconds: 60,
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
    profile: "",
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
    historyRotationMb: 32,
  },
  compaction: {
    thresholdTokens: 500_000,
    mode: "manual",
    progressDocTemplate: "",
    retryAttempts: 2,
    retryDelayMs: 1500,
    timeoutSeconds: 600,
  },
  monitor: {
    eventsMaxBuffer: 1000,
    watchdogIntervalSeconds: 1200,
    watchdogTaskBriefFile: "",
    watchdogTaskBriefHeadLines: 30,
    watchdogStaleMinutes: 30,
    subscriberQueueMax: 200,
    watchdogEmitIdle: false,
    watchdogTemplate: "",
    watchdogTemplateFile: "",
    watchdogAlarms: {},
  },
  heartbeat: {
    intervalSeconds: 60,
    turnStuckSeconds: 600,
    selfHealOnce: true,
    healthTimeoutSeconds: 15,
    healthCheckConcurrency: 8,
    resumeTimeoutSeconds: 30,
    selfHealBackoffSeconds: 30,
  },
  queue: {
    maxPerSession: 5,
    overflowPolicy: "warn",
  },
  profiles: {},
};

export function defaultConfigPath(): string {
  return path.join(xdgConfigDir(), "config.toml");
}

export function loadConfig(configPath: string = defaultConfigPath()): Config {
  let cfg = cloneDefaultConfig();
  if (fs.existsSync(configPath)) {
    let raw: unknown;
    try {
      raw = parseToml(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new ConfigError(`Invalid TOML in ${configPath}: ${(error as Error).message}`);
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

function cloneDefaultConfig(): Config {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

function mergeConfig(base: Config, raw: Record<string, unknown>): Config {
  applySection(base.daemon, raw.daemon, daemonFieldKinds);
  applySection(base.defaults, raw.defaults, defaultsFieldKinds);
  applySection(base.digest, raw.digest, digestFieldKinds);
  applySection(base.compaction, raw.compaction, compactionFieldKinds);
  applySection(base.monitor, raw.monitor, monitorFieldKinds);
  if (isObject(raw.monitor)) {
    const alarmsRaw = isObject(raw.monitor.watchdog_alarms)
      ? raw.monitor.watchdog_alarms
      : isObject(raw.monitor.watchdogAlarms)
        ? raw.monitor.watchdogAlarms
        : null;
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

function cloneProfile(): ProfileConfig {
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
    ephemeral: false,
  };
}

function cloneAlarm(): WatchdogAlarmConfig {
  return {
    enabled: true,
    intervalSeconds: 1200,
    taskBriefFile: "",
    taskBriefHeadLines: 30,
    emitIdle: false,
    template: "",
    templateFile: "",
  };
}

type FieldKind = "string" | "number" | "boolean" | "string[]" | "object";

const daemonFieldKinds: Record<keyof DaemonConfig, FieldKind> = {
  socketPath: "string",
  dataDir: "string",
  logLevel: "string",
  codexBin: "string",
  codexHome: "string",
  launchArgsOverride: "string[]",
  configOverrides: "string[]",
  rpcTimeoutSeconds: "number",
};

const defaultsFieldKinds: Record<keyof DefaultsConfig, FieldKind> = {
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
  profile: "string",
};

const profileFieldKinds: Record<keyof ProfileConfig, FieldKind> = {
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
  ephemeral: "boolean",
};

const digestFieldKinds: Record<keyof DigestConfig, FieldKind> = {
  historyMdEnabled: "boolean",
  turnsJsonlEnabled: "boolean",
  commandTruncateChars: "number",
  agentMessageFull: "boolean",
  reasoningCapture: "boolean",
  stderrTailLinesOnFail: "number",
  maxFilesListed: "number",
  toolArgsTruncateChars: "number",
  historyRotationMb: "number",
};

const compactionFieldKinds: Record<keyof CompactionConfig, FieldKind> = {
  thresholdTokens: "number",
  mode: "string",
  progressDocTemplate: "string",
  retryAttempts: "number",
  retryDelayMs: "number",
  timeoutSeconds: "number",
};

const monitorFieldKinds: Record<keyof MonitorConfig, FieldKind> = {
  eventsMaxBuffer: "number",
  watchdogIntervalSeconds: "number",
  watchdogTaskBriefFile: "string",
  watchdogTaskBriefHeadLines: "number",
  watchdogStaleMinutes: "number",
  subscriberQueueMax: "number",
  watchdogEmitIdle: "boolean",
  watchdogTemplate: "string",
  watchdogTemplateFile: "string",
  watchdogAlarms: "object",
};

const watchdogAlarmFieldKinds: Record<keyof WatchdogAlarmConfig, FieldKind> = {
  enabled: "boolean",
  intervalSeconds: "number",
  taskBriefFile: "string",
  taskBriefHeadLines: "number",
  emitIdle: "boolean",
  template: "string",
  templateFile: "string",
};

const heartbeatFieldKinds: Record<keyof HeartbeatConfig, FieldKind> = {
  intervalSeconds: "number",
  turnStuckSeconds: "number",
  selfHealOnce: "boolean",
  healthTimeoutSeconds: "number",
  healthCheckConcurrency: "number",
  resumeTimeoutSeconds: "number",
  selfHealBackoffSeconds: "number",
};

const queueFieldKinds: Record<keyof QueueConfig, FieldKind> = {
  maxPerSession: "number",
  overflowPolicy: "string",
};

function applySection<T extends object>(
  target: T,
  source: unknown,
  fieldKinds: Record<keyof T, FieldKind>,
): void {
  if (!isObject(source)) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = resolveFieldKey(key, fieldKinds);
    if (!normalizedKey) {
      continue;
    }
    const kind = fieldKinds[normalizedKey];
    (target as Record<string, unknown>)[normalizedKey as string] = coerceValue(
      value,
      kind,
      `.${String(normalizedKey)}`,
    );
  }
}

function resolveFieldKey<T extends object>(
  rawKey: string,
  fieldKinds: Record<keyof T, FieldKind>,
): keyof T | null {
  if (rawKey in fieldKinds) {
    return rawKey as keyof T;
  }
  const camelKey = rawKey.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
  if (camelKey in fieldKinds) {
    return camelKey as keyof T;
  }
  return null;
}

function coerceValue(value: unknown, kind: FieldKind, label: string): unknown {
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

const BOOL_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOL_FALSE = new Set(["0", "false", "no", "off"]);

function applyEnvOverrides(cfg: Config): void {
  applyEnvSection("daemon", cfg.daemon, daemonFieldKinds);
  applyEnvSection("defaults", cfg.defaults, defaultsFieldKinds);
  applyEnvSection("digest", cfg.digest, digestFieldKinds);
  applyEnvSection("compaction", cfg.compaction, compactionFieldKinds);
  applyEnvSection("monitor", cfg.monitor, monitorFieldKinds);
  applyEnvSection("heartbeat", cfg.heartbeat, heartbeatFieldKinds);
  applyEnvSection("queue", cfg.queue, queueFieldKinds);
}

function applyEnvSection<T extends object>(
  sectionName: string,
  target: T,
  fieldKinds: Record<keyof T, FieldKind>,
): void {
  for (const [fieldName, rawKind] of Object.entries(fieldKinds)) {
    const kind = rawKind as FieldKind;
    const envKeys = [
      `CODEX_TEAM_${sectionName.toUpperCase()}_${camelToEnvKey(fieldName)}`,
      `CODEX_TEAM_${sectionName.toUpperCase()}_${fieldName.toUpperCase()}`,
    ];
    const raw = envKeys.map((key) => process.env[key]).find((value) => value !== undefined);
    if (raw === undefined) {
      continue;
    }
    (target as Record<string, unknown>)[fieldName] = coerceEnvValue(raw, kind);
  }
}

function camelToEnvKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function validateConfig(cfg: Config): void {
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

function assertOneOf(value: string, allowed: string[], label: string): void {
  if (!allowed.includes(value)) {
    throw new ConfigError(`${label} must be one of ${allowed.join(", ")}`);
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer`);
  }
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${label} must be a non-negative integer`);
  }
}

function validateOptionalSandbox(value: string, label: string): void {
  const normalized = normalizeSandboxMode(value);
  if (!normalized) {
    return;
  }
  assertOneOf(normalized, ["read-only", "workspace-write", "danger-full-access"], label);
}

function validateOptionalApproval(value: string, label: string): void {
  const normalized = normalizeApprovalPolicy(value);
  if (!normalized) {
    return;
  }
  assertOneOf(normalized, ["never", "on-request", "on-failure", "untrusted"], label);
}

function coerceEnvValue(value: string, kind: FieldKind): unknown {
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
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    case "object":
      throw new ConfigError("Cannot override object fields via env");
  }
}

export function resolveDataDir(cfg: Config): string {
  return cfg.daemon.dataDir || xdgDataDir();
}

export function resolveSocketPath(cfg: Config): string {
  return cfg.daemon.socketPath || defaultSocketPath();
}

export function resolveCodexBin(cfg: Config): string {
  const configured = cfg.daemon.codexBin.trim();
  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new CodexCliMissing(`codex binary not found at configured path: ${configured}`);
    }
    return configured;
  }
  const fromEnv = (process.env.CODEX_TEAM_CODEX_BIN || "").trim();
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
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

function which(name: string): string | null {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function normalizeSandboxMode(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.replace(/_/g, "-") : null;
}

export function normalizeApprovalPolicy(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.replace(/_/g, "-") : null;
}
