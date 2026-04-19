import fs from "node:fs";
import path from "node:path";

import { SessionExists, SessionNotFound, WrongWorkspace } from "./errors";
import { RegistryEntry } from "./models";
import { isObject } from "./protocol";
import { DEFAULT_WORKSPACE, safeWorkspace, workspaceSessionKey } from "./workspace";

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
    let migrated = false;
    for (const [key, value] of Object.entries(sessions)) {
      if (!isObject(value)) {
        continue;
      }
      const entry = normalizeEntry(key, value);
      if (value.createdByClientId === undefined) {
        migrated = true;
      }
      this.entries.set(entryKey(entry.workspace, entry.name), entry);
    }
    if (migrated) {
      this.save();
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
    const normalized = normalizeEntry(entry.name, entry as unknown as Record<string, unknown>);
    const key = entryKey(normalized.workspace, normalized.name);
    if (this.entries.has(key)) {
      throw new SessionExists(
        `session ${JSON.stringify(normalized.name)} already exists in workspace ${JSON.stringify(normalized.workspace)}`,
      );
    }
    this.entries.set(key, cloneEntry(normalized));
    this.save();
  }

  get(name: string, workspace = DEFAULT_WORKSPACE): RegistryEntry {
    const entry = this.entries.get(entryKey(workspace, name));
    if (!entry) {
      throw new SessionNotFound(
        `session ${JSON.stringify(name)} not found in workspace ${JSON.stringify(workspace)}`,
      );
    }
    return cloneEntry(entry);
  }

  find(name: string, workspace: string | null, allWorkspaces = false): RegistryEntry {
    if (!allWorkspaces) {
      const requested = workspace || DEFAULT_WORKSPACE;
      try {
        return this.get(name, requested);
      } catch (error) {
        if (error instanceof SessionNotFound) {
          const other = [...this.entries.values()].find((entry) => entry.name === name);
          if (other) {
            throw new WrongWorkspace(
              `session ${JSON.stringify(name)} is in workspace ${JSON.stringify(other.workspace)}, not ${JSON.stringify(requested)}`,
            );
          }
        }
        throw error;
      }
    }
    const matches = [...this.entries.values()].filter((entry) => entry.name === name);
    if (matches.length === 0) {
      throw new SessionNotFound(`session ${JSON.stringify(name)} not found`);
    }
    if (matches.length > 1) {
      throw new SessionNotFound(
        `session ${JSON.stringify(name)} exists in multiple workspaces; pass --workspace`,
      );
    }
    return cloneEntry(matches[0]);
  }

  list(workspace?: string | null, allWorkspaces = false): RegistryEntry[] {
    const entries = [...this.entries.values()];
    const filtered = allWorkspaces || !workspace
      ? entries
      : entries.filter((entry) => entry.workspace === workspace);
    return filtered.map(cloneEntry);
  }

  workspaces(): string[] {
    return [...new Set([...this.entries.values()].map((entry) => entry.workspace))].sort();
  }

  update(name: string, fields: Partial<RegistryEntry>, workspace = DEFAULT_WORKSPACE): RegistryEntry {
    const key = entryKey(workspace, name);
    const current = this.entries.get(key);
    if (!current) {
      throw new SessionNotFound(
        `session ${JSON.stringify(name)} not found in workspace ${JSON.stringify(workspace)}`,
      );
    }
    const updated = { ...current, ...fields, workspace: current.workspace, name: current.name };
    this.entries.set(key, updated);
    this.save();
    return cloneEntry(updated);
  }

  delete(name: string, workspace = DEFAULT_WORKSPACE): void {
    const key = entryKey(workspace, name);
    if (!this.entries.has(key)) {
      throw new SessionNotFound(
        `session ${JSON.stringify(name)} not found in workspace ${JSON.stringify(workspace)}`,
      );
    }
    this.entries.delete(key);
    this.save();
  }
}

function entryKey(workspace: string, name: string): string {
  return workspaceSessionKey(workspace, name);
}

function cloneEntry(entry: RegistryEntry): RegistryEntry {
  return JSON.parse(JSON.stringify(entry)) as RegistryEntry;
}

function normalizeEntry(key: string, raw: Record<string, unknown>): RegistryEntry {
  const parsedKey = parseKey(key);
  const name = String(raw.name ?? parsedKey.name);
  if (raw.workspace == null && parsedKey.workspace == null) {
    throw new Error(`registry entry ${JSON.stringify(key)} is missing workspace`);
  }
  const workspace = safeWorkspace(String(raw.workspace ?? parsedKey.workspace));
  return {
    workspace,
    name,
    createdByClientId: raw.createdByClientId == null ? null : String(raw.createdByClientId),
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

function parseKey(key: string): { workspace: string | null; name: string } {
  const nul = key.indexOf("\u0000");
  if (nul > 0) {
    return { workspace: key.slice(0, nul), name: key.slice(nul + 1) };
  }
  return { workspace: null, name: key };
}
