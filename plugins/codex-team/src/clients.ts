import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { InvalidRequest } from "./errors";
import { isObject } from "./protocol";
import { clientsDir } from "./paths";

export interface ClientRecord {
  clientId: string;
  workspace: string;
  hostname: string;
  pid: number | null;
  startedAt: string;
  claudeProjectDir: string | null;
  sessionId: string | null;
}

export class ClientStore {
  constructor(private readonly dataDir: string) {}

  private dir(): string {
    return clientsDir(this.dataDir);
  }

  private filePath(clientId: string): string {
    return path.join(this.dir(), `${safeClientId(clientId)}.json`);
  }

  register(record: ClientRecord): ClientRecord {
    fs.mkdirSync(this.dir(), { recursive: true });
    fs.writeFileSync(this.filePath(record.clientId), JSON.stringify(record), "utf8");
    return record;
  }

  detach(clientId: string): boolean {
    const filePath = this.filePath(clientId);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  }

  detachBySession(workspace: string, sessionId: string): ClientRecord[] {
    const detached: ClientRecord[] = [];
    for (const record of this.list()) {
      if (record.workspace === workspace && record.sessionId === sessionId && this.detach(record.clientId)) {
        detached.push(record);
      }
    }
    return detached;
  }

  list(): ClientRecord[] {
    if (!fs.existsSync(this.dir())) {
      return [];
    }
    const records: ClientRecord[] = [];
    for (const file of fs.readdirSync(this.dir())) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const raw = fs.readFileSync(path.join(this.dir(), file), "utf8");
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (isObject(parsed)) {
          records.push(normalizeClient(parsed));
        }
      } catch {
        // ignore malformed stale files
      }
    }
    return records;
  }

  sweepStale(now = Date.now()): ClientRecord[] {
    const stale: ClientRecord[] = [];
    for (const record of this.list()) {
      const started = Date.parse(record.startedAt);
      const olderThanSevenDays = Number.isFinite(started) && now - started > 7 * 24 * 60 * 60 * 1000;
      const pidDead = record.pid != null && record.pid > 0 && !pidAlive(record.pid);
      if (pidDead || olderThanSevenDays) {
        this.detach(record.clientId);
        stale.push(record);
      }
    }
    return stale;
  }
}

function safeClientId(clientId: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(clientId)) {
    throw new InvalidRequest(`invalid client id: ${clientId}`);
  }
  return clientId;
}

function normalizeClient(raw: Record<string, unknown>): ClientRecord {
  return {
    clientId: String(raw.clientId ?? raw.client_id ?? ""),
    workspace: String(raw.workspace ?? "default"),
    hostname: String(raw.hostname ?? os.hostname()),
    pid: raw.pid == null ? null : Number(raw.pid),
    startedAt: String(raw.startedAt ?? raw.started_at ?? new Date().toISOString()),
    claudeProjectDir:
      raw.claudeProjectDir == null && raw.claude_project_dir == null
        ? null
        : String(raw.claudeProjectDir ?? raw.claude_project_dir),
    sessionId: raw.sessionId == null && raw.session_id == null ? null : String(raw.sessionId ?? raw.session_id),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
