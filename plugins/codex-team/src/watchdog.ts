import fs from "node:fs";

import { Config, WatchdogAlarmConfig } from "./config";
import { EventBus } from "./eventBus";
import { RegistryStore } from "./registry";
import { Session } from "./session";
import { DEFAULT_WORKSPACE, workspaceSessionKey } from "./workspace";

interface WatchdogSessionView {
  name: string;
  status: string;
  threadIdShort: string;
  tokens: number;
  metricKind: string;
  queue: number;
  transportAlive: boolean;
  currentTurnId: string | null;
  currentTurnAgeMs: number | null;
  advisories: string[];
}

export class WatchdogTimer {
  constructor(
    private readonly cfg: Config,
    private readonly registry: RegistryStore,
    private readonly eventBus: EventBus,
    private readonly sessions: Map<string, Session>,
  ) {}

  private readBrief(alarm?: WatchdogAlarmConfig): string {
    const filePath = alarm?.taskBriefFile || this.cfg.monitor.watchdogTaskBriefFile;
    if (!filePath || !fs.existsSync(filePath)) {
      return "";
    }
    const headLines = alarm?.taskBriefHeadLines || this.cfg.monitor.watchdogTaskBriefHeadLines;
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .slice(0, headLines)
      .join("\n");
  }

  private readTemplate(alarm?: WatchdogAlarmConfig): string {
    const filePath = alarm?.templateFile || this.cfg.monitor.watchdogTemplateFile;
    if (filePath && fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
    return alarm?.template || this.cfg.monitor.watchdogTemplate || defaultWatchdogTemplate();
  }

  async tickOnce(options: { force?: boolean; alarmName?: string; alarm?: WatchdogAlarmConfig; workspace?: string } = {}): Promise<void> {
    const workspace = options.workspace || DEFAULT_WORKSPACE;
    const now = new Date();
    const sentAt = now.toISOString();
    const localTime = formatLocalTime(now);
    const sessions: WatchdogSessionView[] = this.registry.list(workspace).map((entry) => {
      const advisories: string[] = [];
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
      const live = this.sessions.get(workspaceSessionKey(entry.workspace, entry.name));
      if (live) {
        if (!live.isTransportAlive()) {
          advisories.push("transport-down");
        }
        if (live.isRunning()) {
          const turnAgeMs = live.currentTurnAgeMs();
          if (turnAgeMs != null) {
            advisories.push(`running=${Math.floor(turnAgeMs / 1000)}s`);
            if (turnAgeMs >= this.cfg.heartbeat.turnStuckSeconds * 1000) {
              advisories.push("turn-stuck-threshold");
            }
          }
        }
      }
      if (entry.lastTurnEndedAt) {
        const last = new Date(entry.lastTurnEndedAt);
        if (!Number.isNaN(last.getTime())) {
          const idleMinutes = (now.getTime() - last.getTime()) / 60_000;
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
        advisories,
      };
    });
    const taskBrief = this.readBrief(options.alarm) || null;
    const emitIdle = options.alarm?.emitIdle ?? this.cfg.monitor.watchdogEmitIdle;
    const hasSignal =
      options.force ||
      Boolean(taskBrief) ||
      sessions.some((session) => session.advisories.length > 0 || session.status === "running");
    if (!hasSignal && !emitIdle) {
      return;
    }
    const summary = {
      total: sessions.length,
      running: sessions.filter((session) => session.status === "running").length,
      errored: sessions.filter((session) => session.status === "errored").length,
      queued: sessions.reduce((sum, session) => sum + Number(session.queue || 0), 0),
    };
    const alarmName = options.alarmName || "default";
    const message = renderWatchdogTemplate(this.readTemplate(options.alarm), {
      at: sentAt,
      sentAt,
      localTime,
      alarm: alarmName,
      workspace,
      taskBrief,
      summary,
      sessions,
    });
    this.eventBus.publish("watchdog", {
      workspace,
      kind: "watchdog-tick",
      at: sentAt,
      sentAt,
      localTime,
      alarm: alarmName,
      taskBrief,
      message,
      summary,
      sessions,
    });
  }
}

function defaultWatchdogTemplate(): string {
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
    "{{/if}}",
  ].join("\n");
}

function renderWatchdogTemplate(
  template: string,
  input: {
    at: string;
    sentAt: string;
    localTime: string;
    alarm: string;
    workspace: string;
    taskBrief: string | null;
    summary: { total: number; running: number; errored: number; queued: number };
    sessions: WatchdogSessionView[];
  },
): string {
  const sessionsText = input.sessions
    .map((session) => {
      const advisory = session.advisories.length > 0 ? ` [${session.advisories.join(", ")}]` : "";
      const turn = session.currentTurnId
        ? ` turn=${session.currentTurnId}${session.currentTurnAgeMs == null ? "" : ` age=${Math.floor(session.currentTurnAgeMs / 1000)}s`}`
        : "";
      return `- ${session.name}: ${session.status} queue=${session.queue} tokens=${session.tokens} ${session.metricKind}${turn}${advisory}`;
    })
    .join("\n");
  const variables: Record<string, string> = {
    at: input.at,
    sentAt: input.sentAt,
    localTime: input.localTime,
    alarm: input.alarm,
    workspace: input.workspace,
    taskBrief: input.taskBrief || "",
    sessionsText,
    "summary.total": String(input.summary.total),
    "summary.running": String(input.summary.running),
    "summary.errored": String(input.summary.errored),
    "summary.queued": String(input.summary.queued),
  };
  let out = template.replace(/{{#if ([\w.]+)}}([\s\S]*?){{\/if}}/g, (_match, key: string, body: string) => {
    return variables[key] ? body : "";
  });
  out = out.replace(/{{\s*([\w.]+)\s*}}/g, (_match, key: string) => variables[key] ?? "");
  return out.trim();
}

function formatLocalTime(date: Date): string {
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}
