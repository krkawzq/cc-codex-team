"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// package.json
var require_package = __commonJS({
  "package.json"(exports2, module2) {
    module2.exports = {
      name: "codex-team",
      version: "0.5.0",
      private: true,
      description: "CLI + daemon orchestrating long-lived Codex app-server sessions for agents",
      license: "MIT",
      engines: {
        node: ">=18"
      },
      scripts: {
        build: "tsup src/main.ts --format cjs --platform node --target node18 --out-dir dist --clean",
        dev: "tsup src/main.ts --format cjs --platform node --target node18 --out-dir dist --watch",
        test: "vitest run",
        "test:watch": "vitest",
        typecheck: "tsc --noEmit",
        clean: "rm -rf dist"
      },
      devDependencies: {
        "@types/node": "^24.0.0",
        tsup: "^8.5.0",
        typescript: "^5.9.2",
        vitest: "^4.1.5"
      }
    };
  }
});

// src/cli/run.ts
var import_node_child_process = require("child_process");
var import_promises = require("timers/promises");

// src/ipc/sock.ts
var import_node_fs = __toESM(require("fs"));
var import_node_net = __toESM(require("net"));
var import_node_path2 = __toESM(require("path"));

// src/paths.ts
var import_node_crypto = __toESM(require("crypto"));
var import_node_os = __toESM(require("os"));
var import_node_path = __toESM(require("path"));
var APP = "codex-team";
var WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
var UNIX_SOCKET_MAX_BYTES = 90;
function homeDir() {
  if (process.platform === "win32") {
    const nativeHome = import_node_os.default.homedir();
    if (nativeHome) return nativeHome;
    if (process.env.USERPROFILE) return process.env.USERPROFILE;
    if (process.env.HOMEDRIVE && process.env.HOMEPATH) return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`;
    if (process.env.HOME) return process.env.HOME;
    return "\\";
  }
  return process.env.HOME || import_node_os.default.homedir() || "/";
}
function defaultDataDir() {
  const configured = process.env.CODEX_TEAM_DATA_DIR;
  if (configured) return expandUserPath(configured);
  return import_node_path.default.join(homeDir(), `.${APP}`);
}
function defaultSockPath(dataDir = defaultDataDir(), platform = process.platform) {
  const configured = process.env.CODEX_TEAM_SOCK;
  if (configured) return normalizeSockPath(expandUserPath(configured, platform), platform);
  const resolvedDataDir = expandUserPath(dataDir, platform);
  if (platform === "win32") return namedPipePath(resolvedDataDir);
  const candidate = import_node_path.default.join(resolvedDataDir, "daemon.sock");
  if (Buffer.byteLength(candidate, "utf8") <= UNIX_SOCKET_MAX_BYTES) return candidate;
  return import_node_path.default.join(import_node_os.default.tmpdir(), `${APP}-${pathHash(resolvedDataDir)}.sock`);
}
function defaultLogPath(dataDir = defaultDataDir()) {
  return import_node_path.default.join(expandUserPath(dataDir), "daemon.log");
}
function configFilePath(dataDir = defaultDataDir()) {
  return import_node_path.default.join(expandUserPath(dataDir), "config.json");
}
function pidFilePath(dataDir = defaultDataDir()) {
  return import_node_path.default.join(expandUserPath(dataDir), "daemon.pid");
}
function usersDir(dataDir = defaultDataDir()) {
  return import_node_path.default.join(expandUserPath(dataDir), "users");
}
function userDir(token, dataDir = defaultDataDir()) {
  return import_node_path.default.join(usersDir(dataDir), encodeToken(token));
}
function userMetadataPath(token, dataDir = defaultDataDir()) {
  return import_node_path.default.join(userDir(token, dataDir), "metadata.json");
}
function userEventLogPath(token, dataDir = defaultDataDir()) {
  return import_node_path.default.join(userDir(token, dataDir), "events.log");
}
function userSessionsPath(token, dataDir = defaultDataDir()) {
  return import_node_path.default.join(userDir(token, dataDir), "sessions.json");
}
function normalizeSockPath(sockPath, platform = process.platform) {
  if (platform !== "win32") return sockPath;
  if (isNamedPipePath(sockPath)) return sockPath.replace(/\//g, "\\");
  return namedPipePath(sockPath);
}
function isNamedPipePath(sockPath) {
  return /^\\\\\.\\pipe[\\/]/i.test(sockPath);
}
function isFilesystemSockPath(sockPath, platform = process.platform) {
  return !isNamedPipePath(normalizeSockPath(sockPath, platform));
}
function expandUserPath(input, platform = process.platform, home = homeDir()) {
  if (/^~[^\\/]/.test(input)) {
    throw new Error(`unsupported user-home path '${input}'; only '~' is supported`);
  }
  if (input !== "~" && !input.startsWith("~/") && !input.startsWith("~\\")) return input;
  const pathModule = platform === "win32" ? import_node_path.default.win32 : import_node_path.default.posix;
  const suffix = input === "~" ? "" : input.slice(1).replace(/^[\\/]+/, "");
  return suffix.length > 0 ? pathModule.join(home, suffix) : home;
}
function encodeToken(token) {
  return Buffer.from(token, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeToken(encoded) {
  const pad = encoded.length % 4 === 0 ? "" : "=".repeat(4 - encoded.length % 4);
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}
function namedPipePath(seed) {
  return `${WINDOWS_PIPE_PREFIX}${APP}-${pathHash(seed)}`;
}
function pathHash(input) {
  return import_node_crypto.default.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// src/ipc/sock.ts
function writeMessage(socket, msg) {
  socket.write(JSON.stringify(msg) + "\n");
}
function onMessages(socket, handler, onClose) {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handler(msg);
      } catch {
      }
    }
  });
  if (onClose) {
    let closed = false;
    const onceClose = () => {
      if (closed) return;
      closed = true;
      onClose();
    };
    socket.on("close", onceClose);
    socket.on("end", onceClose);
  }
}
async function listenSock(sockPath) {
  const endpoint = normalizeSockPath(sockPath);
  if (isFilesystemSockPath(sockPath)) {
    import_node_fs.default.mkdirSync(import_node_path2.default.dirname(endpoint), { recursive: true });
  }
  const server = import_node_net.default.createServer();
  await new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
  return server;
}
function connectSock(sockPath, timeoutMs = 2e3) {
  return new Promise((resolve, reject) => {
    const sock = import_node_net.default.createConnection(normalizeSockPath(sockPath));
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    timer.unref();
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
function probeSock(sockPath, timeoutMs = 200) {
  return new Promise((resolve) => {
    const endpoint = normalizeSockPath(sockPath);
    if (isFilesystemSockPath(sockPath) && !import_node_fs.default.existsSync(endpoint)) {
      resolve(false);
      return;
    }
    const sock = import_node_net.default.createConnection(endpoint);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    timer.unref();
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
      }
      resolve(false);
    });
  });
}
function unlinkSockIfStale(sockPath) {
  if (!isFilesystemSockPath(sockPath)) return;
  const endpoint = normalizeSockPath(sockPath);
  try {
    import_node_fs.default.unlinkSync(endpoint);
  } catch {
  }
}

// src/cli/args.ts
var COMMANDS = /* @__PURE__ */ new Set([
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
  "monitor:alarm"
]);
var HELP_PATHS = /* @__PURE__ */ new Set([
  ...COMMANDS,
  "daemon",
  "daemon:user",
  "daemon:config",
  "session",
  "message",
  "monitor"
]);
var GLOBAL_FLAGS = {
  "-b": { name: "bearer", takesValue: true },
  "--bearer": { name: "bearer", takesValue: true },
  "-v": { name: "verbose", takesValue: false },
  "--verbose": { name: "verbose", takesValue: false },
  "-h": { name: "help", takesValue: false },
  "--help": { name: "help", takesValue: false },
  "--daemon-sock": { name: "daemonSock", takesValue: true }
};
function parseArgs(argv) {
  const result = {
    commandPath: [],
    positionals: [],
    flags: {},
    bearer: null,
    verbose: false,
    daemonSock: null,
    help: false,
    unknown: null
  };
  const nonGlobal = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const spec = GLOBAL_FLAGS[a];
    if (!spec) {
      nonGlobal.push(a);
      continue;
    }
    if (spec.takesValue) {
      const v = argv[++i];
      if (v === void 0) {
        result.unknown = `flag ${a} requires a value`;
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
      let key;
      let value;
      if (eqIdx >= 0) {
        key = a.slice(2, eqIdx);
        value = a.slice(eqIdx + 1);
      } else {
        key = a.slice(2);
        const next = tail[i + 1];
        if (next !== void 0 && !isFlagLike(next)) {
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
      if (next !== void 0 && !isFlagLike(next)) {
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
function isFlagLike(s) {
  if (!s.startsWith("-")) return false;
  if (s === "-") return false;
  if (isNegativeNumber(s)) return false;
  return true;
}
function isNegativeNumber(s) {
  return /^-\d+(\.\d+)?$/.test(s);
}
function setFlag(flags, key, value) {
  if (value === null) {
    flags[key] = true;
    return;
  }
  const existing = flags[key];
  if (existing === void 0) {
    flags[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else if (typeof existing === "string") {
    flags[key] = [existing, value];
  } else {
    flags[key] = value;
  }
}
function matchCommand(tokens, available) {
  const maxDepth = Math.min(tokens.length, 3);
  for (let len = maxDepth; len >= 1; len--) {
    const key = tokens.slice(0, len).join(":");
    if (available.has(key)) {
      return { path: tokens.slice(0, len), remaining: tokens.slice(len) };
    }
  }
  return null;
}
function commandKey(path12) {
  return path12.join(":");
}

// src/cli/help.ts
function leaf(node) {
  return { ...node, subcommands: [] };
}
var PROMPT_SOURCE_FLAGS = [
  {
    long: "--stdin",
    type: "bool",
    default: "false",
    required: false,
    description: "Read the prompt from stdin."
  },
  {
    long: "--file",
    type: "path",
    required: false,
    description: "Read the prompt from a file."
  },
  {
    long: "--attach",
    type: "path[]",
    required: false,
    description: "Attach input files such as images."
  }
];
var JSON_RESPONSE_FLAGS = [
  {
    long: "--json",
    type: "string",
    required: false,
    description: "Pass the full JSON response inline."
  },
  {
    long: "--file",
    type: "path",
    required: false,
    description: "Read the full JSON response from a file."
  },
  {
    long: "--stdin",
    type: "bool",
    default: "false",
    required: false,
    description: "Read the full JSON response from stdin."
  }
];
var SESSION_TARGET = {
  name: "name|thread_id",
  required: true,
  description: "Session name or thread ID."
};
var LIVE_SESSION_TARGET = {
  name: "name|thread_id",
  required: true,
  description: "Target live session name or thread ID."
};
var REQUEST_ID = {
  name: "request_id",
  required: true,
  description: "Request ID from event payload.request_id."
};
var daemonUserGroup = {
  name: "user",
  summary: "Manage daemon users keyed by bearer token.",
  usage: "codex-team daemon user <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team daemon user list"
  ],
  subcommands: [
    leaf({
      name: "create",
      summary: "Create a daemon user for a bearer token.",
      usage: "codex-team daemon user create <token>",
      positionals: [
        {
          name: "token",
          required: true,
          description: "Bearer token for the new user."
        }
      ],
      flags: [],
      examples: [
        "codex-team daemon user create agent-a"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "destroy",
      summary: "Delete a daemon user and its tracked state.",
      usage: "codex-team daemon user destroy <token> [flags]",
      positionals: [
        {
          name: "token",
          required: true,
          description: "Bearer token for the user to delete."
        }
      ],
      flags: [
        {
          long: "--force",
          type: "bool",
          default: "false",
          required: false,
          description: "Delete the user even if live sessions remain."
        }
      ],
      examples: [
        "codex-team daemon user destroy agent-a --force"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "list",
      summary: "List all daemon users and their activity.",
      usage: "codex-team daemon user list",
      positionals: [],
      flags: [],
      examples: [
        "codex-team daemon user list"
      ],
      needs_bearer: false
    })
  ],
  needs_bearer: false
};
var daemonConfigGroup = {
  name: "config",
  summary: "Read and update daemon configuration.",
  usage: "codex-team daemon config <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team daemon config set codex.default_model gpt-5.4"
  ],
  subcommands: [
    leaf({
      name: "get",
      summary: "Read one daemon configuration key.",
      usage: "codex-team daemon config get <key>",
      positionals: [
        {
          name: "key",
          required: true,
          description: "Config key such as daemon.idle_shutdown_hours."
        }
      ],
      flags: [],
      examples: [
        "codex-team daemon config get codex.default_model"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "set",
      summary: "Set one daemon configuration key.",
      usage: "codex-team daemon config set <key> <value>",
      positionals: [
        {
          name: "key",
          required: true,
          description: "Config key to write."
        },
        {
          name: "value",
          required: true,
          description: "Value parsed according to the key type."
        }
      ],
      flags: [],
      examples: [
        "codex-team daemon config set monitor.default_interval_seconds 10"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "unset",
      summary: "Restore one daemon configuration key to default.",
      usage: "codex-team daemon config unset <key>",
      positionals: [
        {
          name: "key",
          required: true,
          description: "Config key to reset."
        }
      ],
      flags: [],
      examples: [
        "codex-team daemon config unset codex.default_model"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "list",
      summary: "List daemon configuration values and sources.",
      usage: "codex-team daemon config list [flags]",
      positionals: [],
      flags: [
        {
          long: "--explicit-only",
          type: "bool",
          default: "false",
          required: false,
          description: "Show only keys set explicitly by the user."
        }
      ],
      examples: [
        "codex-team daemon config list --explicit-only"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "reset",
      summary: "Reset every daemon configuration key to default.",
      usage: "codex-team daemon config reset [flags]",
      positionals: [],
      flags: [
        {
          long: "--yes",
          type: "bool",
          default: "false",
          required: true,
          description: "Confirm the full reset operation."
        }
      ],
      examples: [
        "codex-team daemon config reset --yes"
      ],
      needs_bearer: false
    })
  ],
  needs_bearer: false
};
var daemonGroup = {
  name: "daemon",
  summary: "Manage the shared daemon and daemon-owned resources.",
  usage: "codex-team daemon <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team daemon status",
    "codex-team daemon logs -f --level warn"
  ],
  subcommands: [
    leaf({
      name: "status",
      summary: "Show daemon process, socket, and resource status.",
      usage: "codex-team daemon status",
      positionals: [],
      flags: [],
      examples: [
        "codex-team daemon status"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "start",
      summary: "Start the daemon if it is not already running.",
      usage: "codex-team daemon start",
      positionals: [],
      flags: [],
      examples: [
        "codex-team daemon start"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "stop",
      summary: "Stop the daemon and persist its state.",
      usage: "codex-team daemon stop [flags]",
      positionals: [],
      flags: [
        {
          long: "--force",
          type: "bool",
          default: "false",
          required: false,
          description: "Kill the daemon without detach or persistence."
        }
      ],
      examples: [
        "codex-team daemon stop --force"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "restart",
      summary: "Restart the daemon.",
      usage: "codex-team daemon restart",
      positionals: [],
      flags: [],
      examples: [
        "codex-team daemon restart"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "logs",
      summary: "Print daemon logs with optional tail-style streaming.",
      usage: "codex-team daemon logs [flags]",
      positionals: [],
      flags: [
        {
          long: "--follow",
          short: "-f",
          type: "bool",
          default: "false",
          required: false,
          description: "Stream new log lines as they arrive."
        },
        {
          long: "-n",
          type: "int",
          default: "100",
          required: false,
          description: "Print this many trailing lines first."
        },
        {
          long: "--level",
          type: "enum",
          required: false,
          description: "Filter by error, warn, info, debug, or trace."
        }
      ],
      examples: [
        "codex-team daemon logs -f --level warn"
      ],
      needs_bearer: false
    }),
    daemonUserGroup,
    daemonConfigGroup
  ],
  needs_bearer: false
};
var sessionGroup = {
  name: "session",
  summary: "Manage live Codex sessions for the current user.",
  usage: "codex-team -b <token> session <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team -b $TOKEN session list --all"
  ],
  subcommands: [
    leaf({
      name: "new",
      summary: "Create a live session with optional runtime settings.",
      usage: "codex-team -b <token> session new [name] [flags]",
      positionals: [
        {
          name: "name",
          required: false,
          description: "Human-friendly session name."
        }
      ],
      flags: [
        {
          long: "--model",
          type: "string",
          default: "codex.default_model",
          required: false,
          description: "Model name such as gpt-5.4."
        },
        {
          long: "--cwd",
          type: "path",
          default: "current directory",
          required: false,
          description: "Working directory for Codex."
        },
        {
          long: "--sandbox",
          type: "enum",
          default: "codex.default_sandbox",
          required: false,
          description: "Sandbox mode for the session."
        },
        {
          long: "--approval",
          type: "enum",
          default: "codex.default_approval",
          required: false,
          description: "Approval policy for risky actions."
        },
        {
          long: "--effort",
          type: "enum",
          default: "codex.default_effort",
          required: false,
          description: "Reasoning effort level."
        },
        {
          long: "--personality",
          type: "string",
          required: false,
          description: "Personality preset name."
        },
        {
          long: "--base-instructions",
          type: "path",
          required: false,
          description: "Load system-level instructions from a file."
        },
        {
          long: "--developer-instructions",
          type: "path",
          required: false,
          description: "Load developer instructions from a file."
        },
        {
          long: "--profile",
          type: "string",
          required: false,
          description: "Use a Codex config profile for defaults."
        },
        {
          long: "--experimental-tools",
          type: "csv",
          default: "experimental.default_tools",
          required: false,
          description: "Enable experimental Codex tools such as ask-user-question."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session new audit --model gpt-5.4 --cwd /repo",
        "codex-team -b $TOKEN session new --profile fast-review",
        "codex-team -b $TOKEN session new askq --experimental-tools ask-user-question"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "attach",
      summary: "Mark an existing Codex session as live for this user.",
      usage: "codex-team -b <token> session attach <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET }
      ],
      flags: [
        {
          long: "--takeover",
          type: "bool",
          default: "false",
          required: false,
          description: "Seize a live session from another user."
        },
        {
          long: "--experimental-tools",
          type: "csv",
          default: "inherit session or experimental.default_tools",
          required: false,
          description: "Enable experimental Codex tools when attaching or rehydrating a thread."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session attach th-abc123 --takeover",
        "codex-team -b $TOKEN session attach th-abc123 --experimental-tools ask-user-question"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "detach",
      summary: "Stop tracking a live session and release its runtime.",
      usage: "codex-team -b <token> session detach <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET }
      ],
      flags: [
        {
          long: "--graceful",
          type: "bool",
          default: "false",
          required: false,
          description: "Wait for the current turn before detaching."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session detach audit --graceful"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "fork",
      summary: "Fork a session into a new live session.",
      usage: "codex-team -b <token> session fork <name|thread_id> [new_name] [flags]",
      positionals: [
        { ...SESSION_TARGET, description: "Source session name or thread ID." },
        {
          name: "new_name",
          required: false,
          description: "Name for the forked session."
        }
      ],
      flags: [
        {
          long: "--at-turn",
          type: "string",
          default: "tip",
          required: false,
          description: "Fork from the specified turn ID."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session fork audit audit-fix --at-turn turn-42"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "rename",
      summary: "Rename a session without attaching it.",
      usage: "codex-team -b <token> session rename <name|thread_id> <new_name>",
      positionals: [
        { ...SESSION_TARGET, description: "Current session name or thread ID." },
        {
          name: "new_name",
          required: true,
          description: "New session name."
        }
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN session rename audit audit-review"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "info",
      summary: "Show metadata for one session.",
      usage: "codex-team -b <token> session info <name|thread_id>",
      positionals: [
        { ...SESSION_TARGET }
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN session info audit"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "context",
      summary: "Show the compacted session context from Codex.",
      usage: "codex-team -b <token> session context <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET }
      ],
      flags: [
        {
          long: "--format",
          type: "enum",
          default: "json",
          required: false,
          description: "Render output as json or markdown."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session context audit --format markdown"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "list",
      summary: "List live sessions or every known Codex session.",
      usage: "codex-team -b <token> session list [flags]",
      positionals: [],
      flags: [
        {
          long: "--all",
          type: "bool",
          default: "false",
          required: false,
          description: "List every known session, not only live ones."
        },
        {
          long: "--sort",
          type: "enum",
          default: "last_active",
          required: false,
          description: "Sort by name, last_active, turn_count, or created_at."
        },
        {
          long: "--format",
          type: "enum",
          default: "json",
          required: false,
          description: "Render output as json or table."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session list --all --format table"
      ],
      needs_bearer: true
    })
  ],
  needs_bearer: true
};
var messageGroup = {
  name: "message",
  summary: "Send prompts and inspect turns on a live session.",
  usage: "codex-team -b <token> message <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team -b $TOKEN message history audit --limit 10"
  ],
  subcommands: [
    leaf({
      name: "send",
      summary: "Queue a prompt on a live session without interrupting it.",
      usage: "codex-team -b <token> message send <name|thread_id> [prompt] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET },
        {
          name: "prompt",
          required: false,
          description: "Prompt text when not using --stdin or --file."
        }
      ],
      flags: PROMPT_SOURCE_FLAGS,
      examples: [
        'codex-team -b $TOKEN message send audit "Summarize the failing tests."',
        "codex-team -b $TOKEN message send audit --file prompt.md --attach screenshot.png"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "peer",
      summary: "Soft-interrupt the session, then send a prompt.",
      usage: "codex-team -b <token> message peer <name|thread_id> [prompt] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET },
        {
          name: "prompt",
          required: false,
          description: "Prompt text when not using --stdin or --file."
        }
      ],
      flags: PROMPT_SOURCE_FLAGS,
      examples: [
        'codex-team -b $TOKEN message peer audit "Stop after the current file write."'
      ],
      needs_bearer: true
    }),
    leaf({
      name: "interrupt",
      summary: "Hard-interrupt the current work on a live session.",
      usage: "codex-team -b <token> message interrupt <name|thread_id>",
      positionals: [
        { ...LIVE_SESSION_TARGET }
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN message interrupt audit"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "approval",
      summary: "Resolve an approval request on a live session.",
      usage: "codex-team -b <token> message approval <name|thread_id> <request_id> [shortcut] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET, description: "Session that owns the request." },
        { ...REQUEST_ID },
        {
          name: "shortcut",
          required: false,
          description: "Use a shortcut that matches the approval kind."
        }
      ],
      flags: JSON_RESPONSE_FLAGS,
      notes: [
        "command_execution and file_change: all shortcuts are valid.",
        "permissions: cancel is invalid.",
        "mcp_elicitation: accept-session is invalid; form mode needs --json."
      ],
      examples: [
        "codex-team -b $TOKEN message approval audit req-17 accept-session",
        "codex-team -b $TOKEN message approval audit req-17 --file approval.json"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "answer",
      summary: "Answer a user_input request on a live session.",
      usage: "codex-team -b <token> message answer <name|thread_id> <request_id> [answer] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET, description: "Session that owns the request." },
        { ...REQUEST_ID },
        {
          name: "answer",
          required: false,
          description: "Single-answer shortcut for a one-question request."
        }
      ],
      flags: JSON_RESPONSE_FLAGS,
      examples: [
        'codex-team -b $TOKEN message answer audit req-21 "Use the staging URL."',
        `codex-team -b $TOKEN message answer audit req-21 --json '{"answers":{}}'`
      ],
      needs_bearer: true
    }),
    leaf({
      name: "history",
      summary: "Show runtime history for a session from newest to oldest.",
      usage: "codex-team -b <token> message history <name|thread_id> [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET, description: "Session to inspect." }
      ],
      flags: [
        {
          long: "--limit",
          type: "int",
          default: "50",
          required: false,
          description: "Return at most this many history entries."
        },
        {
          long: "--since",
          type: "string|int",
          default: "tip",
          required: false,
          description: "Start from a turn ID or a relative negative offset."
        },
        {
          long: "--format",
          type: "enum",
          default: "json",
          required: false,
          description: "Render output as json or markdown."
        }
      ],
      examples: [
        "codex-team -b $TOKEN message history audit --since -3 --format markdown"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "tail",
      summary: "Show recent turns and optionally follow new ones.",
      usage: "codex-team -b <token> message tail <name|thread_id> [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET, description: "Session to inspect." }
      ],
      flags: [
        {
          long: "--follow",
          short: "-f",
          type: "bool",
          default: "false",
          required: false,
          description: "Keep printing turns until the CLI exits."
        },
        {
          long: "-n",
          type: "int",
          default: "3",
          required: false,
          description: "Return this many recent turns first."
        },
        {
          long: "--format",
          type: "enum",
          default: "json",
          required: false,
          description: "Render output as json or markdown."
        }
      ],
      examples: [
        "codex-team -b $TOKEN message tail audit -n 5 --follow"
      ],
      needs_bearer: true
    })
  ],
  needs_bearer: true
};
var monitorGroup = {
  name: "monitor",
  summary: "Stream events and run interval alarms.",
  usage: "codex-team -b <token> monitor <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team -b $TOKEN monitor events --stream"
  ],
  subcommands: [
    leaf({
      name: "events",
      summary: "Stream normalized daemon events as NDJSON.",
      usage: "codex-team -b <token> monitor events [flags]",
      positionals: [],
      flags: [
        {
          long: "--interval",
          type: "int",
          default: "monitor.default_interval_seconds",
          required: false,
          description: "Poll in batches every N seconds; cannot be used with --stream."
        },
        {
          long: "--stream",
          type: "bool",
          default: "false",
          required: false,
          description: "Emit events immediately; cannot be used with --interval."
        },
        {
          long: "--filter",
          type: "string",
          required: false,
          description: "Comma-separated event type allowlist."
        },
        {
          long: "--exclude",
          type: "string",
          required: false,
          description: "Comma-separated event type denylist."
        },
        {
          long: "--include-delta",
          type: "bool",
          default: "false",
          required: false,
          description: "Include high-frequency *.delta events."
        },
        {
          long: "--since",
          type: "string",
          required: false,
          description: "Resume from the given event ID."
        },
        {
          long: "--session",
          type: "string",
          required: false,
          description: "Filter to one session name or thread ID."
        }
      ],
      examples: [
        "codex-team -b $TOKEN monitor events --stream --session audit"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "alarm",
      summary: "Run a shell command at a fixed interval.",
      usage: "codex-team -b <token> monitor alarm <interval_s> <command> [flags]",
      positionals: [
        {
          name: "interval_s",
          required: true,
          description: "Execution interval in seconds."
        },
        {
          name: "command",
          required: true,
          description: "Shell command string to run."
        }
      ],
      flags: [
        {
          long: "--once",
          type: "bool",
          default: "false",
          required: false,
          description: "Run the command once and exit."
        },
        {
          long: "--timeout",
          type: "int",
          default: "60",
          required: false,
          description: "Kill one run if it exceeds this many seconds."
        }
      ],
      examples: [
        'codex-team -b $TOKEN monitor alarm 30 "codex-team -b $TOKEN status"'
      ],
      needs_bearer: true
    })
  ],
  needs_bearer: true
};
var HELP_TREE = {
  name: "codex-team",
  summary: "CLI and daemon for orchestrating Codex app-server sessions.",
  usage: "codex-team [-b <token>] <command> [args] [flags]",
  positionals: [],
  flags: [
    {
      long: "--bearer",
      short: "-b",
      type: "string",
      required: false,
      description: "User identity token for user-scoped commands."
    },
    {
      long: "--verbose",
      short: "-v",
      type: "bool",
      default: "false",
      required: false,
      description: "Write CLI debug logs to stderr."
    },
    {
      long: "--daemon-sock",
      type: "path",
      default: "config value",
      required: false,
      description: "Override the daemon socket path."
    },
    {
      long: "--help",
      short: "-h",
      type: "bool",
      default: "false",
      required: false,
      description: "Show help for the resolved command path."
    }
  ],
  examples: [
    "codex-team --help",
    "codex-team -b $TOKEN session new audit --model gpt-5.4"
  ],
  subcommands: [
    leaf({
      name: "version",
      summary: "Print the CLI version and the daemon version when available.",
      usage: "codex-team version",
      positionals: [],
      flags: [],
      examples: [
        "codex-team version"
      ],
      needs_bearer: false
    }),
    leaf({
      name: "status",
      summary: "Show live sessions, pending events, and recent activity.",
      usage: "codex-team -b <token> status",
      positionals: [],
      flags: [],
      examples: [
        "codex-team -b $TOKEN status"
      ],
      needs_bearer: true
    }),
    daemonGroup,
    sessionGroup,
    messageGroup,
    monitorGroup
  ],
  needs_bearer: false
};
function findNode(path12, node = HELP_TREE) {
  if (path12.length === 0) return node;
  const [head, ...rest] = path12;
  const child = node.subcommands.find((entry) => entry.name === head);
  if (!child) return null;
  return findNode(rest, child);
}
function formatCommandPath(path12) {
  return path12.length === 0 ? "codex-team" : `codex-team ${path12.join(" ")}`;
}
function formatPositional(positional) {
  return positional.required ? `<${positional.name}>` : `[${positional.name}]`;
}
function formatFlag(flag) {
  return flag.short ? `${flag.short}, ${flag.long}` : flag.long;
}
function renderTable(headers, rows) {
  const widths = headers.map(
    (header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0))
  );
  return [
    `  ${headers.map((header, index) => header.padEnd(widths[index])).join("  ")}`,
    `  ${widths.map((width) => "-".repeat(width)).join("  ")}`,
    ...rows.map(
      (row) => `  ${row.map((cell, index) => cell.padEnd(widths[index])).join("  ")}`
    )
  ];
}
function renderPositionals(node) {
  const lines = ["POSITIONALS"];
  if (node.positionals.length === 0) {
    lines.push("  None.");
    return lines;
  }
  lines.push(
    ...renderTable(
      ["Name", "Required", "Description"],
      node.positionals.map((positional) => [
        formatPositional(positional),
        positional.required ? "yes" : "no",
        positional.description
      ])
    )
  );
  return lines;
}
function renderFlags(node, title = "FLAGS") {
  const lines = [title];
  if (node.flags.length === 0) {
    lines.push("  None.");
    return lines;
  }
  lines.push(
    ...renderTable(
      ["Flag", "Type", "Default", "Required", "Description"],
      node.flags.map((flag) => [
        formatFlag(flag),
        flag.type,
        flag.default ?? "-",
        flag.required ? "yes" : "no",
        flag.description
      ])
    )
  );
  return lines;
}
function renderNotes(node) {
  return [
    "NOTES",
    ...(node.notes ?? []).map((note) => `  ${note}`)
  ];
}
function renderSubcommands(node) {
  return [
    "SUBCOMMANDS",
    ...renderTable(
      ["Command", "Summary"],
      node.subcommands.map((subcommand) => [subcommand.name, subcommand.summary])
    )
  ];
}
function renderExamples(node) {
  return [
    "EXAMPLES",
    ...node.examples.map((example) => `  ${example}`)
  ];
}
function renderHelp(path12) {
  const node = findNode(path12) ?? HELP_TREE;
  const resolvedPath = findNode(path12) ? path12 : [];
  const sections = [
    [formatCommandPath(resolvedPath), node.summary],
    ["USAGE", `  ${node.usage}`]
  ];
  if (resolvedPath.length === 0) {
    sections.push(renderSubcommands(node));
    sections.push(renderFlags(node, "GLOBAL FLAGS"));
  } else if (node.subcommands.length > 0) {
    sections.push(renderSubcommands(node));
  } else {
    sections.push(renderPositionals(node));
    sections.push(renderFlags(node));
    if (node.notes && node.notes.length > 0) sections.push(renderNotes(node));
  }
  sections.push(renderExamples(node));
  return `${sections.map((section) => section.join("\n")).join("\n\n")}
`;
}

// src/result.ts
function ok(data) {
  return { ok: true, data };
}
function err(code, message, data) {
  const error = { code, message };
  if (data !== void 0) {
    error.data = data;
  }
  return { ok: false, error };
}

// src/daemon/config.ts
var import_node_fs2 = __toESM(require("fs"));
var import_node_path3 = __toESM(require("path"));
function enumSpec(values, def, needsRestart, desc) {
  return { type: "enum", enumValues: values, default: def, needsRestart, description: desc };
}
var CONFIG_KEYS = {
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
  "monitor.event_log_retention": { type: "int", default: 1e4, needsRestart: false, description: "per-user ring-buffer event retention" },
  "app_server.max_sessions_per_process": { type: "int", default: 16, needsRestart: false, description: "max session bindings per reusable app-server process (primarily adhoc clients)" },
  "app_server.idle_unload_minutes": { type: "int", default: 60, needsRestart: false, description: "idle duration before unloading live session from app-server" },
  "app_server.request_timeout_seconds": { type: "int", default: 120, needsRestart: false, description: "per-request timeout for app-server JSON-RPC calls" },
  "retry.max_attempts": { type: "int", default: 3, needsRestart: false, description: "retry count for transient app-server transport / stream errors" },
  "retry.initial_delay_seconds": { type: "float", default: 0.25, needsRestart: false, description: "initial backoff" },
  "retry.max_delay_seconds": { type: "float", default: 2, needsRestart: false, description: "max backoff" },
  "codex.default_model": { type: "string", default: "", needsRestart: false, description: "default --model for session new" },
  "codex.default_sandbox": enumSpec(["read-only", "workspace-write", "danger-full-access"], "workspace-write", false, "default --sandbox"),
  "codex.default_approval": enumSpec(["never", "on-request", "on-failure", "untrusted"], "on-request", false, "default --approval"),
  "codex.default_effort": enumSpec(["minimal", "low", "medium", "high", "xhigh"], "medium", false, "default --effort"),
  "experimental.default_tools": { type: "string", default: "", needsRestart: false, description: "default session experimental tools CSV" }
};
var ConfigStore = class {
  explicit = {};
  filePath;
  constructor(dataDir = defaultDataDir()) {
    this.filePath = configFilePath(dataDir);
    this.load();
  }
  load() {
    try {
      const raw = import_node_fs2.default.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          const spec = CONFIG_KEYS[k];
          if (spec && isValidPersistedValue(v, spec)) {
            this.explicit[k] = v;
          }
        }
      }
    } catch {
    }
  }
  persist() {
    import_node_fs2.default.mkdirSync(import_node_path3.default.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + ".tmp";
    import_node_fs2.default.writeFileSync(tmp, JSON.stringify(this.explicit, null, 2));
    import_node_fs2.default.renameSync(tmp, this.filePath);
  }
  listKeys() {
    return Object.keys(CONFIG_KEYS);
  }
  spec(key) {
    return CONFIG_KEYS[key] ?? null;
  }
  get(key) {
    const spec = CONFIG_KEYS[key];
    if (!spec) return null;
    if (key in this.explicit) {
      return { value: this.explicit[key], source: "explicit", spec };
    }
    return { value: spec.default, source: "default", spec };
  }
  getEffective(key) {
    const e = this.get(key);
    return e ? e.value : null;
  }
  set(key, rawValue) {
    const spec = CONFIG_KEYS[key];
    if (!spec) return { ok: false, error: `unknown key: ${key}` };
    const parsed = parseValue(rawValue, spec);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    this.explicit[key] = parsed.value;
    this.persist();
    return { ok: true, value: parsed.value, needs_restart: spec.needsRestart };
  }
  unset(key) {
    const spec = CONFIG_KEYS[key];
    if (!spec) return { ok: false, error: `unknown key: ${key}` };
    if (key in this.explicit) {
      delete this.explicit[key];
      this.persist();
    }
    return { ok: true, needs_restart: spec.needsRestart };
  }
  reset() {
    this.explicit = {};
    this.persist();
  }
  snapshot() {
    const explicit = { ...this.explicit };
    const effective = {};
    for (const key of Object.keys(CONFIG_KEYS)) {
      const e = this.get(key);
      if (e) effective[key] = e.value;
    }
    return { explicit, effective };
  }
  resolvedLogPath() {
    const explicit = this.explicit["daemon.log_path"];
    if (typeof explicit === "string" && explicit.trim().length > 0) return expandUserPath(explicit);
    return defaultLogPath(this.resolvedDataDir());
  }
  resolvedSockPath() {
    const explicit = this.explicit["daemon.sock_path"];
    if (typeof explicit === "string" && explicit.trim().length > 0) return normalizeSockPath(expandUserPath(explicit));
    return defaultSockPath(this.resolvedDataDir());
  }
  resolvedDataDir() {
    const explicit = this.explicit["daemon.data_dir"];
    if (typeof explicit === "string" && explicit.trim().length > 0) return expandUserPath(explicit);
    return defaultDataDir();
  }
};
function parseValue(raw, spec) {
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
function isValidPersistedValue(value, spec) {
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

// src/cli/run.ts
var DAEMON_POLL_INTERVAL_MS = 100;
var DEFAULT_DAEMON_READY_TIMEOUT_MS = 15e3;
var DEFAULT_DAEMON_CONNECT_TIMEOUT_MS = 5e3;
var DEFAULT_DAEMON_CONNECT_RETRY_ATTEMPTS = 3;
var DEFAULT_DAEMON_CONNECT_RETRY_DELAY_MS = 250;
async function readStdinAll() {
  return await new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.once("end", () => resolve(buf));
    process.stdin.once("error", reject);
  });
}
async function runCli(argv) {
  const parsed = parseArgs(argv);
  if (parsed.unknown) {
    process.stdout.write(JSON.stringify(err("invalid_params", parsed.unknown)) + "\n");
    return 1;
  }
  if (parsed.help || parsed.commandPath.length === 0) {
    process.stdout.write(renderHelp(parsed.commandPath));
    return 0;
  }
  const method = commandKey(parsed.commandPath);
  const sockPath = parsed.daemonSock || defaultSockPath();
  if (method === "version") {
    return await runVersion(sockPath);
  }
  const needsBearer = !isDaemonLevel(method);
  if (needsBearer && !parsed.bearer) {
    process.stdout.write(
      JSON.stringify(err("invalid_params", `bearer token required for '${method}'; pass -b <token>`)) + "\n"
    );
    return 1;
  }
  const ready = await ensureDaemon(sockPath);
  if (!ready) {
    process.stdout.write(JSON.stringify(err("daemon_unreachable", "daemon did not become ready in time")) + "\n");
    return 1;
  }
  return await dispatchCommand(sockPath, parsed, method);
}
function isDaemonLevel(method) {
  return method === "version" || method === "daemon:status" || method.startsWith("daemon:");
}
async function runVersion(sockPath) {
  const cliVersion = getCliVersion();
  const alive = await probeSock(sockPath, 200);
  const cliConfig = readCliConfig();
  let daemonVersion = null;
  if (alive) {
    try {
      const resp = await requestOnceWithRetry(sockPath, { method: "version", bearer: null, params: {} }, cliConfig, true);
      if ("result" in resp && resp.result && typeof resp.result === "object") {
        const d = resp.result;
        daemonVersion = d.daemon_version || null;
      }
    } catch {
    }
  }
  process.stdout.write(
    JSON.stringify(ok({ cli_version: cliVersion, daemon_version: daemonVersion })) + "\n"
  );
  return 0;
}
async function dispatchCommand(sockPath, parsed, method) {
  const cliConfig = readCliConfig();
  const needsStreaming = method === "monitor:events" || method === "monitor:alarm" || method === "daemon:logs" || method === "message:tail" && truthy(parsed.flags["follow"] ?? parsed.flags["f"]);
  if (truthy(parsed.flags["stdin"]) && !("stdin_content" in parsed.flags)) {
    try {
      const content = await readStdinAll();
      parsed.flags["stdin_content"] = content;
    } catch (e) {
      process.stdout.write(
        JSON.stringify(err("invalid_params", `failed to read stdin: ${e.message}`)) + "\n"
      );
      return 1;
    }
  }
  if (needsStreaming) {
    const sock = await connectSockWithRetry(sockPath, cliConfig.connectTimeoutMs, cliConfig.connectRetryAttempts, cliConfig.connectRetryDelayMs);
    return await runStream(sock, parsed, method);
  }
  try {
    const params = {
      positionals: parsed.positionals,
      flags: parsed.flags
    };
    const stdinContent = parsed.flags["stdin_content"];
    if (typeof stdinContent === "string") params.stdin_content = stdinContent;
    const resp = await requestOnceWithRetry(sockPath, {
      method,
      bearer: parsed.bearer,
      params
    }, cliConfig, isReadOnlyMethod(method));
    if ("error" in resp && resp.error) {
      process.stdout.write(JSON.stringify({ ok: false, error: resp.error }) + "\n");
      return 1;
    }
    process.stdout.write(JSON.stringify({ ok: true, data: resp.result }) + "\n");
    return 0;
  } catch (e) {
    process.stdout.write(
      JSON.stringify(err("internal", e.message ?? "rpc failed")) + "\n"
    );
    return 1;
  }
}
async function runStream(sock, parsed, method) {
  return await new Promise((resolve) => {
    let finished = false;
    const stdoutQueue = [];
    const pendingFinalizers = [];
    let stdoutBlocked = false;
    let socketPaused = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      process.off("SIGBREAK", onInterrupt);
      resolve(code);
    };
    const maybeResumeSocket = () => {
      if (!socketPaused) return;
      socketPaused = false;
      if (typeof sock.resume === "function") sock.resume();
    };
    const flushFinalizers = () => {
      if (stdoutBlocked || stdoutQueue.length > 0) return;
      while (pendingFinalizers.length > 0) pendingFinalizers.shift()?.();
    };
    const flushStdout = () => {
      if (stdoutBlocked) return;
      while (stdoutQueue.length > 0) {
        const next = stdoutQueue[0];
        const ok2 = process.stdout.write(next.line);
        if (!ok2) {
          stdoutBlocked = true;
          if (!socketPaused && typeof sock.pause === "function") {
            socketPaused = true;
            sock.pause();
          }
          process.stdout.once("drain", () => {
            stdoutBlocked = false;
            const flushed = stdoutQueue.shift();
            flushed?.afterWrite?.();
            maybeResumeSocket();
            flushStdout();
            flushFinalizers();
          });
          return;
        }
        stdoutQueue.shift();
        next.afterWrite?.();
      }
      maybeResumeSocket();
      flushFinalizers();
    };
    const writeStdout = (line, afterWrite) => {
      stdoutQueue.push({ line, afterWrite });
      flushStdout();
    };
    const afterStdout = (cb) => {
      pendingFinalizers.push(cb);
      flushFinalizers();
    };
    const reqId = randomId();
    const params = {
      positionals: parsed.positionals,
      flags: parsed.flags,
      streaming: true
    };
    const stdinContent = parsed.flags["stdin_content"];
    if (typeof stdinContent === "string") params.stdin_content = stdinContent;
    const req = {
      kind: "request",
      id: reqId,
      method,
      bearer: parsed.bearer ?? void 0,
      params
    };
    onMessages(sock, (msg) => {
      if (msg.kind === "stream_chunk" && msg.id === reqId) {
        writeStdout(JSON.stringify(msg.data) + "\n");
      } else if (msg.kind === "stream_end" && msg.id === reqId) {
        if (msg.error) {
          writeStdout(JSON.stringify({ ok: false, error: msg.error }) + "\n", () => {
            finish(1);
            sock.end();
          });
        } else {
          afterStdout(() => {
            finish(0);
            sock.end();
          });
        }
      } else if (msg.kind === "response" && msg.id === reqId) {
        if (msg.error) {
          writeStdout(JSON.stringify({ ok: false, error: msg.error }) + "\n", () => {
            finish(1);
            sock.end();
          });
        } else {
          afterStdout(() => {
            finish(0);
            sock.end();
          });
        }
      }
    }, () => {
      finish(finished ? 0 : 1);
    });
    const onInterrupt = () => {
      sock.end();
      finish(130);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    if (process.platform === "win32") process.once("SIGBREAK", onInterrupt);
    writeMessage(sock, req);
  });
}
function requestOnce(sock, opts) {
  return new Promise((resolve, reject) => {
    const id = randomId();
    const req = {
      kind: "request",
      id,
      method: opts.method,
      bearer: opts.bearer ?? void 0,
      params: opts.params
    };
    let resolved = false;
    onMessages(sock, (msg) => {
      if (resolved) return;
      if (msg.kind === "response" && msg.id === id) {
        resolved = true;
        resolve({ id: msg.id, result: msg.result, error: msg.error });
      }
    }, () => {
      if (!resolved) reject(new Error("daemon closed connection"));
    });
    sock.once("error", (e) => {
      if (!resolved) reject(e);
    });
    writeMessage(sock, req);
  });
}
async function requestOnceWithRetry(sockPath, opts, cliConfig, allowRetry) {
  let attempt = 0;
  let lastError = null;
  while (attempt < cliConfig.connectRetryAttempts) {
    attempt++;
    let sock = null;
    try {
      sock = await connectSock(sockPath, cliConfig.connectTimeoutMs);
      const resp = await requestOnce(sock, opts);
      sock.end();
      return resp;
    } catch (e) {
      lastError = e;
      if (sock) sock.destroy();
      if (!allowRetry || !isTransientRequestError(lastError) || attempt >= cliConfig.connectRetryAttempts) {
        throw lastError;
      }
      await (0, import_promises.setTimeout)(cliConfig.connectRetryDelayMs);
    }
  }
  throw lastError ?? new Error("request failed");
}
async function ensureDaemon(sockPath) {
  const cliConfig = readCliConfig();
  if (await probeSock(sockPath, 200)) return true;
  spawnDaemon();
  const deadline = Date.now() + cliConfig.readyTimeoutMs;
  while (Date.now() < deadline) {
    await (0, import_promises.setTimeout)(DAEMON_POLL_INTERVAL_MS);
    if (await probeSock(sockPath, 200)) return true;
  }
  return false;
}
async function connectSockWithRetry(sockPath, timeoutMs, retryAttempts, retryDelayMs) {
  let attempt = 0;
  let lastError = null;
  while (attempt < retryAttempts) {
    attempt++;
    try {
      return await connectSock(sockPath, timeoutMs);
    } catch (e) {
      const err2 = e;
      lastError = err2;
      if (!isTransientConnectError(err2) || attempt >= retryAttempts) break;
      await (0, import_promises.setTimeout)(retryDelayMs);
    }
  }
  throw lastError ?? new Error("connect failed");
}
function spawnDaemon() {
  const child = (0, import_node_child_process.spawn)(process.execPath, [process.argv[1], "--daemon-internal"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true
  });
  child.unref();
}
function getCliVersion() {
  try {
    const pkg = require_package();
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function truthy(v) {
  return v === true || v === "true" || v === "1";
}
function isTransientConnectError(err2) {
  return err2.message === "connect timeout" || err2.code === "ECONNREFUSED" || err2.code === "ENOENT" || err2.code === "EPIPE" || err2.code === "ECONNRESET";
}
function isTransientRequestError(err2) {
  return isTransientConnectError(err2) || err2.message === "daemon closed connection";
}
function isReadOnlyMethod(method) {
  return method === "version" || method === "status" || method === "daemon:status" || method === "daemon:user:list" || method === "daemon:config:get" || method === "daemon:config:list" || method === "session:info" || method === "session:context" || method === "session:list" || method === "message:history";
}
function readCliConfig() {
  const config = new ConfigStore();
  return {
    readyTimeoutMs: toMs(config.getEffective("daemon.ready_timeout_seconds"), DEFAULT_DAEMON_READY_TIMEOUT_MS),
    connectTimeoutMs: toMs(config.getEffective("daemon.connect_timeout_seconds"), DEFAULT_DAEMON_CONNECT_TIMEOUT_MS),
    connectRetryAttempts: toInt(config.getEffective("daemon.connect_retry_attempts"), DEFAULT_DAEMON_CONNECT_RETRY_ATTEMPTS),
    connectRetryDelayMs: toMs(config.getEffective("daemon.connect_retry_delay_seconds"), DEFAULT_DAEMON_CONNECT_RETRY_DELAY_MS)
  };
}
function toInt(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : fallback;
}
function toMs(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v * 1e3)) : fallback;
}

// src/daemon/run.ts
var import_node_fs13 = __toESM(require("fs"));
var import_node_path11 = __toESM(require("path"));

// src/daemon/users.ts
var import_node_fs3 = __toESM(require("fs"));
var import_node_path4 = __toESM(require("path"));

// src/errors.ts
var CodexTeamError = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "CodexTeamError";
  }
};
function invalidParams(message, data) {
  return new CodexTeamError("invalid_params", message, data);
}
function methodNotFound(method) {
  return new CodexTeamError("method_not_found", `unknown method '${method}'`);
}

// src/daemon/users.ts
var SCHEMA_VERSION = 1;
var UserRegistry = class {
  users = /* @__PURE__ */ new Map();
  dataDir;
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.loadFromDisk();
  }
  loadFromDisk() {
    const root = usersDir(this.dataDir);
    if (!import_node_fs3.default.existsSync(root)) return;
    for (const dirname of import_node_fs3.default.readdirSync(root)) {
      const metaPath = import_node_path4.default.join(root, dirname, "metadata.json");
      if (import_node_fs3.default.existsSync(metaPath)) {
        try {
          const raw = import_node_fs3.default.readFileSync(metaPath, "utf8");
          const parsed = JSON.parse(raw);
          const user = normalizePersistedUser(parsed);
          if (user && typeof user.token === "string") {
            try {
              validateToken(user.token);
              this.users.set(user.token, user);
            } catch {
            }
          }
        } catch (e) {
          if (isCanonicalUserDir(dirname)) {
            throw new Error(`failed to load metadata.json for '${dirname}': ${e.message}`);
          }
        }
        continue;
      }
      try {
        const token = decodeToken(dirname);
        validateToken(token);
        if (encodeToken(token) !== dirname) continue;
        this.users.set(token, { token, created_at: (/* @__PURE__ */ new Date()).toISOString() });
      } catch {
      }
    }
  }
  has(token) {
    return this.users.has(token);
  }
  get(token) {
    return this.users.get(token) ?? null;
  }
  list() {
    return Array.from(this.users.values());
  }
  create(token) {
    validateToken(token);
    if (this.users.has(token)) {
      throw new CodexTeamError("user_already_exists", `user '${token}' already exists`);
    }
    const user = {
      token,
      created_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.users.set(token, user);
    this.persist(user);
    return user;
  }
  destroy(token) {
    if (!this.users.has(token)) {
      throw new CodexTeamError("user_not_found", `user '${token}' not found`);
    }
    this.users.delete(token);
    const dir = userDir(token, this.dataDir);
    try {
      import_node_fs3.default.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
  touch(token) {
    const user = this.users.get(token);
    if (!user) return;
    user.last_active_at = (/* @__PURE__ */ new Date()).toISOString();
    this.persist(user);
  }
  persist(user) {
    const dir = userDir(user.token, this.dataDir);
    import_node_fs3.default.mkdirSync(dir, { recursive: true });
    const metaPath = userMetadataPath(user.token, this.dataDir);
    const tmp = metaPath + ".tmp";
    import_node_fs3.default.writeFileSync(tmp, JSON.stringify({
      schema_version: SCHEMA_VERSION,
      user
    }, null, 2));
    import_node_fs3.default.renameSync(tmp, metaPath);
  }
};
function validateToken(token) {
  if (!token) {
    throw new CodexTeamError("invalid_params", "token must be non-empty");
  }
  if (token.length > 256) {
    throw new CodexTeamError("invalid_params", "token too long (max 256)");
  }
}
function normalizePersistedUser(parsed) {
  if (parsed && typeof parsed === "object" && "schema_version" in parsed) {
    const env = parsed;
    if (typeof env.schema_version === "number" && env.schema_version > SCHEMA_VERSION) {
      throw new Error(`metadata.json schema_version ${env.schema_version} is newer than supported ${SCHEMA_VERSION}`);
    }
    return env.user ?? null;
  }
  return parsed;
}
function isCanonicalUserDir(dirname) {
  try {
    const token = decodeToken(dirname);
    return encodeToken(token) === dirname;
  } catch {
    return false;
  }
}

// src/daemon/sessions.ts
var import_node_crypto2 = __toESM(require("crypto"));
var import_node_fs5 = __toESM(require("fs"));
var import_node_path6 = __toESM(require("path"));

// src/logger.ts
var import_node_fs4 = __toESM(require("fs"));
var import_node_path5 = __toESM(require("path"));
var LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};
var Logger = class {
  level = "info";
  stream = null;
  logPath = null;
  configure(opts) {
    if (opts.level) this.level = opts.level;
    if (opts.logPath && opts.logPath !== this.logPath) {
      if (this.stream) this.stream.end();
      import_node_fs4.default.mkdirSync(import_node_path5.default.dirname(opts.logPath), { recursive: true });
      this.stream = import_node_fs4.default.createWriteStream(opts.logPath, { flags: "a" });
      this.logPath = opts.logPath;
    }
  }
  setLevel(level) {
    this.level = level;
  }
  emit(level, msg, meta) {
    if (LEVELS[level] > LEVELS[this.level]) return;
    const line = JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      msg,
      ...meta ?? {}
    });
    if (this.stream) {
      this.stream.write(line + "\n");
    } else {
      process.stderr.write(line + "\n");
    }
  }
  error(msg, meta) {
    this.emit("error", msg, meta);
  }
  warn(msg, meta) {
    this.emit("warn", msg, meta);
  }
  info(msg, meta) {
    this.emit("info", msg, meta);
  }
  debug(msg, meta) {
    this.emit("debug", msg, meta);
  }
  trace(msg, meta) {
    this.emit("trace", msg, meta);
  }
};
var logger = new Logger();

// src/daemon/sessions.ts
var NAME_RE = /^[A-Za-z0-9_\-]{1,128}$/;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var SCHEMA_VERSION2 = 1;
var SessionRegistry = class {
  dataDir;
  users = /* @__PURE__ */ new Map();
  globalByThreadId = /* @__PURE__ */ new Map();
  touchTimers = /* @__PURE__ */ new Map();
  writeChains = /* @__PURE__ */ new Map();
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  loadForUser(user) {
    if (this.users.has(user)) return;
    const bucket = this.emptyBucket();
    const p = userSessionsPath(user, this.dataDir);
    if (!import_node_fs5.default.existsSync(p)) {
      this.users.set(user, bucket);
      return;
    }
    try {
      const raw = import_node_fs5.default.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.schema_version === "number" && parsed.schema_version > SCHEMA_VERSION2) {
        throw new Error(`sessions.json schema_version ${parsed.schema_version} is newer than supported ${SCHEMA_VERSION2}`);
      }
      for (const rec of parsed.sessions ?? []) {
        if (!rec || typeof rec.name !== "string" || typeof rec.thread_id !== "string" || rec.thread_id.length === 0) continue;
        bucket.byName.set(rec.name, rec);
        bucket.byThreadId.set(rec.thread_id, rec);
        this.globalByThreadId.set(rec.thread_id, user);
      }
      this.users.set(user, bucket);
    } catch (e) {
      throw new Error(`failed to load sessions.json for '${user}': ${e.message}`);
    }
  }
  loadAllUsers(userTokens) {
    for (const u of userTokens) this.loadForUser(u);
  }
  listLive(user) {
    this.loadForUser(user);
    return Array.from(this.users.get(user).byName.values());
  }
  get(user, identifier) {
    this.loadForUser(user);
    const b = this.users.get(user);
    const byName = b.byName.get(identifier);
    if (byName) return byName;
    const byId = b.byThreadId.get(identifier);
    if (byId) return byId;
    return null;
  }
  findLiveAnywhere(identifier) {
    const ownerByThread = this.globalByThreadId.get(identifier);
    if (ownerByThread) {
      const rec = this.users.get(ownerByThread)?.byThreadId.get(identifier);
      if (rec) return { user: ownerByThread, record: rec };
    }
    return null;
  }
  findUniqueLiveByNameAnywhere(name) {
    let match = null;
    for (const [user, bucket] of this.users) {
      const rec = bucket.byName.get(name);
      if (!rec) continue;
      if (match) return "ambiguous";
      match = { user, record: rec };
    }
    return match;
  }
  add(user, record) {
    validateRecord(record);
    this.loadForUser(user);
    const b = this.users.get(user);
    if (b.byName.has(record.name)) {
      throw new CodexTeamError("invalid_params", `session '${record.name}' already exists`);
    }
    if (b.byThreadId.has(record.thread_id)) {
      throw new CodexTeamError("invalid_params", `thread_id '${record.thread_id}' already registered`);
    }
    const existingGlobal = this.globalByThreadId.get(record.thread_id);
    if (existingGlobal && existingGlobal !== user) {
      throw new CodexTeamError("session_busy", `thread '${record.thread_id}' is live under another user`);
    }
    b.byName.set(record.name, record);
    b.byThreadId.set(record.thread_id, record);
    this.globalByThreadId.set(record.thread_id, user);
    this.schedulePersist(user, 0);
  }
  update(user, name, patch) {
    this.loadForUser(user);
    const b = this.users.get(user);
    const rec = b.byName.get(name);
    if (!rec) throw new CodexTeamError("session_not_found", `session '${name}' not found`);
    if (patch.name && patch.name !== rec.name) {
      if (!NAME_RE.test(patch.name)) throw invalidParams(`invalid session name: ${patch.name}`);
      if (patch.name.startsWith("th-")) throw invalidParams("session name cannot start with 'th-'");
      if (b.byName.has(patch.name)) throw invalidParams(`session '${patch.name}' already exists`);
      b.byName.delete(rec.name);
      rec.name = patch.name;
      b.byName.set(rec.name, rec);
    }
    if (patch.last_active_at !== void 0) rec.last_active_at = patch.last_active_at;
    if (patch.turn_count !== void 0) rec.turn_count = patch.turn_count;
    if (patch.recovery_state !== void 0) rec.recovery_state = patch.recovery_state ?? void 0;
    if (patch.model !== void 0) rec.model = patch.model;
    if (patch.cwd !== void 0) rec.cwd = patch.cwd;
    if (patch.sandbox !== void 0) rec.sandbox = patch.sandbox;
    if (patch.approval !== void 0) rec.approval = patch.approval;
    if (patch.effort !== void 0) rec.effort = patch.effort;
    if (patch.profile !== void 0) rec.profile = patch.profile;
    if (patch.experimental_tools !== void 0) {
      rec.experimental_tools = patch.experimental_tools.length > 0 ? [...patch.experimental_tools] : void 0;
    }
    if (patch.app_server_client_id !== void 0) rec.app_server_client_id = patch.app_server_client_id;
    this.schedulePersist(user, 0);
    return rec;
  }
  remove(user, name) {
    this.loadForUser(user);
    const b = this.users.get(user);
    const rec = b.byName.get(name);
    if (!rec) return null;
    b.byName.delete(rec.name);
    b.byThreadId.delete(rec.thread_id);
    this.globalByThreadId.delete(rec.thread_id);
    this.schedulePersist(user, 0);
    return rec;
  }
  removeAllForUser(user) {
    this.loadForUser(user);
    const bucket = this.users.get(user);
    if (!bucket) return [];
    const removed = Array.from(bucket.byName.values());
    for (const rec of removed) {
      this.globalByThreadId.delete(rec.thread_id);
    }
    this.users.delete(user);
    return removed;
  }
  async clearUser(user) {
    const timer = this.touchTimers.get(user);
    if (timer) {
      clearTimeout(timer);
      this.touchTimers.delete(user);
    }
    await (this.writeChains.get(user)?.catch(() => void 0) ?? Promise.resolve());
    this.writeChains.delete(user);
    return this.removeAllForUser(user);
  }
  touch(user, name) {
    this.loadForUser(user);
    const b = this.users.get(user);
    const rec = b.byName.get(name);
    if (!rec) return;
    rec.last_active_at = (/* @__PURE__ */ new Date()).toISOString();
    this.schedulePersist(user, 250);
  }
  async flush() {
    for (const [user, timer] of this.touchTimers) {
      clearTimeout(timer);
      this.touchTimers.delete(user);
      this.enqueuePersist(user);
    }
    await Promise.all(Array.from(this.writeChains.values()).map((p) => p.catch(() => void 0)));
  }
  async persistAsync(user) {
    const dir = userDir(user, this.dataDir);
    await import_node_fs5.default.promises.mkdir(dir, { recursive: true });
    const p = userSessionsPath(user, this.dataDir);
    const bucket = this.users.get(user);
    const payload = {
      schema_version: SCHEMA_VERSION2,
      sessions: bucket ? Array.from(bucket.byName.values()) : []
    };
    const tmp = p + ".tmp";
    await import_node_fs5.default.promises.writeFile(tmp, JSON.stringify(payload, null, 2));
    await import_node_fs5.default.promises.rename(tmp, p);
  }
  schedulePersist(user, delayMs) {
    const existing = this.touchTimers.get(user);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.touchTimers.delete(user);
      this.enqueuePersist(user);
    }, delayMs);
    timer.unref();
    this.touchTimers.set(user, timer);
  }
  enqueuePersist(user) {
    const prev = this.writeChains.get(user) ?? Promise.resolve();
    const next = prev.catch(() => void 0).then(() => this.persistAsync(user)).catch((e) => {
      logger.warn("failed to persist sessions.json", { user, err: e.message });
    });
    this.writeChains.set(user, next);
  }
  emptyBucket() {
    return { byName: /* @__PURE__ */ new Map(), byThreadId: /* @__PURE__ */ new Map() };
  }
};
function validateSessionName(name) {
  if (!NAME_RE.test(name)) throw invalidParams(`invalid session name: ${name}`);
  if (UUID_RE.test(name)) throw invalidParams("session name must not be a UUID (reserved for thread_id)");
  if (name.startsWith("th-")) throw invalidParams("session name cannot start with 'th-' (reserved)");
}
function validateRecord(record) {
  validateSessionName(record.name);
  if (!record.thread_id) throw invalidParams("thread_id is required");
}
function generateSessionName() {
  return "s-" + import_node_crypto2.default.randomBytes(4).toString("hex");
}
function looksLikeThreadId(s) {
  return UUID_RE.test(s) || s.startsWith("th-");
}

// src/daemon/events.ts
var import_node_fs6 = __toESM(require("fs"));
var import_node_path7 = __toESM(require("path"));
var DELTA_SUFFIX = "_delta";
var SCHEMA_VERSION3 = 1;
var DEFAULT_FLUSH_DELAY_MS = 25;
var OVERFLOW_FLUSH_DELAY_MS = 250;
var FLUSH_RETRY_DELAY_MS = 250;
var MAX_PENDING_WRITE_BYTES = 1024 * 1024;
var EventLog = class {
  retention;
  dataDir;
  counters = /* @__PURE__ */ new Map();
  buffers = /* @__PURE__ */ new Map();
  subscribers = /* @__PURE__ */ new Map();
  loaded = /* @__PURE__ */ new Set();
  loadPromises = /* @__PURE__ */ new Map();
  rotatedSinceCompact = /* @__PURE__ */ new Map();
  pendingLines = /* @__PURE__ */ new Map();
  pendingBytes = /* @__PURE__ */ new Map();
  flushTimers = /* @__PURE__ */ new Map();
  writeChains = /* @__PURE__ */ new Map();
  userOps = /* @__PURE__ */ new Map();
  overflowWarned = /* @__PURE__ */ new Set();
  constructor(retention = 1e4, dataDir = null) {
    this.retention = Math.max(100, retention);
    this.dataDir = dataDir;
  }
  loadUser(user) {
    if (this.loaded.has(user)) return;
    if (!this.dataDir) {
      this.ensureUserState(user);
      this.loaded.add(user);
      this.loadPromises.delete(user);
      return;
    }
    const filePath = userEventLogPath(user, this.dataDir);
    if (!import_node_fs6.default.existsSync(filePath)) {
      this.ensureUserState(user);
      this.loaded.add(user);
      this.loadPromises.delete(user);
      return;
    }
    const raw = import_node_fs6.default.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const { events, totalLines } = parsePersistedEvents(lines);
    const buf = events.slice(Math.max(0, events.length - this.retention));
    let maxSeq = 0;
    for (const ev of buf) {
      const seq = parseInt(ev.id.replace(/^evt-/, ""), 10);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
    this.buffers.set(user, buf);
    this.counters.set(user, maxSeq);
    this.loaded.add(user);
    this.loadPromises.delete(user);
    if (totalLines > this.retention * 1.5) this.compactFile(user, buf);
  }
  setRetention(n) {
    this.retention = Math.max(100, n);
    for (const [user, buf] of this.buffers) {
      let rotated = false;
      while (buf.length > this.retention) {
        buf.shift();
        rotated = true;
      }
      if (rotated) this.bumpCompactionDebt(user);
    }
  }
  retainedCount(user) {
    return this.buffers.get(user)?.length ?? 0;
  }
  async append(user, input) {
    await this.ensureLoaded(user);
    return await this.withUserLock(user, async () => this.appendLoaded(user, input));
  }
  async flush() {
    const users = /* @__PURE__ */ new Set([
      ...this.flushTimers.keys(),
      ...this.pendingLines.keys(),
      ...this.writeChains.keys(),
      ...this.loadPromises.keys(),
      ...this.userOps.keys()
    ]);
    await Promise.all(Array.from(this.loadPromises.values()).map((p) => p.catch(() => void 0)));
    for (const user of users) {
      const timer = this.flushTimers.get(user);
      if (timer) {
        clearTimeout(timer);
        this.flushTimers.delete(user);
      }
      await this.flushUser(user);
    }
    await Promise.all(Array.from(this.writeChains.values()).map((p) => p.catch(() => void 0)));
  }
  async clearUser(user) {
    const timer = this.flushTimers.get(user);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(user);
    }
    await (this.loadPromises.get(user)?.catch(() => void 0) ?? Promise.resolve());
    await (this.userOps.get(user)?.catch(() => void 0) ?? Promise.resolve());
    await (this.writeChains.get(user)?.catch(() => void 0) ?? Promise.resolve());
    this.pendingLines.delete(user);
    this.pendingBytes.delete(user);
    this.writeChains.delete(user);
    this.userOps.delete(user);
    this.rotatedSinceCompact.delete(user);
    this.counters.delete(user);
    this.buffers.delete(user);
    this.subscribers.delete(user);
    this.loaded.delete(user);
    this.loadPromises.delete(user);
    this.overflowWarned.delete(user);
  }
  subscribe(user, cb) {
    let set = this.subscribers.get(user);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.subscribers.set(user, set);
    }
    set.add(cb);
    return {
      dispose: () => {
        const s = this.subscribers.get(user);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) this.subscribers.delete(user);
      }
    };
  }
  pendingCount(user) {
    return this.buffers.get(user)?.length ?? 0;
  }
  async listSince(user, sinceId, opts = { includeDelta: false }) {
    await this.ensureLoaded(user);
    return await this.withUserLock(user, async () => {
      const buf = this.buffers.get(user) ?? [];
      let slice;
      if (!sinceId) {
        slice = buf.slice();
      } else {
        const idx = buf.findIndex((e) => e.id === sinceId);
        if (idx < 0) {
          if (buf.length > 0 && compareSeq(sinceId, buf[0].id) < 0) {
            return { ok: false, reason: "id_rotated", oldest_available_id: buf[0].id };
          }
          return { ok: false, reason: "invalid_since" };
        }
        slice = buf.slice(idx + 1);
      }
      if (!opts.includeDelta) slice = slice.filter((e) => !e.type.endsWith(DELTA_SUFFIX));
      return { ok: true, events: slice };
    });
  }
  oldestId(user) {
    const buf = this.buffers.get(user);
    return buf && buf.length > 0 ? buf[0].id : null;
  }
  async ensureLoaded(user) {
    if (this.loaded.has(user)) return;
    let promise = this.loadPromises.get(user);
    if (!promise) {
      promise = new Promise((resolve, reject) => {
        queueMicrotask(() => {
          void this.loadUserFromDisk(user).then(resolve, reject);
        });
      });
      this.loadPromises.set(user, promise);
    }
    await promise;
  }
  async loadUserFromDisk(user) {
    if (this.loaded.has(user)) return;
    let shouldMarkLoaded = false;
    try {
      if (!this.dataDir) {
        this.ensureUserState(user);
        shouldMarkLoaded = true;
        return;
      }
      const filePath = userEventLogPath(user, this.dataDir);
      const raw = await import_node_fs6.default.promises.readFile(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const { events, totalLines } = parsePersistedEvents(lines);
      const buf = events.slice(Math.max(0, events.length - this.retention));
      let maxSeq = 0;
      for (const ev of buf) {
        const seq = parseInt(ev.id.replace(/^evt-/, ""), 10);
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
      }
      this.buffers.set(user, buf);
      this.counters.set(user, maxSeq);
      if (totalLines > this.retention * 1.5) this.compactFile(user, buf);
      shouldMarkLoaded = true;
    } catch (e) {
      if (e.code === "ENOENT") {
        this.ensureUserState(user);
        shouldMarkLoaded = true;
        return;
      }
      if (e.message.toLowerCase().includes("schema_version")) {
        throw e;
      }
      logger.warn("failed to load event log", { user, err: e.message });
      this.ensureUserState(user);
      shouldMarkLoaded = true;
    } finally {
      if (shouldMarkLoaded) this.loaded.add(user);
      this.loadPromises.delete(user);
    }
  }
  appendLoaded(user, input, opts = {}) {
    this.ensureUserState(user);
    const seq = (this.counters.get(user) ?? 0) + 1;
    this.counters.set(user, seq);
    const event = {
      id: `evt-${seq}`,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ...input
    };
    const buf = this.buffers.get(user);
    buf.push(event);
    let rotated = false;
    while (buf.length > this.retention) {
      buf.shift();
      rotated = true;
    }
    if (rotated) this.bumpCompactionDebt(user);
    this.dispatchSubscribers(user, event);
    if (opts.persist !== false) this.appendToFile(user, event);
    return event;
  }
  dispatchSubscribers(user, event) {
    const listeners = Array.from(this.subscribers.get(user) ?? []);
    if (listeners.length === 0) return;
    queueMicrotask(() => {
      for (const cb of listeners) {
        try {
          cb(event);
        } catch {
        }
      }
    });
  }
  appendToFile(user, event) {
    if (!this.dataDir) return;
    const line = JSON.stringify(event) + "\n";
    const bytes = Buffer.byteLength(line);
    const pending = this.pendingLines.get(user) ?? [];
    pending.push(line);
    this.pendingLines.set(user, pending);
    const totalBytes = (this.pendingBytes.get(user) ?? 0) + bytes;
    this.pendingBytes.set(user, totalBytes);
    if (totalBytes > MAX_PENDING_WRITE_BYTES) {
      if (!this.overflowWarned.has(user)) {
        this.overflowWarned.add(user);
        this.appendLoaded(user, {
          type: "warning",
          session: null,
          thread_id: null,
          payload: {
            message: "event log backlog exceeded 1048576 bytes; writes are being retried more slowly",
            kind: "event_log_backpressure",
            pending_bytes: totalBytes
          }
        }, { persist: false });
      }
      this.scheduleFlush(user, OVERFLOW_FLUSH_DELAY_MS, true);
      return;
    }
    this.scheduleFlush(user, DEFAULT_FLUSH_DELAY_MS);
  }
  compactFile(user, buf) {
    if (!this.dataDir) return;
    const timer = this.flushTimers.get(user);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(user);
    }
    this.pendingLines.delete(user);
    this.pendingBytes.delete(user);
    const filePath = userEventLogPath(user, this.dataDir);
    void this.enqueueFsOp(user, async () => {
      try {
        await import_node_fs6.default.promises.mkdir(import_node_path7.default.dirname(filePath), { recursive: true });
        await import_node_fs6.default.promises.mkdir(userDir(user, this.dataDir), { recursive: true });
        const tmp = filePath + ".tmp";
        await import_node_fs6.default.promises.writeFile(tmp, serializeEventFile(buf));
        await import_node_fs6.default.promises.rename(tmp, filePath);
        this.rotatedSinceCompact.set(user, 0);
      } catch (e) {
        logger.warn("event log compaction failed", { user, err: e.message });
      }
    });
  }
  bumpCompactionDebt(user) {
    const debt = (this.rotatedSinceCompact.get(user) ?? 0) + 1;
    this.rotatedSinceCompact.set(user, debt);
    if (debt >= Math.max(100, Math.floor(this.retention / 2))) {
      this.compactFile(user, this.buffers.get(user) ?? []);
    }
  }
  scheduleFlush(user, delayMs, reset = false) {
    if (!this.dataDir) return;
    if (this.flushTimers.has(user)) {
      if (!reset) return;
      clearTimeout(this.flushTimers.get(user));
    }
    const timer = setTimeout(() => {
      this.flushTimers.delete(user);
      void this.flushUser(user);
    }, delayMs);
    timer.unref();
    this.flushTimers.set(user, timer);
  }
  async flushUser(user) {
    if (!this.dataDir) return;
    const snapshot = await this.withUserLock(user, async () => {
      const lines = this.pendingLines.get(user);
      if (!lines || lines.length === 0) return null;
      const bytes = this.pendingBytes.get(user) ?? 0;
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
      return { lines: [...lines], bytes };
    });
    if (!snapshot) return;
    const filePath = userEventLogPath(user, this.dataDir);
    const ok2 = await this.enqueueFsOp(user, async () => {
      try {
        await import_node_fs6.default.promises.mkdir(import_node_path7.default.dirname(filePath), { recursive: true });
        await import_node_fs6.default.promises.mkdir(userDir(user, this.dataDir), { recursive: true });
        if (!import_node_fs6.default.existsSync(filePath)) {
          await import_node_fs6.default.promises.writeFile(filePath, serializeHeaderLine() + snapshot.lines.join(""));
        } else {
          await import_node_fs6.default.promises.appendFile(filePath, snapshot.lines.join(""));
        }
        return true;
      } catch (e) {
        logger.warn("failed to append event log", { user, err: e.message });
        return false;
      }
    });
    if (!ok2) {
      await this.withUserLock(user, async () => {
        const pending = this.pendingLines.get(user) ?? [];
        this.pendingLines.set(user, [...snapshot.lines, ...pending]);
        this.pendingBytes.set(user, (this.pendingBytes.get(user) ?? 0) + snapshot.bytes);
        this.scheduleFlush(user, FLUSH_RETRY_DELAY_MS, true);
      });
      return;
    }
    if ((this.pendingBytes.get(user) ?? 0) <= Math.floor(MAX_PENDING_WRITE_BYTES / 2)) {
      this.overflowWarned.delete(user);
    }
  }
  ensureUserState(user) {
    if (!this.buffers.has(user)) this.buffers.set(user, []);
    if (!this.counters.has(user)) this.counters.set(user, 0);
  }
  async withUserLock(user, fn) {
    const prev = this.userOps.get(user) ?? Promise.resolve();
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const next = prev.catch(() => void 0).then(() => barrier);
    this.userOps.set(user, next);
    await prev.catch(() => void 0);
    try {
      return await fn();
    } finally {
      release();
      if (this.userOps.get(user) === next) this.userOps.delete(user);
    }
  }
  enqueueFsOp(user, op) {
    const prev = this.writeChains.get(user) ?? Promise.resolve();
    const next = prev.catch(() => void 0).then(op);
    const chain = next.then(() => void 0, () => void 0);
    this.writeChains.set(user, chain);
    return next.finally(() => {
      if (this.writeChains.get(user) === chain) this.writeChains.delete(user);
    });
  }
};
function compareSeq(a, b) {
  const na = parseInt(a.replace(/^evt-/, ""), 10);
  const nb = parseInt(b.replace(/^evt-/, ""), 10);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}
function isDeltaType(type) {
  return type.endsWith(DELTA_SUFFIX);
}
function parsePersistedEvents(lines) {
  if (lines.length === 0) return { events: [], totalLines: 0 };
  let eventLines = lines;
  let totalLines = lines.length;
  const first = parseLine(lines[0]);
  if (isHeader(first)) {
    if (first.schema_version > SCHEMA_VERSION3) {
      throw new Error(`event log schema_version ${first.schema_version} is newer than supported ${SCHEMA_VERSION3}`);
    }
    eventLines = lines.slice(1);
    totalLines = eventLines.length;
  }
  const events = [];
  for (const line of eventLines) {
    const parsed = parseLine(line);
    if (isPersistedEvent(parsed)) {
      events.push(parsed);
    }
  }
  return { events, totalLines };
}
function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch (e) {
    throw new Error(`failed to parse event log line: ${e.message}`);
  }
}
function isHeader(value) {
  if (!value || typeof value !== "object") return false;
  const rec = value;
  return rec.kind === "event_log_header" && typeof rec.schema_version === "number";
}
function isPersistedEvent(value) {
  if (!value || typeof value !== "object") return false;
  const rec = value;
  return typeof rec.id === "string" && typeof rec.ts === "string" && typeof rec.type === "string" && (rec.session === null || typeof rec.session === "string") && (rec.thread_id === null || typeof rec.thread_id === "string") && typeof rec.payload === "object" && rec.payload !== null && !Array.isArray(rec.payload);
}
function serializeHeaderLine() {
  return JSON.stringify({ schema_version: SCHEMA_VERSION3, kind: "event_log_header" }) + "\n";
}
function serializeEventFile(buf) {
  return serializeHeaderLine() + buf.map((e) => JSON.stringify(e)).join("\n") + (buf.length ? "\n" : "");
}

// src/daemon/pending.ts
var import_node_crypto3 = __toESM(require("crypto"));
var PendingRegistry = class {
  availableByRequestId = /* @__PURE__ */ new Map();
  inFlightByRequestId = /* @__PURE__ */ new Map();
  byJsonrpcKey = /* @__PURE__ */ new Map();
  add(entry) {
    const request_id = `req-${import_node_crypto3.default.randomBytes(4).toString("hex")}`;
    const rec = {
      ...entry,
      request_id,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      claimed_at: null
    };
    this.availableByRequestId.set(request_id, rec);
    this.byJsonrpcKey.set(this.jsonrpcKey(entry.client, entry.jsonrpc_id), request_id);
    return rec;
  }
  get(requestId) {
    return this.availableByRequestId.get(requestId) ?? null;
  }
  claim(requestId, user) {
    const rec = this.availableByRequestId.get(requestId);
    if (!rec || rec.user !== user) return null;
    this.availableByRequestId.delete(requestId);
    rec.claimed_at = (/* @__PURE__ */ new Date()).toISOString();
    this.inFlightByRequestId.set(requestId, rec);
    return rec;
  }
  releaseClaim(requestId) {
    const rec = this.inFlightByRequestId.get(requestId);
    if (!rec || rec.responded_at) return null;
    this.inFlightByRequestId.delete(requestId);
    rec.claimed_at = null;
    this.availableByRequestId.set(requestId, rec);
    return rec;
  }
  markResponded(requestId) {
    const rec = this.inFlightByRequestId.get(requestId) ?? this.availableByRequestId.get(requestId);
    if (!rec) return null;
    if (!rec.responded_at) rec.responded_at = (/* @__PURE__ */ new Date()).toISOString();
    return rec;
  }
  remove(requestId) {
    const rec = this.availableByRequestId.get(requestId) ?? this.inFlightByRequestId.get(requestId);
    if (!rec) return null;
    this.availableByRequestId.delete(requestId);
    this.inFlightByRequestId.delete(requestId);
    this.byJsonrpcKey.delete(this.jsonrpcKey(rec.client, rec.jsonrpc_id));
    return rec;
  }
  removeByJsonrpcId(client, jsonrpcId) {
    const reqId = this.byJsonrpcKey.get(this.jsonrpcKey(client, jsonrpcId));
    if (!reqId) return null;
    return this.remove(reqId);
  }
  listForUser(user) {
    return this.allRequests().filter((r) => r.user === user);
  }
  removeForSession(user, sessionName) {
    return this.removeMatching((rec) => rec.user === user && rec.session_name === sessionName);
  }
  removeForUser(user) {
    return this.removeMatching((rec) => rec.user === user);
  }
  removeMatching(predicate) {
    const removed = [];
    for (const rec of this.allRequests()) {
      if (!predicate(rec)) continue;
      this.remove(rec.request_id);
      if (!rec.responded_at) removed.push(rec);
    }
    return removed;
  }
  allRequests() {
    return [
      ...this.availableByRequestId.values(),
      ...this.inFlightByRequestId.values()
    ];
  }
  jsonrpcKey(client, id) {
    const tag = client.__ct_tag;
    const ref = tag ?? assignTag(client);
    return `${ref}::${id}`;
  }
};
function assignTag(client) {
  const tag = import_node_crypto3.default.randomBytes(4).toString("hex");
  client.__ct_tag = tag;
  return tag;
}

// src/daemon/queues.ts
var import_node_crypto4 = __toESM(require("crypto"));

// src/codex/retry.ts
var import_promises2 = require("timers/promises");

// src/codex/errors.ts
var AppServerError = class extends Error {
  kind;
  constructor(message, kind = "app_server_error") {
    super(message);
    this.name = this.constructor.name;
    this.kind = kind;
  }
};
var JsonRpcError = class extends AppServerError {
  code;
  rpcMessage;
  data;
  codexErrorInfo;
  additionalDetails;
  constructor(code, message, data) {
    super(`JSON-RPC error ${code}: ${message}`, "json_rpc_error");
    this.code = code;
    this.rpcMessage = message;
    this.data = data;
    this.codexErrorInfo = extractCodexErrorInfo(data);
    this.additionalDetails = extractAdditionalDetails(data);
  }
};
var TransportClosedError = class extends AppServerError {
  constructor(message) {
    super(message, "transport_closed");
  }
};
var RequestTimeoutError = class extends AppServerError {
  constructor(message) {
    super(message, "request_timeout");
  }
};
var ParseError = class extends JsonRpcError {
};
var InvalidRequestError = class extends JsonRpcError {
};
var MethodNotFoundError = class extends JsonRpcError {
};
var InvalidParamsError = class extends JsonRpcError {
};
var InternalRpcError = class extends JsonRpcError {
};
var ServerBusyError = class extends JsonRpcError {
};
var RetryLimitExceededError = class extends ServerBusyError {
};
var TRANSIENT_CODEX_ERROR_INFOS = /* @__PURE__ */ new Set([
  "server_overloaded",
  "http_connection_failed",
  "response_stream_connection_failed",
  "response_stream_disconnected"
]);
function mapJsonRpcError(code, message, data) {
  if (code === -32700) return new ParseError(code, message, data);
  if (code === -32600) return new InvalidRequestError(code, message, data);
  if (code === -32601) return new MethodNotFoundError(code, message, data);
  if (code === -32602) return new InvalidParamsError(code, message, data);
  if (code === -32603) return new InternalRpcError(code, message, data);
  if (code >= -32099 && code <= -32e3) {
    const overloaded = isServerOverloaded(data);
    const retryExhausted = containsRetryLimitText(message);
    if (overloaded && retryExhausted) return new RetryLimitExceededError(code, message, data);
    if (overloaded) return new ServerBusyError(code, message, data);
    if (retryExhausted) return new RetryLimitExceededError(code, message, data);
  }
  return new JsonRpcError(code, message, data);
}
function isRetryable(err2) {
  if (err2 instanceof RetryLimitExceededError) return false;
  if (err2 instanceof ServerBusyError) return true;
  if (err2 instanceof RequestTimeoutError) return false;
  if (err2 instanceof JsonRpcError) {
    return isServerOverloaded(err2.data) || isTransientCodexErrorInfo(err2.codexErrorInfo);
  }
  return false;
}
function containsRetryLimitText(message) {
  const lower = message.toLowerCase();
  return lower.includes("retry limit") || lower.includes("too many failed attempts");
}
function isServerOverloaded(data) {
  if (data === void 0 || data === null) return false;
  if (typeof data === "string") return data.toLowerCase() === "server_overloaded";
  if (Array.isArray(data)) return data.some(isServerOverloaded);
  if (typeof data === "object") {
    const obj = data;
    const direct = obj["codex_error_info"] ?? obj["codexErrorInfo"] ?? obj["errorInfo"];
    if (typeof direct === "string" && direct.toLowerCase() === "server_overloaded") return true;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      for (const v of Object.values(direct)) {
        if (typeof v === "string" && v.toLowerCase() === "server_overloaded") return true;
      }
    }
    for (const v of Object.values(obj)) {
      if (isServerOverloaded(v)) return true;
    }
  }
  return false;
}
function extractCodexErrorInfo(data) {
  if (data === void 0 || data === null || typeof data !== "object") return null;
  if (Array.isArray(data)) return null;
  const obj = data;
  const direct = obj["codex_error_info"] ?? obj["codexErrorInfo"] ?? obj["errorInfo"];
  if (typeof direct === "string") return snakeCaseVariant(direct);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const innerObj = direct;
    const type = innerObj["type"];
    if (typeof type === "string") return snakeCaseVariant(type);
    const variantKeys = Object.keys(innerObj);
    if (variantKeys.length === 1) return snakeCaseVariant(variantKeys[0]);
  }
  return null;
}
function extractAdditionalDetails(data) {
  if (data === void 0 || data === null || typeof data !== "object") return null;
  if (Array.isArray(data)) return null;
  const obj = data;
  const v = obj["additional_details"] ?? obj["additionalDetails"];
  return typeof v === "string" ? v : null;
}
function snakeCaseVariant(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
}
function isTransientCodexErrorInfo(info) {
  return info !== null && TRANSIENT_CODEX_ERROR_INFOS.has(info);
}

// src/codex/retry.ts
var DEFAULT_RETRY = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 2e3,
  jitterRatio: 0.2
};
async function retryOnOverload(op, options = DEFAULT_RETRY) {
  const { maxAttempts, initialDelayMs, maxDelayMs, jitterRatio } = options;
  if (maxAttempts < 1) throw new Error("maxAttempts must be >= 1");
  let delay = initialDelayMs;
  let attempt = 0;
  for (; ; ) {
    attempt++;
    try {
      return await op();
    } catch (e) {
      if (attempt >= maxAttempts) throw e;
      if (!isRetryable(e)) throw e;
      if (e instanceof RetryLimitExceededError) throw e;
      const cap = Math.min(maxDelayMs, delay);
      const jitter = cap * jitterRatio;
      const sleepMs = Math.max(0, cap + (Math.random() * 2 - 1) * jitter);
      if (sleepMs > 0) await (0, import_promises2.setTimeout)(sleepMs);
      delay = Math.min(maxDelayMs, delay * 2);
    }
  }
}

// src/codex/rpc.ts
async function threadStart(client, params, retry = DEFAULT_RETRY) {
  const result = await retryOnOverload(() => client.request("thread/start", params), retry);
  return coerceLifecycle(result, "thread/start");
}
async function threadResume(client, threadId, retry = DEFAULT_RETRY) {
  const result = await retryOnOverload(() => client.request("thread/resume", { threadId }), retry);
  return coerceLifecycle(result, "thread/resume");
}
async function threadFork(client, threadId, atTurnId, retry = DEFAULT_RETRY) {
  const params = { threadId };
  if (atTurnId) params.atTurnId = atTurnId;
  const result = await retryOnOverload(() => client.request("thread/fork", params), retry);
  return coerceLifecycle(result, "thread/fork");
}
async function threadSetName(client, threadId, name, retry = DEFAULT_RETRY) {
  await retryOnOverload(() => client.request("thread/name/set", { threadId, name }), retry);
}
async function threadList(client, params = {}, retry = DEFAULT_RETRY) {
  const result = await retryOnOverload(() => client.request("thread/list", params), retry);
  const obj = asObject(result);
  const data = Array.isArray(obj.data) ? obj.data : [];
  return {
    data,
    nextCursor: obj.nextCursor ?? null,
    backwardsCursor: obj.backwardsCursor ?? null
  };
}
async function threadRead(client, threadId, retry = DEFAULT_RETRY) {
  const result = await retryOnOverload(() => client.request("thread/read", { threadId }), retry);
  const obj = asObject(result);
  const thread = asObject(obj.thread);
  if (!thread.id) throw new Error(`thread/read: response missing thread.id`);
  return { thread };
}
async function threadUnsubscribe(client, threadId, retry = DEFAULT_RETRY) {
  try {
    await retryOnOverload(() => client.request("thread/unsubscribe", { threadId }), retry);
  } catch {
  }
}
async function threadTurnsList(client, threadId, opts = {}, retry = DEFAULT_RETRY) {
  const params = { threadId };
  if (opts.limit !== void 0) params.limit = opts.limit;
  if (opts.cursor !== void 0) params.cursor = opts.cursor;
  if (opts.sortDirection !== void 0) params.sortDirection = opts.sortDirection;
  const result = await retryOnOverload(() => client.request("thread/turns/list", params), retry);
  const obj = asObject(result);
  return {
    data: Array.isArray(obj.data) ? obj.data : [],
    nextCursor: obj.nextCursor ?? null,
    backwardsCursor: obj.backwardsCursor ?? null
  };
}
async function turnStart(client, threadId, input, retry = DEFAULT_RETRY) {
  const result = await retryOnOverload(() => client.request("turn/start", { threadId, input }), retry);
  const obj = asObject(result);
  const turn = asObject(obj.turn);
  const turnId = typeof turn.id === "string" ? turn.id : null;
  if (!turnId) throw new Error("turn/start: response missing turn.id");
  return { turnId };
}
async function turnSteer(client, threadId, turnId, input, retry = DEFAULT_RETRY) {
  await retryOnOverload(() => client.request("turn/steer", { threadId, expectedTurnId: turnId, input }), retry);
}
async function turnInterrupt(client, threadId, turnId, retry = DEFAULT_RETRY) {
  await retryOnOverload(() => client.request("turn/interrupt", { threadId, turnId }), retry);
}
function threadIdOf(resp) {
  return resp.thread.id;
}
function coerceLifecycle(result, rpc) {
  const obj = asObject(result);
  const thread = asObject(obj.thread);
  if (typeof thread.id !== "string" || !thread.id) {
    throw new Error(`${rpc}: response missing thread.id`);
  }
  return { ...obj, thread };
}
function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

// src/daemon/queues.ts
var QueueTeardownError = class extends Error {
  constructor(message = "session queue is tearing down") {
    super(message);
    this.name = "QueueTeardownError";
  }
};
var TurnQueues = class {
  states = /* @__PURE__ */ new Map();
  async sendOrQueue(sessionKey, client, threadId, input, retry) {
    return await this.withSessionLock(sessionKey, async (state) => {
      assertActive(state);
      if (state.currentTurnId || state.draining) {
        const queued = { id: queueId(), input, enqueuedAt: (/* @__PURE__ */ new Date()).toISOString() };
        state.pending.push(queued);
        return { started: false, turn_id: state.currentTurnId, queue_id: queued.id, queued_depth: state.pending.length };
      }
      const generation = state.generation;
      assertActive(state);
      const res = await turnStart(client, threadId, input, retry);
      if (!isStateUsable(state, generation)) throw new QueueTeardownError();
      state.currentTurnId = res.turnId;
      return { started: true, turn_id: res.turnId, queue_id: null, queued_depth: state.pending.length };
    });
  }
  getCurrentTurn(sessionKey) {
    return this.states.get(sessionKey)?.currentTurnId ?? null;
  }
  setCurrentTurn(sessionKey, turnId) {
    const existing = this.states.get(sessionKey);
    if (!existing && turnId === null) return;
    const state = existing ?? this.getOrInit(sessionKey);
    if (state.disposed) return;
    state.currentTurnId = turnId;
    this.resolveIdleWaiters(state);
  }
  isTeardown(sessionKey) {
    return this.states.get(sessionKey)?.tearingDown ?? false;
  }
  async beginTeardown(sessionKey) {
    const state = this.getOrInit(sessionKey);
    state.tearingDown = true;
    await state.serial;
    return { currentTurnId: state.currentTurnId };
  }
  async waitForIdle(sessionKey) {
    const state = this.states.get(sessionKey);
    if (!state) return;
    if (this.isIdle(state)) return;
    await new Promise((resolve) => {
      state.idleWaiters.add(resolve);
    });
  }
  onClientClosed(sessionKey) {
    const state = this.states.get(sessionKey);
    if (!state) return;
    state.currentTurnId = null;
    state.draining = false;
    this.resolveIdleWaiters(state);
  }
  clearTeardown(sessionKey) {
    const state = this.states.get(sessionKey);
    if (!state) return;
    state.tearingDown = false;
    this.resolveIdleWaiters(state);
  }
  depth(sessionKey) {
    return this.states.get(sessionKey)?.pending.length ?? 0;
  }
  rekey(oldKey, newKey) {
    if (oldKey === newKey) return;
    const state = this.states.get(oldKey);
    if (!state) return;
    this.states.delete(oldKey);
    this.states.set(newKey, state);
  }
  async onTurnCompleted(sessionKey, client, threadId, retry) {
    return await this.withSessionLock(sessionKey, async (state) => {
      state.draining = true;
      state.currentTurnId = null;
      this.resolveIdleWaiters(state);
      if (state.pending.length === 0 || !client || state.disposed || state.tearingDown) {
        state.draining = false;
        this.resolveIdleWaiters(state);
        return { turn_id: null, queue_id: null, failed: false };
      }
      const next = state.pending[0];
      const generation = state.generation;
      try {
        if (!isStateUsable(state, generation)) {
          return { turn_id: null, queue_id: null, failed: false };
        }
        const res = await turnStart(client, threadId, next.input, retry);
        if (!isStateUsable(state, generation)) {
          return { turn_id: null, queue_id: null, failed: false };
        }
        state.pending.shift();
        state.currentTurnId = res.turnId;
        return { turn_id: res.turnId, queue_id: next.id, failed: false };
      } catch (e) {
        if (!isStateUsable(state, generation)) {
          return { turn_id: null, queue_id: null, failed: false };
        }
        const err2 = e;
        logger.warn("failed to dispatch queued turn", { session: sessionKey, err: err2.message, queue_id: next.id });
        return {
          turn_id: null,
          queue_id: next.id,
          failed: true,
          error_message: err2.message
        };
      } finally {
        if (isSameGeneration(state, generation)) {
          state.draining = false;
          this.resolveIdleWaiters(state);
        }
      }
    });
  }
  dispose(sessionKey) {
    const state = this.states.get(sessionKey);
    if (!state) return { dropped: 0 };
    state.disposed = true;
    state.tearingDown = true;
    state.generation += 1;
    const dropped = state.pending.length;
    state.pending = [];
    state.currentTurnId = null;
    state.draining = false;
    this.resolveIdleWaiters(state);
    this.states.delete(sessionKey);
    return { dropped };
  }
  getOrInit(sessionKey) {
    let state = this.states.get(sessionKey);
    if (!state) {
      state = {
        pending: [],
        currentTurnId: null,
        draining: false,
        serial: Promise.resolve(),
        tearingDown: false,
        disposed: false,
        generation: 0,
        idleWaiters: /* @__PURE__ */ new Set()
      };
      this.states.set(sessionKey, state);
    }
    return state;
  }
  async withSessionLock(sessionKey, fn) {
    const state = this.getOrInit(sessionKey);
    const prev = state.serial;
    let release;
    state.serial = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      if (state.disposed) throw new QueueTeardownError();
      return await fn(state);
    } finally {
      release();
    }
  }
  isIdle(state) {
    return state.currentTurnId === null && !state.draining;
  }
  resolveIdleWaiters(state) {
    if (!this.isIdle(state)) return;
    for (const resolve of state.idleWaiters) resolve();
    state.idleWaiters.clear();
  }
};
function queueId() {
  return `q-${import_node_crypto4.default.randomBytes(4).toString("hex")}`;
}
function assertActive(state) {
  if (state.disposed || state.tearingDown) {
    throw new QueueTeardownError();
  }
}
function isSameGeneration(state, generation) {
  return state.generation === generation;
}
function isStateUsable(state, generation) {
  return !state.disposed && !state.tearingDown && isSameGeneration(state, generation);
}

// src/daemon/orphans.ts
var import_node_crypto5 = __toESM(require("crypto"));
var import_node_fs8 = __toESM(require("fs"));
var import_node_path8 = __toESM(require("path"));
var import_promises3 = require("timers/promises");

// src/daemon/processes.ts
var import_node_fs7 = __toESM(require("fs"));
var import_node_child_process2 = require("child_process");
function readLinuxCmdline(pid) {
  try {
    const raw = import_node_fs7.default.readFileSync(`/proc/${pid}/cmdline`);
    const commandLine = raw.toString("utf8").replace(/\0/g, " ").trim() || null;
    return { commandLine, source: "proc", reliable: true };
  } catch {
    return { commandLine: null, source: null, reliable: false };
  }
}
function readLinuxStartTime(pid) {
  try {
    const raw = import_node_fs7.default.readFileSync(`/proc/${pid}/stat`, "utf8");
    const lastParen = raw.lastIndexOf(")");
    if (lastParen < 0) return null;
    const rest = raw.slice(lastParen + 2).trim().split(/\s+/);
    const startTime = rest[19];
    return typeof startTime === "string" && startTime.length > 0 ? startTime : null;
  } catch {
    return null;
  }
}
function readPsCommand(pid) {
  try {
    const raw = (0, import_node_child_process2.execFileSync)("ps", ["-p", String(pid), "-o", "command="], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    const commandLine = raw.trim();
    return { commandLine: commandLine.length > 0 ? commandLine : null, source: "ps", reliable: true };
  } catch {
    return { commandLine: null, source: null, reliable: false };
  }
}
function readPsStartTime(pid) {
  try {
    const raw = (0, import_node_child_process2.execFileSync)("ps", ["-p", String(pid), "-o", "lstart="], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    const startTime = raw.trim();
    return startTime.length > 0 ? startTime : null;
  } catch {
    return null;
  }
}
function readWindowsCommand(pid) {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p -and $null -ne $p.CommandLine) { [Console]::Out.Write($p.CommandLine) }`;
  for (const bin of ["powershell.exe", "powershell", "pwsh"]) {
    try {
      const raw = (0, import_node_child_process2.execFileSync)(bin, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8"
      });
      const commandLine = raw.trim();
      if (commandLine.length > 0) return { commandLine, source: "powershell", reliable: true };
    } catch {
    }
  }
  try {
    const raw = (0, import_node_child_process2.execFileSync)("wmic", ["process", "where", `processid=${pid}`, "get", "CommandLine", "/value"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    const line = raw.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("CommandLine="));
    const commandLine = line?.slice("CommandLine=".length).trim() ?? "";
    if (commandLine.length > 0) return { commandLine, source: "wmic", reliable: true };
  } catch {
  }
  try {
    const raw = (0, import_node_child_process2.execFileSync)("tasklist", ["/FO", "LIST", "/NH", "/FI", `PID eq ${pid}`], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    const line = raw.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => /^Image Name:/i.test(entry));
    const commandLine = line?.replace(/^Image Name:\s*/i, "").trim() ?? "";
    if (commandLine.length > 0) return { commandLine, source: "tasklist", reliable: false };
  } catch {
  }
  return { commandLine: null, source: null, reliable: false };
}
function readWindowsStartTime(pid) {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p -and $null -ne $p.CreationDate) { [Console]::Out.Write($p.CreationDate) }`;
  for (const bin of ["powershell.exe", "powershell", "pwsh"]) {
    try {
      const raw = (0, import_node_child_process2.execFileSync)(bin, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8"
      });
      const startTime = raw.trim();
      if (startTime.length > 0) return startTime;
    } catch {
    }
  }
  try {
    const raw = (0, import_node_child_process2.execFileSync)("wmic", ["process", "where", `processid=${pid}`, "get", "CreationDate", "/value"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    const line = raw.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("CreationDate="));
    const startTime = line?.slice("CreationDate=".length).trim() ?? "";
    return startTime.length > 0 ? startTime : null;
  } catch {
    return null;
  }
}
function inspectProcessCommandLine(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return { commandLine: null, source: null, reliable: false };
  if (process.platform === "linux") return readLinuxCmdline(pid);
  if (process.platform === "darwin" || process.platform === "freebsd") return readPsCommand(pid);
  if (process.platform === "win32") return readWindowsCommand(pid);
  return { commandLine: null, source: null, reliable: false };
}
function readProcessStartTime(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === "linux") return readLinuxStartTime(pid);
  if (process.platform === "darwin" || process.platform === "freebsd") return readPsStartTime(pid);
  if (process.platform === "win32") return readWindowsStartTime(pid);
  return null;
}
function inspectCodexAppServerProcess(pid) {
  const inspection = inspectProcessCommandLine(pid);
  if (!inspection.commandLine) return "unknown";
  if (looksLikeCodexAppServerCommand(inspection.commandLine)) return "match";
  if (!inspection.reliable) return "unknown";
  return "mismatch";
}
function isLikelyCodexTeamDaemonProcess(pid) {
  const inspection = inspectProcessCommandLine(pid);
  return inspection.commandLine !== null && inspection.commandLine.includes("--daemon-internal");
}
function looksLikeCodexAppServerCommand(commandLine) {
  return commandLine.includes("app-server") && (commandLine.includes("codex") || commandLine.includes("codex-cli-bin"));
}

// src/daemon/orphans.ts
var SCHEMA_VERSION4 = 2;
var TERM_GRACE_MS = 2e3;
var KILL_GRACE_MS = 500;
var POLL_MS = 100;
function orphanPidsPath(dataDir) {
  return import_node_path8.default.join(dataDir, "codex-pids.json");
}
function readPidFile(dataDir) {
  const p = orphanPidsPath(dataDir);
  if (!import_node_fs8.default.existsSync(p)) return [];
  try {
    const raw = import_node_fs8.default.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x) => typeof x === "number" && Number.isFinite(x)).map((pid) => ({
        pid: Math.floor(pid),
        nonce: `legacy-${pid}`,
        start_time: null,
        tracked_at: (/* @__PURE__ */ new Date(0)).toISOString()
      }));
    }
    if (!parsed || typeof parsed !== "object") return [];
    const obj = parsed;
    if (typeof obj.schema_version === "number" && obj.schema_version > SCHEMA_VERSION4) {
      logger.warn("unknown orphan pid schema_version", { schema_version: obj.schema_version });
      return [];
    }
    if (!Array.isArray(obj.processes)) return [];
    return obj.processes.flatMap((entry) => normalizeTrackedPid(entry));
  } catch {
    return [];
  }
}
function writePidFile(dataDir, pids) {
  const p = orphanPidsPath(dataDir);
  try {
    import_node_fs8.default.mkdirSync(import_node_path8.default.dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    import_node_fs8.default.writeFileSync(tmp, JSON.stringify({
      schema_version: SCHEMA_VERSION4,
      processes: pids
    }));
    import_node_fs8.default.renameSync(tmp, p);
  } catch (e) {
    logger.warn("failed to persist codex pid file", { err: e.message });
  }
}
async function reapOrphans(dataDir) {
  const pids = readPidFile(dataDir);
  let killed = 0;
  const retryPids = [];
  for (const tracked of pids) {
    const liveness = inspectTrackedProcessLiveness(tracked);
    if (liveness === "dead") continue;
    if (liveness === "unknown") {
      retryPids.push(tracked);
      logger.warn("unable to verify orphan codex pid identity; retaining for retry", {
        pid: tracked.pid,
        platform: process.platform
      });
      continue;
    }
    const classification = inspectCodexAppServerProcess(tracked.pid);
    if (classification === "unknown") {
      retryPids.push(tracked);
      logger.warn("unable to verify orphan codex pid; retaining for retry", {
        pid: tracked.pid,
        platform: process.platform
      });
      continue;
    }
    if (classification !== "match") {
      logger.warn("skipping stale non-codex pid", { pid: tracked.pid });
      continue;
    }
    try {
      process.kill(tracked.pid, "SIGTERM");
      killed++;
    } catch (e) {
      if (inspectTrackedProcessLiveness(tracked) !== "dead") {
        retryPids.push(tracked);
      }
      logger.warn("failed to terminate orphan codex pid; retaining for retry", {
        pid: tracked.pid,
        err: e.message
      });
      continue;
    }
    if (await waitForTrackedExit(tracked, TERM_GRACE_MS)) continue;
    try {
      process.kill(tracked.pid, "SIGKILL");
    } catch (e) {
      if (inspectTrackedProcessLiveness(tracked) !== "dead") {
        retryPids.push(tracked);
      }
      logger.warn("failed to hard-kill orphan codex pid; retaining for retry", {
        pid: tracked.pid,
        err: e.message
      });
      continue;
    }
    if (!await waitForTrackedExit(tracked, KILL_GRACE_MS)) {
      retryPids.push(tracked);
      logger.warn("orphan codex pid still alive after SIGKILL; retaining for retry", {
        pid: tracked.pid
      });
    }
  }
  if (killed > 0) {
    logger.info("reaped orphan codex processes", { count: killed });
  }
  writePidFile(dataDir, retryPids);
  return killed;
}
var PidTracker = class {
  dataDir;
  pids = /* @__PURE__ */ new Map();
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  track(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return;
    this.pids.set(pid, {
      pid,
      nonce: import_node_crypto5.default.randomBytes(8).toString("hex"),
      start_time: readProcessStartTime(pid),
      tracked_at: (/* @__PURE__ */ new Date()).toISOString()
    });
    this.persist();
  }
  untrack(pid) {
    if (this.pids.delete(pid)) this.persist();
  }
  snapshot() {
    return Array.from(this.pids.values());
  }
  persist() {
    writePidFile(this.dataDir, this.snapshot());
  }
};
function normalizeTrackedPid(entry) {
  if (!entry || typeof entry !== "object") return [];
  const obj = entry;
  const pid = typeof obj.pid === "number" && Number.isFinite(obj.pid) ? Math.floor(obj.pid) : null;
  if (!pid || pid <= 0) return [];
  return [{
    pid,
    nonce: typeof obj.nonce === "string" && obj.nonce.length > 0 ? obj.nonce : import_node_crypto5.default.randomBytes(8).toString("hex"),
    start_time: typeof obj.start_time === "string" ? obj.start_time : null,
    tracked_at: typeof obj.tracked_at === "string" ? obj.tracked_at : (/* @__PURE__ */ new Date(0)).toISOString()
  }];
}
function inspectTrackedProcessLiveness(tracked) {
  try {
    process.kill(tracked.pid, 0);
  } catch {
    return "dead";
  }
  if (!tracked.start_time) return "alive";
  const startTime = readProcessStartTime(tracked.pid);
  if (startTime === null) return "unknown";
  return startTime === tracked.start_time ? "alive" : "dead";
}
async function waitForTrackedExit(tracked, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (inspectTrackedProcessLiveness(tracked) === "dead") return true;
    await (0, import_promises3.setTimeout)(POLL_MS, void 0, { ref: false });
  }
  return inspectTrackedProcessLiveness(tracked) === "dead";
}

// src/codex/pool.ts
var import_node_events2 = require("events");

// src/codex/appServerClient.ts
var import_node_child_process3 = require("child_process");
var import_node_events = require("events");
var import_node_crypto6 = require("crypto");
var import_node_path9 = __toESM(require("path"));
var STDERR_TAIL_LINES = 400;
var DEFAULT_REQUEST_TIMEOUT_MS = 12e4;
var AppServerClient = class extends import_node_events.EventEmitter {
  proc = null;
  buf = "";
  pending = /* @__PURE__ */ new Map();
  stderrTail = [];
  lastPid = null;
  options;
  initialized = false;
  constructor(options = {}) {
    super();
    this.options = {
      bin: options.bin ?? "codex",
      args: options.args ?? [],
      cwd: options.cwd,
      env: options.env,
      configOverrides: options.configOverrides ?? [],
      clientInfo: options.clientInfo,
      experimentalApi: options.experimentalApi ?? true,
      stderrTailLines: options.stderrTailLines ?? STDERR_TAIL_LINES,
      requestTimeoutMs: Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    };
  }
  isAlive() {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }
  pid() {
    return this.proc?.pid ?? this.lastPid;
  }
  stderrTailText() {
    return this.stderrTail.join("\n");
  }
  async start() {
    if (this.proc) throw new Error("app-server already started");
    const args = [...this.options.args];
    for (const kv of this.options.configOverrides) args.push("--config", kv);
    args.push("app-server", "--listen", "stdio://");
    const launch = resolveLaunch(this.options.bin, args);
    const env = { ...process.env, ...this.options.env ?? {} };
    logger.debug("spawning app-server", { bin: launch.command, args: launch.args });
    this.proc = (0, import_node_child_process3.spawn)(launch.command, launch.args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.lastPid = this.proc.pid ?? null;
    this.proc.on("error", (err2) => {
      logger.error("app-server spawn error", { err: err2.message });
      this.failAllPending(new TransportClosedError(`spawn error: ${err2.message}`));
      this.emit("error", err2);
    });
    this.proc.on("exit", (code, signal) => {
      logger.info("app-server exited", { code, signal });
      this.failAllPending(new TransportClosedError(`app-server exited (code=${code}, signal=${signal})`));
      this.emit("close", code);
      this.proc = null;
      this.initialized = false;
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => this.onStderr(chunk));
    const init = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? { name: "codex-team", title: "codex-team", version: "0.5.0" },
      capabilities: { experimentalApi: this.options.experimentalApi }
    });
    this.notify("initialized", {});
    this.initialized = true;
    return init;
  }
  async close(graceMs = 2e3) {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.initialized = false;
    const exited = new Promise((resolve) => proc.once("exit", () => resolve()));
    requestProcessShutdown(proc);
    const timer = setTimeout(() => forceKillProcess(proc), graceMs);
    timer.unref();
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
    this.failAllPending(new TransportClosedError("app-server closed"));
  }
  request(method, params = {}) {
    if (!this.proc) return Promise.reject(new TransportClosedError("app-server is not running"));
    if (this.proc.exitCode !== null) return Promise.reject(new TransportClosedError("app-server already exited"));
    const id = (0, import_node_crypto6.randomUUID)();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        void this.close().catch(() => void 0);
        pending.reject(new RequestTimeoutError(`${method} timed out after ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve,
        reject,
        timer
      });
      try {
        this.writeMessage({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  notify(method, params = {}) {
    if (!this.proc) throw new TransportClosedError("app-server is not running");
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }
  respond(id, result) {
    if (!this.proc) return;
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }
  respondAck(id, result) {
    if (!this.proc) return Promise.reject(new TransportClosedError("app-server is not running"));
    return this.writeMessageAck({ jsonrpc: "2.0", id, result });
  }
  respondError(id, code, message, data) {
    if (!this.proc) return;
    const error = { code, message };
    if (data !== void 0) error.data = data;
    this.writeMessage({ jsonrpc: "2.0", id, error });
  }
  respondErrorAck(id, code, message, data) {
    if (!this.proc) return Promise.reject(new TransportClosedError("app-server is not running"));
    const error = { code, message };
    if (data !== void 0) error.data = data;
    return this.writeMessageAck({ jsonrpc: "2.0", id, error });
  }
  isInitialized() {
    return this.initialized;
  }
  writeMessage(msg) {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) {
      throw new TransportClosedError("app-server stdin closed");
    }
    const line = JSON.stringify(msg) + "\n";
    proc.stdin.write(line);
  }
  writeMessageAck(msg) {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) {
      return Promise.reject(new TransportClosedError("app-server stdin closed"));
    }
    const line = JSON.stringify(msg) + "\n";
    return new Promise((resolve, reject) => {
      const onExit = () => {
        reject(new TransportClosedError("app-server exited during stdin write"));
      };
      proc.once("exit", onExit);
      try {
        const backpressured = !proc.stdin.write(line, (err2) => {
          proc.off("exit", onExit);
          if (err2) {
            reject(new TransportClosedError(`app-server stdin write failed: ${err2.message}`));
            return;
          }
          resolve({ backpressured });
        });
      } catch (e) {
        proc.off("exit", onExit);
        reject(e);
      }
    });
  }
  onStdout(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        logger.warn("malformed line from app-server", { snippet: line.slice(0, 200) });
        continue;
      }
      this.dispatchIncoming(parsed);
    }
  }
  onStderr(chunk) {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (!line) continue;
      this.stderrTail.push(line);
      if (this.stderrTail.length > this.options.stderrTailLines) this.stderrTail.shift();
    }
  }
  dispatchIncoming(msg) {
    const hasId = "id" in msg;
    const hasMethod = typeof msg.method === "string";
    const method = typeof msg.method === "string" ? msg.method : null;
    if (hasMethod && hasId) {
      this.emit("server_request", {
        id: msg.id,
        method,
        params: msg.params ?? null
      });
      return;
    }
    if (hasMethod && !hasId) {
      this.emit("notification", { method, params: msg.params ?? null });
      return;
    }
    if (hasId) {
      const id = String(msg.id);
      const pending = this.pending.get(id);
      if (!pending) {
        logger.debug("unmatched response id", { id });
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in msg && msg.error && typeof msg.error === "object") {
        const errObj = msg.error;
        const code = typeof errObj.code === "number" ? errObj.code : -32e3;
        const message = typeof errObj.message === "string" ? errObj.message : "unknown";
        pending.reject(mapJsonRpcError(code, message, errObj.data));
      } else {
        pending.resolve(msg.result ?? null);
      }
    }
  }
  failAllPending(err2) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err2);
    }
    this.pending.clear();
  }
};
function resolveLaunch(bin, args) {
  if (isNodeScript(bin)) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  if (process.platform !== "win32") {
    return { command: bin, args };
  }
  const resolved = resolveWindowsCommand(bin) ?? bin;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", quoteWindowsCommand(resolved, args)]
    };
  }
  return { command: resolved, args };
}
function resolveWindowsCommand(bin) {
  if (bin.includes("\\") || bin.includes("/") || import_node_path9.default.extname(bin).length > 0) return bin;
  try {
    const raw = (0, import_node_child_process3.execFileSync)("where", [bin], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    return raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}
function isNodeScript(bin) {
  return /\.(cjs|mjs|js)$/i.test(bin);
}
function quoteWindowsCommand(bin, args) {
  return [bin, ...args].map(quoteWindowsArg).join(" ");
}
function quoteWindowsArg(arg) {
  if (arg.length === 0) return '""';
  if (!/[ \t"&()^<>|]/.test(arg)) return arg;
  return `"${arg.replace(/(["])/g, "\\$1")}"`;
}
function requestProcessShutdown(proc) {
  try {
    proc.stdin.end();
  } catch {
  }
  if (process.platform === "win32") {
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
  }
}
function forceKillProcess(proc) {
  try {
    if (process.platform === "win32") proc.kill();
    else proc.kill("SIGKILL");
  } catch {
  }
}

// src/codex/pool.ts
var AppServerPool = class extends import_node_events2.EventEmitter {
  options;
  byUser = /* @__PURE__ */ new Map();
  byClient = /* @__PURE__ */ new Map();
  bySession = /* @__PURE__ */ new Map();
  inFlightAcquireBySession = /* @__PURE__ */ new Map();
  nextClientId = 1;
  shuttingDown = false;
  constructor(options) {
    super();
    this.options = options;
  }
  async acquire(user, sessionKey, clientOptions) {
    if (this.shuttingDown) throw new Error("pool is shutting down");
    const existing = this.bySession.get(sessionKey);
    if (existing) {
      if (existing.user !== user) {
        throw new Error(`session ${sessionKey} is already held by another user`);
      }
      return existing.client;
    }
    const inFlight = this.inFlightAcquireBySession.get(sessionKey);
    if (inFlight) return await inFlight;
    const acquirePromise = this.acquireSlow(user, sessionKey, clientOptions);
    this.inFlightAcquireBySession.set(sessionKey, acquirePromise);
    try {
      return await acquirePromise;
    } finally {
      if (this.inFlightAcquireBySession.get(sessionKey) === acquirePromise) {
        this.inFlightAcquireBySession.delete(sessionKey);
      }
    }
  }
  async acquireSlow(user, sessionKey, clientOptions) {
    const existing = this.bySession.get(sessionKey);
    if (existing) {
      if (existing.user !== user) {
        throw new Error(`session ${sessionKey} is already held by another user`);
      }
      return existing.client;
    }
    const managed = this.findAvailableForUser(user, false);
    if (managed) {
      managed.sessions.add(sessionKey);
      this.bySession.set(sessionKey, managed);
      return managed.client;
    }
    const fresh = await this.spawn(user, clientOptions);
    fresh.sessions.add(sessionKey);
    this.bySession.set(sessionKey, fresh);
    return fresh.client;
  }
  release(sessionKey) {
    const m = this.bySession.get(sessionKey);
    if (!m) return;
    m.sessions.delete(sessionKey);
    this.bySession.delete(sessionKey);
  }
  rekeySession(oldKey, newKey) {
    if (oldKey === newKey) return;
    const m = this.bySession.get(oldKey);
    if (!m) return;
    m.sessions.delete(oldKey);
    m.sessions.add(newKey);
    this.bySession.delete(oldKey);
    this.bySession.set(newKey, m);
  }
  async acquireForAdhoc(user, clientOptions) {
    if (this.shuttingDown) throw new Error("pool is shutting down");
    const existing = this.findAvailableForUser(user, true);
    if (existing) return existing.client;
    const fresh = await this.spawn(user, clientOptions);
    return fresh.client;
  }
  sessionsForClient(clientId) {
    const m = this.byClient.get(clientId);
    return m ? Array.from(m.sessions) : [];
  }
  clientForSession(sessionKey) {
    const m = this.bySession.get(sessionKey);
    return m ? m.client : null;
  }
  clientById(clientId) {
    return this.byClient.get(clientId)?.client ?? null;
  }
  listClients() {
    return Array.from(this.byClient.values()).map((m) => ({
      id: m.id,
      user: m.user,
      sessions: new Set(m.sessions)
    }));
  }
  processCount() {
    return this.byClient.size;
  }
  async shutdown() {
    this.shuttingDown = true;
    const closes = Array.from(this.byClient.values()).map((m) => {
      m.closeReason = "shutdown";
      return m.client.close().catch(() => void 0);
    });
    await Promise.all(closes);
    this.inFlightAcquireBySession.clear();
    this.byUser.clear();
    this.byClient.clear();
    this.bySession.clear();
  }
  async closeUser(user) {
    const managed = [...this.byUser.get(user) ?? []];
    await Promise.all(managed.map((m) => {
      m.closeReason = "user_close";
      return m.client.close().catch(() => void 0);
    }));
  }
  findAvailableForUser(user, allowBoundSessions) {
    const list = this.byUser.get(user);
    if (!list) return null;
    for (const m of list) {
      if (!m.client.isAlive()) continue;
      if (!allowBoundSessions && m.sessions.size > 0) continue;
      if (m.sessions.size < this.options.maxSessionsPerProcess) return m;
    }
    return null;
  }
  async spawn(user, override) {
    const clientOptions = { ...this.options.clientDefaults ?? {}, ...override ?? {} };
    const client = new AppServerClient(clientOptions);
    const id = `as-${this.nextClientId++}`;
    const managed = { id, user, client, sessions: /* @__PURE__ */ new Set(), closeReason: null };
    client.on("notification", (n) => {
      this.emit("notification", { user, clientId: id, notification: n });
    });
    client.on("server_request", (r) => {
      this.emit("server_request", {
        user,
        clientId: id,
        request: r,
        respond: (result) => client.respond(r.id, result),
        respondError: (code, message, data) => client.respondError(r.id, code, message, data)
      });
    });
    client.on("close", (code) => {
      const sessions = Array.from(managed.sessions);
      const reason = managed.closeReason ?? (this.shuttingDown ? "shutdown" : "unexpected");
      managed.closeReason = null;
      for (const s of sessions) this.bySession.delete(s);
      managed.sessions.clear();
      const list2 = this.byUser.get(user);
      if (list2) {
        const idx = list2.indexOf(managed);
        if (idx >= 0) list2.splice(idx, 1);
        if (list2.length === 0) this.byUser.delete(user);
      }
      this.byClient.delete(id);
      const pid2 = client.pid();
      if (pid2 !== null && this.options.onExit) this.options.onExit(pid2);
      this.emit("client_close", { user, clientId: id, sessions, exitCode: code, reason });
    });
    client.on("error", (err2) => {
      logger.error("app-server client error", { user, clientId: id, err: err2.message });
    });
    try {
      await client.start();
    } catch (e) {
      try {
        await client.close();
      } catch {
      }
      throw e;
    }
    const pid = client.pid();
    if (pid !== null && this.options.onSpawn) this.options.onSpawn(pid);
    const list = this.byUser.get(user) ?? [];
    list.push(managed);
    this.byUser.set(user, list);
    this.byClient.set(id, managed);
    return managed;
  }
};

// src/daemon/context.ts
function buildContext() {
  const config = new ConfigStore();
  const dataDir = config.resolvedDataDir();
  const sockPath = config.resolvedSockPath();
  const logPath = config.resolvedLogPath();
  const logLevel = config.getEffective("daemon.log_level");
  logger.configure({
    level: typeof logLevel === "string" ? logLevel : "info",
    logPath
  });
  const users = new UserRegistry(dataDir);
  const sessions = new SessionRegistry(dataDir);
  sessions.loadAllUsers(users.list().map((u) => u.token));
  const pidTracker = new PidTracker(dataDir);
  const maxPerProcess = config.getEffective("app_server.max_sessions_per_process");
  const pool = new AppServerPool({
    maxSessionsPerProcess: typeof maxPerProcess === "number" ? maxPerProcess : 16,
    clientDefaults: {
      requestTimeoutMs: toMs2(config.getEffective("app_server.request_timeout_seconds"), 12e4)
    },
    onSpawn: (pid) => pidTracker.track(pid),
    onExit: (pid) => pidTracker.untrack(pid)
  });
  pool.on("client_close", (e) => {
    logger.info("app-server client closed", {
      user: e.user,
      client: e.clientId,
      lost_sessions: e.sessions.length,
      exit_code: e.exitCode
    });
  });
  const retentionRaw = config.getEffective("monitor.event_log_retention");
  const events = new EventLog(typeof retentionRaw === "number" ? retentionRaw : 1e4, dataDir);
  const pending = new PendingRegistry();
  const queues = new TurnQueues();
  const activity = {
    lastActivityAt: /* @__PURE__ */ new Date(),
    touch() {
      activity.lastActivityAt = /* @__PURE__ */ new Date();
    }
  };
  const retryOptions = () => {
    return {
      maxAttempts: toInt2(config.getEffective("retry.max_attempts"), 3),
      initialDelayMs: toMs2(config.getEffective("retry.initial_delay_seconds"), 250),
      maxDelayMs: toMs2(config.getEffective("retry.max_delay_seconds"), 2e3),
      jitterRatio: 0.2
    };
  };
  return {
    startedAt: /* @__PURE__ */ new Date(),
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
    logPath
  };
}
function toInt2(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return fallback;
}
function toMs2(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v * 1e3);
  return fallback;
}

// src/daemon/handlers/version.ts
var version = async (_ctx, _req) => {
  let pkgVersion = "unknown";
  try {
    const pkg = require_package();
    pkgVersion = pkg.version ?? "unknown";
  } catch {
  }
  return {
    daemon_version: pkgVersion
  };
};

// src/daemon/handlers/status.ts
var status = async (ctx, req) => {
  const token = req.bearer;
  if (!token) {
    throw new CodexTeamError("invalid_params", "status requires -b <token>");
  }
  const user = ctx.users.get(token);
  if (!user) {
    throw new CodexTeamError("user_not_found", `user '${token}' not found \u2014 run 'codex-team daemon user create ${token}'`);
  }
  ctx.users.touch(token);
  return {
    token: user.token,
    created_at: user.created_at,
    last_active_at: user.last_active_at,
    live_sessions: ctx.sessions.listLive(token).length,
    retained_events: ctx.events.retainedCount(token),
    pending_requests: ctx.pending.listForUser(token).length,
    daemon: {
      pid: process.pid,
      started_at: ctx.startedAt.toISOString(),
      data_dir: ctx.dataDir
    }
  };
};

// src/daemon/handlers/daemon.ts
var import_node_fs10 = __toESM(require("fs"));
var import_node_path10 = __toESM(require("path"));
var import_node_child_process4 = require("child_process");

// src/daemon/shutdown.ts
var import_node_fs9 = __toESM(require("fs"));
var shuttingDown = false;
async function shutdownDaemon(ctx, reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown initiated", { reason });
  try {
    await ctx.pool.shutdown();
  } catch (e) {
    logger.error("pool shutdown error", { err: e.message });
  }
  try {
    await ctx.sessions.flush();
  } catch (e) {
    logger.error("session registry flush error", { err: e.message });
  }
  try {
    await ctx.events.flush();
  } catch (e) {
    logger.error("event log flush error", { err: e.message });
  }
  unlinkSockIfStale(ctx.sockPath);
  try {
    import_node_fs9.default.unlinkSync(pidFilePath(ctx.dataDir));
  } catch {
  }
  setTimeout(() => process.exit(exitCode), 10);
}

// src/daemon/handlers/daemon.ts
var daemonStatus = async (ctx) => {
  const uptimeMs = Date.now() - ctx.startedAt.getTime();
  return {
    pid: process.pid,
    version: getPkgVersion(),
    uptime_s: Math.floor(uptimeMs / 1e3),
    sock: ctx.sockPath,
    data_dir: ctx.dataDir,
    log_path: ctx.logPath,
    user_count: ctx.users.list().length,
    app_server_count: ctx.pool.processCount(),
    started_at: ctx.startedAt.toISOString()
  };
};
var daemonStart = async () => {
  return { already_running: true };
};
var daemonStop = async (ctx, req) => {
  const force = isTrue(getFlag(req.params, "force"));
  if (force) {
    setTimeout(() => process.exit(1), 10);
  } else {
    setTimeout(() => void shutdownDaemon(ctx, "daemon stop"), 10);
  }
  return { stopping: true, force };
};
var daemonRestart = async (ctx) => {
  const entry = process.argv[1];
  (0, import_node_child_process4.spawn)(process.execPath, [entry, "--daemon-internal"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true
  }).unref();
  setTimeout(() => void shutdownDaemon(ctx, "daemon restart"), 100);
  return { restarting: true };
};
var daemonUserCreate = async (ctx, req) => {
  const token = reqPositional(req, 0, "token");
  const user = ctx.users.create(token);
  return user;
};
var daemonUserDestroy = async (ctx, req) => {
  const token = reqPositional(req, 0, "token");
  const force = isTrue(getFlag(req.params, "force"));
  if (!ctx.users.has(token)) {
    throw new CodexTeamError("user_not_found", `user '${token}' not found`);
  }
  const liveSessions = ctx.sessions.listLive(token);
  if (!force && liveSessions.length > 0) {
    throw invalidParams(
      `cannot destroy user '${token}' while ${liveSessions.length} live session(s) remain; pass --force to destroy anyway`
    );
  }
  const pending = ctx.pending.removeForUser(token);
  for (const p of pending) {
    try {
      p.client.respondError(p.jsonrpc_id, -32e3, "user destroyed");
    } catch {
    }
  }
  await ctx.pool.closeUser(token);
  const sessions = await ctx.sessions.clearUser(token);
  for (const rec of sessions) {
    ctx.queues.dispose(`${token}::${rec.name}`);
  }
  await ctx.events.clearUser(token);
  ctx.users.destroy(token);
  return { destroyed: token, sessions_closed: sessions.length, pending_canceled: pending.length };
};
var daemonUserList = async (ctx) => {
  return { users: ctx.users.list() };
};
var daemonConfigGet = async (ctx, req) => {
  const key = reqPositional(req, 0, "key");
  const entry = ctx.config.get(key);
  if (!entry) throw invalidParams(`unknown config key: ${key}`);
  return {
    key,
    value: entry.value,
    default: entry.spec.default,
    source: entry.source,
    needs_restart: entry.spec.needsRestart
  };
};
var daemonConfigSet = async (ctx, req) => {
  const key = reqPositional(req, 0, "key");
  const value = reqPositional(req, 1, "value");
  const result = ctx.config.set(key, value);
  if (!result.ok) throw invalidParams(result.error);
  applyHotConfigChange(ctx, key, result.value);
  return {
    key,
    value: result.value,
    needs_restart: result.needs_restart
  };
};
function applyHotConfigChange(ctx, key, value) {
  if (key === "daemon.log_level" && typeof value === "string") {
    logger.setLevel(value);
    return;
  }
  if (key === "monitor.event_log_retention" && typeof value === "number") {
    ctx.events.setRetention(value);
    return;
  }
}
var daemonConfigUnset = async (ctx, req) => {
  const key = reqPositional(req, 0, "key");
  const result = ctx.config.unset(key);
  if (!result.ok) throw invalidParams(result.error);
  applyHotConfigChange(ctx, key, ctx.config.getEffective(key));
  return { key, needs_restart: result.needs_restart };
};
var daemonConfigList = async (ctx, req) => {
  const explicitOnly = isTrue(getFlag(req.params, "explicit-only"));
  const snapshot = ctx.config.snapshot();
  const rows = [];
  for (const key of Object.keys(CONFIG_KEYS)) {
    const spec = CONFIG_KEYS[key];
    const isExplicit = key in snapshot.explicit;
    if (explicitOnly && !isExplicit) continue;
    rows.push({
      key,
      value: snapshot.effective[key],
      default: spec.default,
      explicit: isExplicit,
      needs_restart: spec.needsRestart,
      type: spec.type,
      description: spec.description
    });
  }
  return { config: rows };
};
var daemonConfigReset = async (ctx, req) => {
  if (!isTrue(getFlag(req.params, "yes"))) {
    throw invalidParams("pass --yes to confirm reset");
  }
  ctx.config.reset();
  applyHotConfigChange(ctx, "daemon.log_level", ctx.config.getEffective("daemon.log_level"));
  applyHotConfigChange(ctx, "monitor.event_log_retention", ctx.config.getEffective("monitor.event_log_retention"));
  return { reset: true };
};
var daemonLogsStream = async (ctx, req, stream) => {
  if (!stream) throw new CodexTeamError("internal", "daemonLogs requires a stream");
  const logPath = ctx.logPath;
  const follow = isTrue(getFlag(req.params, "follow")) || isTrue(getFlag(req.params, "f"));
  const n = toInt3(getFlag(req.params, "n"), 100);
  const level = asString(getFlag(req.params, "level"));
  let offset = 0;
  let closed = false;
  let debounceTimer = null;
  const emitLine = (line) => {
    if (!line) return;
    if (level && !lineMatchesLevel(line, level)) return;
    stream.chunk(safeParseOr(line, { raw: line }));
  };
  const initial = await readTextIfExists(logPath);
  if (initial !== null) {
    const lines = initial.split("\n").filter(Boolean);
    const tailLines = lines.slice(Math.max(0, lines.length - n));
    for (const line of tailLines) emitLine(line);
    offset = Buffer.byteLength(initial);
  } else if (!follow) {
    stream.end();
    return { streamed: true };
  }
  if (!follow) {
    stream.end();
    return { streamed: true };
  }
  const syncAppended = async () => {
    try {
      const stat = await import_node_fs10.default.promises.stat(logPath);
      if (stat.size < offset) offset = 0;
      if (stat.size === offset) return;
      const chunk = await readBytes(logPath, offset, stat.size - offset);
      offset = stat.size;
      for (const line of chunk.split("\n").filter(Boolean)) emitLine(line);
    } catch (e) {
      if (e.code === "ENOENT") {
        offset = 0;
        return;
      }
      logger.warn("daemon log follow read failed", { err: e.message });
    }
  };
  const scheduleSync = () => {
    if (closed || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void syncAppended();
    }, 50);
    debounceTimer.unref();
  };
  const watcher = import_node_fs10.default.watch(import_node_path10.default.dirname(logPath), { persistent: true }, (_event, filename) => {
    if (!filename || filename.toString() === import_node_path10.default.basename(logPath)) scheduleSync();
  });
  stream.onClose(() => {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  });
  return { streamed: true };
};
function reqPositional(req, idx, name) {
  const positionals = req.params.positionals ?? [];
  const v = positionals[idx];
  if (typeof v !== "string" || v.length === 0) {
    throw invalidParams(`missing positional '${name}'`);
  }
  return v;
}
function getFlag(params, key) {
  const flags = params.flags;
  if (!flags || typeof flags !== "object") return void 0;
  return flags[key];
}
function isTrue(v) {
  return v === true || v === "true" || v === "1";
}
function toInt3(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return fallback;
}
function asString(v) {
  return typeof v === "string" ? v : null;
}
function lineMatchesLevel(line, level) {
  try {
    const obj = JSON.parse(line);
    return obj.level === level;
  } catch {
    return false;
  }
}
function safeParseOr(line, fallback) {
  try {
    return JSON.parse(line);
  } catch {
    return fallback;
  }
}
async function readTextIfExists(filePath) {
  try {
    return await import_node_fs10.default.promises.readFile(filePath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function readBytes(filePath, start, length) {
  if (length <= 0) return "";
  const handle = await import_node_fs10.default.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}
function getPkgVersion() {
  try {
    const pkg = require_package();
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// src/daemon/handlers/session.ts
var import_node_fs11 = __toESM(require("fs"));

// src/daemon/experimentalTools.ts
var TOOL_SPECS = [
  {
    canonicalName: "ask-user-question",
    aliases: [
      "ask-user-question",
      "ask_user_question",
      "askuserquestion",
      "request-user-input",
      "request_user_input",
      "requestuserinput"
    ],
    featureFlags: ["default_mode_request_user_input"]
  },
  {
    canonicalName: "request-permissions",
    aliases: [
      "request-permissions",
      "request_permissions",
      "requestpermissions"
    ],
    featureFlags: ["request_permissions_tool"]
  }
];
var ALIAS_TO_SPEC = /* @__PURE__ */ new Map();
for (const spec of TOOL_SPECS) {
  for (const alias of spec.aliases) {
    ALIAS_TO_SPEC.set(alias, spec);
  }
}
var SUPPORTED_EXPERIMENTAL_TOOLS = TOOL_SPECS.map((spec) => spec.canonicalName);
function parseExperimentalTools(value) {
  if (value === void 0 || value === null || value === "") return [];
  if (value === true) {
    throw invalidParams(
      `--experimental-tools requires a comma-separated value (${SUPPORTED_EXPERIMENTAL_TOOLS.join(", ")})`
    );
  }
  const rawParts = Array.isArray(value) ? value.flatMap((part) => splitCsv(part)) : splitCsv(value);
  if (rawParts.length === 0) return [];
  const deduped = [];
  const seen = /* @__PURE__ */ new Set();
  for (const part of rawParts) {
    const normalized = normalizeAlias(part);
    const spec = ALIAS_TO_SPEC.get(normalized);
    if (!spec) {
      throw invalidParams(
        `unsupported experimental tool '${part}'; supported values: ${SUPPORTED_EXPERIMENTAL_TOOLS.join(", ")}`
      );
    }
    if (seen.has(spec.canonicalName)) continue;
    seen.add(spec.canonicalName);
    deduped.push(spec.canonicalName);
  }
  return deduped;
}
function buildExperimentalToolThreadConfig(tools) {
  const features = {};
  for (const spec of specsForTools(tools)) {
    for (const featureFlag of spec.featureFlags) {
      features[featureFlag] = true;
    }
  }
  return Object.keys(features).length > 0 ? { features } : null;
}
function buildExperimentalToolAppServerOptions(tools) {
  const configOverrides = Array.from(new Set(
    specsForTools(tools).flatMap((spec) => spec.featureFlags.map((flag) => `features.${flag}=true`))
  ));
  if (configOverrides.length === 0) return void 0;
  return { configOverrides };
}
function specsForTools(tools) {
  return tools.map((tool) => {
    const spec = TOOL_SPECS.find((candidate) => candidate.canonicalName === tool);
    if (!spec) {
      throw invalidParams(
        `unsupported experimental tool '${tool}'; supported values: ${SUPPORTED_EXPERIMENTAL_TOOLS.join(", ")}`
      );
    }
    return spec;
  });
}
function splitCsv(value) {
  if (typeof value !== "string") {
    throw invalidParams("experimental tool lists must be strings");
  }
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}
function normalizeAlias(value) {
  return value.trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, "-").toLowerCase();
}

// src/format/markdown.ts
function renderTag(name, attrs, body) {
  const line = `<${name}> ${compactJson(attrs)}`;
  if (!body || body.trim().length === 0) {
    return `${line}

<\\${name}>`;
  }
  return `${line}

${body.trim()}

<\\${name}>`;
}
function renderInline(name, attrs) {
  return `<${name}>${compactJson(attrs)}<\\${name}>`;
}
function renderHistory(input) {
  const attrs = {
    session: input.session,
    thread_id: input.thread_id,
    count: input.turns.length,
    generated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (input.nextCursor) attrs.next_cursor = input.nextCursor;
  const body = input.turns.map(renderTurn).join("\n\n");
  return renderTag("history", attrs, body);
}
function renderTail(input) {
  const attrs = {
    session: input.session,
    thread_id: input.thread_id,
    count: input.turns.length,
    generated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (input.follow) attrs.follow = true;
  const body = input.turns.map(renderTurn).join("\n\n");
  return renderTag("tail", attrs, body);
}
function renderContext(input) {
  const t = input.thread;
  const attrs = {
    session: input.session,
    thread_id: input.thread_id,
    generated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (t) {
    if (typeof t.model_provider === "string") attrs.model_provider = t.model_provider;
    if (typeof t.preview === "string") attrs.preview = t.preview;
    if (typeof t.cwd === "string") attrs.cwd = t.cwd;
    const status2 = t.status?.type;
    if (typeof status2 === "string") attrs.status = status2;
    if (typeof t.created_at === "number") attrs.created_at = t.created_at;
    if (typeof t.updated_at === "number") attrs.updated_at = t.updated_at;
  }
  return renderTag("context", attrs, [
    "<!-- thread/read only returns thread metadata; for turn-level content use 'message history' -->"
  ].join("\n"));
}
function renderTurn(turn) {
  const attrs = {
    id: turn.id,
    status: turn.status ?? null
  };
  if (turn.durationMs !== void 0 && turn.durationMs !== null) attrs.duration_ms = turn.durationMs;
  if (turn.startedAt !== void 0 && turn.startedAt !== null) attrs.started_at = turn.startedAt;
  if (turn.completedAt !== void 0 && turn.completedAt !== null) attrs.completed_at = turn.completedAt;
  const err2 = turn.error ?? null;
  if (err2) attrs.error = err2;
  const items = Array.isArray(turn.items) ? turn.items : [];
  if (items.length === 0) {
    return renderInline("turn", attrs);
  }
  const body = items.map(renderItem).filter(Boolean).join("\n\n");
  return renderTag("turn", attrs, body);
}
function renderItem(raw) {
  if (!raw || typeof raw !== "object") return "";
  const item = raw;
  const type = typeof item.type === "string" ? item.type : "unknown";
  const id = typeof item.id === "string" ? item.id : void 0;
  const attrs = {};
  if (id) attrs.id = id;
  switch (type) {
    case "agent_message": {
      const text = typeof item.text === "string" ? item.text : stringifyMaybe(item.content);
      return renderTag("agent-message", attrs, text ?? "");
    }
    case "reasoning": {
      const text = typeof item.text === "string" ? item.text : stringifyMaybe(item.summary);
      return renderTag("reasoning", attrs, text ?? "");
    }
    case "command_execution": {
      if (item.command !== void 0) attrs.cmd = item.command;
      if (item.exit !== void 0) attrs.exit = item.exit;
      if (item.durationMs !== void 0) attrs.duration_ms = item.durationMs;
      if (item.stderr !== void 0) attrs.stderr = item.stderr;
      const body = typeof item.stdout === "string" ? item.stdout : stringifyMaybe(item.output) ?? "";
      return renderTag("shell", attrs, body);
    }
    case "file_change": {
      if (item.path !== void 0) attrs.path = item.path;
      if (item.status !== void 0) attrs.status = item.status;
      const body = typeof item.diff === "string" ? item.diff : stringifyMaybe(item.changes) ?? "";
      return renderTag("file-patch", attrs, body);
    }
    default: {
      attrs.type = type;
      const body = stringifyMaybe(item) ?? "";
      return renderTag("item", attrs, body);
    }
  }
}
function stringifyMaybe(v) {
  if (v === void 0 || v === null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
function compactJson(obj) {
  return JSON.stringify(obj);
}

// src/format/table.ts
function renderTable2(rows, columns) {
  if (rows.length === 0) return `(no rows)`;
  const matrix = [columns];
  for (const row of rows) {
    matrix.push(columns.map((c) => stringify(row[c])));
  }
  const widths = columns.map((_, colIdx) => Math.max(...matrix.map((r) => (r[colIdx] ?? "").length)));
  const pad = (cell, w) => cell + " ".repeat(Math.max(0, w - cell.length));
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const lines = [];
  lines.push(matrix[0].map((c, i) => pad(c, widths[i])).join("  "));
  lines.push(sep);
  for (let i = 1; i < matrix.length; i++) {
    lines.push(matrix[i].map((c, j) => pad(c, widths[j])).join("  "));
  }
  return lines.join("\n");
}
function stringify(v) {
  if (v === null || v === void 0) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// src/daemon/handlers/session.ts
var attachLocks = /* @__PURE__ */ new Map();
var sessionNew = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const positionals = asPositionals(req);
  const flags = asFlags(req);
  const provided = positionals[0];
  if (provided) validateSessionName(provided);
  let name = provided ?? generateSessionName();
  if (!provided) {
    while (ctx.sessions.get(user, name)) name = generateSessionName();
  } else if (ctx.sessions.get(user, name)) {
    throw invalidParams(`session '${name}' already exists`);
  }
  const experimentalTools = resolveExperimentalToolsForCreate(ctx, flags);
  const startParams = await buildThreadStartParams(ctx, flags, experimentalTools);
  const client = await ctx.pool.acquire(user, keyFor(user, name), buildExperimentalToolAppServerOptions(experimentalTools));
  let result;
  try {
    result = await threadStart(client, startParams, ctx.retryOptions());
  } catch (e) {
    ctx.pool.release(keyFor(user, name));
    throw e;
  }
  const threadId = threadIdOf(result);
  try {
    await threadSetName(client, threadId, name, ctx.retryOptions());
  } catch {
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const record = {
    name,
    thread_id: threadId,
    state: "live",
    model: asString2(flags["model"]) ?? resolveDefault(ctx, "codex.default_model") ?? void 0,
    cwd: asString2(flags["cwd"]) ?? process.cwd(),
    sandbox: asString2(flags["sandbox"]) ?? resolveDefault(ctx, "codex.default_sandbox") ?? void 0,
    approval: asString2(flags["approval"]) ?? resolveDefault(ctx, "codex.default_approval") ?? void 0,
    effort: asString2(flags["effort"]) ?? resolveDefault(ctx, "codex.default_effort") ?? void 0,
    profile: asString2(flags["profile"]) ?? void 0,
    base_instructions: asString2(flags["base-instructions"]) ?? void 0,
    developer_instructions: asString2(flags["developer-instructions"]) ?? void 0,
    experimental_tools: experimentalTools.length > 0 ? experimentalTools : void 0,
    created_at: now,
    last_active_at: now,
    turn_count: 0
  };
  ctx.sessions.add(user, record);
  ctx.users.touch(user);
  return { session: record };
};
var sessionAttach = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const takeover = isTrue2(flags["takeover"]);
  const lockThreadId = resolveAttachLockThreadId(ctx, identifier);
  const attach = async () => {
    const existing = ctx.sessions.get(user, identifier);
    if (existing) {
      ctx.sessions.touch(user, existing.name);
      return { session: existing, noop: true };
    }
    const anywhere = looksLikeThreadId(identifier) ? ctx.sessions.findLiveAnywhere(identifier) : ctx.sessions.findUniqueLiveByNameAnywhere(identifier);
    if (anywhere === "ambiguous") {
      throw invalidParams(`session name '${identifier}' is ambiguous across users; use a thread_id or attach within the owning user`);
    }
    if (anywhere && anywhere.user !== user) {
      if (!takeover) {
        throw new CodexTeamError("session_busy", `session is live under user '${anywhere.user}'. Pass --takeover to seize.`);
      }
      await seizeFromOtherUser(ctx, anywhere.user, user, anywhere.record);
    }
    const threadId = looksLikeThreadId(identifier) ? identifier : anywhere?.record.thread_id ?? null;
    if (!threadId) {
      throw new CodexTeamError("session_not_found", `no session matches '${identifier}' in this user`);
    }
    ensureAttachOwnership(ctx, user, threadId);
    const name = anywhere?.record.name ?? deriveNameFromThreadId(threadId, ctx, user);
    const experimentalTools = resolveExperimentalToolsForAttach(ctx, flags, anywhere?.record.experimental_tools);
    const sessionKey = keyFor(user, name);
    const client = await ctx.pool.acquire(user, sessionKey, buildExperimentalToolAppServerOptions(experimentalTools));
    let added = false;
    try {
      ensureAttachOwnership(ctx, user, threadId);
      await threadResume(client, threadId, ctx.retryOptions());
      ensureAttachOwnership(ctx, user, threadId);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const record = {
        name,
        thread_id: threadId,
        state: "live",
        created_at: now,
        last_active_at: now,
        turn_count: 0,
        ...anywhere?.record ? {
          model: anywhere.record.model,
          cwd: anywhere.record.cwd,
          sandbox: anywhere.record.sandbox,
          approval: anywhere.record.approval,
          effort: anywhere.record.effort,
          profile: anywhere.record.profile,
          experimental_tools: anywhere.record.experimental_tools
        } : {},
        ...experimentalTools.length > 0 ? { experimental_tools: experimentalTools } : {}
      };
      ctx.sessions.add(user, record);
      added = true;
      ctx.users.touch(user);
      return { session: record };
    } catch (e) {
      if (!added) ctx.pool.release(sessionKey);
      throw e;
    }
  };
  return lockThreadId ? await withAttachLock(lockThreadId, attach) : await attach();
};
var sessionDetach = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const graceful = isTrue2(flags["graceful"]);
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) {
    return { session: null, noop: true };
  }
  const sessionKey = keyFor(user, rec.name);
  const teardown = await ctx.queues.beginTeardown(sessionKey);
  const client = ctx.pool.clientForSession(sessionKey);
  const turnId = teardown.currentTurnId;
  if (client && !graceful && turnId) {
    try {
      await turnInterrupt(client, rec.thread_id, turnId, ctx.retryOptions());
    } catch {
    }
  }
  if (graceful) {
    await ctx.queues.waitForIdle(sessionKey);
  }
  if (client) {
    try {
      await threadUnsubscribe(client, rec.thread_id, ctx.retryOptions());
    } catch {
    }
  }
  ctx.pool.release(sessionKey);
  ctx.queues.dispose(sessionKey);
  ctx.sessions.remove(user, rec.name);
  for (const p of ctx.pending.removeForSession(user, rec.name)) {
    try {
      p.client.respondError(p.jsonrpc_id, -32e3, "session detached");
    } catch {
    }
  }
  return { session: rec, noop: false, graceful };
};
var sessionRename = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const newName = asPositional(req, 1, "new_name");
  validateSessionName(newName);
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);
  const oldName = rec.name;
  const client = ctx.pool.clientForSession(keyFor(user, oldName));
  if (client) {
    try {
      await threadSetName(client, rec.thread_id, newName, ctx.retryOptions());
    } catch {
    }
  }
  const updated = ctx.sessions.update(user, oldName, { name: newName });
  ctx.pool.rekeySession(keyFor(user, oldName), keyFor(user, newName));
  return { session: updated };
};
var sessionFork = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const newNameRaw = asPositionalOptional(req, 1);
  const flags = asFlags(req);
  const atTurn = asString2(flags["at-turn"]);
  const source = ctx.sessions.get(user, identifier);
  if (!source) throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);
  let newName = newNameRaw ?? generateSessionName();
  if (newNameRaw) validateSessionName(newNameRaw);
  while (ctx.sessions.get(user, newName)) newName = generateSessionName();
  const client = await ctx.pool.acquire(
    user,
    keyFor(user, newName),
    buildExperimentalToolAppServerOptions(source.experimental_tools ?? [])
  );
  let forkResult;
  try {
    forkResult = await threadFork(client, source.thread_id, atTurn ?? void 0, ctx.retryOptions());
  } catch (e) {
    ctx.pool.release(keyFor(user, newName));
    throw e;
  }
  const newThreadId = threadIdOf(forkResult);
  try {
    await threadSetName(client, newThreadId, newName, ctx.retryOptions());
  } catch {
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const record = {
    name: newName,
    thread_id: newThreadId,
    state: "live",
    model: source.model,
    cwd: source.cwd,
    sandbox: source.sandbox,
    approval: source.approval,
    effort: source.effort,
    profile: source.profile,
    experimental_tools: source.experimental_tools,
    created_at: now,
    last_active_at: now,
    turn_count: 0
  };
  ctx.sessions.add(user, record);
  return { session: record, forked_from: source.name, at_turn: atTurn };
};
var sessionInfo = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const rec = ctx.sessions.get(user, identifier);
  if (rec) {
    return { session: rec };
  }
  try {
    const client = await ctx.pool.acquireForAdhoc(user);
    const result = await threadRead(client, identifier, ctx.retryOptions());
    return { session: null, thread: result.thread, live: false };
  } catch (e) {
    throw new CodexTeamError("session_not_found", `session '${identifier}' not found: ${e.message}`);
  }
};
var sessionContext = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const format = asString2(flags["format"]) ?? "json";
  if (format !== "json" && format !== "markdown") {
    throw invalidParams(`--format must be 'json' or 'markdown'`);
  }
  const rec = ctx.sessions.get(user, identifier);
  let threadId;
  let client;
  if (rec) {
    threadId = rec.thread_id;
    client = ctx.pool.clientForSession(keyFor(user, rec.name));
    if (!client) client = await ctx.pool.acquireForAdhoc(user);
  } else {
    if (!looksLikeThreadId(identifier)) {
      throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);
    }
    threadId = identifier;
    client = await ctx.pool.acquireForAdhoc(user);
  }
  const result = await threadRead(client, threadId, ctx.retryOptions());
  if (format === "json") {
    return { thread_id: threadId, thread: result.thread };
  }
  const markdown = renderContext({
    session: rec?.name ?? null,
    thread_id: threadId,
    thread: result.thread
  });
  return {
    thread_id: threadId,
    format: "markdown",
    markdown,
    thread: result.thread
  };
};
var sessionList = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const flags = asFlags(req);
  const all = isTrue2(flags["all"]);
  const sortField = asString2(flags["sort"]) ?? "last_active";
  const format = asString2(flags["format"]) ?? "json";
  if (format !== "json" && format !== "table") {
    throw invalidParams(`--format must be 'json' or 'table'`);
  }
  if (!all) {
    const live = ctx.sessions.listLive(user);
    const sorted = sortSessions(live, sortField);
    const response2 = { sessions: sorted, all: false, sort: sortField, format };
    if (format === "table") {
      response2.table = renderTable2(
        sorted,
        ["name", "thread_id", "state", "model", "turn_count", "last_active_at"]
      );
    }
    return response2;
  }
  const client = await ctx.pool.acquireForAdhoc(user);
  const result = await threadList(client, {}, ctx.retryOptions());
  const response = {
    sessions: result.data,
    next_cursor: result.nextCursor,
    all: true,
    sort: sortField,
    format
  };
  if (format === "table") {
    response.table = renderTable2(
      result.data,
      ["id", "status", "preview", "cwd", "updated_at"]
    );
  }
  return response;
};
function requireUser(ctx, req) {
  const bearer = req.bearer;
  if (!bearer) throw invalidParams("bearer token required");
  if (!ctx.users.has(bearer)) {
    throw new CodexTeamError("user_not_found", `user '${bearer}' not found \u2014 run 'codex-team daemon user create ${bearer}'`);
  }
}
function asFlags(req) {
  const flags = req.params.flags;
  if (flags && typeof flags === "object") return flags;
  return {};
}
function asPositionals(req) {
  const p = req.params.positionals;
  return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
}
function asPositional(req, idx, name) {
  const positionals = asPositionals(req);
  const v = positionals[idx];
  if (typeof v !== "string" || v.length === 0) {
    throw invalidParams(`missing positional '${name}'`);
  }
  return v;
}
function asPositionalOptional(req, idx) {
  const positionals = asPositionals(req);
  const v = positionals[idx];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asString2(v) {
  if (Array.isArray(v)) return v[v.length - 1] ?? null;
  return typeof v === "string" ? v : null;
}
function isTrue2(v) {
  return v === true || v === "true" || v === "1";
}
async function buildThreadStartParams(ctx, flags, experimentalTools) {
  const p = {};
  const config = {};
  const model = asString2(flags["model"]) ?? resolveDefault(ctx, "codex.default_model");
  if (model) p.model = model;
  const cwd = asString2(flags["cwd"]) ?? process.cwd();
  if (cwd) p.cwd = cwd;
  const sandbox = asString2(flags["sandbox"]) ?? resolveDefault(ctx, "codex.default_sandbox");
  if (sandbox) p.sandbox = sandbox;
  const approval = asString2(flags["approval"]) ?? resolveDefault(ctx, "codex.default_approval");
  if (approval) p.approvalPolicy = approval;
  const effort = asString2(flags["effort"]) ?? resolveDefault(ctx, "codex.default_effort");
  if (effort) config.model_reasoning_effort = effort;
  const profile = asString2(flags["profile"]);
  if (profile) config.profile = profile;
  const baseInstr = await readInstructionFile(flags["base-instructions"], "--base-instructions");
  if (baseInstr) p.baseInstructions = baseInstr;
  const devInstr = await readInstructionFile(flags["developer-instructions"], "--developer-instructions");
  if (devInstr) p.developerInstructions = devInstr;
  const personality = asString2(flags["personality"]);
  if (personality) p.personality = personality;
  const experimentalConfig = buildExperimentalToolThreadConfig(experimentalTools);
  if (experimentalConfig) Object.assign(config, experimentalConfig);
  if (Object.keys(config).length > 0) p.config = config;
  return p;
}
function resolveDefault(ctx, key) {
  const v = ctx.config.getEffective(key);
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}
function resolveExperimentalToolsForCreate(ctx, flags) {
  if (hasFlag(flags, "experimental-tools")) return parseExperimentalTools(flags["experimental-tools"]);
  return parseExperimentalTools(resolveDefault(ctx, "experimental.default_tools"));
}
function resolveExperimentalToolsForAttach(ctx, flags, inherited) {
  if (hasFlag(flags, "experimental-tools")) return parseExperimentalTools(flags["experimental-tools"]);
  if (inherited && inherited.length > 0) return [...inherited];
  return parseExperimentalTools(resolveDefault(ctx, "experimental.default_tools"));
}
function keyFor(user, name) {
  return `${user}::${name}`;
}
function hasFlag(flags, key) {
  return Object.prototype.hasOwnProperty.call(flags, key);
}
function deriveNameFromThreadId(threadId, ctx, user) {
  const existing = ctx.sessions.get(user, threadId);
  if (existing) return existing.name;
  const tail = threadId.replace(/^th-/, "").replace(/-/g, "").slice(0, 8) || "x";
  let candidate = `s-${tail}`;
  while (ctx.sessions.get(user, candidate)) candidate = generateSessionName();
  return candidate;
}
function resolveAttachLockThreadId(ctx, identifier) {
  if (looksLikeThreadId(identifier)) return identifier;
  const anywhere = ctx.sessions.findUniqueLiveByNameAnywhere(identifier);
  if (anywhere === "ambiguous") {
    throw invalidParams(`session name '${identifier}' is ambiguous across users; use a thread_id or attach within the owning user`);
  }
  return anywhere?.record.thread_id ?? null;
}
function ensureAttachOwnership(ctx, user, threadId) {
  const owner = ctx.sessions.findLiveAnywhere(threadId);
  if (owner && owner.user !== user) {
    throw new CodexTeamError("session_busy", `thread '${threadId}' is live under user '${owner.user}'`);
  }
}
async function withAttachLock(threadId, fn) {
  const prev = attachLocks.get(threadId) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => next);
  attachLocks.set(threadId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (attachLocks.get(threadId) === tail) attachLocks.delete(threadId);
  }
}
async function readInstructionFile(value, flag) {
  const filePath = asString2(value);
  if (!filePath) return null;
  try {
    return await import_node_fs11.default.promises.readFile(filePath, "utf8");
  } catch (e) {
    throw invalidParams(`${flag} not readable: ${e.message}`);
  }
}
async function seizeFromOtherUser(ctx, fromUser, toUser, rec) {
  const sessionKey = keyFor(fromUser, rec.name);
  const teardown = await ctx.queues.beginTeardown(sessionKey);
  const client = ctx.pool.clientForSession(sessionKey);
  const turnId = teardown.currentTurnId;
  if (client) {
    if (turnId) {
      try {
        await turnInterrupt(client, rec.thread_id, turnId, ctx.retryOptions());
      } catch {
      }
    }
    try {
      await threadUnsubscribe(client, rec.thread_id, ctx.retryOptions());
    } catch {
    }
  }
  ctx.pool.release(sessionKey);
  ctx.queues.dispose(sessionKey);
  ctx.sessions.remove(fromUser, rec.name);
  for (const p of ctx.pending.removeForSession(fromUser, rec.name)) {
    try {
      p.client.respondError(p.jsonrpc_id, -32e3, "session seized by another user");
    } catch {
    }
  }
  await ctx.events.append(fromUser, {
    type: "session.seized",
    session: rec.name,
    thread_id: rec.thread_id,
    payload: { seized_by: toUser }
  });
}
function sortSessions(rows, field) {
  const f = (/* @__PURE__ */ new Set(["name", "last_active", "turn_count", "created_at"])).has(field) ? field : "last_active";
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = a[f === "last_active" ? "last_active_at" : f === "created_at" ? "created_at" : f];
    const bv = b[f === "last_active" ? "last_active_at" : f === "created_at" ? "created_at" : f];
    if (typeof av === "string" && typeof bv === "string") return bv.localeCompare(av);
    if (typeof av === "number" && typeof bv === "number") return bv - av;
    return 0;
  });
  return copy;
}

// src/daemon/handlers/message.ts
var import_node_fs12 = __toESM(require("fs"));
var messageSend = async (ctx, req) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const prompt = await readPromptInput(req);
  const attachments = asStringArray(getFlag2(req, "attach"));
  const input = await buildUserInput(prompt, attachments);
  const sessionKey = keyFor2(user, rec.name);
  const result = await ctx.queues.sendOrQueue(sessionKey, client, rec.thread_id, input, ctx.retryOptions());
  ctx.sessions.touch(user, rec.name);
  return {
    session: rec.name,
    thread_id: rec.thread_id,
    turn_id: result.turn_id,
    started: result.started,
    queue_id: result.queue_id,
    queued_depth: result.queued_depth
  };
};
var messagePeer = async (ctx, req) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const prompt = await readPromptInput(req);
  const attachments = asStringArray(getFlag2(req, "attach"));
  const input = await buildUserInput(prompt, attachments);
  const sessionKey = keyFor2(user, rec.name);
  const turnId = ctx.queues.getCurrentTurn(sessionKey);
  if (!turnId) {
    throw new CodexTeamError("invalid_params", "no active turn to peer into; use 'message send' instead");
  }
  await turnSteer(client, rec.thread_id, turnId, input, ctx.retryOptions());
  ctx.sessions.touch(user, rec.name);
  return { session: rec.name, turn_id: turnId, peered: true };
};
var messageInterrupt = async (ctx, req) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const sessionKey = keyFor2(user, rec.name);
  const turnId = ctx.queues.getCurrentTurn(sessionKey);
  if (!turnId) {
    return { session: rec.name, turn_id: null, interrupted: false, noop: true };
  }
  await turnInterrupt(client, rec.thread_id, turnId, ctx.retryOptions());
  ctx.queues.setCurrentTurn(sessionKey, null);
  ctx.sessions.touch(user, rec.name);
  return { session: rec.name, turn_id: turnId, interrupted: true };
};
var messageApproval = async (ctx, req) => {
  const { user, rec } = await resolveLive(ctx, req);
  const requestId = asPositional2(req, 1, "request_id");
  const shortcut = asPositionalOptional2(req, 2);
  const pending = requirePending(ctx, user, requestId);
  if (!pending.kind.startsWith("approval.")) {
    throw new CodexTeamError("invalid_decision", `request '${requestId}' is not an approval (kind=${pending.kind})`);
  }
  const claimed = claimPending(ctx, user, requestId);
  let response;
  try {
    response = await buildResponse(req, claimed, shortcut);
  } catch (e) {
    ctx.pending.releaseClaim(requestId);
    throw e;
  }
  try {
    const ack = await claimed.client.respondAck(claimed.jsonrpc_id, response);
    ctx.pending.markResponded(requestId);
    if (ack.backpressured) {
      emitPendingWarning(ctx, user, rec.name, rec.thread_id, {
        message: "approval reply is delayed by app-server stdin backpressure",
        kind: "approval_reply_backpressured",
        request_id: requestId
      });
    }
  } catch (err2) {
    ctx.pending.remove(requestId);
    emitPendingWarning(ctx, user, rec.name, rec.thread_id, {
      message: `approval reply delivery failed: ${err2.message}`,
      kind: "approval_reply_delivery_failed",
      request_id: requestId
    });
    throw err2;
  }
  return {
    session: rec.name,
    request_id: requestId,
    kind: claimed.kind,
    responded: true,
    response
  };
};
var messageAnswer = async (ctx, req) => {
  const { user, rec } = await resolveLive(ctx, req);
  const requestId = asPositional2(req, 1, "request_id");
  const inline = asPositionalOptional2(req, 2);
  const pending = requirePending(ctx, user, requestId);
  if (pending.kind !== "user_input.request") {
    throw new CodexTeamError("invalid_decision", `request '${requestId}' is not a user_input request (kind=${pending.kind})`);
  }
  const claimed = claimPending(ctx, user, requestId);
  let response;
  try {
    response = await buildAnswerResponse(req, claimed, inline);
  } catch (e) {
    ctx.pending.releaseClaim(requestId);
    throw e;
  }
  try {
    const ack = await claimed.client.respondAck(claimed.jsonrpc_id, response);
    ctx.pending.markResponded(requestId);
    if (ack.backpressured) {
      emitPendingWarning(ctx, user, rec.name, rec.thread_id, {
        message: "user_input reply is delayed by app-server stdin backpressure",
        kind: "user_input_reply_backpressured",
        request_id: requestId
      });
    }
  } catch (err2) {
    ctx.pending.remove(requestId);
    emitPendingWarning(ctx, user, rec.name, rec.thread_id, {
      message: `user_input reply delivery failed: ${err2.message}`,
      kind: "user_input_reply_delivery_failed",
      request_id: requestId
    });
    throw err2;
  }
  return { session: rec.name, request_id: requestId, responded: true, response };
};
var messageHistory = async (ctx, req) => {
  const { rec, client } = await resolveLive(ctx, req);
  const limitRaw = getFlag2(req, "limit");
  const limit = typeof limitRaw === "string" ? parseInt(limitRaw, 10) : typeof limitRaw === "number" ? limitRaw : 50;
  const sinceRaw = asString3(getFlag2(req, "since"));
  const format = asString3(getFlag2(req, "format")) ?? "json";
  if (format !== "json" && format !== "markdown") throw invalidParams("--format must be json or markdown");
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
  const relativeSince = sinceRaw && /^-\d+$/.test(sinceRaw) ? Math.max(1, Math.floor(Math.abs(Number(sinceRaw)))) : null;
  const result = relativeSince ? await listTurnsFromRelativeOffset(client, rec.thread_id, relativeSince, safeLimit, ctx.retryOptions()) : await threadTurnsList(client, rec.thread_id, {
    limit: safeLimit,
    cursor: sinceRaw ?? void 0,
    sortDirection: "desc"
  }, ctx.retryOptions());
  const response = {
    session: rec.name,
    thread_id: rec.thread_id,
    turns: result.data,
    next_cursor: result.nextCursor,
    format,
    note: "Turn items are not included in turnsList responses (protocol limitation). Use 'session context' for per-thread metadata."
  };
  if (relativeSince) response.relative_since = relativeSince;
  if (format === "markdown") {
    response.markdown = renderHistory({
      session: rec.name,
      thread_id: rec.thread_id,
      turns: result.data,
      nextCursor: result.nextCursor
    });
  }
  return response;
};
var messageTail = async (ctx, req, stream) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const nRaw = getFlag2(req, "n");
  const n = typeof nRaw === "string" ? parseInt(nRaw, 10) : typeof nRaw === "number" ? nRaw : 3;
  const format = asString3(getFlag2(req, "format")) ?? "json";
  if (format !== "json" && format !== "markdown") throw invalidParams("--format must be json or markdown");
  const follow = isTrue3(getFlag2(req, "follow")) || isTrue3(getFlag2(req, "f"));
  const snapshot = async () => {
    const result = await threadTurnsList(client, rec.thread_id, {
      limit: Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 3,
      sortDirection: "desc"
    }, ctx.retryOptions());
    const thread = await threadRead(client, rec.thread_id, ctx.retryOptions()).catch(() => null);
    const response = {
      session: rec.name,
      turns: result.data,
      format,
      follow,
      thread: thread?.thread ?? null
    };
    if (format === "markdown") {
      response.markdown = renderTail({
        session: rec.name,
        thread_id: rec.thread_id,
        turns: result.data,
        thread: thread?.thread ?? null,
        follow
      });
    }
    return response;
  };
  if (!follow || !stream) {
    return await snapshot();
  }
  stream.chunk(await snapshot());
  const sub = ctx.events.subscribe(user, (e) => {
    if (e.session !== rec.name) return;
    if (e.type !== "turn.completed") return;
    void snapshot().then((snap) => stream.chunk(snap)).catch(() => {
    });
  });
  stream.onClose(() => sub.dispose());
  return { streaming: true };
};
async function resolveLive(ctx, req) {
  const user = req.bearer;
  if (!user) throw invalidParams("bearer token required");
  if (!ctx.users.has(user)) {
    throw new CodexTeamError("user_not_found", `user '${user}' not found`);
  }
  const identifier = asPositional2(req, 0, "session");
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) {
    throw new CodexTeamError("session_not_found", `session '${identifier}' not live in this user`);
  }
  const client = ctx.pool.clientForSession(keyFor2(user, rec.name));
  if (!client) {
    const fresh = await ctx.pool.acquire(
      user,
      keyFor2(user, rec.name),
      buildExperimentalToolAppServerOptions(rec.experimental_tools ?? [])
    );
    return { user, rec, client: fresh };
  }
  return { user, rec, client };
}
function requirePending(ctx, user, requestId) {
  const p = ctx.pending.get(requestId);
  if (!p) throw new CodexTeamError("invalid_params", `no pending request '${requestId}'`);
  if (p.user !== user) throw new CodexTeamError("invalid_params", `pending request '${requestId}' belongs to another user`);
  return p;
}
function claimPending(ctx, user, requestId) {
  const claimed = ctx.pending.claim(requestId, user);
  if (!claimed) throw new CodexTeamError("invalid_params", `no pending request '${requestId}'`);
  return claimed;
}
function emitPendingWarning(ctx, user, session, threadId, payload) {
  void ctx.events.append(user, {
    type: "warning",
    session,
    thread_id: threadId,
    payload
  }).catch(() => void 0);
}
async function readPromptInput(req) {
  const positional = asPositionalOptional2(req, 1);
  const fromFile = asString3(getFlag2(req, "file"));
  const fromStdin = isTrue3(getFlag2(req, "stdin"));
  const sources = [positional, fromFile, fromStdin].filter((v) => v !== null && v !== false).length;
  if (sources === 0) {
    throw invalidParams("prompt is required: positional text, --file <path>, or --stdin");
  }
  if (sources > 1) {
    throw invalidParams("prompt is ambiguous: supply exactly one of positional, --file, --stdin");
  }
  if (positional) return positional;
  if (fromFile) {
    try {
      return await import_node_fs12.default.promises.readFile(fromFile, "utf8");
    } catch (e) {
      throw invalidParams(`--file not readable: ${e.message}`);
    }
  }
  const stdinContent = asString3(req.params.stdin_content);
  if (stdinContent === null) throw invalidParams("--stdin requested but no content forwarded from cli");
  return stdinContent;
}
async function readJsonInput(req) {
  const jsonRaw = asString3(getFlag2(req, "json"));
  const fromFile = asString3(getFlag2(req, "file"));
  const fromStdin = isTrue3(getFlag2(req, "stdin"));
  const sources = [jsonRaw, fromFile, fromStdin].filter((v) => v !== null && v !== false).length;
  if (sources === 0) return null;
  if (sources > 1) throw invalidParams("json payload ambiguous: supply exactly one of --json, --file, --stdin");
  let raw;
  if (jsonRaw) raw = jsonRaw;
  else if (fromFile) {
    try {
      raw = await import_node_fs12.default.promises.readFile(fromFile, "utf8");
    } catch (e) {
      throw invalidParams(`--file not readable: ${e.message}`);
    }
  } else {
    const stdinContent = asString3(req.params.stdin_content);
    if (stdinContent === null) throw invalidParams("--stdin requested but no content forwarded from cli");
    raw = stdinContent;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw invalidParams(`invalid JSON payload: ${e.message}`);
  }
}
async function buildUserInput(text, attachments) {
  const items = [{ type: "text", text }];
  for (const path12 of attachments) {
    await assertAttachable(path12);
    items.push({ type: "localImage", path: path12 });
  }
  return items;
}
async function buildResponse(req, pending, shortcut) {
  const explicit = await readJsonInput(req);
  if (explicit) {
    if (shortcut) throw invalidParams("cannot combine shortcut and --json/--file/--stdin");
    return explicit;
  }
  if (!shortcut) throw invalidParams("supply a shortcut (accept|accept-session|decline|cancel) or --json/--file/--stdin");
  switch (pending.kind) {
    case "approval.command_execution":
    case "approval.file_change":
      return { decision: commandOrFileShortcut(shortcut, pending.kind) };
    case "approval.permissions":
      return permissionsShortcut(shortcut, pending.raw);
    case "approval.mcp_elicitation":
      return mcpElicitationShortcut(shortcut, pending.raw);
    default:
      throw new CodexTeamError("invalid_decision", `unknown approval kind '${pending.kind}'`);
  }
}
function commandOrFileShortcut(shortcut, kind) {
  if (shortcut === "accept") return "accept";
  if (shortcut === "accept-session") return "acceptForSession";
  if (shortcut === "decline") return "decline";
  if (shortcut === "cancel") return "cancel";
  throw new CodexTeamError("invalid_decision", `shortcut '${shortcut}' not allowed for ${kind}`);
}
function permissionsShortcut(shortcut, raw) {
  const requested = raw.permissions ?? {};
  if (shortcut === "accept") return { permissions: requested, scope: "turn" };
  if (shortcut === "accept-session") return { permissions: requested, scope: "session" };
  if (shortcut === "decline") return { permissions: {}, scope: "turn" };
  throw new CodexTeamError("invalid_decision", `shortcut '${shortcut}' not allowed for approval.permissions (cancel not supported)`);
}
function mcpElicitationShortcut(shortcut, raw) {
  const mode = raw.mode;
  if (shortcut === "accept") {
    if (mode === "form") {
      throw new CodexTeamError("invalid_decision", "mcp_elicitation form mode requires --json with content");
    }
    return { action: "accept", content: null, _meta: null };
  }
  if (shortcut === "decline") return { action: "decline", content: null, _meta: null };
  if (shortcut === "cancel") return { action: "cancel", content: null, _meta: null };
  throw new CodexTeamError("invalid_decision", `shortcut '${shortcut}' not allowed for approval.mcp_elicitation`);
}
async function buildAnswerResponse(req, pending, inline) {
  const explicit = await readJsonInput(req);
  if (explicit) {
    if (inline) throw invalidParams("cannot combine positional answer and --json/--file/--stdin");
    return explicit;
  }
  if (!inline) throw invalidParams("supply inline answer, --json, --file, or --stdin");
  const questions = Array.isArray(pending.raw.questions) ? pending.raw.questions : [];
  if (questions.length !== 1) {
    throw invalidParams(`inline answer only supported when request has exactly one question (got ${questions.length})`);
  }
  const q = questions[0];
  if (!q.id) throw new CodexTeamError("internal", "pending question missing id");
  return { answers: { [q.id]: { answers: [inline] } } };
}
function keyFor2(user, name) {
  return `${user}::${name}`;
}
function getFlag2(req, key) {
  const flags = req.params.flags;
  if (flags && typeof flags === "object") return flags[key];
  return void 0;
}
function asPositional2(req, idx, name) {
  const positionals = req.params.positionals;
  const list = Array.isArray(positionals) ? positionals : [];
  const v = list[idx];
  if (typeof v !== "string" || v.length === 0) throw invalidParams(`missing positional '${name}'`);
  return v;
}
function asPositionalOptional2(req, idx) {
  const positionals = req.params.positionals;
  const list = Array.isArray(positionals) ? positionals : [];
  const v = list[idx];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asString3(v) {
  if (Array.isArray(v)) {
    const last = v[v.length - 1];
    return typeof last === "string" ? last : null;
  }
  return typeof v === "string" ? v : null;
}
function asStringArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}
function isTrue3(v) {
  return v === true || v === "true" || v === "1";
}
async function assertAttachable(filePath) {
  let stat;
  try {
    stat = await import_node_fs12.default.promises.stat(filePath);
  } catch (e) {
    throw invalidParams(`--attach not readable: ${filePath}: ${e.message}`);
  }
  if (!stat.isFile()) {
    throw invalidParams(`--attach must point to a file: ${filePath}`);
  }
  if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath)) {
    throw invalidParams(`--attach currently supports image files only: ${filePath}`);
  }
}
async function listTurnsFromRelativeOffset(client, threadId, relativeSince, limit, retry) {
  const skip = Math.max(0, relativeSince - 1);
  let remainingSkip = skip;
  let cursor;
  const data = [];
  let nextCursor = null;
  while (data.length < limit) {
    const pageSize = Math.max(limit - data.length, Math.min(100, remainingSkip + limit - data.length));
    const page = await threadTurnsList(client, threadId, {
      limit: Math.max(1, pageSize),
      cursor,
      sortDirection: "desc"
    }, retry);
    if (page.data.length === 0) {
      nextCursor = null;
      break;
    }
    if (remainingSkip >= page.data.length) {
      remainingSkip -= page.data.length;
      cursor = page.nextCursor ?? void 0;
      nextCursor = page.nextCursor ?? null;
      if (!cursor) break;
      continue;
    }
    const visible = page.data.slice(remainingSkip);
    remainingSkip = 0;
    const take = visible.slice(0, limit - data.length);
    data.push(...take);
    if (take.length < visible.length) {
      nextCursor = null;
      break;
    }
    nextCursor = page.nextCursor ?? null;
    cursor = page.nextCursor ?? void 0;
    if (!cursor) break;
  }
  return { data, nextCursor };
}

// src/daemon/handlers/monitor.ts
var import_node_child_process5 = require("child_process");
var MAX_INTERVAL_QUEUE_EVENTS = 512;
var MAX_INTERVAL_QUEUE_BYTES = 512 * 1024;
var MAX_FLUSH_EVENTS_PER_TICK = 64;
var monitorEvents = async (ctx, req, stream) => {
  if (!stream) throw new CodexTeamError("internal", "monitor events requires streaming");
  const user = req.bearer;
  if (!user) throw invalidParams("-b required");
  if (!ctx.users.has(user)) {
    throw new CodexTeamError("user_not_found", `user '${user}' not found`);
  }
  const flags = asFlags2(req);
  const streamMode = isTrue4(flags["stream"]);
  const intervalGiven = flags["interval"] !== void 0;
  if (streamMode && intervalGiven) throw invalidParams("--stream and --interval are mutually exclusive");
  const intervalDefault = numConfig(ctx, "monitor.default_interval_seconds", 30);
  const intervalS = intervalGiven ? toInt4(flags["interval"], intervalDefault) : intervalDefault;
  if (intervalS <= 0 && !streamMode) throw invalidParams("--interval must be > 0");
  const includeDelta = isTrue4(flags["include-delta"]);
  const filterTypes = parseTypeList(flags["filter"]);
  const excludeTypes = parseTypeList(flags["exclude"]);
  const sinceId = asString4(flags["since"]);
  const sessionFilter = asString4(flags["session"]);
  const accept = (e) => {
    if (!includeDelta && isDeltaType(e.type)) return false;
    if (filterTypes && filterTypes.length > 0 && !filterTypes.includes(e.type)) return false;
    if (excludeTypes && excludeTypes.length > 0 && excludeTypes.includes(e.type)) return false;
    if (sessionFilter) {
      const match = e.session === sessionFilter || e.thread_id === sessionFilter;
      if (!match) return false;
    }
    return true;
  };
  const backlog = await ctx.events.listSince(user, sinceId, { includeDelta: true });
  if (!backlog.ok) {
    if (backlog.reason === "id_rotated") {
      stream.end(new CodexTeamError("id_rotated", `event '${sinceId}' has been rotated out`, {
        oldest_available_id: backlog.oldest_available_id
      }));
    } else {
      stream.end(invalidParams(`event '${sinceId}' not found`));
    }
    return { streaming: true };
  }
  const initialEvents = backlog.events.filter(accept);
  const queue = streamMode ? [...initialEvents] : [];
  let queueBytes = 0;
  let overflowDropped = 0;
  let overflowDroppedBytes = 0;
  let overflowSeq = 0;
  const enqueueIntervalEvent = (event) => {
    queue.push(event);
    queueBytes += eventSize(event);
    while (queue.length > MAX_INTERVAL_QUEUE_EVENTS || queueBytes > MAX_INTERVAL_QUEUE_BYTES) {
      const dropped = queue.shift();
      if (!dropped) break;
      overflowDropped++;
      const droppedBytes = eventSize(dropped);
      overflowDroppedBytes += droppedBytes;
      queueBytes = Math.max(0, queueBytes - droppedBytes);
    }
  };
  const takeOverflowEvent = () => {
    if (overflowDropped === 0) return null;
    const event = {
      id: `monitor-overflow-${++overflowSeq}`,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      type: "monitor.overflow",
      session: sessionFilter ?? null,
      thread_id: null,
      payload: {
        dropped_count: overflowDropped,
        dropped_bytes: overflowDroppedBytes,
        limit_events: MAX_INTERVAL_QUEUE_EVENTS,
        limit_bytes: MAX_INTERVAL_QUEUE_BYTES
      }
    };
    overflowDropped = 0;
    overflowDroppedBytes = 0;
    return event;
  };
  if (!streamMode) {
    for (const event of initialEvents) enqueueIntervalEvent(event);
  }
  if (streamMode) {
    for (const e of queue) stream.chunk(e);
    queue.length = 0;
    const sub2 = ctx.events.subscribe(user, (e) => {
      if (accept(e)) stream.chunk(e);
    });
    stream.onClose(() => sub2.dispose());
    return { streaming: true };
  }
  const sub = ctx.events.subscribe(user, (e) => {
    if (accept(e)) enqueueIntervalEvent(e);
  });
  let closed = false;
  let draining = false;
  let drainTimer = null;
  const scheduleDrain = (delayMs) => {
    if (closed || drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drainQueue();
    }, delayMs);
    drainTimer.unref();
  };
  const drainQueue = () => {
    if (closed || draining) return;
    draining = true;
    const overflowEvent = takeOverflowEvent();
    if (overflowEvent) stream.chunk(overflowEvent);
    const batch = queue.splice(0, MAX_FLUSH_EVENTS_PER_TICK);
    for (const event of batch) {
      queueBytes = Math.max(0, queueBytes - eventSize(event));
      stream.chunk(event);
    }
    draining = false;
    if (overflowDropped > 0 || queue.length > 0) scheduleDrain(1);
  };
  const timer = setInterval(() => {
    if (overflowDropped === 0 && queue.length === 0) return;
    scheduleDrain(0);
  }, intervalS * 1e3);
  if (overflowDropped > 0 || queue.length > 0) {
    scheduleDrain(0);
  }
  stream.onClose(() => {
    closed = true;
    clearInterval(timer);
    if (drainTimer) clearTimeout(drainTimer);
    sub.dispose();
  });
  return { streaming: true };
};
var monitorAlarm = async (_ctx, req, stream) => {
  if (!stream) throw new CodexTeamError("internal", "monitor alarm requires streaming");
  const positionals = asPositionals2(req);
  const intervalS = toInt4(positionals[0], 0);
  if (intervalS <= 0) throw invalidParams("first positional must be interval seconds (positive integer)");
  const command = positionals[1];
  if (!command) throw invalidParams("missing command string");
  const flags = asFlags2(req);
  const once = isTrue4(flags["once"]);
  const timeoutS = toInt4(flags["timeout"], 60);
  let cancelled = false;
  let running = false;
  let timer = null;
  let activeChild = null;
  let activeTimeoutTimer = null;
  let activeKillHardTimer = null;
  let activeTimedOut = false;
  stream.onClose(() => {
    cancelled = true;
    if (timer) clearInterval(timer);
    requestActiveChildShutdown();
  });
  const runOnce = async () => {
    if (cancelled || running) return;
    running = true;
    const start = Date.now();
    try {
      await new Promise((resolve) => {
        const { file, args } = shellCommand(command);
        const child = (0, import_node_child_process5.spawn)(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        activeChild = child;
        activeTimedOut = false;
        let stdoutBuf = "";
        let stderrBuf = "";
        const timeoutTimer = setTimeout(() => {
          activeTimedOut = true;
          clearActiveTimeoutTimer();
          requestChildShutdown(child);
        }, timeoutS * 1e3);
        timeoutTimer.unref();
        activeTimeoutTimer = timeoutTimer;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (c) => {
          stdoutBuf += c;
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (c) => {
          stderrBuf += c;
        });
        child.on("error", (err2) => {
          clearActiveKillTimers();
          if (activeChild === child) activeChild = null;
          if (!cancelled) stream.chunk({ __alarm_event: "spawn_error", error: err2.message });
          resolve();
        });
        child.on("exit", (code, signal) => {
          clearActiveKillTimers();
          if (activeChild === child) activeChild = null;
          if (!cancelled) {
            if (stdoutBuf) stream.chunk({ stdout: stdoutBuf });
            if (stderrBuf) stream.chunk({ stderr: stderrBuf });
            stream.chunk({
              __alarm_event: activeTimedOut ? "timeout" : "exit",
              exit_code: code,
              signal,
              duration_ms: Date.now() - start
            });
          }
          resolve();
        });
      });
    } finally {
      running = false;
    }
  };
  await runOnce();
  if (once || cancelled) {
    if (!cancelled) stream.end();
    return { streaming: true };
  }
  timer = setInterval(() => {
    void runOnce();
  }, intervalS * 1e3);
  return { streaming: true };
  function clearActiveKillTimers() {
    clearActiveTimeoutTimer();
    clearActiveHardKillTimer();
  }
  function clearActiveTimeoutTimer() {
    if (activeTimeoutTimer) {
      clearTimeout(activeTimeoutTimer);
      activeTimeoutTimer = null;
    }
  }
  function clearActiveHardKillTimer() {
    if (activeKillHardTimer) {
      clearTimeout(activeKillHardTimer);
      activeKillHardTimer = null;
    }
  }
  function requestActiveChildShutdown() {
    const child = activeChild;
    if (!child) return;
    requestChildShutdown(child);
  }
  function requestChildShutdown(child) {
    if (activeChild !== child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin?.end();
    } catch {
    }
    scheduleHardKill(child, 5e3);
    if (process.platform === "win32") return;
    try {
      child.kill("SIGTERM");
    } catch {
    }
  }
  function scheduleHardKill(child, delayMs) {
    clearActiveHardKillTimer();
    activeKillHardTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === "win32") child.kill();
        else child.kill("SIGKILL");
      } catch {
      }
    }, delayMs);
    activeKillHardTimer.unref();
  }
};
function shellCommand(command) {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command]
    };
  }
  return {
    file: process.env.SHELL || "sh",
    args: ["-c", command]
  };
}
function asFlags2(req) {
  const f = req.params.flags;
  return f && typeof f === "object" ? f : {};
}
function asPositionals2(req) {
  const p = req.params.positionals;
  return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
}
function isTrue4(v) {
  return v === true || v === "true" || v === "1";
}
function asString4(v) {
  if (Array.isArray(v)) {
    const last = v[v.length - 1];
    return typeof last === "string" ? last : null;
  }
  return typeof v === "string" ? v : null;
}
function toInt4(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return fallback;
}
function parseTypeList(v) {
  const s = asString4(v);
  if (!s) return null;
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function numConfig(ctx, key, fallback) {
  const v = ctx.config.getEffective(key);
  return typeof v === "number" ? v : fallback;
}
function eventSize(event) {
  return Buffer.byteLength(JSON.stringify(event));
}

// src/daemon/dispatch.ts
var HANDLERS = {
  "version": version,
  "status": status,
  "daemon:status": daemonStatus,
  "daemon:start": daemonStart,
  "daemon:stop": daemonStop,
  "daemon:restart": daemonRestart,
  "daemon:logs": daemonLogsStream,
  "daemon:user:create": daemonUserCreate,
  "daemon:user:destroy": daemonUserDestroy,
  "daemon:user:list": daemonUserList,
  "daemon:config:get": daemonConfigGet,
  "daemon:config:set": daemonConfigSet,
  "daemon:config:unset": daemonConfigUnset,
  "daemon:config:list": daemonConfigList,
  "daemon:config:reset": daemonConfigReset,
  "session:new": sessionNew,
  "session:attach": sessionAttach,
  "session:detach": sessionDetach,
  "session:fork": sessionFork,
  "session:rename": sessionRename,
  "session:info": sessionInfo,
  "session:context": sessionContext,
  "session:list": sessionList,
  "message:send": messageSend,
  "message:peer": messagePeer,
  "message:interrupt": messageInterrupt,
  "message:approval": messageApproval,
  "message:answer": messageAnswer,
  "message:history": messageHistory,
  "message:tail": messageTail,
  "monitor:events": monitorEvents,
  "monitor:alarm": monitorAlarm
};
function getHandler(method) {
  const h = HANDLERS[method];
  if (!h) throw methodNotFound(method);
  return h;
}

// src/daemon/server.ts
var MAX_STREAM_QUEUE_BYTES = 1024 * 1024;
var MAX_STREAM_QUEUE_MESSAGES = 1024;
async function startServer(ctx) {
  const server = await listenSock(ctx.sockPath);
  server.on("connection", (socket) => handleConnection(ctx, socket));
  logger.info("daemon listening", { sock: ctx.sockPath });
  return server;
}
function handleConnection(ctx, socket) {
  const closeCallbacks = /* @__PURE__ */ new Set();
  onMessages(
    socket,
    async (msg) => {
      if (msg.kind !== "request") return;
      try {
        await handleRequest(ctx, socket, msg, closeCallbacks);
      } catch (e) {
        sendError(socket, msg.id, e);
      }
    },
    () => {
      for (const cb of closeCallbacks) {
        try {
          cb();
        } catch {
        }
      }
      closeCallbacks.clear();
    }
  );
  socket.on("error", (e) => {
    logger.debug("socket error", { err: e.message });
  });
}
async function handleRequest(ctx, socket, req, closeCallbacks) {
  ctx.activity.touch();
  const handler = getHandler(req.method);
  const streaming = req.params?.streaming === true;
  if (streaming) {
    const stream = createStreamHandle(socket, req.id, closeCallbacks);
    try {
      await handler(ctx, req, stream);
    } catch (e) {
      stream.end(toCodexTeamError(e));
    }
    return;
  }
  const result = await handler(ctx, req);
  const resp = {
    kind: "response",
    id: req.id,
    result
  };
  writeMessage(socket, resp);
}
function createStreamHandle(socket, id, closeCallbacks) {
  let ended = false;
  let blocked = false;
  let queuedBytes = 0;
  const queuedFrames = [];
  const flushQueued = () => {
    while (queuedFrames.length > 0) {
      const frame = queuedFrames[0];
      if (!socket.write(frame)) {
        blocked = true;
        return;
      }
      queuedFrames.shift();
      queuedBytes = Math.max(0, queuedBytes - Buffer.byteLength(frame));
    }
    blocked = false;
  };
  const onDrain = () => flushQueued();
  socket.on("drain", onDrain);
  closeCallbacks.add(() => socket.off("drain", onDrain));
  const enqueueFrame = (frame) => {
    if (ended) return;
    if (!blocked && queuedFrames.length === 0) {
      if (!socket.write(frame)) {
        blocked = true;
      }
      return;
    }
    queuedFrames.push(frame);
    queuedBytes += Buffer.byteLength(frame);
    if (queuedFrames.length > MAX_STREAM_QUEUE_MESSAGES || queuedBytes > MAX_STREAM_QUEUE_BYTES) {
      queuedFrames.length = 0;
      queuedBytes = 0;
      ended = true;
      const msg = {
        kind: "stream_end",
        id,
        error: {
          code: "internal",
          message: "stream consumer too slow"
        }
      };
      writeMessage(socket, msg);
      try {
        socket.end();
      } catch {
      }
      return;
    }
    flushQueued();
  };
  return {
    chunk(data) {
      if (ended) return;
      const msg = { kind: "stream_chunk", id, data };
      enqueueFrame(JSON.stringify(msg) + "\n");
    },
    end(error) {
      if (ended) return;
      ended = true;
      const msg = { kind: "stream_end", id };
      if (error) {
        msg.error = { code: error.code, message: error.message, ...error.data !== void 0 ? { data: error.data } : {} };
      }
      if (queuedFrames.length > 0) {
        const frame = JSON.stringify(msg) + "\n";
        queuedFrames.push(frame);
        queuedBytes += Buffer.byteLength(frame);
        flushQueued();
        return;
      }
      writeMessage(socket, msg);
    },
    onClose(cb) {
      closeCallbacks.add(cb);
    }
  };
}
function sendError(socket, id, e) {
  const err2 = toCodexTeamError(e);
  const resp = {
    kind: "response",
    id,
    error: {
      code: err2.code,
      message: err2.message,
      ...err2.data !== void 0 ? { data: err2.data } : {}
    }
  };
  writeMessage(socket, resp);
}
function toCodexTeamError(e) {
  if (e instanceof CodexTeamError) return e;
  if (e instanceof JsonRpcError) {
    return new CodexTeamError("codex_error", e.rpcMessage, {
      rpc_code: e.code,
      rpc_message: e.rpcMessage,
      codex_error_info: e.codexErrorInfo,
      additional_details: e.additionalDetails
    });
  }
  if (e instanceof Error) return new CodexTeamError("internal", e.message);
  return new CodexTeamError("internal", String(e));
}

// src/daemon/normalize.ts
var NOTIF_MAP = {
  "turn/started": "turn.started",
  "turn/completed": "turn.completed",
  "error": "turn.error",
  "item/started": "item.started",
  "item/completed": "item.completed",
  "item/mcpToolCall/progress": "item.mcp_tool_call_progress",
  "item/fileChange/patchUpdated": "item.file_change_patch_updated",
  "item/commandExecution/terminalInteraction": "item.command_exec_terminal_interaction",
  "item/autoApprovalReview/started": "item.auto_approval_review_started",
  "item/autoApprovalReview/completed": "item.auto_approval_review_completed",
  // High-frequency deltas — will be marked as delta category
  "item/agentMessage/delta": "item.agent_message_delta",
  "item/commandExecution/outputDelta": "item.command_exec_output_delta",
  "item/fileChange/outputDelta": "item.file_change_output_delta",
  "item/reasoning/textDelta": "item.reasoning_text_delta",
  "item/reasoning/summaryTextDelta": "item.reasoning_summary_text_delta",
  "item/reasoning/summaryPartAdded": "item.reasoning_summary_part_added",
  "item/plan/delta": "item.plan_delta",
  "thread/started": "thread.started",
  "thread/closed": "thread.closed",
  "thread/status/changed": "thread.status_changed",
  "thread/tokenUsage/updated": "thread.token_usage_updated",
  "thread/name/updated": "thread.name_updated",
  "thread/archived": "thread.archived",
  "thread/unarchived": "thread.unarchived",
  "thread/compacted": "context_compacted",
  "model/rerouted": "model_rerouted",
  "serverRequest/resolved": "server_request_resolved",
  "fuzzyFileSearch/sessionUpdated": "fuzzy_file_search.session_updated",
  "fuzzyFileSearch/sessionCompleted": "fuzzy_file_search.session_completed",
  "hook/started": "hook.started",
  "hook/completed": "hook.completed",
  "warning": "warning",
  "configWarning": "config_warning",
  "deprecationNotice": "deprecation_notice",
  "account/updated": "account.updated",
  "account/rateLimits/updated": "account.rate_limits_updated",
  "account/login/completed": "account.login_completed",
  "mcpServer/startupStatus/updated": "mcp_server.status_updated",
  "mcpServer/oauthLogin/completed": "mcp_server.oauth_login_completed",
  "app/list/updated": "app.list_updated",
  "skills/changed": "skills.changed",
  "fs/changed": "fs.changed"
};
var REQUEST_MAP = {
  "item/commandExecution/requestApproval": "approval.command_execution",
  "item/fileChange/requestApproval": "approval.file_change",
  "item/permissions/requestApproval": "approval.permissions",
  "mcpServer/elicitation/request": "approval.mcp_elicitation",
  "item/tool/requestUserInput": "user_input.request"
};
function normalizeNotification(n) {
  const type = NOTIF_MAP[n.method] ?? fallbackType(n.method);
  const params = asObject2(n.params);
  const threadId = extractThreadId(params);
  const payload = buildNotificationPayload(type, params);
  return { type, threadId, payload, isDelta: type.endsWith("_delta") };
}
function normalizeServerRequest(r) {
  const kind = REQUEST_MAP[r.method] ?? fallbackType(r.method);
  const params = asObject2(r.params);
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  const payload = {
    kind,
    turn_id: typeof params.turnId === "string" ? params.turnId : null,
    item_id: typeof params.itemId === "string" ? params.itemId : null,
    raw: params
  };
  if (kind === "approval.command_execution") {
    if (params.command !== void 0) payload.command = params.command;
    if (params.cwd !== void 0) payload.cwd = params.cwd;
    if (params.reason !== void 0) payload.reason = params.reason;
  } else if (kind === "approval.file_change") {
    if (params.reason !== void 0) payload.reason = params.reason;
    if (params.grantRoot !== void 0) payload.grant_root = params.grantRoot;
  } else if (kind === "approval.permissions") {
    if (params.reason !== void 0) payload.reason = params.reason;
    if (params.cwd !== void 0) payload.cwd = params.cwd;
    if (params.permissions !== void 0) payload.permissions = params.permissions;
  } else if (kind === "approval.mcp_elicitation") {
    if (params.serverName !== void 0) payload.server_name = params.serverName;
    if (params.mode !== void 0) payload.mode = params.mode;
    if (params.message !== void 0) payload.message = params.message;
    if (params.requestedSchema !== void 0) payload.requested_schema = params.requestedSchema;
    if (params.url !== void 0) payload.url = params.url;
  } else if (kind === "user_input.request") {
    if (Array.isArray(params.questions)) payload.questions = params.questions;
  }
  return { type: kind, threadId, payload, kind };
}
function buildNotificationPayload(type, params) {
  switch (type) {
    case "turn.started":
    case "turn.completed": {
      const turn = asObject2(params.turn);
      const items = Array.isArray(turn.items) ? turn.items : [];
      return {
        turn_id: turn.id ?? null,
        status: turn.status ?? null,
        started_at: asNumber(turn.startedAt),
        completed_at: asNumber(turn.completedAt),
        duration_ms: deriveDurationMs(turn),
        item_count: items.length,
        turn
      };
    }
    case "turn.error": {
      const err2 = asObject2(params.error);
      return {
        turn_id: params.turnId ?? null,
        will_retry: Boolean(params.willRetry),
        error: {
          message: err2.message ?? null,
          codex_error_info: err2.codexErrorInfo ?? null,
          additional_details: err2.additionalDetails ?? null
        }
      };
    }
    case "item.started":
    case "item.completed": {
      const item = asObject2(params.item);
      return {
        item_id: params.itemId ?? item.id ?? null,
        turn_id: params.turnId ?? null,
        type: item.type ?? null,
        status: item.status ?? null
      };
    }
    case "thread.started": {
      const thread = asObject2(params.thread);
      return {
        thread_id: thread.id ?? null,
        source: thread.source ?? null,
        cwd: thread.cwd ?? null,
        thread
      };
    }
    case "thread.closed":
    case "thread.archived":
    case "thread.unarchived":
      return {};
    case "thread.token_usage_updated":
      return {
        turn_id: params.turnId ?? null,
        token_usage: params.tokenUsage ?? null
      };
    case "thread.name_updated":
      return { name: params.threadName ?? null };
    case "thread.status_changed":
      return { status: params.status ?? null };
    case "server_request_resolved":
      return {
        request_id: params.requestId ?? null
      };
    case "model_rerouted":
      return { reason: params.reason ?? null };
    case "mcp_server.status_updated":
      return {
        name: params.name ?? null,
        status: params.status ?? null,
        error: params.error ?? null
      };
    case "mcp_server.oauth_login_completed":
      return {
        name: params.name ?? null,
        success: Boolean(params.success),
        error: params.error ?? null
      };
    case "warning":
    case "error":
      return {
        message: params.message ?? null,
        thread_id: params.threadId ?? null
      };
    case "config_warning":
      return {
        summary: params.summary ?? null,
        details: params.details ?? null,
        path: params.path ?? null
      };
    case "deprecation_notice":
      return {
        summary: params.summary ?? null,
        details: params.details ?? null
      };
    case "hook.started":
    case "hook.completed": {
      const run = asObject2(params.run);
      return {
        turn_id: params.turnId ?? null,
        hook_id: run.id ?? null,
        status: run.status ?? null,
        run
      };
    }
    case "context_compacted":
      return {
        turn_id: params.turnId ?? null
      };
    case "fuzzy_file_search.session_updated":
    case "fuzzy_file_search.session_completed":
      return {
        search_session_id: params.searchSessionId ?? null
      };
    default:
      if (type.endsWith("_delta")) {
        return {
          item_id: params.itemId ?? null,
          turn_id: params.turnId ?? null,
          delta: params.delta ?? ""
        };
      }
      return { raw: params };
  }
}
function deriveDurationMs(turn) {
  const durationMs = asNumber(turn.durationMs);
  if (durationMs !== null) return durationMs;
  const startedAt = asNumber(turn.startedAt);
  const completedAt = asNumber(turn.completedAt);
  if (startedAt !== null && completedAt !== null) {
    const deltaMs = (completedAt - startedAt) * 1e3;
    if (Number.isFinite(deltaMs)) return Math.max(0, Math.round(deltaMs));
  }
  return null;
}
function fallbackType(method) {
  return method.replace(/\//g, ".").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function asObject2(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function extractThreadId(params) {
  if (typeof params.threadId === "string") return params.threadId;
  const thread = asObject2(params.thread);
  return typeof thread.id === "string" ? thread.id : null;
}

// src/daemon/wire.ts
function wireDaemonEvents(ctx) {
  const recoveringSessions = /* @__PURE__ */ new Set();
  ctx.pool.on("notification", (e) => {
    void handleNotification(ctx, recoveringSessions, e).catch((err2) => {
      logger.warn("notification handling failed", { err: err2.message });
    });
  });
  ctx.pool.on("server_request", (e) => {
    void handleServerRequest(ctx, e).catch((err2) => {
      logger.warn("server request handling failed", { err: err2.message });
    });
  });
  ctx.pool.on("client_close", (e) => {
    void handleClientClose(ctx, recoveringSessions, e).catch((err2) => {
      logger.warn("client close handling failed", { err: err2.message });
    });
  });
}
async function handleNotification(ctx, recoveringSessions, e) {
  const norm = normalizeNotification(e.notification);
  const sessionName = resolveSession(ctx, e.user, norm.threadId);
  await ctx.events.append(e.user, {
    type: norm.type,
    session: sessionName,
    thread_id: norm.threadId,
    payload: norm.payload
  });
  if (norm.type === "turn.started" && sessionName) {
    ctx.queues.setCurrentTurn(keyFor3(e.user, sessionName), norm.payload.turn_id ?? null);
  }
  if (norm.type === "turn.completed" && sessionName && norm.threadId) {
    const client = ctx.pool.clientForSession(keyFor3(e.user, sessionName));
    void ctx.queues.onTurnCompleted(keyFor3(e.user, sessionName), client, norm.threadId, ctx.retryOptions()).then(async (next) => {
      if (next.turn_id) {
        logger.debug("drained queued turn", { session: sessionName, turn_id: next.turn_id, queue_id: next.queue_id });
        await ctx.events.append(e.user, {
          type: "turn.queued_started",
          session: sessionName,
          thread_id: norm.threadId,
          payload: {
            turn_id: next.turn_id,
            queue_id: next.queue_id
          }
        });
        return;
      }
      if (next.failed && next.queue_id) {
        logger.warn("queued turn remains enqueued after dispatch failure", {
          session: sessionName,
          queue_id: next.queue_id,
          err: next.error_message
        });
        await ctx.events.append(e.user, {
          type: "turn.queued_failed",
          session: sessionName,
          thread_id: norm.threadId,
          payload: {
            queue_id: next.queue_id,
            error: {
              message: next.error_message
            }
          }
        });
      }
    }).catch((err2) => {
      logger.warn("turn completion queue drain failed", {
        session: sessionName,
        err: err2.message
      });
    });
  }
  if (norm.type === "thread.closed" && sessionName) {
    try {
      const sessionKey = keyFor3(e.user, sessionName);
      ctx.pool.release(sessionKey);
      ctx.queues.dispose(sessionKey);
      ctx.sessions.remove(e.user, sessionName);
      for (const p of ctx.pending.removeForSession(e.user, sessionName)) {
        try {
          p.client.respondError(p.jsonrpc_id, -32e3, "session detached");
        } catch {
        }
      }
    } catch (err2) {
      logger.warn("thread closed cleanup failed", { session: sessionName, err: err2.message });
    }
  }
  if (norm.type === "server_request_resolved") {
    const reqId = norm.payload.request_id;
    if (reqId !== null && reqId !== void 0) {
      const jsonrpcId = reqId;
      const client = ctx.pool.clientById(e.clientId);
      if (client) {
        ctx.pending.removeByJsonrpcId(client, jsonrpcId);
      } else {
        for (const p of ctx.pending.listForUser(e.user)) {
          if (String(p.jsonrpc_id) === String(jsonrpcId)) {
            ctx.pending.remove(p.request_id);
            break;
          }
        }
      }
    }
  }
  if (norm.type === "client_close" && sessionName && norm.threadId) {
    void recoverSession(ctx, recoveringSessions, e.user, sessionName, norm.threadId);
  }
}
async function handleServerRequest(ctx, e) {
  const norm = normalizeServerRequest(e.request);
  const sessionName = resolveSession(ctx, e.user, norm.threadId);
  if (!sessionName) {
    e.respondError(-32e3, "session detached");
    return;
  }
  if (ctx.queues.isTeardown(keyFor3(e.user, sessionName))) {
    e.respondError(-32e3, "session detached");
    return;
  }
  const effectiveClient = ctx.pool.clientById(e.clientId);
  if (!effectiveClient) {
    logger.warn("server_request: no client to track", { user: e.user, kind: norm.kind });
    e.respondError(-32e3, "no client available");
    return;
  }
  const pending = ctx.pending.add({
    client: effectiveClient,
    jsonrpc_id: e.request.id,
    kind: norm.kind,
    user: e.user,
    session_name: sessionName,
    thread_id: norm.threadId,
    turn_id: norm.payload.turn_id ?? null,
    raw: norm.payload.raw
  });
  const payload = { ...norm.payload, request_id: pending.request_id };
  await ctx.events.append(e.user, {
    type: norm.type,
    session: sessionName,
    thread_id: norm.threadId,
    payload
  });
}
async function handleClientClose(ctx, recoveringSessions, e) {
  if (e.reason !== "unexpected") return;
  for (const sessionKey of e.sessions) {
    const [user, sessionName] = parseKey(sessionKey);
    if (!user || !sessionName) continue;
    const rec = ctx.sessions.get(user, sessionName);
    if (!rec) continue;
    ctx.sessions.update(user, sessionName, { recovery_state: "degraded" });
    await ctx.events.append(user, {
      type: "turn.error",
      session: sessionName,
      thread_id: rec.thread_id,
      payload: {
        will_retry: false,
        error: {
          message: "app-server process exited unexpectedly",
          codex_error_info: "internal_server_error",
          additional_details: `exit_code=${e.exitCode ?? "null"}`
        }
      }
    });
    ctx.queues.onClientClosed(sessionKey);
    for (const p of ctx.pending.removeForSession(user, sessionName)) {
      void p;
    }
    void recoverSession(ctx, recoveringSessions, user, sessionName, rec.thread_id);
  }
}
async function recoverSession(ctx, recoveringSessions, user, sessionName, threadId) {
  const recoveryKey = `${user}::${threadId}`;
  if (recoveringSessions.has(recoveryKey)) return;
  recoveringSessions.add(recoveryKey);
  const sessionKey = keyFor3(user, sessionName);
  try {
    const rec = ctx.sessions.get(user, sessionName);
    const client = await ctx.pool.acquire(
      user,
      sessionKey,
      buildExperimentalToolAppServerOptions(rec?.experimental_tools ?? [])
    );
    await threadResume(client, threadId, ctx.retryOptions());
    const live = ctx.sessions.get(user, sessionName);
    if (live) {
      ctx.sessions.update(user, sessionName, { recovery_state: null });
    } else {
      ctx.pool.release(sessionKey);
    }
  } catch (err2) {
    logger.warn("failed to recover session after client exit", {
      user,
      session: sessionName,
      thread_id: threadId,
      err: err2.message
    });
    ctx.pool.release(sessionKey);
  } finally {
    recoveringSessions.delete(recoveryKey);
  }
}
function resolveSession(ctx, user, threadId) {
  if (!threadId) return null;
  const rec = ctx.sessions.get(user, threadId);
  return rec ? rec.name : null;
}
function keyFor3(user, name) {
  return `${user}::${name}`;
}
function parseKey(sessionKey) {
  const idx = sessionKey.indexOf("::");
  if (idx < 0) return [null, null];
  return [sessionKey.slice(0, idx), sessionKey.slice(idx + 2)];
}

// src/daemon/run.ts
async function runDaemon() {
  const ctx = buildContext();
  const pidPath = pidFilePath(ctx.dataDir);
  const acquired = await acquireDaemonOwnership(ctx.sockPath, pidPath);
  if (!acquired.ok) {
    logger.info(acquired.message, acquired.details);
    return 1;
  }
  await reapOrphans(ctx.dataDir);
  const cleanup = () => {
    unlinkSockIfStale(ctx.sockPath);
    try {
      import_node_fs13.default.unlinkSync(pidPath);
    } catch {
    }
  };
  process.on("exit", cleanup);
  registerShutdownSignal("SIGINT", ctx);
  registerShutdownSignal("SIGTERM", ctx);
  if (process.platform === "win32") registerShutdownSignal("SIGBREAK", ctx);
  else registerShutdownSignal("SIGHUP", ctx);
  wireDaemonEvents(ctx);
  try {
    await startServer(ctx);
    logger.info("daemon started", {
      pid: process.pid,
      sock: ctx.sockPath,
      data_dir: ctx.dataDir
    });
  } catch (e) {
    logger.error("failed to start server", { err: e.message });
    try {
      import_node_fs13.default.unlinkSync(pidPath);
    } catch {
    }
    return 1;
  }
  scheduleIdleShutdown(ctx);
  return await new Promise(() => {
  });
}
function acquirePid(pidPath) {
  try {
    import_node_fs13.default.mkdirSync(import_node_path11.default.dirname(pidPath), { recursive: true });
    const fd = import_node_fs13.default.openSync(pidPath, "wx");
    try {
      import_node_fs13.default.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        created_at: (/* @__PURE__ */ new Date()).toISOString()
      }));
    } finally {
      import_node_fs13.default.closeSync(fd);
    }
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    return false;
  }
}
function scheduleIdleShutdown(ctx) {
  const check = () => {
    const hours = ctx.config.getEffective("daemon.idle_shutdown_hours");
    const threshold = typeof hours === "number" ? hours : 6;
    const ms = threshold * 3600 * 1e3;
    const liveSessions = Array.from(ctx.users.list()).reduce(
      (n, u) => n + ctx.sessions.listLive(u.token).length,
      0
    );
    if (liveSessions > 0) return;
    const idleMs = Date.now() - ctx.activity.lastActivityAt.getTime();
    if (idleMs >= ms) {
      logger.info("idle threshold exceeded, shutting down", {
        idle_ms: idleMs,
        threshold_ms: ms
      });
      void shutdownDaemon(ctx, "idle timeout");
    }
  };
  setInterval(check, 60 * 1e3).unref();
}
function registerShutdownSignal(signal, ctx) {
  process.on(signal, () => void shutdownDaemon(ctx, signal));
}
async function acquireDaemonOwnership(sockPath, pidPath) {
  const waitStart = Date.now();
  const legacyPidPath = legacyWindowsPidFilePath(pidPath);
  for (; ; ) {
    const sockReachable = await probeSock(sockPath, 200);
    const pidRecord = readPidFile2(pidPath);
    const pid = pidRecord?.pid ?? null;
    const pidAlive = pid !== null && isDaemonPidAlive(pid);
    const legacyPidRecord = legacyPidPath ? readPidFile2(legacyPidPath) : null;
    const legacyPid = legacyPidRecord?.pid ?? null;
    const legacyPidAlive = legacyPid !== null && isDaemonPidAlive(legacyPid);
    if (sockReachable) {
      if (Date.now() - waitStart > 3e3) {
        return {
          ok: false,
          message: "another daemon already owns the sock",
          details: {
            sock: sockPath,
            pidfile_pid: pid,
            pidfile_live: pidAlive,
            legacy_pidfile_pid: legacyPid,
            legacy_pidfile_live: legacyPidAlive
          }
        };
      }
      await sleep4(150);
      continue;
    }
    if (pidAlive || legacyPidAlive) {
      const livePid = pidAlive ? pid : legacyPid;
      const livePidPath = pidAlive ? pidPath : legacyPidPath;
      if (Date.now() - waitStart > 3e3) {
        return {
          ok: false,
          message: "another daemon pidfile is live; aborting",
          details: {
            pid_path: livePidPath,
            pid: livePid
          }
        };
      }
      await sleep4(150);
      continue;
    }
    if (pid !== null && !pidAlive) {
      try {
        import_node_fs13.default.unlinkSync(pidPath);
      } catch {
      }
    }
    if (legacyPidPath && legacyPid !== null && !legacyPidAlive) {
      try {
        import_node_fs13.default.unlinkSync(legacyPidPath);
      } catch {
      }
    }
    unlinkSockIfStale(sockPath);
    if (acquirePid(pidPath)) {
      return { ok: true, message: "daemon ownership acquired" };
    }
    if (Date.now() - waitStart > 3e3) {
      return {
        ok: false,
        message: "failed to acquire daemon pidfile",
        details: { pid_path: pidPath }
      };
    }
    await sleep4(150);
  }
}
function readPidFile2(pidPath) {
  try {
    const raw = import_node_fs13.default.readFileSync(pidPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    return {
      pid: Math.floor(parsed.pid),
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : void 0
    };
  } catch {
    return null;
  }
}
function isDaemonPidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return isLikelyCodexTeamDaemonProcess(pid);
}
function legacyWindowsPidFilePath(currentPidPath) {
  if (process.platform !== "win32") return null;
  const legacyHome = process.env.HOME;
  if (!legacyHome) return null;
  const legacyPath = import_node_path11.default.join(legacyHome, `.${APP}`, "daemon.pid");
  if (legacyPath === currentPidPath) return null;
  if (legacyHome === homeDir()) return null;
  return legacyPath;
}
function sleep4(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

// src/main.ts
async function main() {
  const argv = process.argv.slice(2);
  const daemonIdx = argv.indexOf("--daemon-internal");
  if (daemonIdx >= 0) {
    argv.splice(daemonIdx, 1);
    const code2 = await runDaemon();
    process.exit(code2);
  }
  const code = await runCli(argv);
  process.exit(code);
}
main().catch((e) => {
  process.stderr.write(`fatal: ${e.message ?? e}
`);
  process.exit(1);
});
