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
  "session:fork",
  "session:rename",
  "session:info",
  "session:context",
  "session:list",
  "message:send",
  "message:peer",
  "message:interrupt",
  "message:approval",
  "message:answer",
  "message:history",
  "message:tail",
  "monitor:events",
  "monitor:alarm",
]);

const COMMAND_GROUPS = new Set(["daemon", "session", "message", "monitor"]);

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
    const spec = GLOBAL_FLAGS[a];
    if (!spec) {
      nonGlobal.push(a);
      continue;
    }
    if (spec.takesValue) {
      const v = argv[++i];
      if (v === undefined) {
        result.unknown = `flag ${a} requires a value`;
        return result;
      }
      if (spec.name === "bearer") result.bearer = v;
      else if (spec.name === "daemonSock") result.daemonSock = v;
    } else {
      if (spec.name === "verbose") result.verbose = true;
      else if (spec.name === "help") result.help = true;
    }
  }

  const matched = matchCommand(nonGlobal);
  if (!matched) {
    if (nonGlobal.length === 0) {
      result.help = true;
      return result;
    }
    if (result.help && nonGlobal.length === 1 && COMMAND_GROUPS.has(nonGlobal[0])) {
      result.commandPath = [nonGlobal[0]];
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
        const next = tail[i + 1];
        if (next !== undefined && !isFlagLike(next)) {
          value = next;
          i++;
        } else {
          value = null;
        }
      }
      setFlag(result.flags, key, value);
    } else if (a.length > 1 && a.startsWith("-") && !isNegativeNumber(a)) {
      const key = a.slice(1);
      const next = tail[i + 1];
      if (next !== undefined && !isFlagLike(next)) {
        setFlag(result.flags, key, next);
        i++;
      } else {
        setFlag(result.flags, key, null);
      }
    } else {
      result.positionals.push(a);
    }
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

function matchCommand(tokens: string[]): { path: string[]; remaining: string[] } | null {
  const maxDepth = Math.min(tokens.length, 3);
  for (let len = maxDepth; len >= 1; len--) {
    const key = tokens.slice(0, len).join(":");
    if (COMMANDS.has(key)) {
      return { path: tokens.slice(0, len), remaining: tokens.slice(len) };
    }
  }
  return null;
}

export function commandKey(path: string[]): string {
  return path.join(":");
}
