import fs from "node:fs";
import path from "node:path";

import { configFilePath, defaultDataDir, defaultLogPath, defaultSockPath, expandUserPath, normalizeSockPath } from "../paths";

export type ConfigValue = string | number | boolean;
export type HotCold = "hot" | "restart";

export interface ConfigSpec {
  type: "string" | "int" | "float" | "bool" | "path" | "enum";
  default: ConfigValue;
  needsRestart: boolean;
  enumValues?: string[];
  description: string;
}

function enumSpec(values: string[], def: string, needsRestart: boolean, desc: string): ConfigSpec {
  return { type: "enum", enumValues: values, default: def, needsRestart, description: desc };
}

export const CONFIG_KEYS: Record<string, ConfigSpec> = {
  "daemon.idle_shutdown_hours": { type: "int", default: 6, needsRestart: false, description: "idle auto-shutdown threshold (hours)" },
  "daemon.log_level": enumSpec(["error", "warn", "info", "debug", "trace"], "info", false, "log verbosity"),
  "daemon.log_path": { type: "path", default: "", needsRestart: true, description: "log file path (empty = default)" },
  "daemon.data_dir": { type: "path", default: "", needsRestart: true, description: "persistent state root (empty = default)" },
  "daemon.sock_path": { type: "path", default: "", needsRestart: true, description: "sock path (empty = default)" },
  "daemon.ready_timeout_seconds": { type: "int", default: 15, needsRestart: false, description: "how long the CLI waits for the daemon to become ready" },
  "daemon.connect_timeout_seconds": { type: "int", default: 5, needsRestart: false, description: "per-attempt CLI connect timeout to the daemon" },
  "daemon.connect_retry_attempts": { type: "int", default: 3, needsRestart: false, description: "CLI retries for transient daemon connect errors" },
  "daemon.connect_retry_delay_seconds": { type: "float", default: 0.25, needsRestart: false, description: "delay between transient daemon connect retries" },

  "monitor.default_interval_seconds": { type: "int", default: 30, needsRestart: false, description: "default --interval for `monitor events`" },
  "monitor.event_log_retention": { type: "int", default: 10000, needsRestart: false, description: "per-user ring-buffer event retention" },

  "app_server.max_sessions_per_process": { type: "int", default: 16, needsRestart: false, description: "max session bindings per reusable app-server process (primarily adhoc clients)" },
  "app_server.idle_unload_minutes": { type: "int", default: 60, needsRestart: false, description: "idle duration before unloading live session from app-server" },
  "app_server.request_timeout_seconds": { type: "int", default: 120, needsRestart: false, description: "per-request timeout for app-server JSON-RPC calls" },

  "retry.max_attempts": { type: "int", default: 3, needsRestart: false, description: "retry count for transient app-server transport / stream errors" },
  "retry.initial_delay_seconds": { type: "float", default: 0.25, needsRestart: false, description: "initial backoff" },
  "retry.max_delay_seconds": { type: "float", default: 2.0, needsRestart: false, description: "max backoff" },

  "codex.default_model": { type: "string", default: "", needsRestart: false, description: "default --model for session new" },
  "codex.default_sandbox": enumSpec(["read-only", "workspace-write", "danger-full-access"], "workspace-write", false, "default --sandbox"),
  "codex.default_approval": enumSpec(["never", "on-request", "on-failure", "untrusted"], "on-request", false, "default --approval"),
  "codex.default_effort": enumSpec(["minimal", "low", "medium", "high", "xhigh"], "medium", false, "default --effort"),
  "experimental.default_tools": { type: "string", default: "", needsRestart: false, description: "default session experimental tools CSV" },
};

export interface ConfigSnapshot {
  explicit: Record<string, ConfigValue>;
  effective: Record<string, ConfigValue>;
}

export class ConfigStore {
  private explicit: Record<string, ConfigValue> = {};
  private readonly filePath: string;

  constructor(dataDir = defaultDataDir()) {
    this.filePath = configFilePath(dataDir);
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, ConfigValue>;
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          const spec = CONFIG_KEYS[k];
          if (spec && isValidPersistedValue(v, spec)) {
            this.explicit[k] = v;
          }
        }
      }
    } catch {
      // missing or invalid → start empty
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.explicit, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  listKeys(): string[] {
    return Object.keys(CONFIG_KEYS);
  }

  spec(key: string): ConfigSpec | null {
    return CONFIG_KEYS[key] ?? null;
  }

  get(key: string): { value: ConfigValue; source: "explicit" | "default"; spec: ConfigSpec } | null {
    const spec = CONFIG_KEYS[key];
    if (!spec) return null;
    if (key in this.explicit) {
      return { value: this.explicit[key], source: "explicit", spec };
    }
    return { value: spec.default, source: "default", spec };
  }

  getEffective(key: string): ConfigValue | null {
    const e = this.get(key);
    return e ? e.value : null;
  }

  set(key: string, rawValue: string): { ok: true; value: ConfigValue; needs_restart: boolean } | { ok: false; error: string } {
    const spec = CONFIG_KEYS[key];
    if (!spec) return { ok: false, error: `unknown key: ${key}` };
    const parsed = parseValue(rawValue, spec);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    this.explicit[key] = parsed.value;
    this.persist();
    return { ok: true, value: parsed.value, needs_restart: spec.needsRestart };
  }

  unset(key: string): { ok: true; needs_restart: boolean } | { ok: false; error: string } {
    const spec = CONFIG_KEYS[key];
    if (!spec) return { ok: false, error: `unknown key: ${key}` };
    if (key in this.explicit) {
      delete this.explicit[key];
      this.persist();
    }
    return { ok: true, needs_restart: spec.needsRestart };
  }

  reset(): void {
    this.explicit = {};
    this.persist();
  }

  snapshot(): ConfigSnapshot {
    const explicit = { ...this.explicit };
    const effective: Record<string, ConfigValue> = {};
    for (const key of Object.keys(CONFIG_KEYS)) {
      const e = this.get(key);
      if (e) effective[key] = e.value;
    }
    return { explicit, effective };
  }

  resolvedLogPath(): string {
    const explicit = this.explicit["daemon.log_path"];
    if (typeof explicit === "string" && explicit.trim().length > 0) return expandUserPath(explicit);
    return defaultLogPath(this.resolvedDataDir());
  }

  resolvedSockPath(): string {
    const explicit = this.explicit["daemon.sock_path"];
    if (typeof explicit === "string" && explicit.trim().length > 0) return normalizeSockPath(expandUserPath(explicit));
    return defaultSockPath(this.resolvedDataDir());
  }

  resolvedDataDir(): string {
    const explicit = this.explicit["daemon.data_dir"];
    if (typeof explicit === "string" && explicit.trim().length > 0) return expandUserPath(explicit);
    return defaultDataDir();
  }
}

function parseValue(raw: string, spec: ConfigSpec): { ok: true; value: ConfigValue } | { ok: false; error: string } {
  switch (spec.type) {
    case "int": {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: `expected integer, got: ${raw}` };
      return { ok: true, value: n };
    }
    case "float": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `expected number, got: ${raw}` };
      return { ok: true, value: n };
    }
    case "bool": {
      if (raw === "true" || raw === "1") return { ok: true, value: true };
      if (raw === "false" || raw === "0") return { ok: true, value: false };
      return { ok: false, error: `expected true/false, got: ${raw}` };
    }
    case "enum": {
      if (!spec.enumValues || !spec.enumValues.includes(raw)) {
        return { ok: false, error: `expected one of: ${spec.enumValues?.join(" / ") ?? ""}` };
      }
      return { ok: true, value: raw };
    }
    case "path":
    case "string":
    default:
      return { ok: true, value: raw };
  }
}

function isValidPersistedValue(value: unknown, spec: ConfigSpec): value is ConfigValue {
  switch (spec.type) {
    case "int":
      return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "bool":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && !!spec.enumValues?.includes(value);
    case "path":
    case "string":
    default:
      return typeof value === "string";
  }
}
