export interface ParsedArgs {
  commandPath: string[];
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
  bearer: string | null;
  verbose: boolean;
  daemonSock: string | null;
  help: boolean;
  unknown: string | null;
}

const COMMANDS: Set<string> = new Set([
  "version",
  "doctor",
  "status",
  "daemon:status",
  "daemon:start",
  "daemon:stop",
  "daemon:restart",
  "daemon:logs",
  "daemon:user:create",
  "daemon:user:destroy",
  "daemon:user:list",
  "daemon:config:get",
  "daemon:config:set",
  "daemon:config:unset",
  "daemon:config:list",
  "daemon:config:reset",
  "session:new",
  "session:attach",
  "session:detach",
  "session:archive",
  "session:unarchive",
  "session:fork",
  "session:rename",
  "session:rollback",
  "session:info",
  "session:context",
  "session:list",
  "message:send",
  "message:send-many",
  "message:peer",
  "message:interrupt",
  "message:approval",
  "message:answer",
  "message:history",
  "message:tail",
  "monitor:events",
  "monitor:alarm",
  "session:health",
  "session:heal",
  "message:wait",
  "cursor:save",
  "cursor:list",
  "cursor:get",
  "cursor:delete",
]);

const HELP_PATHS: Set<string> = new Set([
  ...COMMANDS,
  "daemon",
  "daemon:user",
  "daemon:config",
  "session",
  "message",
  "monitor",
  "cursor",
]);

interface GlobalSpec {
  name: "bearer" | "verbose" | "help" | "daemonSock";
  takesValue: boolean;
}

const GLOBAL_FLAGS: Record<string, GlobalSpec> = {
  "-b": { name: "bearer", takesValue: true },
  "--bearer": { name: "bearer", takesValue: true },
  "-v": { name: "verbose", takesValue: false },
  "--verbose": { name: "verbose", takesValue: false },
  "-h": { name: "help", takesValue: false },
  "--help": { name: "help", takesValue: false },
  "--daemon-sock": { name: "daemonSock", takesValue: true },
};

const BOOLEAN_LONG_FLAGS: Set<string> = new Set([
  "all",
  "any",
  "explicit-only",
  "follow",
  "force",
  "full",
  "graceful",
  "help",
  "include-delta",
  "once",
  "short",
  "stdin",
  "stream",
  "summary",
  "takeover",
  "verbose",
  "yes",
]);

const BOOLEAN_SHORT_FLAGS: Set<string> = new Set([
  "f",
  "h",
  "v",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    commandPath: [],
    positionals: [],
    flags: {},
    bearer: null,
    verbose: false,
    daemonSock: null,
    help: false,
    unknown: null,
  };

  const nonGlobal: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [globalToken, inlineValue] = splitLongFlagAssignment(a);
    const spec = GLOBAL_FLAGS[globalToken];
    if (!spec) {
      nonGlobal.push(a);
      continue;
    }
    if (spec.takesValue) {
      const v = inlineValue ?? argv[++i];
      if (v === undefined) {
        result.unknown = `flag ${globalToken} requires a value`;
        return result;
      }
      if (spec.name === "bearer") result.bearer = v;
      else if (spec.name === "daemonSock") result.daemonSock = v;
    } else {
      if (spec.name === "verbose") result.verbose = true;
      else if (spec.name === "help") {
        result.help = true;
        break;
      }
    }
  }

  const matched = matchCommand(nonGlobal, result.help ? HELP_PATHS : COMMANDS);
  if (!matched) {
    if (nonGlobal.length === 0) {
      result.help = true;
      return result;
    }
    result.unknown = `unknown command: ${nonGlobal.join(" ")}`;
    return result;
  }

  result.commandPath = matched.path;
  const tail = matched.remaining;

  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith("--")) {
      const eqIdx = a.indexOf("=");
      let key: string;
      let value: string | null;
      if (eqIdx >= 0) {
        key = a.slice(2, eqIdx);
        value = a.slice(eqIdx + 1);
      } else {
        key = a.slice(2);
        if (BOOLEAN_LONG_FLAGS.has(key)) {
          value = null;
        } else {
          const next = tail[i + 1];
          if (next !== undefined && !isFlagLike(next)) {
            value = next;
            i++;
          } else {
            value = null;
          }
        }
      }
      setFlag(result.flags, key, value);
    } else if (a.length > 1 && a.startsWith("-") && !isNegativeNumber(a)) {
      const key = a.slice(1);
      if (BOOLEAN_SHORT_FLAGS.has(key)) {
        setFlag(result.flags, key, null);
      } else {
        const next = tail[i + 1];
        if (next !== undefined && !isFlagLike(next)) {
          setFlag(result.flags, key, next);
          i++;
        } else {
          setFlag(result.flags, key, null);
        }
      }
    } else {
      result.positionals.push(a);
    }
  }

  if (truthyFlag(result.flags.short) && truthyFlag(result.flags.full)) {
    result.unknown = "--short and --full are mutually exclusive";
  } else if (commandKey(result.commandPath) === "message:wait" && truthyFlag(result.flags.all) && truthyFlag(result.flags.any)) {
    result.unknown = "--all and --any are mutually exclusive";
  }

  return result;
}

function isFlagLike(s: string): boolean {
  if (!s.startsWith("-")) return false;
  if (s === "-") return false;
  if (isNegativeNumber(s)) return false;
  return true;
}

function isNegativeNumber(s: string): boolean {
  return /^-\d+(\.\d+)?$/.test(s);
}

function splitLongFlagAssignment(token: string): [string, string | null] {
  if (!token.startsWith("--")) return [token, null];
  const eqIdx = token.indexOf("=");
  if (eqIdx < 0) return [token, null];
  return [token.slice(0, eqIdx), token.slice(eqIdx + 1)];
}

function setFlag(flags: Record<string, string | boolean | string[]>, key: string, value: string | null): void {
  if (value === null) {
    flags[key] = true;
    return;
  }
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else if (typeof existing === "string") {
    flags[key] = [existing, value];
  } else {
    flags[key] = value;
  }
}

function matchCommand(tokens: string[], available: Set<string>): { path: string[]; remaining: string[] } | null {
  const maxDepth = Math.min(tokens.length, 3);
  for (let len = maxDepth; len >= 1; len--) {
    const key = tokens.slice(0, len).join(":");
    if (available.has(key)) {
      return { path: tokens.slice(0, len), remaining: tokens.slice(len) };
    }
  }
  return null;
}

export function commandKey(path: string[]): string {
  return path.join(":");
}

const SHORT_COMMANDS: Set<string> = new Set([
  "doctor",
  "status",
  "daemon:status",
  "daemon:user:list",
  "session:info",
  "session:list",
  "message:history",
]);

export function supportsShort(method: string): boolean {
  return SHORT_COMMANDS.has(method);
}

function truthyFlag(value: unknown): boolean {
  if (Array.isArray(value)) return truthyFlag(value[value.length - 1]);
  return value === true || value === "true" || value === "1";
}
