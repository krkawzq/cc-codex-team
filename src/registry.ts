import fs from "node:fs";
import path from "node:path";

import { SessionExists, SessionNotFound } from "./errors";
import { RegistryEntry } from "./models";
import { isObject } from "./protocol";

interface RegistryFile {
  sessions?: Record<string, RegistryEntry>;
}

export class RegistryStore {
  private entries = new Map<string, RegistryEntry>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as unknown;
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

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: RegistryFile = { sessions: Object.fromEntries(this.entries.entries()) };
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }

  create(entry: RegistryEntry): void {
    if (this.entries.has(entry.name)) {
      throw new SessionExists(`session ${JSON.stringify(entry.name)} already exists`);
    }
    this.entries.set(entry.name, cloneEntry(entry));
    this.save();
  }

  get(name: string): RegistryEntry {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new SessionNotFound(`session ${JSON.stringify(name)} not found`);
    }
    return cloneEntry(entry);
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()].map(cloneEntry);
  }

  update(name: string, fields: Partial<RegistryEntry>): RegistryEntry {
    const current = this.entries.get(name);
    if (!current) {
      throw new SessionNotFound(`session ${JSON.stringify(name)} not found`);
    }
    const updated = { ...current, ...fields };
    this.entries.set(name, updated);
    this.save();
    return cloneEntry(updated);
  }

  delete(name: string): void {
    if (!this.entries.has(name)) {
      throw new SessionNotFound(`session ${JSON.stringify(name)} not found`);
    }
    this.entries.delete(name);
    this.save();
  }
}

function cloneEntry(entry: RegistryEntry): RegistryEntry {
  return JSON.parse(JSON.stringify(entry)) as RegistryEntry;
}

function normalizeEntry(name: string, raw: Record<string, unknown>): RegistryEntry {
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
    status: (raw.status as RegistryEntry["status"]) || "idle",
    appServerPid: raw.appServerPid == null ? null : Number(raw.appServerPid),
    queueLength: Number(raw.queueLength ?? 0),
    tokenUsageInput: Number(raw.tokenUsageInput ?? 0),
    contextTokensEstimate: raw.contextTokensEstimate == null ? null : Number(raw.contextTokensEstimate),
    modelContextWindow: raw.modelContextWindow == null ? null : Number(raw.modelContextWindow),
    errorMessage: raw.errorMessage == null ? null : String(raw.errorMessage),
  };
}
