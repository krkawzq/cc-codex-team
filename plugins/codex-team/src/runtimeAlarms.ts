import fs from "node:fs";
import path from "node:path";

import { WatchdogAlarmConfig } from "./config";
import { InvalidRequest } from "./errors";
import { isObject } from "./protocol";
import { alarmsDir, workspaceAlarmsDir } from "./paths";

export interface RuntimeAlarmRecord {
  workspace: string;
  name: string;
  clientId: string | null;
  alarm: WatchdogAlarmConfig;
  createdAt: string;
  updatedAt: string;
}

export class RuntimeAlarmStore {
  constructor(private readonly dataDir: string) {}

  upsert(record: RuntimeAlarmRecord): RuntimeAlarmRecord {
    const normalized = normalizeRecord(record as unknown as Record<string, unknown>);
    const dir = workspaceAlarmsDir(this.dataDir, normalized.workspace);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath(normalized.workspace, normalized.name), JSON.stringify(normalized), "utf8");
    return normalized;
  }

  delete(workspace: string, name: string): boolean {
    const filePath = this.filePath(workspace, name);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  }

  deleteByClient(clientId: string): number {
    let count = 0;
    for (const record of this.list(null, true)) {
      if (record.clientId === clientId && this.delete(record.workspace, record.name)) {
        count += 1;
      }
    }
    return count;
  }

  list(workspace?: string | null, allWorkspaces = false): RuntimeAlarmRecord[] {
    const root = alarmsDir(this.dataDir);
    if (!fs.existsSync(root)) {
      return [];
    }
    const workspaces = allWorkspaces || !workspace ? fs.readdirSync(root) : [workspace];
    const records: RuntimeAlarmRecord[] = [];
    for (const ws of workspaces) {
      const dir = workspaceAlarmsDir(this.dataDir, ws);
      if (!fs.existsSync(dir)) {
        continue;
      }
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) {
          continue;
        }
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as unknown;
          if (isObject(parsed)) {
            records.push(normalizeRecord(parsed));
          }
        } catch {
          // ignore corrupt runtime alarm files
        }
      }
    }
    return records;
  }

  private filePath(workspace: string, name: string): string {
    return path.join(workspaceAlarmsDir(this.dataDir, safePart(workspace)), `${safePart(name)}.json`);
  }
}

export function runtimeAlarmToWire(record: RuntimeAlarmRecord): Record<string, unknown> {
  return {
    workspace: record.workspace,
    name: record.name,
    client_id: record.clientId,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ...alarmToWire(record.alarm),
  };
}

function normalizeRecord(raw: Record<string, unknown>): RuntimeAlarmRecord {
  return {
    workspace: safePart(String(raw.workspace ?? "default")),
    name: safePart(String(raw.name ?? "")),
    clientId: raw.clientId == null && raw.client_id == null ? null : String(raw.clientId ?? raw.client_id),
    alarm: normalizeAlarm(isObject(raw.alarm) ? raw.alarm : raw),
    createdAt: String(raw.createdAt ?? raw.created_at ?? new Date().toISOString()),
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? new Date().toISOString()),
  };
}

function normalizeAlarm(raw: Record<string, unknown>): WatchdogAlarmConfig {
  return {
    enabled: raw.enabled == null ? true : Boolean(raw.enabled),
    intervalSeconds: numberValue(raw.intervalSeconds ?? raw.interval_seconds, 1200),
    taskBriefFile: String(raw.taskBriefFile ?? raw.task_brief_file ?? ""),
    taskBriefHeadLines: numberValue(raw.taskBriefHeadLines ?? raw.task_brief_head_lines, 30),
    emitIdle: raw.emitIdle == null && raw.emit_idle == null ? false : Boolean(raw.emitIdle ?? raw.emit_idle),
    template: String(raw.template ?? ""),
    templateFile: String(raw.templateFile ?? raw.template_file ?? ""),
  };
}

function alarmToWire(alarm: WatchdogAlarmConfig): Record<string, unknown> {
  return {
    enabled: alarm.enabled,
    interval_seconds: alarm.intervalSeconds,
    task_brief_file: alarm.taskBriefFile,
    task_brief_head_lines: alarm.taskBriefHeadLines,
    emit_idle: alarm.emitIdle,
    template: alarm.template,
    template_file: alarm.templateFile,
  };
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safePart(value: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(value) || value === "*") {
    throw new InvalidRequest(`invalid alarm path component: ${value}`);
  }
  return value;
}
