import { ConfigStore } from "./config";
import { UserRegistry } from "./users";
import { SessionRegistry } from "./sessions";
import { EventLog } from "./events";
import { PendingRegistry } from "./pending";
import { TurnQueues } from "./queues";
import { PidTracker } from "./orphans";
import { AppServerPool } from "../codex/pool";
import type { RetryOptions } from "../codex/retry";
import { logger } from "../logger";

export interface ActivityTracker {
  lastActivityAt: Date;
  touch(): void;
}

export interface DaemonContext {
  startedAt: Date;
  config: ConfigStore;
  users: UserRegistry;
  sessions: SessionRegistry;
  pool: AppServerPool;
  events: EventLog;
  pending: PendingRegistry;
  queues: TurnQueues;
  activity: ActivityTracker;
  retryOptions(): RetryOptions;
  dataDir: string;
  sockPath: string;
  logPath: string;
}

export function buildContext(): DaemonContext {
  const config = new ConfigStore();
  const dataDir = config.resolvedDataDir();
  const sockPath = config.resolvedSockPath();
  const logPath = config.resolvedLogPath();

  const logLevel = config.getEffective("daemon.log_level");
  logger.configure({
    level: typeof logLevel === "string" ? (logLevel as "info") : "info",
    logPath,
  });

  const users = new UserRegistry(dataDir);

  const sessions = new SessionRegistry(dataDir);
  sessions.loadAllUsers(users.list().map((u) => u.token));

  const pidTracker = new PidTracker(dataDir);
  const maxPerProcess = config.getEffective("app_server.max_sessions_per_process");
  const pool = new AppServerPool({
    maxSessionsPerProcess: typeof maxPerProcess === "number" ? maxPerProcess : 16,
    clientDefaults: {
      requestTimeoutMs: toMs(config.getEffective("app_server.request_timeout_seconds"), 120_000),
    },
    onSpawn: (pid) => pidTracker.track(pid),
    onExit: (pid) => pidTracker.untrack(pid),
  });

  pool.on("client_close", (e) => {
    logger.info("app-server client closed", {
      user: e.user,
      client: e.clientId,
      lost_sessions: e.sessions.length,
      exit_code: e.exitCode,
    });
  });

  const retentionRaw = config.getEffective("monitor.event_log_retention");
  const events = new EventLog(typeof retentionRaw === "number" ? retentionRaw : 10000, dataDir);
  const pending = new PendingRegistry();
  const queues = new TurnQueues();

  const activity: ActivityTracker = {
    lastActivityAt: new Date(),
    touch(): void { activity.lastActivityAt = new Date(); },
  };

  const retryOptions = (): RetryOptions => {
    return {
      maxAttempts: toInt(config.getEffective("retry.max_attempts"), 3),
      initialDelayMs: toMs(config.getEffective("retry.initial_delay_seconds"), 250),
      maxDelayMs: toMs(config.getEffective("retry.max_delay_seconds"), 2000),
      jitterRatio: 0.2,
    };
  };

  return {
    startedAt: new Date(),
    config,
    users,
    sessions,
    pool,
    events,
    pending,
    queues,
    activity,
    retryOptions,
    dataDir,
    sockPath,
    logPath,
  };
}

function toInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return fallback;
}

function toMs(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v * 1000);
  return fallback;
}
