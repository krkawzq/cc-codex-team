"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// src/main.ts
var import_node_fs19 = __toESM(require("fs"));
var import_node_path18 = __toESM(require("path"));

// src/cli/run.ts
var import_node_fs8 = __toESM(require("fs"));
var import_node_path8 = __toESM(require("path"));
var import_node_child_process3 = require("child_process");
var import_promises = require("timers/promises");

// src/ipc/sock.ts
var import_node_fs3 = __toESM(require("fs"));
var import_node_net = __toESM(require("net"));
var import_node_path3 = __toESM(require("path"));

// src/logger.ts
var import_node_fs = __toESM(require("fs"));
var import_node_path = __toESM(require("path"));
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
      import_node_fs.default.mkdirSync(import_node_path.default.dirname(opts.logPath), { recursive: true });
      this.stream = import_node_fs.default.createWriteStream(opts.logPath, { flags: "a" });
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

// src/ipc/frameParser.ts
var DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
var NEWLINE_BYTE = 10;
var EMPTY_BUFFER = Buffer.alloc(0);
var FrameTooLargeError = class extends Error {
  peer;
  frameBytes;
  maxFrameBytes;
  constructor(peer, frameBytes, maxFrameBytes) {
    super(`frame from ${peer} exceeded ${maxFrameBytes} bytes`);
    this.name = "FrameTooLargeError";
    this.peer = peer;
    this.frameBytes = frameBytes;
    this.maxFrameBytes = maxFrameBytes;
  }
};
function createLineParser(options) {
  const maxFrameBytes = normalizeMaxFrameBytes(options.maxFrameBytes);
  let buffer = EMPTY_BUFFER;
  let readOffset = 0;
  let paused = false;
  let failed = false;
  const compactIfNeeded = () => {
    if (readOffset === 0) return;
    if (readOffset >= buffer.length) {
      buffer = EMPTY_BUFFER;
      readOffset = 0;
      return;
    }
    if (readOffset < Math.floor(buffer.length / 2)) return;
    buffer = Buffer.from(buffer.subarray(readOffset));
    readOffset = 0;
  };
  const fail2 = (frameBytes) => {
    if (failed) return;
    failed = true;
    const error = new FrameTooLargeError(options.peer, frameBytes, maxFrameBytes);
    logger.warn("frame_too_large", {
      peer: options.peer,
      frame_bytes: frameBytes,
      max_frame_bytes: maxFrameBytes
    });
    options.onError(error);
  };
  const parseAvailable = () => {
    if (paused || failed) return;
    while (true) {
      const newlineIdx = buffer.indexOf(NEWLINE_BYTE, readOffset);
      if (newlineIdx < 0) {
        const unreadBytes = buffer.length - readOffset;
        if (unreadBytes > maxFrameBytes) fail2(unreadBytes);
        else compactIfNeeded();
        return;
      }
      const frameBytes = newlineIdx - readOffset;
      if (frameBytes > maxFrameBytes) {
        fail2(frameBytes);
        return;
      }
      const line = buffer.toString("utf8", readOffset, newlineIdx);
      readOffset = newlineIdx + 1;
      compactIfNeeded();
      if (!line.trim()) continue;
      if (options.onLine(line) === false) {
        paused = true;
        return;
      }
    }
  };
  const appendChunk = (chunk) => {
    if (chunk.length === 0) return;
    if (buffer.length === 0 || readOffset >= buffer.length) {
      buffer = chunk;
      readOffset = 0;
      return;
    }
    const unread = readOffset === 0 ? buffer : buffer.subarray(readOffset);
    buffer = Buffer.concat([unread, chunk]);
    readOffset = 0;
  };
  return {
    bufferedBytes() {
      return Math.max(0, buffer.length - readOffset);
    },
    push(chunk) {
      if (failed) return;
      appendChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
      parseAvailable();
    },
    resume() {
      if (failed || !paused) return;
      paused = false;
      parseAvailable();
    }
  };
}
function readMaxFrameBytes(env = process.env) {
  return parsePositiveIntEnv(env.CODEX_TEAM_MAX_FRAME_BYTES, DEFAULT_MAX_FRAME_BYTES);
}
function normalizeMaxFrameBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_FRAME_BYTES;
  return Math.max(1, Math.floor(value));
}
function parsePositiveIntEnv(raw, fallback) {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

// src/paths.ts
var import_node_crypto = __toESM(require("crypto"));
var import_node_fs2 = __toESM(require("fs"));
var import_node_os = __toESM(require("os"));
var import_node_path2 = __toESM(require("path"));
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
  return import_node_path2.default.join(homeDir(), `.${APP}`);
}
function defaultSockPath(dataDir = defaultDataDir(), platform = process.platform) {
  const configured = process.env.CODEX_TEAM_SOCK;
  if (configured) return normalizeSockPath(expandUserPath(configured, platform), platform);
  const resolvedDataDir = expandUserPath(dataDir, platform);
  if (platform === "win32") return namedPipePath(resolvedDataDir);
  const candidate = import_node_path2.default.join(resolvedDataDir, "daemon.sock");
  if (Buffer.byteLength(candidate, "utf8") <= UNIX_SOCKET_MAX_BYTES) return candidate;
  return import_node_path2.default.join(import_node_os.default.tmpdir(), `${APP}-${pathHash(resolvedDataDir)}.sock`);
}
function defaultLogPath(dataDir = defaultDataDir()) {
  return import_node_path2.default.join(expandUserPath(dataDir), "daemon.log");
}
function configFilePath(dataDir = defaultDataDir()) {
  return import_node_path2.default.join(expandUserPath(dataDir), "config.json");
}
function pidFilePath(dataDir = defaultDataDir()) {
  return import_node_path2.default.join(expandUserPath(dataDir), "daemon.pid");
}
function usersDir(dataDir = defaultDataDir()) {
  return import_node_path2.default.join(expandUserPath(dataDir), "users");
}
function userDir(token, dataDir = defaultDataDir()) {
  return import_node_path2.default.join(usersDir(dataDir), encodeToken(token));
}
function userMetadataPath(token, dataDir = defaultDataDir()) {
  return import_node_path2.default.join(userDir(token, dataDir), "metadata.json");
}
function userEventLogPath(token, dataDir = defaultDataDir()) {
  return import_node_path2.default.join(userDir(token, dataDir), "events.log");
}
function userSessionsPath(token, dataDir = defaultDataDir()) {
  return import_node_path2.default.join(userDir(token, dataDir), "sessions.json");
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
  const pathModule = platform === "win32" ? import_node_path2.default.win32 : import_node_path2.default.posix;
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
var legacyWindowsDataDirWarned = false;
function warnLegacyWindowsDataDir(emit, opts = {}) {
  if (legacyWindowsDataDirWarned) return null;
  const warning = getLegacyWindowsDataDirWarning(opts);
  if (!warning) return null;
  legacyWindowsDataDirWarned = true;
  emit(warning);
  return warning;
}
function namedPipePath(seed) {
  return `${WINDOWS_PIPE_PREFIX}${APP}-${pathHash(seed)}`;
}
function pathHash(input) {
  return import_node_crypto.default.createHash("sha256").update(input).digest("hex").slice(0, 16);
}
function getLegacyWindowsDataDirWarning(opts) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return null;
  if ((opts.dataDirOverride ?? process.env.CODEX_TEAM_DATA_DIR)?.trim()) return null;
  const legacyHome = (opts.legacyHome ?? process.env.HOME ?? "").trim();
  if (!legacyHome) return null;
  const nativeHome = opts.nativeHome ?? homeDir();
  if (!nativeHome || nativeHome === legacyHome) return null;
  const exists = opts.exists ?? import_node_fs2.default.existsSync;
  const legacyPath = import_node_path2.default.join(legacyHome, `.${APP}`);
  const newPath = import_node_path2.default.join(nativeHome, `.${APP}`);
  if (!exists(legacyPath) || exists(newPath)) return null;
  return {
    legacyPath,
    newPath,
    message: `warning: Windows legacy HOME data dir '${legacyPath}' exists but new default '${newPath}' does not; move it manually to keep codex-team state.`
  };
}

// src/ipc/sock.ts
function writeMessage(socket, msg) {
  socket.write(JSON.stringify(msg) + "\n");
}
function onMessages(socket, handler, onClose) {
  const parser = createLineParser({
    maxFrameBytes: readMaxFrameBytes(),
    peer: socketPeer(socket),
    onError: (error) => {
      if (socket.listenerCount("error") === 0) {
        socket.once("error", () => void 0);
      }
      if (typeof socket.destroy === "function") socket.destroy(error);
      else socket.emit("error", error);
    },
    onLine: (line) => {
      try {
        const msg = JSON.parse(line);
        return handler(msg);
      } catch {
        return void 0;
      }
    }
  });
  socket.on("data", (chunk) => {
    parser.push(chunk);
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
  return {
    resume() {
      parser.resume();
    }
  };
}
async function listenSock(sockPath) {
  const endpoint = normalizeSockPath(sockPath);
  if (isFilesystemSockPath(sockPath)) {
    import_node_fs3.default.mkdirSync(import_node_path3.default.dirname(endpoint), { recursive: true });
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
    if (isFilesystemSockPath(sockPath) && !import_node_fs3.default.existsSync(endpoint)) {
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
    import_node_fs3.default.unlinkSync(endpoint);
  } catch {
  }
}
function socketPeer(socket) {
  const remoteAddress = socket.remoteAddress;
  const remotePort = socket.remotePort;
  if (typeof remoteAddress === "string" && remoteAddress.length > 0) {
    return remotePort ? `${remoteAddress}:${remotePort}` : remoteAddress;
  }
  const maybePath = socket.path;
  if (typeof maybePath === "string" && maybePath.length > 0) return maybePath;
  return "ipc_socket";
}

// src/cli/args.ts
var COMMANDS = /* @__PURE__ */ new Set([
  "version",
  "doctor",
  "status",
  "daemon:fleet:status",
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
  "session:events",
  "session:logs",
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
  "cursor:delete"
]);
var HELP_PATHS = /* @__PURE__ */ new Set([
  ...COMMANDS,
  "daemon",
  "daemon:fleet",
  "daemon:user",
  "daemon:config",
  "session",
  "message",
  "monitor",
  "cursor"
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
var BOOLEAN_LONG_FLAGS = /* @__PURE__ */ new Set([
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
  "yes"
]);
var BOOLEAN_SHORT_FLAGS = /* @__PURE__ */ new Set([
  "f",
  "h",
  "v"
]);
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
    const [globalToken, inlineValue] = splitLongFlagAssignment(a);
    const spec = GLOBAL_FLAGS[globalToken];
    if (!spec) {
      nonGlobal.push(a);
      continue;
    }
    if (spec.takesValue) {
      const v = inlineValue ?? argv[++i];
      if (v === void 0) {
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
      let key;
      let value;
      if (eqIdx >= 0) {
        key = a.slice(2, eqIdx);
        value = a.slice(eqIdx + 1);
      } else {
        key = a.slice(2);
        if (BOOLEAN_LONG_FLAGS.has(key)) {
          value = null;
        } else {
          const next = tail[i + 1];
          if (next !== void 0 && !isFlagLike(next)) {
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
        if (next !== void 0 && !isFlagLike(next)) {
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
function isFlagLike(s) {
  if (!s.startsWith("-")) return false;
  if (s === "-") return false;
  if (isNegativeNumber(s)) return false;
  return true;
}
function isNegativeNumber(s) {
  return /^-\d+(\.\d+)?$/.test(s);
}
function splitLongFlagAssignment(token) {
  if (!token.startsWith("--")) return [token, null];
  const eqIdx = token.indexOf("=");
  if (eqIdx < 0) return [token, null];
  return [token.slice(0, eqIdx), token.slice(eqIdx + 1)];
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
function commandKey(path19) {
  return path19.join(":");
}
var SHORT_COMMANDS = /* @__PURE__ */ new Set([
  "doctor",
  "status",
  "daemon:fleet:status",
  "daemon:status",
  "daemon:user:list",
  "session:info",
  "session:health",
  "session:health:all",
  "session:logs",
  "session:list",
  "message:history"
]);
function supportsShort(method) {
  return SHORT_COMMANDS.has(method);
}
function truthyFlag(value) {
  if (Array.isArray(value)) return truthyFlag(value[value.length - 1]);
  return value === true || value === "true" || value === "1";
}

// src/cli/help.ts
var FULL_FLAG = {
  long: "--full",
  type: "bool",
  default: "false",
  required: false,
  description: "Print the full JSON response body instead of the default concise projection."
};
function leaf(node) {
  const flags = node.flags.some((flag) => flag.long === "--full") ? [...node.flags] : [...node.flags, { ...FULL_FLAG }];
  return { ...node, flags, subcommands: [] };
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
var LIVE_SESSION_TARGETS = {
  name: "name|thread_id...",
  required: true,
  description: "One or more live session names or thread IDs."
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
      usage: "codex-team daemon user list [flags]",
      positionals: [],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact line per user to stdout."
        }
      ],
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
        "codex-team daemon config set monitor.default_interval_seconds 10",
        "codex-team daemon config set session.auto_approve_command_patterns 'git*,node *'"
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
var daemonFleetGroup = {
  name: "fleet",
  summary: "Inspect daemon-wide user and session health at a glance.",
  usage: "codex-team daemon fleet <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team daemon fleet status"
  ],
  subcommands: [
    leaf({
      name: "status",
      summary: "Show a cross-user live-session fleet snapshot.",
      usage: "codex-team daemon fleet status [flags]",
      positionals: [],
      flags: [
        {
          long: "--users",
          type: "csv|all",
          default: "all known users",
          required: false,
          description: "Limit the snapshot to 'all' or a comma-separated token list."
        },
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact line per user to stdout."
        }
      ],
      examples: [
        "codex-team daemon fleet status",
        "codex-team daemon fleet status --users claude-alice,claude-bob"
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
    "codex-team daemon fleet status",
    "codex-team daemon logs -f --level warn"
  ],
  subcommands: [
    leaf({
      name: "status",
      summary: "Show daemon process, socket, and resource status.",
      usage: "codex-team daemon status [flags]",
      positionals: [],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact status line to stdout."
        }
      ],
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
          short: "-n",
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
    daemonFleetGroup,
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
        },
        {
          long: "--auto-approve",
          type: "csv|regex",
          required: false,
          description: "Comma-separated approval target patterns to auto-accept for this session."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session new audit --model gpt-5.4 --cwd /repo",
        "codex-team -b $TOKEN session new --profile fast-review",
        "codex-team -b $TOKEN session new askq --experimental-tools ask-user-question",
        "codex-team -b $TOKEN session new audit --auto-approve 'git*,node *'"
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
      usage: "codex-team -b <token> session detach [<name|thread_id>|--all] [flags]",
      positionals: [
        { ...SESSION_TARGET, required: false, description: "Target session unless using --all." }
      ],
      flags: [
        {
          long: "--all",
          type: "bool",
          default: "false",
          required: false,
          description: "Detach every live session for the current bearer."
        },
        {
          long: "--match",
          type: "glob",
          required: false,
          description: "Filter --all targets by session name using * and ? wildcards."
        },
        {
          long: "--graceful",
          type: "bool",
          default: "false",
          required: false,
          description: "Wait for the current turn before detaching."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session detach audit --graceful",
        "codex-team -b $TOKEN session detach --all --match 'mapper-*'"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "archive",
      summary: "Archive a detached thread, or detach and archive a live session.",
      usage: "codex-team -b <token> session archive <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET }
      ],
      flags: [
        {
          long: "--and-detach",
          type: "bool",
          default: "false",
          required: false,
          description: "Hard-detach a live session before archiving it."
        }
      ],
      notes: [
        "Live sessions refuse without --and-detach."
      ],
      examples: [
        "codex-team -b $TOKEN session archive audit --and-detach",
        "codex-team -b $TOKEN session archive th-abc123"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "unarchive",
      summary: "Restore an archived detached thread.",
      usage: "codex-team -b <token> session unarchive <thread_id>",
      positionals: [
        {
          name: "thread_id",
          required: true,
          description: "Detached archived thread ID."
        }
      ],
      flags: [],
      notes: [
        "Fails if the thread is currently live."
      ],
      examples: [
        "codex-team -b $TOKEN session unarchive th-abc123"
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
      summary: "Rename a live session or, with --detached-ok, a detached thread.",
      usage: "codex-team -b <token> session rename <name|thread_id> <new_name> [flags]",
      positionals: [
        { ...SESSION_TARGET, description: "Current session name or thread ID." },
        {
          name: "new_name",
          required: true,
          description: "New session name."
        }
      ],
      flags: [
        {
          long: "--detached-ok",
          type: "bool",
          default: "false",
          required: false,
          description: "Allow renaming a detached thread via persisted thread metadata."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session rename audit audit-review",
        "codex-team -b $TOKEN session rename th-abc123 audit-review --detached-ok"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "rollback",
      summary: "Fork a thread at an earlier turn, archive the old thread, and move the session name forward.",
      usage: "codex-team -b <token> session rollback <name|thread_id> --to-turn <turn_id> [flags]",
      positionals: [
        { ...SESSION_TARGET, description: "Source live session or detached thread." }
      ],
      flags: [
        {
          long: "--to-turn",
          type: "string",
          required: true,
          description: "Turn ID to fork from."
        },
        {
          long: "--detach-after",
          type: "bool",
          default: "false",
          required: false,
          description: "Leave the forked thread detached instead of resuming it live."
        }
      ],
      notes: [
        "The original thread is renamed to <name>-pre-rollback-<iso8601> and archived."
      ],
      examples: [
        "codex-team -b $TOKEN session rollback audit --to-turn turn-42",
        "codex-team -b $TOKEN session rollback th-abc123 --to-turn turn-42 --detach-after"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "info",
      summary: "Show metadata for one session.",
      usage: "codex-team -b <token> session info <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET }
      ],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact status line to stdout."
        }
      ],
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
          long: "--cursor",
          type: "string",
          default: "",
          required: false,
          description: "Pagination cursor from a previous session list page."
        },
        {
          long: "--limit",
          type: "int",
          default: "50",
          required: false,
          description: "Maximum number of sessions to return."
        },
        {
          long: "--archived",
          type: "enum",
          default: "exclude",
          required: false,
          description: "Include archived sessions, exclude them, or return only archived sessions."
        },
        {
          long: "--state",
          type: "string",
          default: "",
          required: false,
          description: "Comma-separated session states to keep: live, crashed, closed, archived."
        },
        {
          long: "--owner",
          type: "string",
          default: "self",
          required: false,
          description: "Best-effort owner filter: self, any, or an explicit bearer token."
        },
        {
          long: "--loaded-only",
          type: "bool",
          default: "false",
          required: false,
          description: "List threads currently loaded in app-server memory instead of persisted thread/list results."
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
        },
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact line per session to stdout; cannot be used with --format table."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session list --all --format table",
        "codex-team -b $TOKEN session list --all --limit 25 --cursor abc123",
        "codex-team -b $TOKEN session list --loaded-only --owner any"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "health",
      summary: "Show a live health snapshot for one session or every tracked session.",
      usage: "codex-team -b <token> session health [<name|thread_id>] [flags]",
      positionals: [
        {
          ...SESSION_TARGET,
          required: false,
          description: "Session name or thread ID when not using --all."
        }
      ],
      flags: [
        {
          long: "--all",
          type: "bool",
          default: "false",
          required: false,
          description: "Return one health snapshot per tracked session instead of a single target."
        },
        {
          long: "--only-unhealthy",
          type: "bool",
          default: "false",
          required: false,
          description: "With --all, hide idle live sessions whose app-server is healthy."
        },
        {
          long: "--state",
          type: "csv",
          required: false,
          description: "With --all, limit results to live, crashed, and/or closed states."
        },
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact line per returned session to stdout."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session health audit",
        "codex-team -b $TOKEN session health --all --only-unhealthy",
        "codex-team -b $TOKEN session health --all --state live,crashed"
      ],
      notes: [
        "Without --all, current single-session behavior stays in place.",
        "If the session is crashed or the app-server is dead, run 'codex-team -b <token> session heal <name|thread_id>'."
      ],
      needs_bearer: true
    }),
    leaf({
      name: "events",
      summary: "Replay retained normalized events for one session, with optional follow mode.",
      usage: "codex-team -b <token> session events <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET }
      ],
      flags: [
        {
          long: "--type",
          type: "csv",
          required: false,
          description: "Only include matching event types such as turn.completed,item.completed."
        },
        {
          long: "--turn",
          type: "string",
          required: false,
          description: "Only include events associated with one turn ID."
        },
        {
          long: "--since",
          type: "event_id",
          required: false,
          description: "Start after this retained event ID."
        },
        {
          long: "--limit",
          type: "int",
          default: "50",
          required: false,
          description: "Cap the initial backlog size; when --since is absent, uses the most recent N events."
        },
        {
          long: "--follow",
          type: "bool",
          default: "false",
          required: false,
          description: "Keep streaming future matching events after the initial backlog."
        },
        {
          long: "--summary",
          type: "bool",
          default: "false",
          required: false,
          description: "Emit the same compact event summaries as monitor events --summary."
        },
        {
          long: "--by-tool",
          type: "bool",
          default: "false",
          required: false,
          description: "Count item.completed events by rendered tool bucket; cannot be used with --follow or --summary."
        },
        {
          long: "--by-item-kind",
          type: "bool",
          default: "false",
          required: false,
          description: "Count item.completed events by normalized item kind; cannot be used with --follow or --summary."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session events audit --limit 10",
        "codex-team -b $TOKEN session events audit --type turn.completed,item.completed",
        "codex-team -b $TOKEN session events audit --turn turn-42",
        "codex-team -b $TOKEN session events audit --follow --summary",
        "codex-team -b $TOKEN session events audit --by-tool"
      ],
      notes: [
        "Default output is chronological oldest-to-newest NDJSON for the retained event window.",
        "Use --since to page forward from a prior event ID."
      ],
      needs_bearer: true
    }),
    leaf({
      name: "logs",
      summary: "Show the recent app-server stdout/stderr tail for one session.",
      usage: "codex-team -b <token> session logs <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET }
      ],
      flags: [
        {
          long: "-n",
          type: "int",
          default: "100",
          required: false,
          description: "Return the last N captured log lines."
        },
        {
          long: "--follow",
          short: "-f",
          type: "bool",
          default: "false",
          required: false,
          description: "Keep streaming new log lines until the CLI exits."
        },
        {
          long: "--stream",
          type: "enum",
          default: "stderr",
          required: false,
          description: "Choose stderr, stdout, or all captured streams."
        },
        {
          long: "--truncate",
          type: "int",
          default: "2048",
          required: false,
          description: "Clip each log line to this many bytes; use 0 to disable clipping."
        },
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print '<ts> <stream> <line>' per log line."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session logs audit -n 50",
        "codex-team -b $TOKEN session logs audit --stream all",
        "codex-team -b $TOKEN session logs audit --follow --short"
      ],
      notes: [
        "Detached sessions return session_not_live; re-attach them first.",
        "Crashed sessions return the last captured tail with state=crashed."
      ],
      needs_bearer: true
    }),
    leaf({
      name: "heal",
      summary: "Re-attach a crashed or dead live session to a fresh app-server.",
      usage: "codex-team -b <token> session heal <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET }
      ],
      flags: [
        {
          long: "--force",
          type: "bool",
          default: "false",
          required: false,
          description: "Drop half-baked in-memory queue state before retrying the resume."
        }
      ],
      examples: [
        "codex-team -b $TOKEN session heal audit",
        "codex-team -b $TOKEN session heal audit --force"
      ],
      notes: [
        "Use 'codex-team -b <token> session health <name|thread_id>' first to inspect crash state and pending work.",
        'Healthy live sessions return { ok: true, note: "already healthy" }.'
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
      name: "send-many",
      summary: "Broadcast one prompt to multiple live sessions.",
      usage: "codex-team -b <token> message send-many <name|thread_id> <name|thread_id> [...name|thread_id] [prompt] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGETS, description: "Two or more live sessions to broadcast to." },
        {
          name: "prompt",
          required: false,
          description: "Prompt text when not using --stdin or --file."
        }
      ],
      flags: [
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
        }
      ],
      notes: [
        "Requires at least two explicit targets."
      ],
      examples: [
        'codex-team -b $TOKEN message send-many audit lint typecheck "Run all pending checks."',
        "codex-team -b $TOKEN message send-many audit lint typecheck --file prompt.md"
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
      flags: [
        ...JSON_RESPONSE_FLAGS,
        {
          long: "--kind",
          type: "string",
          required: false,
          description: "Optional approval kind hint for local shortcut validation."
        }
      ],
      notes: [
        "command_execution and file_change: all shortcuts are valid.",
        "permissions: cancel is invalid.",
        "mcp_elicitation: accept-session is invalid; form mode needs --json.",
        "--kind validates the shortcut before contacting the daemon."
      ],
      examples: [
        "codex-team -b $TOKEN message approval audit req-17 accept-session",
        "codex-team -b $TOKEN message approval audit req-17 accept --kind approval.permissions",
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
        },
        {
          long: "--truncate",
          type: "int",
          default: "2048",
          required: false,
          description: "Clip long markdown bodies to this many bytes; use 0 to disable clipping."
        },
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact line per turn to stdout; cannot be used with --format markdown."
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
          short: "-n",
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
        },
        {
          long: "--truncate",
          type: "int",
          default: "2048",
          required: false,
          description: "Clip long markdown bodies to this many bytes; use 0 to disable clipping."
        }
      ],
      examples: [
        "codex-team -b $TOKEN message tail audit -n 5 --follow"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "wait",
      summary: "Block until a turn completes, errors, or times out.",
      usage: "codex-team -b <token> message wait <name|thread_id>... [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGETS, description: "One session by default, or multiple with --all/--any." }
      ],
      flags: [
        {
          long: "--all",
          type: "bool",
          default: "false",
          required: false,
          description: "Wait until every listed session reaches a terminal outcome."
        },
        {
          long: "--any",
          type: "bool",
          default: "false",
          required: false,
          description: "Return when the first listed session reaches a terminal outcome."
        },
        {
          long: "--for",
          type: "string",
          required: false,
          description: "Wait for a specific turn ID instead of inferring the current or next turn."
        },
        {
          long: "--timeout",
          type: "int",
          default: "600",
          required: false,
          description: "Seconds to wait before returning timeout; use 0 to disable the timeout."
        }
      ],
      notes: [
        "Without --for, waits for the current in-flight turn. If the session is idle, waits for the next turn that starts after this call.",
        "--all and --any are mutually exclusive. --for only applies to single-session waits."
      ],
      examples: [
        "codex-team -b $TOKEN message wait audit",
        "codex-team -b $TOKEN message wait audit --for turn-42 --timeout 30",
        "codex-team -b $TOKEN message wait --all audit lint typecheck --timeout 300",
        "codex-team -b $TOKEN message wait --any audit lint typecheck --timeout 60"
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
          long: "--summary",
          type: "bool",
          default: "false",
          required: false,
          description: "Emit compact NDJSON lines with only id, ts, type, session, and a type-specific key."
        },
        {
          long: "--since",
          type: "string",
          required: false,
          description: "Resume from the given event ID; cannot be used with --cursor."
        },
        {
          long: "--cursor",
          type: "string",
          required: false,
          description: "Resume from a saved named cursor and auto-update it; cannot be used with --since."
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
var cursorGroup = {
  name: "cursor",
  summary: "Manage persisted named event cursors.",
  usage: "codex-team -b <token> cursor <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team -b $TOKEN cursor save audit-tail"
  ],
  subcommands: [
    leaf({
      name: "save",
      summary: "Save the current event tail or an explicit event ID under a cursor name.",
      usage: "codex-team -b <token> cursor save <name> [flags]",
      positionals: [
        {
          name: "name",
          required: true,
          description: "Cursor name to create or update."
        }
      ],
      flags: [
        {
          long: "--event-id",
          type: "string",
          required: false,
          description: "Override the saved event ID instead of using the current tail."
        }
      ],
      examples: [
        "codex-team -b $TOKEN cursor save audit-tail",
        "codex-team -b $TOKEN cursor save audit-tail --event-id evt-42"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "list",
      summary: "List saved named cursors for the current user.",
      usage: "codex-team -b <token> cursor list",
      positionals: [],
      flags: [],
      examples: [
        "codex-team -b $TOKEN cursor list"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "get",
      summary: "Print only the saved event ID for a cursor name.",
      usage: "codex-team -b <token> cursor get <name>",
      positionals: [
        {
          name: "name",
          required: true,
          description: "Cursor name to resolve."
        }
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN cursor get audit-tail"
      ],
      needs_bearer: true
    }),
    leaf({
      name: "delete",
      summary: "Delete a saved cursor.",
      usage: "codex-team -b <token> cursor delete <name>",
      positionals: [
        {
          name: "name",
          required: true,
          description: "Cursor name to delete."
        }
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN cursor delete audit-tail"
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
  notes: [
    "Default JSON output is concise. Pass --full on any leaf command to restore the complete response body."
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
    {
      name: "doctor",
      summary: "Run local environment and daemon bootstrap diagnostics.",
      usage: "codex-team doctor [flags]",
      positionals: [],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one summary line with verdict, failed checks, and warnings."
        }
      ],
      examples: [
        "codex-team doctor",
        "codex-team doctor --short"
      ],
      notes: [
        "Checks: node version, codex binary, plugin launcher, daemon.data_dir writable.",
        "Checks: local socket bind, daemon process state, daemon socket reachability, dist freshness."
      ],
      subcommands: [],
      needs_bearer: false
    },
    leaf({
      name: "status",
      summary: "Show live sessions, pending events, and recent activity.",
      usage: "codex-team -b <token> status [flags]",
      positionals: [],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact status line to stdout."
        }
      ],
      examples: [
        "codex-team -b $TOKEN status"
      ],
      needs_bearer: true
    }),
    daemonGroup,
    sessionGroup,
    messageGroup,
    monitorGroup,
    cursorGroup
  ],
  needs_bearer: false
};
function findNode(path19, node = HELP_TREE) {
  if (path19.length === 0) return node;
  const [head, ...rest] = path19;
  const child = node.subcommands.find((entry) => entry.name === head);
  if (!child) return null;
  return findNode(rest, child);
}
function formatCommandPath(path19) {
  return path19.length === 0 ? "codex-team" : `codex-team ${path19.join(" ")}`;
}
function formatPositional(positional) {
  return positional.required ? `<${positional.name}>` : `[${positional.name}]`;
}
function formatFlag(flag) {
  if (flag.short && flag.long) return `${flag.short}, ${flag.long}`;
  return flag.short ?? flag.long ?? "-";
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
function renderHelp(path19) {
  const node = findNode(path19) ?? HELP_TREE;
  const resolvedPath = findNode(path19) ? path19 : [];
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
  }
  if (node.notes && node.notes.length > 0) sections.push(renderNotes(node));
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
var import_node_fs4 = __toESM(require("fs"));
var import_node_path4 = __toESM(require("path"));

// src/daemon/auto-approve.ts
function parseAutoApprovePatterns(raw) {
  if (raw.length === 0) return [];
  return raw.split(",").map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
}
function parseConfiguredAutoApprovePatterns(value) {
  return typeof value === "string" ? parseAutoApprovePatterns(value) : [];
}
function validateAutoApprovePatterns(raw) {
  return validateParsedAutoApprovePatterns(parseAutoApprovePatterns(raw));
}
function validateParsedAutoApprovePatterns(patterns) {
  try {
    for (const pattern of patterns) {
      validateAutoApprovePattern(pattern);
    }
    return null;
  } catch (error) {
    return error.message;
  }
}
function matchAutoApprovePattern(patterns, target) {
  if (typeof target !== "string" || target.length === 0) return null;
  for (const pattern of patterns) {
    let matched = false;
    try {
      matched = matchesPattern(pattern, target);
    } catch (error) {
      logger.warn("auto-approve pattern match failed; ignoring pattern", {
        pattern,
        err: error.message,
        target: previewAutoApproveTarget(target)
      });
      continue;
    }
    if (matched) {
      return {
        matchedPattern: pattern,
        commandPreview: previewAutoApproveTarget(target)
      };
    }
  }
  return null;
}
function validateAutoApprovePattern(pattern) {
  if (!pattern.startsWith("/")) return;
  parseRegexPattern(pattern);
}
function matchesPattern(pattern, target) {
  if (pattern.startsWith("/")) return parseRegexPattern(pattern).test(target);
  if (!pattern.includes("*")) return pattern === target;
  return new RegExp(`^${escapeGlobPattern(pattern)}$`).test(target);
}
function parseRegexPattern(pattern) {
  const trailingSlash = pattern.lastIndexOf("/");
  if (trailingSlash <= 0) {
    throw new Error(`invalid auto-approve regex '${pattern}': expected /pattern/flags`);
  }
  const source = pattern.slice(1, trailingSlash);
  const flags = pattern.slice(trailingSlash + 1);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(`invalid auto-approve regex '${pattern}': ${error.message}`);
  }
}
function escapeGlobPattern(pattern) {
  return pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
}
function previewAutoApproveTarget(target) {
  return target.length > 160 ? `${target.slice(0, 157)}...` : target;
}

// src/daemon/config.ts
function enumSpec(values, def, needsRestart, desc) {
  return { type: "enum", enumValues: values, default: def, needsRestart, description: desc };
}
function positiveIntValidator(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? null : "expected positive integer";
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
  "monitor.cursor_persist_debounce_ms": { type: "int", default: 200, needsRestart: false, description: "debounce for cursor auto-updates from `monitor events` (milliseconds)" },
  "monitor.event_log_retention": { type: "int", default: 1e4, needsRestart: false, description: "per-user ring-buffer event retention" },
  "monitor.alarm_output_cap_bytes": { type: "int", default: 16384, needsRestart: false, description: "per-stream capture cap for `monitor alarm` stdout/stderr", validate: positiveIntValidator },
  "session.persist_debounce_ms": { type: "int", default: 50, needsRestart: false, description: "debounce for persisting coarse session metadata" },
  "session.auto_approve_command_patterns": {
    type: "string",
    default: "",
    needsRestart: false,
    description: "default session auto-approve command patterns CSV",
    validate: (value) => typeof value === "string" ? validateAutoApprovePatterns(value) : "expected string"
  },
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
      const raw = import_node_fs4.default.readFileSync(this.filePath, "utf8");
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
    import_node_fs4.default.mkdirSync(import_node_path4.default.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + ".tmp";
    import_node_fs4.default.writeFileSync(tmp, JSON.stringify(this.explicit, null, 2));
    import_node_fs4.default.renameSync(tmp, this.filePath);
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
  let parsed;
  switch (spec.type) {
    case "int": {
      const n = Number(raw);
      parsed = !Number.isFinite(n) || !Number.isInteger(n) ? { ok: false, error: `expected integer, got: ${raw}` } : { ok: true, value: n };
      break;
    }
    case "float": {
      const n = Number(raw);
      parsed = !Number.isFinite(n) ? { ok: false, error: `expected number, got: ${raw}` } : { ok: true, value: n };
      break;
    }
    case "bool": {
      if (raw === "true" || raw === "1") parsed = { ok: true, value: true };
      else if (raw === "false" || raw === "0") parsed = { ok: true, value: false };
      else parsed = { ok: false, error: `expected true/false, got: ${raw}` };
      break;
    }
    case "enum": {
      parsed = !spec.enumValues || !spec.enumValues.includes(raw) ? { ok: false, error: `expected one of: ${spec.enumValues?.join(" / ") ?? ""}` } : { ok: true, value: raw };
      break;
    }
    case "path":
    case "string":
    default:
      parsed = { ok: true, value: raw };
      break;
  }
  if (!parsed.ok) return parsed;
  if (!spec.validate) return parsed;
  const error = spec.validate(parsed.value);
  return error ? { ok: false, error } : parsed;
}
function isValidPersistedValue(value, spec) {
  const typeValid = (() => {
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
  })();
  if (!typeValid) return false;
  return !spec.validate || spec.validate(value) === null;
}

// src/cli/approval-validation.ts
var APPROVAL_ACTIONS = {
  "approval.command_execution": ["accept", "accept-session", "decline", "cancel"],
  "approval.file_change": ["accept", "accept-session", "decline", "cancel"],
  "approval.permissions": ["accept", "accept-session", "decline"],
  "approval.mcp_elicitation": ["accept", "decline", "cancel"]
};
function validateApprovalAction(kind, action) {
  const validActions = APPROVAL_ACTIONS[kind];
  if (!validActions) {
    return {
      ok: false,
      message: `unknown approval kind '${kind}'. Valid kinds: ${Object.keys(APPROVAL_ACTIONS).join(", ")}`
    };
  }
  if (validActions.includes(action)) {
    return { ok: true, validActions };
  }
  return {
    ok: false,
    validActions,
    message: `shortcut '${action}' is not valid for ${kind}; valid actions: ${validActions.join(", ")}`
  };
}

// src/version.ts
var import_node_path5 = __toESM(require("path"));
var PACKAGE_JSON_PATH = require.resolve("../package.json");
var pkg = require(PACKAGE_JSON_PATH);
var PACKAGE_ROOT = import_node_path5.default.dirname(PACKAGE_JSON_PATH);
var VERSION = pkg.version ?? "unknown";

// src/format/short.ts
function formatShort(method, data) {
  const value = asObject(data);
  let body;
  switch (method) {
    case "status":
      body = formatStatus(data);
      break;
    case "daemon:fleet:status":
      body = formatDaemonFleetStatus(data);
      break;
    case "daemon:status":
      body = formatDaemonStatus(data);
      break;
    case "daemon:user:list":
      body = formatDaemonUserList(data);
      break;
    case "session:health":
    case "session:health:all":
      body = formatSessionHealth(data);
      break;
    case "session:logs":
      body = formatSessionLogs(data);
      break;
    case "session:info":
      body = formatSessionInfo(data);
      break;
    case "session:list":
      body = formatSessionList(data);
      break;
    case "message:history":
      body = formatMessageHistory(data);
      break;
    default:
      throw new Error(`--short is not supported for '${method}'`);
  }
  const footerLines = extractFooterLines(method, value);
  return footerLines.length > 0 ? `${body}
${footerLines.join("\n")}` : body;
}
function formatStatus(data) {
  const value = asObject(data);
  const daemon = asObject(value.daemon);
  const retainedCount = formatScalar(value.retained_events);
  const retainedLimit = formatScalar(
    value.retained_limit ?? value.retention ?? value.event_log_retention ?? daemon.retained_limit
  );
  const appServers = formatScalar(value.app_server_count ?? daemon.app_server_count);
  return [
    `user=${formatScalar(value.token ?? value.user ?? value.name)}`,
    `live=${formatScalar(value.live_sessions)}`,
    `pending=${formatScalar(value.pending_requests)}`,
    `retained=${retainedCount}/${retainedLimit}`,
    `app_servers=${appServers}`,
    `daemon_age=${formatAgeFromDateish(daemon.started_at ?? value.started_at)}`
  ].join(" ");
}
function formatDaemonStatus(data) {
  const value = asObject(data);
  const distAge = value.dist_age_seconds;
  return [
    `pid=${formatScalar(value.pid)}`,
    `sock=${shortPath(asString(value.sock) ?? "unknown")}`,
    `age=${formatDaemonAge(value)}`,
    `sessions=${formatScalar(value.session_count ?? value.sessions)}`,
    `users=${formatScalar(value.user_count ?? value.users)}`,
    `dist_age=${typeof distAge === "number" && Number.isFinite(distAge) ? humanizeMs(distAge * 1e3) : "unknown"}`
  ].join(" ");
}
function formatDaemonFleetStatus(data) {
  const value = asObject(data);
  const users = Array.isArray(value.per_user) ? value.per_user : [];
  if (users.length === 0) return "(no users)";
  return users.map((entry) => {
    const user = asObject(entry);
    return [
      `user=${formatScalar(user.token)}`,
      `live=${formatCount(user.live)}`,
      `busy=${formatCount(user.busy)}`,
      `pending=${formatCount(user.pending)}`,
      `crashed=${formatCount(user.crashed)}`,
      `last_event=${formatNullableScalar(asString(user.last_event_id))}`,
      `last_seen=${formatFleetAge(user)}`
    ].join(" ");
  }).join("\n");
}
function formatDaemonAge(data) {
  if (typeof data.uptime_s === "number" && Number.isFinite(data.uptime_s)) {
    return humanizeMs(data.uptime_s * 1e3);
  }
  return formatAgeFromDateish(data.started_at);
}
function formatSessionInfo(data) {
  const value = asObject(data);
  const session = asObject(value.session);
  const thread = asObject(value.thread);
  const turn = resolveCurrentTurn(value, session, thread);
  const turnId = resolveCurrentTurnId(value, session, thread, turn);
  const turnIdKnown = hasCurrentTurnIdField(value, session, thread);
  const itemsInTurn = resolveItemsInTurn(value, session, thread, turn);
  const threadId = asString(session.thread_id) ?? asString(thread.id) ?? "unknown";
  return [
    sessionLabel(session, thread),
    `state=${sessionState(value, session, thread)}`,
    `thread=${shortId(threadId)}`,
    `model=${formatScalar(session.model ?? value.model ?? thread.model ?? thread.model_provider)}`,
    `busy=${busyFlag(value.busy ?? session.busy ?? thread.busy, turnId, turn, turnIdKnown)}`,
    `turn=${formatNullableScalar(turnId)}`,
    `items=${formatNullableCount(itemsInTurn)}`
  ].join(" ");
}
function formatSessionHealth(data) {
  const value = asObject(data);
  const sessions = Array.isArray(value.sessions) ? value.sessions : null;
  if (sessions) {
    if (sessions.length === 0) return "(no sessions)";
    return sessions.map((entry) => formatSessionHealthEntry(asObject(entry))).join("\n");
  }
  return formatSessionHealthEntry(value);
}
function formatSessionList(data) {
  const value = asObject(data);
  const sessions = Array.isArray(value.sessions) ? value.sessions : [];
  if (sessions.length === 0) return "(no sessions)";
  return sessions.map((entry) => {
    const session = asObject(entry);
    const turn = resolveCurrentTurn(session, session, session);
    const turnId = resolveCurrentTurnId(session, session, session, turn);
    const turnIdKnown = hasCurrentTurnIdField(session, session, session);
    return [
      sessionLabel(session, session),
      sessionState(session, session, session),
      formatScalar(session.model ?? session.model_provider),
      `busy=${busyFlag(session.busy, turnId, turn, turnIdKnown)}`
    ].join("  ");
  }).join("\n");
}
function formatSessionLogs(data) {
  const value = asObject(data);
  const lines = Array.isArray(value.lines) ? value.lines : [];
  if (lines.length === 0) return "(no logs)";
  return lines.map((entry) => {
    const line = asObject(entry);
    return [
      formatScalar(line.ts),
      formatScalar(line.stream),
      formatScalar(line.line)
    ].join(" ");
  }).join("\n");
}
function formatDaemonUserList(data) {
  const value = asObject(data);
  const users = Array.isArray(value.users) ? value.users : [];
  if (users.length === 0) return "(no users)";
  return users.map((entry) => {
    const user = asObject(entry);
    const live = user.live_sessions ?? user.live_count ?? user.session_count ?? user.live;
    return [
      shortTokenPrefix(user.token),
      `name=${formatScalar(user.name ?? user.token)}`,
      `live=${formatCount(live)}`,
      `last_seen=${formatAgeFromDateish(user.last_active_at ?? user.created_at)}`
    ].join(" ");
  }).join("\n");
}
function formatMessageHistory(data) {
  const value = asObject(data);
  const turns = Array.isArray(value.turns) ? value.turns : [];
  if (turns.length === 0) return "(no turns)";
  return turns.map((entry) => {
    const turn = asObject(entry);
    return [
      formatScalar(turn.id),
      formatScalar(turn.status),
      formatTurnDuration(turn),
      `items=${formatCount(turn.items && Array.isArray(turn.items) ? turn.items.length : turn.item_count ?? turn.itemCount)}`
    ].join(" ");
  }).join("\n");
}
function formatSessionHealthEntry(session) {
  return [
    formatScalar(session.session ?? session.name),
    `state=${formatScalar(session.state)}`,
    `busy=${busyFlag(session.busy, asString(session.current_turn_id), null, hasOwn(session, "current_turn_id"))}`,
    `pending=${formatCount(numericValue(session.pending_approval_requests) + numericValue(session.pending_user_input_requests))}`,
    `app_server=${booleanFlag(session.app_server_alive)}`,
    `turn=${formatNullableScalar(asString(session.current_turn_id))}`
  ].join(" ");
}
function formatAgeFromDateish(value) {
  const date = parseDate(value);
  if (!date) return "unknown";
  return humanizeMs(Math.max(0, Date.now() - date.getTime()));
}
function formatFleetAge(value) {
  const ageSeconds = asFiniteNumber(value.last_activity_age_s);
  if (ageSeconds !== null) return humanizeMs(ageSeconds * 1e3);
  return formatAgeFromDateish(value.last_active_at ?? value.created_at);
}
function humanizeMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1e3) return `${Math.floor(ms)}ms`;
  const seconds = Math.floor(ms / 1e3);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
function shortPath(value) {
  if (value.length <= 28) return value;
  return `...${value.slice(-25)}`;
}
function shortId(value) {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
function sessionLabel(session, thread) {
  return formatScalar(session.name ?? thread.name ?? thread.id);
}
function sessionState(root, session, thread) {
  const status2 = session.state ?? extractStatus(thread.status) ?? (root.live === false ? "retained" : void 0);
  return formatScalar(status2);
}
function extractStatus(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = value.type;
    return typeof type === "string" && type.length > 0 ? type : null;
  }
  return null;
}
function resolveCurrentTurn(root, session, thread) {
  const candidate = root.current_turn ?? root.turn ?? session.current_turn ?? session.turn ?? thread.current_turn ?? thread.turn;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate;
  }
  return null;
}
function busyFlag(value, turnId, turn, turnIdKnown) {
  if (value === true) return "y";
  if (value === false) return "n";
  if (turnId) return "y";
  if (turnIdKnown) return "n";
  if (turn) return "y";
  return "unknown";
}
function resolveCurrentTurnId(root, session, thread, turn) {
  const direct = asString(
    root.current_turn_id ?? root.currentTurnId ?? session.current_turn_id ?? session.currentTurnId ?? thread.current_turn_id ?? thread.currentTurnId
  );
  if (direct) return direct;
  if (!turn) return null;
  return asString(turn.id ?? turn.turn_id ?? turn.turnId);
}
function resolveItemsInTurn(root, session, thread, turn) {
  const direct = asFiniteNumber(
    root.items_in_turn ?? root.itemsInTurn ?? session.items_in_turn ?? session.itemsInTurn ?? thread.items_in_turn ?? thread.itemsInTurn
  );
  if (direct !== null) return direct;
  if (!turn) return null;
  if (Array.isArray(turn.items)) return turn.items.length;
  const count = asFiniteNumber(turn.item_count ?? turn.itemCount ?? turn.items_count);
  return count ?? null;
}
function formatTurnDuration(turn) {
  const direct = turn.durationMs ?? turn.duration_ms;
  if (typeof direct === "number" && Number.isFinite(direct)) return humanizeMs(direct);
  const started = asFiniteNumber(turn.startedAt ?? turn.started_at);
  const completed = asFiniteNumber(turn.completedAt ?? turn.completed_at);
  if (started !== null && completed !== null && completed >= started) {
    return humanizeMs(completed - started);
  }
  return "unknown";
}
function formatCount(value) {
  if (Array.isArray(value)) return String(value.length);
  return formatScalar(value);
}
function formatNullableCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  return "unknown";
}
function formatNullableScalar(value) {
  return value ?? "unknown";
}
function parseDate(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}
function asString(value) {
  if (Array.isArray(value)) return asString(value[value.length - 1]);
  return typeof value === "string" && value.length > 0 ? value : null;
}
function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function hasCurrentTurnIdField(...records) {
  return records.some(
    (record) => hasOwn(record, "current_turn_id") || hasOwn(record, "currentTurnId")
  );
}
function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}
function formatScalar(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "unknown";
}
function booleanFlag(value) {
  if (value === true) return "y";
  if (value === false) return "n";
  return "unknown";
}
function numericValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function shortTokenPrefix(token) {
  const encoded = typeof token === "string" && token.length > 0 ? encodeToken(token) : "unknown";
  return `${encoded.slice(0, 10)}...`;
}
function extractFooterLines(method, value) {
  switch (method) {
    case "session:list":
      return extractSessionListFooters(value);
    case "message:history":
      return extractMessageHistoryFooters(value);
    default:
      return [];
  }
}
function extractSessionListFooters(value) {
  const nextCursor = asString(value.next_cursor);
  const includeContract = value.all === true || nextCursor !== null;
  if (!includeContract) return [];
  const fields = [
    ["next_cursor", nextCursor],
    ["all", value.all],
    ["sort", asString(value.sort)],
    ["format", asString(value.format)]
  ];
  const footer = formatFooterLine(fields);
  return footer ? [footer] : [];
}
function extractMessageHistoryFooters(value) {
  const lines = [];
  const meta = formatFooterLine([
    ["next_cursor", asString(value.next_cursor)],
    ["relative_since", asFiniteNumber(value.relative_since)],
    ["format", asString(value.format)]
  ]);
  if (meta) lines.push(meta);
  const note = asString(value.note);
  if (note) {
    const noteLine = formatFooterLine([["note", note]]);
    if (noteLine) lines.push(noteLine);
  }
  return lines;
}
function formatFooterLine(entries) {
  const parts = entries.flatMap(([key, value]) => {
    const encoded = encodeFooterValue(value);
    return encoded === null ? [] : [`${key}=${encoded}`];
  });
  return parts.length > 0 ? `# ${parts.join(" ")}` : null;
}
function encodeFooterValue(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "string" && value.length === 0) return null;
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : null;
}

// src/format/compact.ts
function formatCompact(method, data) {
  switch (method) {
    case "version":
      return pickFields(data, ["daemon_version"]);
    case "status":
      return pickFields(data, [
        "token",
        "live_sessions",
        "retained_events",
        "retained_limit",
        "pending_requests",
        "app_server_count"
      ]);
    case "daemon:fleet:status":
      return compactDaemonFleetStatus(data);
    case "daemon:status":
      return pickFields(data, [
        "pid",
        "version",
        "uptime_s",
        "sock",
        "session_count",
        "user_count",
        "app_server_count",
        "dist_age_seconds",
        "source_newer_than_dist"
      ]);
    case "daemon:start":
      return pickFields(data, ["already_running"]);
    case "daemon:stop":
      return pickFields(data, ["stopping", "force"]);
    case "daemon:restart":
      return pickFields(data, ["restarting"]);
    case "daemon:logs":
      return asObject2(data);
    case "daemon:user:create":
      return pickFields(data, ["token"]);
    case "daemon:user:destroy":
      return pickFields(data, ["destroyed"]);
    case "daemon:user:list":
      return compactDaemonUserList(data);
    case "daemon:config:get":
      return pickFields(data, ["key", "value", "default", "source", "needs_restart"]);
    case "daemon:config:set":
      return pickFields(data, ["key", "value", "needs_restart"]);
    case "daemon:config:unset":
      return pickFields(data, ["key", "needs_restart"]);
    case "daemon:config:list":
      return compactDaemonConfigList(data);
    case "daemon:config:reset":
      return pickFields(data, ["reset"]);
    case "session:new":
      return compactSessionWithFlags(data, {
        sessionOptions: { includeCreatedAt: true }
      });
    case "session:attach":
      return compactSessionWithFlags(data, {
        sessionOptions: {},
        extraKeys: ["noop"]
      });
    case "session:detach":
      return compactSessionDetach(data);
    case "session:archive":
      return pickFields(data, ["thread_id", "archived"]);
    case "session:unarchive":
      return pickFields(data, ["thread_id", "unarchived"]);
    case "session:fork":
      return compactSessionWithFlags(data, {
        sessionOptions: {}
      });
    case "session:rename":
      return compactSessionWithFlags(data, {
        sessionOptions: { nameOnly: true }
      });
    case "session:rollback":
      return pickFields(data, ["name", "forked_at_turn", "old_thread_id", "new_thread_id"]);
    case "session:info":
      return compactSessionInfo(data);
    case "session:context":
      return compactSessionContext(data);
    case "session:list":
      return compactSessionList(data);
    case "session:health":
      return pickFields(data, [
        "session",
        "thread_id",
        "state",
        "busy",
        "current_turn_id",
        "current_turn_elapsed_ms",
        "current_item_type",
        "items_done_in_turn",
        "pending_approval_requests",
        "pending_user_input_requests",
        "app_server_alive",
        "last_event_id"
      ]);
    case "session:health:all":
      return compactSessionHealthAll(data);
    case "session:events":
      return asObject2(data);
    case "session:logs":
      return compactSessionLogs(data);
    case "session:heal":
      return compactSessionHeal(data);
    case "message:send":
      return pickFields(data, ["turn_id", "started", "queue_id", "queued_depth"]);
    case "message:send-many":
      return compactBatchResults(data, ["turn_id", "started", "queue_id", "queued_depth"]);
    case "message:peer":
      return pickFields(data, ["turn_id", "peered"]);
    case "message:interrupt":
      return pickFields(data, ["turn_id", "interrupted"]);
    case "message:approval":
    case "message:answer":
      return {};
    case "message:history":
      return compactMessageHistory(data);
    case "message:tail":
      return compactMessageTail(data);
    case "message:wait":
      return compactMessageWait(data);
    case "monitor:events":
      return compactMonitorEvent(data);
    case "monitor:alarm":
      return asObject2(data);
    case "cursor:save":
      return compactCursorSave(data);
    case "cursor:list":
      return compactCursorList(data);
    case "cursor:get":
      return pickFields(data, ["event_id"]);
    case "cursor:delete":
      return pickFields(data, ["deleted", "name"]);
    default:
      return asObject2(data);
  }
}
function compactDaemonUserList(data) {
  const value = asObject2(data);
  return {
    users: asArray(value.users).map((entry) => pickFields(entry, ["token"]))
  };
}
function compactDaemonConfigList(data) {
  const value = asObject2(data);
  return {
    config: asArray(value.config).map((entry) => pickFields(entry, [
      "key",
      "value",
      "default",
      "explicit",
      "needs_restart",
      "type"
    ]))
  };
}
function compactDaemonFleetStatus(data) {
  const value = asObject2(data);
  return {
    total_users: value.total_users,
    total_live_sessions: value.total_live_sessions,
    total_pending: value.total_pending,
    total_app_servers: value.total_app_servers,
    per_user: asArray(value.per_user).map((entry) => pickFields(entry, [
      "token",
      "live",
      "busy",
      "pending",
      "crashed",
      "last_event_id",
      "last_activity_age_s"
    ]))
  };
}
function compactSessionWithFlags(data, options) {
  const value = asObject2(data);
  const out = {};
  if (hasOwn2(value, "session")) {
    if (value.session === null && options.allowNullSession) {
      out.session = null;
    } else {
      out.session = projectSession(value.session, options.sessionOptions);
    }
  }
  for (const key of options.extraKeys ?? []) {
    copyIfPresent(out, value, key);
  }
  return out;
}
function compactSessionInfo(data) {
  const value = asObject2(data);
  if (value.session === null) {
    const out = { session: null };
    copyIfPresent(out, value, "live");
    const thread = projectThread(value.thread);
    if (Object.keys(thread).length > 0) out.thread = thread;
    return out;
  }
  return compactSessionWithFlags(data, {
    sessionOptions: {
      includeModel: true,
      includeTurnCount: true,
      includeCurrentTurnId: true,
      includeItemsInTurn: true,
      includePendingApprovals: true,
      includePendingUserInputs: true
    }
  });
}
function compactSessionDetach(data) {
  const value = asObject2(data);
  if (Array.isArray(value.results)) {
    return compactBatchResults(data, ["detached", "graceful"]);
  }
  return compactSessionWithFlags(data, {
    sessionOptions: {},
    extraKeys: ["noop", "graceful"],
    allowNullSession: true
  });
}
function compactSessionContext(data) {
  const value = asObject2(data);
  const out = pickFields(value, ["thread_id"]);
  const thread = projectThread(value.thread);
  if (Object.keys(thread).length > 0) out.thread = thread;
  return out;
}
function compactSessionLogs(data) {
  const value = asObject2(data);
  return pickFields(value, ["session", "state", "lines", "truncated_from"]);
}
function compactSessionList(data) {
  const value = asObject2(data);
  const remote = value.all === true || value.loaded_only === true;
  const out = {
    sessions: asArray(value.sessions).map((entry) => remote ? projectSession(entry, {
      includeModel: true,
      includeBusy: true
    }) : projectSession(entry, {
      includeModel: true,
      includeTurnCount: true,
      includeCurrentTurnId: true
    }))
  };
  copyIfPresent(out, value, "all");
  if (value.loaded_only === true) copyIfPresent(out, value, "loaded_only");
  if (remote) copyIfPresent(out, value, "next_cursor");
  return out;
}
function compactSessionHeal(data) {
  const value = asObject2(data);
  const out = {};
  if (hasOwn2(value, "session")) out.session = projectSession(value.session, {});
  copyIfPresent(out, value, "healed");
  copyIfPresent(out, value, "note");
  return out;
}
function compactSessionHealthAll(data) {
  const value = asObject2(data);
  return {
    summary: pickFields(value.summary, ["total", "healthy", "crashed", "closed", "busy", "pending_total"]),
    sessions: asArray(value.sessions).map((entry) => pickFields(entry, [
      "session",
      "thread_id",
      "state",
      "busy",
      "current_turn_id",
      "current_turn_elapsed_ms",
      "current_item_type",
      "items_done_in_turn",
      "pending_approval_requests",
      "pending_user_input_requests",
      "app_server_alive",
      "last_event_id"
    ]))
  };
}
function compactMessageHistory(data) {
  const value = asObject2(data);
  const out = {
    session: value.session,
    thread_id: value.thread_id,
    turns: asArray(value.turns)
  };
  copyIfPresent(out, value, "next_cursor");
  copyIfPresent(out, value, "relative_since");
  return stripUndefined(out);
}
function compactMessageTail(data) {
  const value = asObject2(data);
  const out = {
    session: value.session,
    turns: asArray(value.turns)
  };
  copyIfPresent(out, value, "follow");
  const thread = projectThread(value.thread);
  if (Object.keys(thread).length > 0) out.thread = thread;
  return stripUndefined(out);
}
function compactMessageWait(data) {
  const value = asObject2(data);
  if (Array.isArray(value.outcomes)) {
    return stripUndefined({
      outcomes: asArray(value.outcomes).map((entry) => pickFields(entry, [
        "session",
        "outcome",
        "turn_id",
        "codex_error_info"
      ])),
      overall: value.overall
    });
  }
  if (Array.isArray(value.still_running)) {
    return stripUndefined({
      session: value.session,
      outcome: value.outcome,
      turn_id: value.turn_id,
      codex_error_info: value.codex_error_info,
      timeout_s: value.timeout_s,
      still_running: asArray(value.still_running)
    });
  }
  return pickFields(data, [
    "thread_id",
    "turn_id",
    "outcome",
    "event_type",
    "event_id",
    "error",
    "duration_ms",
    "items_count",
    "timeout_s"
  ]);
}
function compactBatchResults(data, successKeys) {
  const value = asObject2(data);
  return {
    results: asArray(value.results).map((entry) => projectBatchResultEntry(entry, successKeys))
  };
}
function compactMonitorEvent(data) {
  const value = asObject2(data);
  if (!hasOwn2(value, "payload")) {
    return stripUndefined({
      id: value.id,
      ts: value.ts,
      type: value.type,
      session: value.session,
      thread_id: value.thread_id,
      key: value.key
    });
  }
  return stripUndefined({
    id: value.id,
    ts: value.ts,
    type: value.type,
    session: value.session,
    thread_id: value.thread_id,
    key: summarizeEventKey(value)
  });
}
function compactCursorSave(data) {
  const value = asObject2(data);
  return {
    cursor: projectCursor(value.cursor, { includeUpdatedAt: false, includeAutoUpdate: false })
  };
}
function compactCursorList(data) {
  const value = asObject2(data);
  return {
    cursors: asArray(value.cursors).map((entry) => projectCursor(entry, {
      includeUpdatedAt: true,
      includeAutoUpdate: true
    }))
  };
}
function projectSession(value, options) {
  const session = asObject2(value);
  if (options.nameOnly) {
    return pickFields(session, ["name"]);
  }
  const out = pickFields(session, ["name", "thread_id", "state"]);
  if (options.includeCreatedAt) copyIfPresent(out, session, "created_at");
  if (options.includeModel) copyIfPresent(out, session, "model");
  if (options.includeTurnCount) copyIfPresent(out, session, "turn_count");
  if (options.includeCurrentTurnId) copyIfPresent(out, session, "current_turn_id");
  if (options.includeItemsInTurn) copyIfPresent(out, session, "items_in_turn");
  if (options.includePendingApprovals) copyIfPresent(out, session, "pending_approvals");
  if (options.includePendingUserInputs) copyIfPresent(out, session, "pending_user_inputs");
  if (options.includeBusy) copyIfPresent(out, session, "busy");
  return out;
}
function projectThread(value) {
  const thread = asObject2(value);
  const out = pickFields(thread, [
    "id",
    "name",
    "cwd",
    "source",
    "model_provider",
    "created_at",
    "updated_at"
  ]);
  const status2 = extractStatus2(thread.status);
  if (status2) out.status = status2;
  return out;
}
function projectCursor(value, options) {
  const cursor = asObject2(value);
  const out = pickFields(cursor, ["name", "event_id"]);
  if (options.includeUpdatedAt) copyIfPresent(out, cursor, "updated_at");
  if (options.includeAutoUpdate) copyIfPresent(out, cursor, "auto_update");
  return out;
}
function projectBatchResultEntry(value, successKeys) {
  const entry = asObject2(value);
  if (entry.ok === false) {
    const error = asObject2(entry.error);
    return stripUndefined({
      session: entry.session,
      ok: false,
      error: Object.keys(error).length > 0 ? pickFields(error, ["code"]) : void 0
    });
  }
  return pickFields(entry, ["session", ...successKeys]);
}
function summarizeEventKey(event) {
  const payload = asObject2(event.payload);
  const type = asString2(event.type);
  if (!type) return null;
  if (type.startsWith("turn.")) return scalarString(payload.turn_id);
  if (type === "session.crashed" || type === "session.closed") {
    return labeledSummaryValue("reason", payload.reason ?? payload.crash_reason ?? payload.why);
  }
  if (type === "auto_approved") {
    return labeledSummaryValue("matched_pattern", payload.matched_pattern ?? payload.matchedPattern) ?? scalarString(payload.request_id);
  }
  if (type.startsWith("approval.") || type === "user_input.request" || type === "server_request_resolved") {
    return scalarString(payload.request_id);
  }
  if (type.startsWith("item.")) {
    return scalarString(payload.type) ?? scalarString(payload.item_type) ?? scalarString(payload.item_id);
  }
  if (type.startsWith("thread.")) return scalarString(payload.thread_id) ?? scalarString(event.thread_id);
  if (type.startsWith("hook.")) return scalarString(payload.hook_id);
  if (type.startsWith("mcp_server.")) return scalarString(payload.name);
  if (type.startsWith("fuzzy_file_search.")) return scalarString(payload.search_session_id);
  if (type === "monitor.overflow") return scalarString(payload.dropped_count);
  return scalarString(payload.turn_id) ?? scalarString(payload.request_id) ?? scalarString(payload.type) ?? scalarString(payload.item_id) ?? scalarString(payload.thread_id) ?? scalarString(payload.name) ?? scalarString(event.thread_id);
}
function labeledSummaryValue(label, value) {
  const rendered = scalarString(value);
  return rendered ? `${label}=${rendered}` : null;
}
function extractStatus2(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const type = value.type;
    return typeof type === "string" && type.length > 0 ? type : null;
  }
  return null;
}
function pickFields(value, keys) {
  const record = asObject2(value);
  const out = {};
  for (const key of keys) copyIfPresent(out, record, key);
  return out;
}
function copyIfPresent(target, source, key) {
  if (hasOwn2(source, key)) target[key] = source[key];
}
function stripUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== void 0));
}
function asObject2(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function asString2(value) {
  if (Array.isArray(value)) return asString2(value[value.length - 1]);
  return typeof value === "string" && value.length > 0 ? value : null;
}
function scalarString(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
function hasOwn2(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// src/cli/doctor.ts
var import_node_fs7 = __toESM(require("fs"));
var import_node_net3 = __toESM(require("net"));
var import_node_path7 = __toESM(require("path"));
var import_node_child_process2 = require("child_process");

// src/daemon/processes.ts
var import_node_fs5 = __toESM(require("fs"));
var import_node_child_process = require("child_process");
function readLinuxCmdline(pid) {
  try {
    const raw = import_node_fs5.default.readFileSync(`/proc/${pid}/cmdline`);
    const commandLine = raw.toString("utf8").replace(/\0/g, " ").trim() || null;
    return { commandLine, source: "proc", reliable: true };
  } catch {
    return { commandLine: null, source: null, reliable: false };
  }
}
function readLinuxStartTime(pid) {
  try {
    const raw = import_node_fs5.default.readFileSync(`/proc/${pid}/stat`, "utf8");
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
    const raw = (0, import_node_child_process.execFileSync)("ps", ["-p", String(pid), "-o", "command="], {
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
    const raw = (0, import_node_child_process.execFileSync)("ps", ["-p", String(pid), "-o", "lstart="], {
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
      const raw = (0, import_node_child_process.execFileSync)(bin, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8"
      });
      const commandLine = raw.trim();
      if (commandLine.length > 0) return { commandLine, source: "powershell", reliable: true };
    } catch {
    }
  }
  try {
    const raw = (0, import_node_child_process.execFileSync)("wmic", ["process", "where", `processid=${pid}`, "get", "CommandLine", "/value"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    const line = raw.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("CommandLine="));
    const commandLine = line?.slice("CommandLine=".length).trim() ?? "";
    if (commandLine.length > 0) return { commandLine, source: "wmic", reliable: true };
  } catch {
  }
  try {
    const raw = (0, import_node_child_process.execFileSync)("tasklist", ["/FO", "LIST", "/NH", "/FI", `PID eq ${pid}`], {
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
      const raw = (0, import_node_child_process.execFileSync)(bin, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8"
      });
      const startTime = raw.trim();
      if (startTime.length > 0) return startTime;
    } catch {
    }
  }
  try {
    const raw = (0, import_node_child_process.execFileSync)("wmic", ["process", "where", `processid=${pid}`, "get", "CreationDate", "/value"], {
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

// src/ipc/socket-bind-probe.ts
var import_node_fs6 = __toESM(require("fs"));
var import_node_net2 = __toESM(require("net"));
var import_node_path6 = __toESM(require("path"));
function buildSocketBindProbePath(sockPath) {
  const endpoint = normalizeSockPath(sockPath);
  if (!isFilesystemSockPath(sockPath)) {
    return `${endpoint}-probe-${process.pid}-${Date.now()}`;
  }
  const parentDir = import_node_path6.default.dirname(endpoint);
  const baseName = import_node_path6.default.basename(endpoint, import_node_path6.default.extname(endpoint)) || "daemon";
  return import_node_path6.default.join(parentDir, `${baseName}-probe-${process.pid}-${Date.now()}.sock`);
}
async function probeSocketBind(sockPath, deps = {
  fs: import_node_fs6.default,
  createServer: import_node_net2.default.createServer
}) {
  const probedPath = buildSocketBindProbePath(sockPath);
  const endpoint = normalizeSockPath(probedPath);
  const server = deps.createServer();
  const cleanup = async () => {
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    if (isFilesystemSockPath(probedPath)) {
      try {
        deps.fs.unlinkSync(endpoint);
      } catch {
      }
    }
  };
  if (isFilesystemSockPath(probedPath)) {
    deps.fs.mkdirSync(import_node_path6.default.dirname(endpoint), { recursive: true });
    try {
      deps.fs.unlinkSync(endpoint);
    } catch {
    }
  }
  const listenResult = await new Promise((resolve) => {
    const onError = (error) => {
      server.off("listening", onListening);
      resolve({ ok: false, error });
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({ ok: true });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(endpoint);
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      resolve({ ok: false, error });
    }
  });
  if (!listenResult.ok) {
    await cleanup();
    return {
      ok: false,
      probedPath,
      error: listenResult.error
    };
  }
  await cleanup();
  return {
    ok: true,
    probedPath
  };
}

// src/cli/doctor.ts
var DEFAULT_DEPS = {
  fs: import_node_fs7.default,
  spawnSync: import_node_child_process2.spawnSync,
  createServer: import_node_net3.default.createServer,
  createConnection: import_node_net3.default.createConnection,
  kill: process.kill.bind(process),
  isLikelyCodexTeamDaemonProcess
};
function buildDoctorContext(options = {}) {
  const config = new ConfigStore();
  const dataDir = options.dataDir ?? config.resolvedDataDir();
  const sockPath = options.sockPath ?? (options.dataDir ? defaultSockPath(dataDir) : config.resolvedSockPath());
  return {
    packageRoot: options.packageRoot ?? PACKAGE_ROOT,
    dataDir,
    sockPath,
    pidPath: pidFilePath(dataDir),
    launcherPath: import_node_path7.default.join(options.packageRoot ?? PACKAGE_ROOT, "bin", "codex-team"),
    pathEnv: options.pathEnv ?? process.env.PATH
  };
}
function checkNode() {
  const version2 = process.versions.node || "unknown";
  const major = Number.parseInt(version2.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 18) {
    return fail("node", `node version ${version2}, need >=18`);
  }
  return ok2("node", `node=${version2}`);
}
function checkCodexBin(_ctx, deps = DEFAULT_DEPS) {
  const result = deps.spawnSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) {
    const err2 = result.error;
    if (err2.code === "ENOENT") return fail("codex", "codex binary not found on PATH");
    return fail("codex", `codex --version errored: ${err2.message}`);
  }
  if (result.status !== 0) {
    return fail("codex", `codex --version errored: ${formatSpawnFailure(result)}`);
  }
  const version2 = firstLine(result.stdout) || firstLine(result.stderr) || "unknown";
  return ok2("codex", `codex=${version2}`);
}
function checkLauncherOnPath(ctx, deps = DEFAULT_DEPS) {
  const resolved = resolveOnPath("codex-team", ctx.pathEnv, deps.fs);
  if (resolved) {
    return ok2("path", `codex-team=${resolved}`);
  }
  return warn("path", `codex-team not on PATH; use ${ctx.launcherPath}`);
}
function checkDataDirWritable(ctx, deps = DEFAULT_DEPS) {
  const testPath = import_node_path7.default.join(ctx.dataDir, ".doctor-write-test");
  try {
    deps.fs.mkdirSync(ctx.dataDir, { recursive: true });
    deps.fs.writeFileSync(testPath, "ok");
    deps.fs.unlinkSync(testPath);
    return ok2("data_dir", `data_dir=${ctx.dataDir} writable`);
  } catch (e) {
    try {
      deps.fs.unlinkSync(testPath);
    } catch {
    }
    return fail("data_dir", `data_dir not writable: ${ctx.dataDir}`);
  }
}
async function checkSocketBind(ctx, deps = DEFAULT_DEPS) {
  const result = await probeSocketBind(ctx.sockPath, {
    fs: deps.fs,
    createServer: deps.createServer
  });
  if (!result.ok) {
    const code = result.error?.code ?? "UNKNOWN";
    if (code === "EPERM" || code === "EACCES") {
      return fail("socket_bind", `socket_bind ${code} - sandbox forbids listen(); codex-team won't work here`);
    }
    return fail("socket_bind", `socket_bind ${code} - listen() failed: ${result.error?.message ?? "unknown error"}`);
  }
  return ok2("socket_bind", "socket_bind permitted");
}
function checkDaemonPid(ctx, deps = DEFAULT_DEPS) {
  const record = readPidRecord(ctx.pidPath, deps.fs);
  if (!record) {
    return {
      ...ok2("daemon_pid", "daemon not running (will auto-spawn on first `-b` call)"),
      daemonState: "not_running",
      pid: null
    };
  }
  const alive = isPidReachable(record.pid, deps.kill);
  const isDaemon = alive && deps.isLikelyCodexTeamDaemonProcess(record.pid);
  if (isDaemon) {
    return {
      ...ok2("daemon_pid", `daemon running, pid=${record.pid}`),
      daemonState: "running",
      pid: record.pid
    };
  }
  const reason = alive ? `pid ${record.pid} is not a codex-team daemon` : `pid ${record.pid} is not running`;
  return {
    ...warn("daemon_pid", `stale pidfile: ${reason}. Safe to remove manually: \`rm ${ctx.pidPath}\``),
    daemonState: "not_running",
    pid: record.pid
  };
}
async function checkDaemonSocket(ctx, pidResult, deps = DEFAULT_DEPS) {
  if (pidResult.daemonState !== "running") {
    return skip("daemon_socket", "daemon_socket (daemon not running)");
  }
  const result = await connectSockOnce(ctx.sockPath, 2e3, deps.createConnection);
  if (result.ok) {
    return ok2("daemon_socket", "daemon_socket reachable");
  }
  const code = result.code ?? "UNKNOWN";
  return fail("daemon_socket", `daemon_socket ${code} - ${interpretSocketConnectError(code, result.message)}`);
}
function checkDistFreshness(ctx, deps = DEFAULT_DEPS) {
  const distPath = import_node_path7.default.join(ctx.packageRoot, "dist", "main.js");
  const distStat = statIfExists(distPath, deps.fs);
  if (!distStat) {
    return warn("dist", "dist missing; run `npm run build` in plugins/codex-team");
  }
  const sourceNewest = newestMtime(import_node_path7.default.join(ctx.packageRoot, "src"), deps.fs);
  if (sourceNewest !== null && sourceNewest > distStat.mtimeMs) {
    return warn("dist", "source newer than dist; run `npm run build` in plugins/codex-team");
  }
  return ok2("dist", "dist current");
}
async function runDoctor(options = {}, deps = DEFAULT_DEPS) {
  const ctx = buildDoctorContext(options);
  const write = options.write ?? ((line) => process.stdout.write(line));
  const results = [];
  results.push(checkNode());
  results.push(checkCodexBin(ctx, deps));
  results.push(checkLauncherOnPath(ctx, deps));
  results.push(checkDataDirWritable(ctx, deps));
  results.push(await checkSocketBind(ctx, deps));
  const daemonPid = checkDaemonPid(ctx, deps);
  results.push(daemonPid);
  results.push(await checkDaemonSocket(ctx, daemonPid, deps));
  results.push(checkDistFreshness(ctx, deps));
  const verdict = summarizeVerdict(results);
  if (options.short) {
    const failed = summarizeIds(results, "fail");
    const warned = summarizeIds(results, "warn");
    write(`doctor=${verdict} failed=${failed} warned=${warned}
`);
    return exitCodeForVerdict(verdict);
  }
  for (const result of results) {
    write(`[${renderStatus(result.status)}] ${result.message}
`);
  }
  write(`=== ${verdict} ===
`);
  return exitCodeForVerdict(verdict);
}
function summarizeVerdict(results) {
  if (results.some((result) => result.status === "fail")) return "BROKEN";
  if (results.some((result) => result.status === "warn")) return "DEGRADED";
  return "HEALTHY";
}
function summarizeIds(results, status2) {
  const ids = results.filter((result) => result.status === status2).map((result) => result.id);
  return ids.length > 0 ? ids.join(",") : "none";
}
function exitCodeForVerdict(verdict) {
  if (verdict === "BROKEN") return 2;
  if (verdict === "DEGRADED") return 1;
  return 0;
}
function renderStatus(status2) {
  switch (status2) {
    case "warn":
      return "WARN";
    case "fail":
      return "FAIL";
    case "skip":
      return "SKIP";
    case "ok":
    default:
      return "OK";
  }
}
function ok2(id, message) {
  return { id, status: "ok", message };
}
function warn(id, message) {
  return { id, status: "warn", message };
}
function fail(id, message) {
  return { id, status: "fail", message };
}
function skip(id, message) {
  return { id, status: "skip", message };
}
function resolveOnPath(command, pathEnv, doctorFs) {
  const segments = (pathEnv ?? "").split(import_node_path7.default.delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? windowsExecutableCandidates(command) : [command];
  for (const segment of segments) {
    for (const candidate of candidates) {
      const target = import_node_path7.default.join(segment, candidate);
      try {
        const stat = doctorFs.statSync(target);
        if (!stat.isFile()) continue;
        if (process.platform === "win32" || (stat.mode & 73) !== 0) return target;
      } catch {
      }
    }
  }
  return null;
}
function windowsExecutableCandidates(command) {
  const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((entry) => entry.trim()).filter(Boolean);
  if (/\.[^./\\]+$/.test(command)) return [command];
  return [command, ...pathext.map((ext) => `${command}${ext.toLowerCase()}`), ...pathext.map((ext) => `${command}${ext.toUpperCase()}`)];
}
function readPidRecord(pidPath, doctorFs) {
  try {
    const raw = doctorFs.readFileSync(pidPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: Math.floor(parsed.pid) };
  } catch {
    return null;
  }
}
function isPidReachable(pid, kill) {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function statIfExists(target, doctorFs) {
  try {
    return doctorFs.statSync(target);
  } catch {
    return null;
  }
}
function newestMtime(target, doctorFs) {
  const stat = statIfExists(target, doctorFs);
  if (!stat) return null;
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = null;
  let entries;
  try {
    entries = doctorFs.readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const childNewest = newestMtime(import_node_path7.default.join(target, entry.name), doctorFs);
    if (childNewest !== null && (newest === null || childNewest > newest)) {
      newest = childNewest;
    }
  }
  return newest;
}
function firstLine(value) {
  const text = typeof value === "string" ? value : value ? value.toString("utf8") : "";
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}
function formatSpawnFailure(result) {
  const signal = result.signal ? `signal ${result.signal}` : null;
  const status2 = typeof result.status === "number" ? `exit ${result.status}` : null;
  const detail = firstLine(result.stderr) || firstLine(result.stdout);
  return [status2 ?? signal ?? "unknown failure", detail].filter(Boolean).join(": ");
}
function connectSockOnce(sockPath, timeoutMs, createConnection) {
  return new Promise((resolve) => {
    const sock = createConnection(normalizeSockPath(sockPath));
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, code: "ETIMEDOUT", message: `connect timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref();
    sock.once("connect", () => finish({ ok: true }));
    sock.once("error", (error) => {
      finish({ ok: false, code: error.code, message: error.message });
    });
  });
}
function interpretSocketConnectError(code, message) {
  switch (code) {
    case "ENOENT":
      return "sock file missing";
    case "ECONNREFUSED":
      return "sock exists but nothing is accepting connections";
    case "EACCES":
    case "EPERM":
      return "permission denied while connecting";
    case "ETIMEDOUT":
      return message;
    default:
      return message || "connect failed";
  }
}

// src/cli/run.ts
var DAEMON_POLL_INTERVAL_MS = 100;
var DEFAULT_DAEMON_READY_TIMEOUT_MS = 15e3;
var DEFAULT_DAEMON_CONNECT_TIMEOUT_MS = 5e3;
var DEFAULT_DAEMON_CONNECT_RETRY_ATTEMPTS = 3;
var DEFAULT_DAEMON_CONNECT_RETRY_DELAY_MS = 250;
var DEFAULT_CLI_STDOUT_MAX_BYTES = 4 * 1024 * 1024;
var DAEMON_STDERR_FLAG = "--stderr-to";
var DOCTOR_SUGGESTED_ACTION = "run `codex-team doctor` to diagnose";
var SOCKET_BIND_DENIED_SUGGESTED_ACTION = "codex-team cannot bind a local IPC socket here \u2014 run `codex-team doctor` for details";
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
  if (method !== "doctor") {
    warnLegacyWindowsDataDir((warning) => {
      process.stderr.write(warning.message + "\n");
    });
  }
  const effectiveMethod = resolveMethod(method, parsed);
  const short = truthy(parsed.flags.short);
  const format = flagString(parsed.flags.format);
  if (short && !supportsShort(effectiveMethod)) {
    process.stdout.write(JSON.stringify(err("invalid_params", `--short is not supported for '${method}'`)) + "\n");
    return 1;
  }
  if (method === "doctor" && truthy(parsed.flags.full)) {
    process.stdout.write(JSON.stringify(err("invalid_params", `--full is not supported for '${method}'`)) + "\n");
    return 1;
  }
  if (short && (format === "markdown" || format === "table")) {
    process.stdout.write(JSON.stringify(err("invalid_params", "--short cannot be used with --format markdown or --format table")) + "\n");
    return 1;
  }
  const sockPath = parsed.daemonSock || defaultSockPath();
  if (method === "doctor") {
    return await runDoctor({ short, sockPath });
  }
  if (method === "version") {
    return await runVersion(sockPath);
  }
  const needsBearer = !isDaemonLevel(effectiveMethod);
  if (needsBearer && !parsed.bearer) {
    process.stdout.write(
      JSON.stringify(err("invalid_params", `bearer token required for '${method}'; pass -b <token>`)) + "\n"
    );
    return 1;
  }
  const cliValidationError = validateCliFlags(parsed, method, effectiveMethod);
  if (cliValidationError) {
    process.stdout.write(JSON.stringify(err("invalid_params", cliValidationError)) + "\n");
    return 1;
  }
  const approvalValidationError = validateApprovalHint(method, parsed);
  if (approvalValidationError) {
    process.stdout.write(JSON.stringify(err("invalid_params", approvalValidationError)) + "\n");
    return 2;
  }
  const ready = await ensureDaemon(sockPath);
  if (!ready.ok) {
    process.stdout.write(JSON.stringify(err(ready.code, ready.message, ready.data)) + "\n");
    return 1;
  }
  return await dispatchCommand(sockPath, parsed, effectiveMethod);
}
function isDaemonLevel(method) {
  return method === "version" || method === "daemon:status" || method.startsWith("daemon:");
}
function validateApprovalHint(method, parsed) {
  if (method !== "message:approval") return null;
  const kindHint = asStringFlag(parsed.flags.kind);
  const action = parsed.positionals[2];
  if (!kindHint || typeof action !== "string" || action.length === 0) return null;
  const validation = validateApprovalAction(kindHint, action);
  return validation.ok ? null : validation.message;
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
  const needsStreaming = method === "monitor:events" || method === "session:events" || method === "monitor:alarm" || method === "daemon:logs" || method === "session:logs" && truthy(parsed.flags["follow"] ?? parsed.flags["f"]) || method === "message:tail" && truthy(parsed.flags["follow"] ?? parsed.flags["f"]);
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
      process.stdout.write(forwardDaemonError(resp.error));
      return 1;
    }
    if (truthy(parsed.flags.short)) {
      process.stdout.write(formatShort(method, resp.result) + "\n");
      return 0;
    }
    if (method === "cursor:get") {
      process.stdout.write(extractCursorEventId(resp.result) + "\n");
      return 0;
    }
    const markdown = extractMarkdownResult(resp.result, parsed.flags.format);
    if (markdown !== null) {
      process.stdout.write(markdown + "\n");
      return exitCodeForResult(method, resp.result);
    }
    const rendered = truthy(parsed.flags.full) ? resp.result : formatCompact(method, resp.result);
    process.stdout.write(JSON.stringify({ ok: true, data: rendered }) + "\n");
    return exitCodeForResult(method, resp.result);
  } catch (e) {
    process.stdout.write(
      JSON.stringify(err("internal", e.message ?? "rpc failed")) + "\n"
    );
    return 1;
  }
}
function exitCodeForResult(method, result) {
  if (!result || typeof result !== "object") return 0;
  if (method === "message:send-many" || method === "session:detach") {
    const results = result.results;
    if (Array.isArray(results) && results.some((entry) => entry && typeof entry === "object" && entry.ok === false)) {
      return 1;
    }
    return 0;
  }
  if (method !== "message:wait") return 0;
  const value = result;
  const outcomes = Array.isArray(value.outcomes) ? value.outcomes.map((entry) => entry && typeof entry === "object" ? entry.outcome : null).filter((entry) => typeof entry === "string") : [];
  if (outcomes.length > 0) {
    if (outcomes.includes("error") || outcomes.includes("interrupted")) return 1;
    if (outcomes.includes("timeout")) return 124;
    return 0;
  }
  const outcome = value.outcome;
  if (outcome === "error" || outcome === "interrupted") return 1;
  if (outcome === "timeout") return 124;
  return 0;
}
async function runStream(sock, parsed, method) {
  return await new Promise((resolve) => {
    let finished = false;
    const stdoutQueue = [];
    const pendingFinalizers = [];
    const stdoutMaxBytes = readCliStdoutMaxBytes();
    const stdoutResumeBytes = Math.max(1, Math.floor(stdoutMaxBytes / 2));
    let stdoutBlocked = false;
    let socketPaused = false;
    let queuePaused = false;
    let stdoutQueueBytes = 0;
    let parserControl = null;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      process.off("SIGBREAK", onInterrupt);
      resolve(code);
    };
    const pauseSocket = () => {
      if (socketPaused || typeof sock.pause !== "function") return;
      socketPaused = true;
      sock.pause();
    };
    const maybeResumeSocket = () => {
      if (!socketPaused || stdoutBlocked || queuePaused) return;
      socketPaused = false;
      if (typeof sock.resume === "function") sock.resume();
    };
    const maybeResumeParser = () => {
      if (!queuePaused || stdoutBlocked || stdoutQueueBytes >= stdoutResumeBytes) return;
      queuePaused = false;
      maybeResumeSocket();
      parserControl?.resume();
    };
    const flushFinalizers = () => {
      if (stdoutBlocked || stdoutQueue.length > 0) return;
      while (pendingFinalizers.length > 0) pendingFinalizers.shift()?.();
    };
    const flushStdout = () => {
      if (stdoutBlocked) return;
      while (stdoutQueue.length > 0) {
        const next = stdoutQueue[0];
        const ok3 = process.stdout.write(next.line);
        if (!ok3) {
          stdoutBlocked = true;
          pauseSocket();
          process.stdout.once("drain", () => {
            stdoutBlocked = false;
            const flushed = stdoutQueue.shift();
            stdoutQueueBytes = Math.max(0, stdoutQueueBytes - (flushed?.bytes ?? 0));
            flushed?.afterWrite?.();
            maybeResumeParser();
            flushStdout();
            flushFinalizers();
          });
          return;
        }
        stdoutQueue.shift();
        stdoutQueueBytes = Math.max(0, stdoutQueueBytes - next.bytes);
        next.afterWrite?.();
      }
      maybeResumeParser();
      maybeResumeSocket();
      flushFinalizers();
    };
    const writeStdout = (line, afterWrite) => {
      const bytes = Buffer.byteLength(line);
      stdoutQueue.push({ line, bytes, afterWrite });
      stdoutQueueBytes += bytes;
      let shouldContinueParsing = true;
      if (stdoutQueueBytes > stdoutMaxBytes) {
        queuePaused = true;
        shouldContinueParsing = false;
        pauseSocket();
        queueMicrotask(() => {
          maybeResumeParser();
        });
      }
      flushStdout();
      return shouldContinueParsing;
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
    parserControl = onMessages(sock, (msg) => {
      if (msg.kind === "stream_chunk" && msg.id === reqId) {
        const ackAfterWrite = createStreamAckCallback(method, sock, reqId, msg.data);
        const markdown = extractMarkdownResult(msg.data, parsed.flags.format);
        if (truthy(parsed.flags.short)) {
          return writeStdout(formatShort(method, msg.data) + "\n", ackAfterWrite);
        } else if (markdown !== null) {
          return writeStdout(markdown + "\n", ackAfterWrite);
        } else {
          const rendered = truthy(parsed.flags.full) ? msg.data : formatCompact(method, msg.data);
          return writeStdout(JSON.stringify(rendered) + "\n", ackAfterWrite);
        }
      } else if (msg.kind === "stream_end" && msg.id === reqId) {
        if (msg.error) {
          writeStdout(forwardDaemonError(msg.error), () => {
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
          writeStdout(forwardDaemonError(msg.error), () => {
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
  const config = new ConfigStore();
  const dataDir = config.resolvedDataDir();
  const pidPath = pidFilePath(dataDir);
  const stderrPath = daemonSpawnStderrPath(dataDir);
  if (await probeSock(sockPath, 200)) {
    return { ok: true, code: "", message: "" };
  }
  const staleState = detectStaleDaemonArtifacts(sockPath, pidPath);
  if (staleState) {
    return {
      ok: false,
      code: "daemon_unreachable",
      message: `stale daemon.pid + daemon.sock (pid ${staleState.pid} is not running); remove them and retry`,
      data: {
        pid_path: pidPath,
        sock_path: staleState.sockPath,
        pid: staleState.pid
      }
    };
  }
  try {
    const child = spawnDaemon();
    const firstAttempt = await waitForDaemonReady(sockPath, child, cliConfig.readyTimeoutMs);
    if (firstAttempt.ready) {
      return { ok: true, code: "", message: "" };
    }
  } catch (e) {
    return {
      ok: false,
      code: "daemon_unreachable",
      message: `failed to spawn daemon: ${e.message}`
    };
  }
  try {
    const child = spawnDaemon(stderrPath);
    const secondAttempt = await waitForDaemonReady(sockPath, child, cliConfig.readyTimeoutMs);
    if (secondAttempt.ready) {
      return { ok: true, code: "", message: "" };
    }
    if (secondAttempt.exited) {
      return buildEarlyExitFailure(stderrPath, secondAttempt);
    }
  } catch (e) {
    return {
      ok: false,
      code: "daemon_unreachable",
      message: `failed to spawn daemon with stderr capture: ${e.message}`
    };
  }
  const stderrTail = readTail(stderrPath, 4096);
  const parsedBootstrap = parseBootstrapStderr(stderrTail);
  if (parsedBootstrap?.code === "socket_bind_denied") {
    return buildSocketBindDeniedFailure(parsedBootstrap, stderrTail);
  }
  return {
    ok: false,
    code: "daemon_unreachable",
    message: `daemon failed to start within ${formatDuration(cliConfig.readyTimeoutMs)}. See ${stderrPath} for details`,
    data: buildDaemonUnreachableData(stderrPath, stderrTail)
  };
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
async function waitForDaemonReady(sockPath, child, timeoutMs) {
  let exited = false;
  let exitCode = null;
  let signal = null;
  const onExit = (code, nextSignal) => {
    exited = true;
    exitCode = code;
    signal = nextSignal;
  };
  child.once("exit", onExit);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await (0, import_promises.setTimeout)(DAEMON_POLL_INTERVAL_MS);
      if (await probeSock(sockPath, 200)) return { ready: true, exited, exitCode, signal };
      if (exited) return { ready: false, exited, exitCode, signal };
    }
  } finally {
    if (typeof child.off === "function") child.off("exit", onExit);
    else if (typeof child.removeListener === "function") child.removeListener("exit", onExit);
  }
  return { ready: false, exited, exitCode, signal };
}
function spawnDaemon(stderrPath) {
  const args = [process.argv[1], "--daemon-internal"];
  let stderrFd = null;
  try {
    if (stderrPath) {
      import_node_fs8.default.mkdirSync(import_node_path8.default.dirname(stderrPath), { recursive: true });
      stderrFd = import_node_fs8.default.openSync(stderrPath, "w");
      args.push(DAEMON_STDERR_FLAG, stderrPath);
    }
    const child = (0, import_node_child_process3.spawn)(process.execPath, args, {
      detached: true,
      stdio: stderrFd === null ? "ignore" : ["ignore", "ignore", stderrFd],
      env: process.env,
      windowsHide: true
    });
    child.unref();
    return child;
  } finally {
    if (stderrFd !== null) import_node_fs8.default.closeSync(stderrFd);
  }
}
function getCliVersion() {
  return VERSION;
}
function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function daemonSpawnStderrPath(dataDir) {
  return import_node_path8.default.join(dataDir, "daemon-spawn.stderr");
}
function detectStaleDaemonArtifacts(sockPath, pidPath) {
  const pidRecord = readPidFile(pidPath);
  if (!pidRecord) return null;
  if (isPidAlive(pidRecord.pid)) return null;
  if (!isFilesystemSockPath(sockPath)) return null;
  const normalizedSockPath = normalizeSockPath(sockPath);
  if (!import_node_fs8.default.existsSync(normalizedSockPath)) return null;
  return {
    pid: pidRecord.pid,
    sockPath: normalizedSockPath
  };
}
function readPidFile(targetPath) {
  try {
    const raw = import_node_fs8.default.readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: Math.floor(parsed.pid) };
  } catch {
    return null;
  }
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function buildSocketBindDeniedFailure(parsedBootstrap, stderrTail) {
  return {
    ok: false,
    code: parsedBootstrap.code,
    message: parsedBootstrap.message,
    data: {
      ...parsedBootstrap.data ?? {},
      ...stderrTail ? { bootstrap_stderr: stderrTail } : {}
    }
  };
}
function buildDaemonUnreachableData(stderrPath, stderrTail, result) {
  return {
    stderr_path: stderrPath,
    ...typeof result?.exitCode === "number" ? { exit_code: result.exitCode } : {},
    ...result?.signal ? { signal: result.signal } : {},
    ...stderrTail ? { bootstrap_stderr: stderrTail } : { suggested_action: DOCTOR_SUGGESTED_ACTION }
  };
}
function buildEarlyExitFailure(stderrPath, result) {
  const stderrTail = readTail(stderrPath, 4096);
  const parsedBootstrap = parseBootstrapStderr(stderrTail);
  if (parsedBootstrap?.code === "socket_bind_denied") {
    return buildSocketBindDeniedFailure(parsedBootstrap, stderrTail);
  }
  return {
    ok: false,
    code: "daemon_unreachable",
    message: parsedBootstrap?.message ?? "daemon exited before becoming ready",
    data: buildDaemonUnreachableData(stderrPath, stderrTail, result)
  };
}
function readTail(filePath, maxBytes) {
  try {
    const raw = import_node_fs8.default.readFileSync(filePath, "utf8");
    if (raw.length <= maxBytes) return raw.trim();
    return raw.slice(-maxBytes).trim();
  } catch {
    return null;
  }
}
function parseBootstrapStderr(stderrTail) {
  if (!stderrTail) return null;
  const prefix = "[codex-team-daemon-bootstrap] ";
  const lines = stderrTail.split(/\r?\n/).reverse();
  for (const line of lines) {
    const socketBindDenied = parseSocketBindDeniedLine(line);
    if (socketBindDenied) return socketBindDenied;
    if (!line.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(line.slice(prefix.length));
      if (typeof parsed.code !== "string" || typeof parsed.message !== "string") continue;
      return {
        code: parsed.code,
        message: parsed.message,
        data: parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? parsed.data : void 0
      };
    } catch {
      continue;
    }
  }
  return null;
}
function parseSocketBindDeniedLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed.kind !== "socket_bind_denied") return null;
    const errno = typeof parsed.errno === "string" && parsed.errno.length > 0 ? parsed.errno : "UNKNOWN";
    return {
      code: "socket_bind_denied",
      message: `local socket bind denied by environment (${errno})`,
      data: {
        suggested_action: SOCKET_BIND_DENIED_SUGGESTED_ACTION,
        errno,
        ...typeof parsed.probed_path === "string" && parsed.probed_path.length > 0 ? { probed_path: parsed.probed_path } : {}
      }
    };
  } catch {
    return null;
  }
}
function truthy(v) {
  return v === true || v === "true" || v === "1";
}
function flagString(v) {
  if (Array.isArray(v)) return flagString(v[v.length - 1]);
  return typeof v === "string" ? v : null;
}
function extractMarkdownResult(result, format) {
  if (format !== "markdown" || !result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const markdown = result.markdown;
  return typeof markdown === "string" ? markdown : null;
}
function extractCursorEventId(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const eventId = result.event_id;
  return typeof eventId === "string" ? eventId : "";
}
function createStreamAckCallback(method, sock, reqId, data) {
  if (method !== "monitor:events") return void 0;
  if (!isStreamChunkAckable(data)) return void 0;
  const eventId = extractStreamEventId(data);
  if (!eventId) return void 0;
  return () => sendStreamAck(sock, reqId, eventId);
}
function extractStreamEventId(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const id = data.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
function isStreamChunkAckable(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const ackable = data.ackable;
  return ackable !== false;
}
function sendStreamAck(sock, reqId, eventId) {
  if (sock.destroyed) return;
  writeMessage(sock, {
    kind: "notification",
    method: "stream_ack",
    params: {
      id: reqId,
      event_id: eventId
    }
  });
}
function forwardDaemonError(error) {
  return JSON.stringify(err(error.code, error.message, error.data)) + "\n";
}
function validateCliFlags(parsed, method, effectiveMethod) {
  if (method === "monitor:events") {
    if (parsed.flags.cursor === true) return "--cursor requires a value";
    if (parsed.flags.since !== void 0 && parsed.flags.cursor !== void 0) {
      return "--since and --cursor are mutually exclusive";
    }
    return null;
  }
  if (method === "message:wait") {
    if ((truthy(parsed.flags.all) || truthy(parsed.flags.any)) && parsed.flags.for !== void 0) {
      return "--for is only supported when waiting on a single session";
    }
    return null;
  }
  if (method === "session:detach") {
    if (parsed.flags.match !== void 0 && !truthy(parsed.flags.all)) {
      return "--match requires --all";
    }
    return null;
  }
  if (method === "session:health" && effectiveMethod === "session:health") {
    if (parsed.flags["only-unhealthy"] !== void 0 || parsed.flags.state !== void 0) {
      return "--only-unhealthy and --state require --all";
    }
  }
  if (effectiveMethod === "daemon:fleet:status" && parsed.flags.users === true) {
    return "--users requires a value";
  }
  if (effectiveMethod === "session:events") {
    if (parsed.flags.type === true) return "--type requires a value";
    if (parsed.flags.turn === true) return "--turn requires a value";
    if (parsed.flags.since === true) return "--since requires a value";
    if (parsed.flags.limit === true) return "--limit requires a value";
    if (truthy(parsed.flags["by-tool"]) && truthy(parsed.flags["by-item-kind"])) {
      return "--by-tool and --by-item-kind are mutually exclusive";
    }
    if (truthy(parsed.flags.follow) && (truthy(parsed.flags["by-tool"]) || truthy(parsed.flags["by-item-kind"]))) {
      return "--follow cannot be used with --by-tool or --by-item-kind";
    }
    if (truthy(parsed.flags.summary) && (truthy(parsed.flags["by-tool"]) || truthy(parsed.flags["by-item-kind"]))) {
      return "--summary cannot be used with --by-tool or --by-item-kind";
    }
  }
  if (effectiveMethod === "session:logs") {
    if (parsed.flags.n === true) return "-n requires a value";
    if (parsed.flags.stream === true) return "--stream requires a value";
    if (parsed.flags.truncate === true) return "--truncate requires a value";
  }
  return null;
}
function resolveMethod(method, parsed) {
  if (method === "session:health" && truthy(parsed.flags.all)) {
    return "session:health:all";
  }
  return method;
}
function asStringFlag(value) {
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === "string" ? last : null;
  }
  return typeof value === "string" ? value : null;
}
function isTransientConnectError(err2) {
  return err2.message === "connect timeout" || err2.code === "ECONNREFUSED" || err2.code === "ENOENT" || err2.code === "EPIPE" || err2.code === "ECONNRESET";
}
function isTransientRequestError(err2) {
  return isTransientConnectError(err2) || err2.message === "daemon closed connection";
}
function isReadOnlyMethod(method) {
  return method === "version" || method === "status" || method === "daemon:fleet:status" || method === "daemon:status" || method === "daemon:user:list" || method === "daemon:config:get" || method === "daemon:config:list" || method === "cursor:list" || method === "cursor:get" || method === "session:health" || method === "session:health:all" || method === "session:logs" || method === "session:events" || method === "session:info" || method === "session:context" || method === "session:list" || method === "message:history";
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
function readCliStdoutMaxBytes(env = process.env) {
  const raw = env.CODEX_TEAM_CLI_STDOUT_MAX_BYTES;
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_CLI_STDOUT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CLI_STDOUT_MAX_BYTES;
  return Math.max(1, Math.floor(parsed));
}
function toInt(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : fallback;
}
function toMs(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v * 1e3)) : fallback;
}
function formatDuration(ms) {
  if (ms % 1e3 === 0) return `${ms / 1e3}s`;
  return `${ms}ms`;
}

// src/daemon/run.ts
var import_node_fs18 = __toESM(require("fs"));
var import_node_path17 = __toESM(require("path"));

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
var import_node_fs9 = __toESM(require("fs"));
var import_node_path9 = __toESM(require("path"));
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
    if (!import_node_fs9.default.existsSync(root)) return;
    for (const dirname of import_node_fs9.default.readdirSync(root)) {
      const metaPath = import_node_path9.default.join(root, dirname, "metadata.json");
      if (import_node_fs9.default.existsSync(metaPath)) {
        try {
          const raw = import_node_fs9.default.readFileSync(metaPath, "utf8");
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
      import_node_fs9.default.rmSync(dir, { recursive: true, force: true });
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
    import_node_fs9.default.mkdirSync(dir, { recursive: true });
    const metaPath = userMetadataPath(user.token, this.dataDir);
    const tmp = metaPath + ".tmp";
    import_node_fs9.default.writeFileSync(tmp, JSON.stringify({
      schema_version: SCHEMA_VERSION,
      user
    }, null, 2));
    import_node_fs9.default.renameSync(tmp, metaPath);
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
var import_node_fs10 = __toESM(require("fs"));
var import_node_path10 = __toESM(require("path"));
var NAME_RE = /^[A-Za-z0-9_\-]{1,128}$/;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var SCHEMA_VERSION2 = 1;
var DEFAULT_PERSIST_DEBOUNCE_MS = 50;
var VOLATILE_SESSION_FIELDS = /* @__PURE__ */ new Set([
  "last_turn_id",
  "current_turn_id",
  "current_turn_started_at",
  "current_item_type",
  "items_in_turn",
  "pending_approvals",
  "pending_user_inputs",
  "token_usage_last_turn"
]);
var SessionRegistry = class {
  dataDir;
  resolvePersistDebounceMs;
  users = /* @__PURE__ */ new Map();
  globalByThreadId = /* @__PURE__ */ new Map();
  touchTimers = /* @__PURE__ */ new Map();
  writeChains = /* @__PURE__ */ new Map();
  constructor(dataDir, opts = {}) {
    this.dataDir = dataDir;
    const configured = opts.persistDebounceMs;
    if (typeof configured === "function") {
      this.resolvePersistDebounceMs = () => clampPersistDebounceMs(configured());
    } else if (typeof configured === "number") {
      const value = clampPersistDebounceMs(configured);
      this.resolvePersistDebounceMs = () => value;
    } else {
      this.resolvePersistDebounceMs = () => DEFAULT_PERSIST_DEBOUNCE_MS;
    }
  }
  loadForUser(user) {
    if (this.users.has(user)) return;
    const bucket = this.emptyBucket();
    const p = userSessionsPath(user, this.dataDir);
    if (!import_node_fs10.default.existsSync(p)) {
      this.users.set(user, bucket);
      return;
    }
    try {
      const raw = import_node_fs10.default.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.schema_version === "number" && parsed.schema_version > SCHEMA_VERSION2) {
        throw new Error(`sessions.json schema_version ${parsed.schema_version} is newer than supported ${SCHEMA_VERSION2}`);
      }
      for (const rawRec of parsed.sessions ?? []) {
        const rec = normalizeLoadedRecord(rawRec);
        if (!rec) continue;
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
    this.schedulePersist(user, this.persistDebounceMs());
  }
  update(user, name, patch) {
    this.loadForUser(user);
    const b = this.users.get(user);
    const rec = b.byName.get(name);
    if (!rec) throw new CodexTeamError("session_not_found", `session '${name}' not found`);
    let persistNeeded = false;
    if (patch.name && patch.name !== rec.name) {
      if (!NAME_RE.test(patch.name)) throw invalidParams(`invalid session name: ${patch.name}`);
      if (patch.name.startsWith("th-")) throw invalidParams("session name cannot start with 'th-'");
      if (b.byName.has(patch.name)) throw invalidParams(`session '${patch.name}' already exists`);
      b.byName.delete(rec.name);
      rec.name = patch.name;
      b.byName.set(rec.name, rec);
      persistNeeded = true;
    }
    persistNeeded = applySessionFieldUpdate(rec, "last_active_at", patch.last_active_at) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "turn_count", patch.turn_count) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "state", patch.state) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "recovery_state", patch.recovery_state ?? void 0, patch.recovery_state !== void 0) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "model", patch.model) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "cwd", patch.cwd) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "sandbox", patch.sandbox) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "approval", patch.approval) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "effort", patch.effort) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "profile", patch.profile) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "base_instructions", patch.base_instructions) || persistNeeded;
    persistNeeded = applySessionFieldUpdate(rec, "developer_instructions", patch.developer_instructions) || persistNeeded;
    if (patch.experimental_tools !== void 0) {
      const normalized = patch.experimental_tools.length > 0 ? [...patch.experimental_tools] : void 0;
      persistNeeded = applySessionFieldUpdate(rec, "experimental_tools", normalized, true) || persistNeeded;
    }
    applySessionFieldUpdate(rec, "last_turn_id", patch.last_turn_id);
    applySessionFieldUpdate(rec, "current_turn_id", patch.current_turn_id);
    applySessionFieldUpdate(rec, "current_turn_started_at", patch.current_turn_started_at);
    applySessionFieldUpdate(rec, "current_item_type", patch.current_item_type);
    applySessionFieldUpdate(rec, "items_in_turn", patch.items_in_turn);
    applySessionFieldUpdate(rec, "pending_approvals", patch.pending_approvals);
    applySessionFieldUpdate(rec, "pending_user_inputs", patch.pending_user_inputs);
    applySessionFieldUpdate(rec, "token_usage_last_turn", patch.token_usage_last_turn);
    persistNeeded = applySessionFieldUpdate(rec, "crash_reason", patch.crash_reason) || persistNeeded;
    if (patch.autoApprovePatterns !== void 0) {
      const normalized = normalizeAutoApprovePatterns(patch.autoApprovePatterns);
      persistNeeded = applySessionFieldUpdate(rec, "autoApprovePatterns", normalized) || persistNeeded;
    }
    if (persistNeeded) {
      this.schedulePersist(user, this.persistDebounceMs());
    }
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
    this.schedulePersist(user, this.persistDebounceMs());
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
    this.schedulePersist(user, this.persistDebounceMs());
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
    await import_node_fs10.default.promises.mkdir(dir, { recursive: true });
    const p = userSessionsPath(user, this.dataDir);
    const bucket = this.users.get(user);
    const payload = {
      schema_version: SCHEMA_VERSION2,
      sessions: bucket ? Array.from(bucket.byName.values()).map((record) => toPersistedRecord(record)) : []
    };
    const tmp = p + ".tmp";
    await import_node_fs10.default.promises.writeFile(tmp, JSON.stringify(payload, null, 2));
    await import_node_fs10.default.promises.rename(tmp, p);
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
  persistDebounceMs() {
    return this.resolvePersistDebounceMs();
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
  if (record.state !== "live" && record.state !== "crashed") {
    throw invalidParams(`invalid session state: ${record.state}`);
  }
  record.autoApprovePatterns = normalizeAutoApprovePatterns(record.autoApprovePatterns);
}
function generateSessionName() {
  return "s-" + import_node_crypto2.default.randomBytes(4).toString("hex");
}
function looksLikeThreadId(s) {
  return UUID_RE.test(s) || s.startsWith("th-");
}
function sessionRuntimeDefaults() {
  return {
    last_turn_id: null,
    current_turn_id: null,
    current_turn_started_at: null,
    current_item_type: null,
    items_in_turn: 0,
    pending_approvals: 0,
    pending_user_inputs: 0,
    token_usage_last_turn: null,
    crash_reason: null
  };
}
function normalizeTokenUsage(value) {
  const usage = asObject3(value);
  const prompt = asNumber(
    usage.prompt ?? usage.prompt_tokens ?? usage.promptTokens ?? usage.input ?? usage.input_tokens ?? usage.inputTokens
  );
  const completion = asNumber(
    usage.completion ?? usage.completion_tokens ?? usage.completionTokens ?? usage.output ?? usage.output_tokens ?? usage.outputTokens
  );
  const total = asNumber(usage.total ?? usage.total_tokens ?? usage.totalTokens);
  if (prompt === null && completion === null && total === null) return null;
  return {
    prompt: prompt ?? 0,
    completion: completion ?? 0,
    total: total ?? (prompt ?? 0) + (completion ?? 0)
  };
}
function isoFromUnixSeconds(value, fallback = null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return new Date(value * 1e3).toISOString();
}
function asObject3(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function normalizeAutoApprovePatterns(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((pattern) => typeof pattern === "string");
}
function normalizeLoadedRecord(value) {
  const rec = asObject3(value);
  const name = typeof rec.name === "string" ? rec.name : null;
  const threadId = typeof rec.thread_id === "string" && rec.thread_id.length > 0 ? rec.thread_id : null;
  if (!name || !threadId) return null;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const createdAt = normalizeOptionalString(rec.created_at) ?? normalizeOptionalString(rec.last_active_at) ?? now;
  const lastActiveAt = normalizeOptionalString(rec.last_active_at) ?? createdAt;
  const runtimeDefaults = sessionRuntimeDefaults();
  return {
    name,
    thread_id: threadId,
    state: rec.state === "crashed" ? "crashed" : "live",
    ...rec.recovery_state === "degraded" ? { recovery_state: "degraded" } : {},
    ...normalizeOptionalString(rec.model) ? { model: normalizeOptionalString(rec.model) } : {},
    ...normalizeOptionalString(rec.cwd) ? { cwd: normalizeOptionalString(rec.cwd) } : {},
    ...normalizeOptionalString(rec.sandbox) ? { sandbox: normalizeOptionalString(rec.sandbox) } : {},
    ...normalizeOptionalString(rec.approval) ? { approval: normalizeOptionalString(rec.approval) } : {},
    ...normalizeOptionalString(rec.effort) ? { effort: normalizeOptionalString(rec.effort) } : {},
    ...normalizeOptionalString(rec.profile) ? { profile: normalizeOptionalString(rec.profile) } : {},
    ...normalizeOptionalString(rec.base_instructions) ? { base_instructions: normalizeOptionalString(rec.base_instructions) } : {},
    ...normalizeOptionalString(rec.developer_instructions) ? { developer_instructions: normalizeOptionalString(rec.developer_instructions) } : {},
    ...normalizeStringArray(rec.experimental_tools).length > 0 ? { experimental_tools: normalizeStringArray(rec.experimental_tools) } : {},
    autoApprovePatterns: normalizeLoadedAutoApprovePatterns(name, rec.autoApprovePatterns),
    created_at: createdAt,
    last_active_at: lastActiveAt,
    turn_count: normalizeOptionalNumber(rec.turn_count) ?? 0,
    last_turn_id: runtimeDefaults.last_turn_id,
    current_turn_id: runtimeDefaults.current_turn_id,
    current_turn_started_at: runtimeDefaults.current_turn_started_at,
    current_item_type: runtimeDefaults.current_item_type,
    items_in_turn: runtimeDefaults.items_in_turn,
    pending_approvals: runtimeDefaults.pending_approvals,
    pending_user_inputs: runtimeDefaults.pending_user_inputs,
    token_usage_last_turn: runtimeDefaults.token_usage_last_turn,
    crash_reason: normalizeOptionalString(rec.crash_reason) ?? runtimeDefaults.crash_reason
  };
}
function normalizeLoadedAutoApprovePatterns(sessionName, value) {
  const patterns = normalizeAutoApprovePatterns(value);
  const validPatterns = [];
  for (const pattern of patterns) {
    const validationError = validateParsedAutoApprovePatterns([pattern]);
    if (validationError) {
      logger.warn("dropping invalid persisted auto-approve pattern", {
        session: sessionName,
        pattern,
        err: validationError
      });
      continue;
    }
    validPatterns.push(pattern);
  }
  return validPatterns;
}
function normalizeOptionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
function normalizeOptionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function applySessionFieldUpdate(record, key, nextValue, present = nextValue !== void 0) {
  if (!present) return false;
  if (sessionFieldEquals(record[key], nextValue)) return false;
  record[key] = cloneSessionField(nextValue);
  return !VOLATILE_SESSION_FIELDS.has(key);
}
function cloneSessionField(value) {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (value && typeof value === "object") {
    return { ...value };
  }
  return value;
}
function sessionFieldEquals(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return arrayEquals(
      Array.isArray(left) ? left : [],
      Array.isArray(right) ? right : []
    );
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!sessionFieldEquals(left[key], right[key])) return false;
    }
    return true;
  }
  return left === right;
}
function arrayEquals(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!sessionFieldEquals(left[i], right[i])) return false;
  }
  return true;
}
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function toPersistedRecord(record) {
  const persisted = {};
  for (const [key, value] of Object.entries(record)) {
    if (VOLATILE_SESSION_FIELDS.has(key)) continue;
    persisted[key] = clonePersistedValue(value);
  }
  return persisted;
}
function clonePersistedValue(value) {
  if (Array.isArray(value)) return [...value];
  if (isPlainObject(value)) return { ...value };
  return value;
}
function clampPersistDebounceMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PERSIST_DEBOUNCE_MS;
  return Math.max(0, Math.floor(value));
}

// src/daemon/events.ts
var import_node_fs11 = __toESM(require("fs"));
var import_node_path11 = __toESM(require("path"));
var DELTA_SUFFIX = "_delta";
var SCHEMA_VERSION3 = 1;
var DEFAULT_FLUSH_DELAY_MS = 25;
var OVERFLOW_FLUSH_DELAY_MS = 250;
var FLUSH_RETRY_DELAY_MS = 250;
var MAX_PENDING_WRITE_BYTES = 1024 * 1024;
var MAX_PENDING_BACKLOG_BYTES = 16 * 1024 * 1024;
var MAX_PENDING_LINE_MULTIPLIER = 10;
var EVENT_ID_SOFT_LIMIT = 2 ** 52;
var AUTO_APPROVED_EVENT_TYPE = "auto_approved";
var APPROVAL_REQUEST_CANCELLED_EVENT_TYPE = "approval.request_cancelled";
var SESSION_CLOSED_EVENT_TYPE = "session.closed";
var SESSION_CRASHED_EVENT_TYPE = "session.crashed";
var SESSION_PENDING_DROPPED_EVENT_TYPE = "session.pending_dropped";
var USER_INPUT_REQUEST_CANCELLED_EVENT_TYPE = "user_input.request_cancelled";
var EventRingBuffer = class {
  capacity;
  items;
  start = 0;
  count = 0;
  slotsById = /* @__PURE__ */ new Map();
  constructor(capacity, initial = []) {
    this.capacity = Math.max(1, capacity);
    this.items = new Array(this.capacity);
    for (const event of initial) this.push(event);
  }
  get length() {
    return this.count;
  }
  setCapacity(capacity) {
    const nextCapacity = Math.max(1, capacity);
    if (nextCapacity === this.capacity) return 0;
    const events = this.toArray();
    const dropped = Math.max(0, events.length - nextCapacity);
    this.capacity = nextCapacity;
    this.items = new Array(this.capacity);
    this.start = 0;
    this.count = 0;
    this.slotsById.clear();
    for (const event of events.slice(-nextCapacity)) this.push(event);
    return dropped;
  }
  push(event) {
    if (this.count === this.capacity) {
      const slot2 = this.start;
      const evicted = this.items[slot2] ?? null;
      if (evicted) this.slotsById.delete(evicted.id);
      this.items[slot2] = event;
      this.slotsById.set(event.id, slot2);
      this.start = (this.start + 1) % this.capacity;
      return evicted;
    }
    const slot = (this.start + this.count) % this.capacity;
    this.items[slot] = event;
    this.slotsById.set(event.id, slot);
    this.count += 1;
    return null;
  }
  oldestId() {
    return this.count === 0 ? null : this.items[this.start]?.id ?? null;
  }
  toArray() {
    const events = [];
    for (let offset = 0; offset < this.count; offset++) {
      const event = this.at(offset);
      if (event) events.push(event);
    }
    return events;
  }
  listSince(sinceId) {
    if (!sinceId) return { ok: true, events: this.toArray() };
    const slot = this.slotsById.get(sinceId);
    if (slot === void 0) {
      const oldest = this.oldestId();
      if (oldest && compareSeq(sinceId, oldest) < 0) {
        return { ok: false, reason: "id_rotated", oldest_available_id: oldest };
      }
      return { ok: false, reason: "invalid_since" };
    }
    const events = [];
    for (let offset = this.relativeIndex(slot) + 1; offset < this.count; offset++) {
      const event = this.at(offset);
      if (event) events.push(event);
    }
    return { ok: true, events };
  }
  findLast(predicate) {
    for (let offset = this.count - 1; offset >= 0; offset--) {
      const event = this.at(offset);
      if (event && predicate(event)) return event;
    }
    return null;
  }
  at(offset) {
    if (offset < 0 || offset >= this.count) return null;
    const slot = (this.start + offset) % this.capacity;
    return this.items[slot] ?? null;
  }
  relativeIndex(slot) {
    return slot >= this.start ? slot - this.start : this.capacity - this.start + slot;
  }
};
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
  backlogOverflowWarned = /* @__PURE__ */ new Set();
  eventIdOverflowWarned = /* @__PURE__ */ new Set();
  compacting = /* @__PURE__ */ new Set();
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
    if (!import_node_fs11.default.existsSync(filePath)) {
      this.ensureUserState(user);
      this.loaded.add(user);
      this.loadPromises.delete(user);
      return;
    }
    const raw = import_node_fs11.default.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const { events, totalLines } = parsePersistedEvents(lines);
    this.hydrateLoadedUser(user, events, totalLines);
    this.loaded.add(user);
    this.loadPromises.delete(user);
  }
  setRetention(n) {
    this.retention = Math.max(100, n);
    for (const [user, buf] of this.buffers) {
      const dropped = buf.setCapacity(this.retention);
      if (dropped > 0) this.bumpCompactionDebt(user, dropped);
    }
  }
  retainedCount(user) {
    return this.buffers.get(user)?.length ?? 0;
  }
  async append(user, input) {
    await this.ensureLoaded(user);
    return await this.withUserLock(user, async () => {
      const overflowError = this.guardEventIdOverflow(user, input);
      if (overflowError) throw overflowError;
      return this.appendLoaded(user, input);
    });
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
      const scheduled = this.flushTimers.get(user);
      if (scheduled) {
        clearTimeout(scheduled.timer);
        this.flushTimers.delete(user);
      }
      await this.flushUser(user);
    }
    await Promise.all(Array.from(this.writeChains.values()).map((p) => p.catch(() => void 0)));
  }
  async clearUser(user) {
    const scheduled = this.flushTimers.get(user);
    if (scheduled) {
      clearTimeout(scheduled.timer);
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
    this.backlogOverflowWarned.delete(user);
    this.eventIdOverflowWarned.delete(user);
    this.compacting.delete(user);
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
      const buf = this.buffers.get(user);
      if (!buf) return { ok: true, events: [] };
      const listed = buf.listSince(sinceId);
      if (!listed.ok) return listed;
      let slice = listed.events;
      if (!opts.includeDelta) slice = slice.filter((e) => !e.type.endsWith(DELTA_SUFFIX));
      return { ok: true, events: slice };
    });
  }
  oldestId(user) {
    return this.buffers.get(user)?.oldestId() ?? null;
  }
  latestEvent(user, filter = {}) {
    this.loadUser(user);
    const buf = this.buffers.get(user);
    if (!buf) return null;
    const types = filter.types ? new Set(filter.types) : null;
    return buf.findLast((event) => {
      if (filter.session !== void 0 && event.session !== filter.session) return false;
      if (filter.thread_id !== void 0 && event.thread_id !== filter.thread_id) return false;
      if (types && !types.has(event.type)) return false;
      return true;
    });
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
      const raw = await import_node_fs11.default.promises.readFile(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const { events, totalLines } = parsePersistedEvents(lines);
      this.hydrateLoadedUser(user, events, totalLines);
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
    const evicted = buf.push(event);
    if (evicted) this.bumpCompactionDebt(user);
    this.dispatchSubscribers(user, event);
    if (opts.persist !== false) this.appendToFile(user, event);
    return event;
  }
  guardEventIdOverflow(user, input) {
    this.ensureUserState(user);
    const nextId = (this.counters.get(user) ?? 0) + 1;
    if (nextId <= EVENT_ID_SOFT_LIMIT) return null;
    const message = `event id counter exceeded safe limit (${EVENT_ID_SOFT_LIMIT}); refusing to append new events`;
    if (!this.eventIdOverflowWarned.has(user)) {
      this.eventIdOverflowWarned.add(user);
      logger.error("event id counter exceeded safe limit", {
        user,
        next_event_id: nextId,
        limit: EVENT_ID_SOFT_LIMIT,
        dropped_event_type: input.type
      });
      this.appendLoaded(user, {
        type: "warning",
        session: null,
        thread_id: null,
        payload: {
          message,
          kind: "event_id_overflow",
          limit: EVENT_ID_SOFT_LIMIT,
          next_event_id: nextId,
          dropped_event_type: input.type
        }
      });
    }
    return new Error(message);
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
    this.enforcePendingBacklogCap(user);
    const currentBytes = this.pendingBytes.get(user) ?? 0;
    if (currentBytes > MAX_PENDING_WRITE_BYTES) {
      if (!this.overflowWarned.has(user)) {
        this.overflowWarned.add(user);
        this.appendLoaded(user, {
          type: "warning",
          session: null,
          thread_id: null,
          payload: {
            message: "event log backlog exceeded 1048576 bytes; writes are being retried more slowly",
            kind: "event_log_backpressure",
            pending_bytes: currentBytes
          }
        }, { persist: false });
      }
      this.scheduleFlush(user, OVERFLOW_FLUSH_DELAY_MS, true);
      return;
    }
    this.scheduleFlush(user, DEFAULT_FLUSH_DELAY_MS);
  }
  requestCompaction(user) {
    if (!this.dataDir || this.compacting.has(user)) return;
    this.compacting.add(user);
    void this.compactFile(user).finally(() => {
      this.compacting.delete(user);
      if ((this.rotatedSinceCompact.get(user) ?? 0) >= this.compactionThreshold()) {
        this.requestCompaction(user);
      }
    });
  }
  async compactFile(user) {
    if (!this.dataDir) return;
    const filePath = userEventLogPath(user, this.dataDir);
    let pendingLines = [];
    let pendingBytes = 0;
    let debtSnapshot = 0;
    let writePromise = null;
    await this.withUserLock(user, async () => {
      const scheduled = this.flushTimers.get(user);
      if (scheduled) {
        clearTimeout(scheduled.timer);
        this.flushTimers.delete(user);
      }
      pendingLines = [...this.pendingLines.get(user) ?? []];
      pendingBytes = this.pendingBytes.get(user) ?? 0;
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
      debtSnapshot = this.rotatedSinceCompact.get(user) ?? 0;
      const contents = serializeEventFile(this.buffers.get(user)?.toArray() ?? []);
      writePromise = this.enqueueFsOp(user, async () => {
        try {
          await import_node_fs11.default.promises.mkdir(import_node_path11.default.dirname(filePath), { recursive: true });
          await import_node_fs11.default.promises.mkdir(userDir(user, this.dataDir), { recursive: true });
          const tmp = filePath + ".tmp";
          await import_node_fs11.default.promises.writeFile(tmp, contents);
          await import_node_fs11.default.promises.rename(tmp, filePath);
          return true;
        } catch (e) {
          logger.warn("event log compaction failed", { user, err: e.message });
          return false;
        }
      });
    });
    if (!writePromise) return;
    const ok3 = await writePromise;
    if (!ok3) {
      await this.withUserLock(user, async () => {
        this.restorePendingLines(user, pendingLines, pendingBytes);
        this.scheduleFlush(user, FLUSH_RETRY_DELAY_MS, true);
      });
      return;
    }
    await this.withUserLock(user, async () => {
      const currentDebt = this.rotatedSinceCompact.get(user) ?? 0;
      this.rotatedSinceCompact.set(user, Math.max(0, currentDebt - debtSnapshot));
    });
  }
  bumpCompactionDebt(user, amount = 1) {
    const debt = (this.rotatedSinceCompact.get(user) ?? 0) + amount;
    this.rotatedSinceCompact.set(user, debt);
    if (debt >= this.compactionThreshold()) this.requestCompaction(user);
  }
  scheduleFlush(user, delayMs, reset = false) {
    if (!this.dataDir) return;
    const dueAt = Date.now() + delayMs;
    const existing = this.flushTimers.get(user);
    if (existing) {
      if (!reset || existing.dueAt <= dueAt) return;
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      const scheduled = this.flushTimers.get(user);
      if (!scheduled || scheduled.timer !== timer) return;
      this.flushTimers.delete(user);
      void this.flushUser(user);
    }, delayMs);
    timer.unref?.();
    this.flushTimers.set(user, { dueAt, timer });
  }
  async flushUser(user) {
    if (!this.dataDir) return;
    const filePath = userEventLogPath(user, this.dataDir);
    let snapshotLines = null;
    let snapshotBytes = 0;
    let writePromise = null;
    await this.withUserLock(user, async () => {
      const lines = this.pendingLines.get(user);
      if (!lines || lines.length === 0) return;
      snapshotLines = [...lines];
      snapshotBytes = this.pendingBytes.get(user) ?? 0;
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
      writePromise = this.enqueueFsOp(user, async () => {
        try {
          await import_node_fs11.default.promises.mkdir(import_node_path11.default.dirname(filePath), { recursive: true });
          await import_node_fs11.default.promises.mkdir(userDir(user, this.dataDir), { recursive: true });
          if (!import_node_fs11.default.existsSync(filePath)) {
            await import_node_fs11.default.promises.writeFile(filePath, serializeHeaderLine() + snapshotLines.join(""));
          } else {
            await import_node_fs11.default.promises.appendFile(filePath, snapshotLines.join(""));
          }
          return true;
        } catch (e) {
          logger.warn("failed to append event log", { user, err: e.message });
          return false;
        }
      });
    });
    if (!snapshotLines || !writePromise) return;
    const ok3 = await writePromise;
    if (!ok3) {
      await this.withUserLock(user, async () => {
        this.restorePendingLines(user, snapshotLines, snapshotBytes);
        this.scheduleFlush(user, FLUSH_RETRY_DELAY_MS, true);
      });
      return;
    }
    if ((this.pendingBytes.get(user) ?? 0) <= Math.floor(MAX_PENDING_WRITE_BYTES / 2)) {
      this.overflowWarned.delete(user);
    }
    if (this.pendingBacklogRecovered(user)) this.backlogOverflowWarned.delete(user);
  }
  ensureUserState(user) {
    if (!this.buffers.has(user)) this.buffers.set(user, new EventRingBuffer(this.retention));
    if (!this.counters.has(user)) this.counters.set(user, 0);
  }
  hydrateLoadedUser(user, events, totalLines) {
    const buf = new EventRingBuffer(this.retention, events);
    let maxSeq = 0;
    for (const ev of buf.toArray()) {
      const seq = parseInt(ev.id.replace(/^evt-/, ""), 10);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
    this.buffers.set(user, buf);
    this.counters.set(user, maxSeq);
    if (totalLines > this.retention * 1.5) this.requestCompaction(user);
  }
  compactionThreshold() {
    return Math.max(100, Math.floor(this.retention / 2));
  }
  maxPendingLineCount() {
    return Math.max(1, this.retention * MAX_PENDING_LINE_MULTIPLIER);
  }
  restorePendingLines(user, lines, bytes) {
    if (lines.length === 0 || bytes <= 0) return;
    const pending = this.pendingLines.get(user) ?? [];
    this.pendingLines.set(user, [...lines, ...pending]);
    this.pendingBytes.set(user, bytes + (this.pendingBytes.get(user) ?? 0));
    this.enforcePendingBacklogCap(user);
  }
  enforcePendingBacklogCap(user) {
    const pending = this.pendingLines.get(user);
    if (!pending || pending.length === 0) {
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
      return;
    }
    const maxLines = this.maxPendingLineCount();
    let totalBytes = this.pendingBytes.get(user) ?? 0;
    let droppedLines = 0;
    let droppedBytes = 0;
    while (pending.length > maxLines || totalBytes > MAX_PENDING_BACKLOG_BYTES) {
      const dropped = pending.shift();
      if (!dropped) break;
      const lineBytes = Buffer.byteLength(dropped);
      totalBytes -= lineBytes;
      droppedLines += 1;
      droppedBytes += lineBytes;
    }
    if (pending.length === 0) {
      this.pendingLines.delete(user);
      this.pendingBytes.delete(user);
    } else {
      this.pendingBytes.set(user, totalBytes);
    }
    if (droppedLines > 0 && !this.backlogOverflowWarned.has(user)) {
      this.backlogOverflowWarned.add(user);
      this.appendLoaded(user, {
        type: "warning",
        session: null,
        thread_id: null,
        payload: {
          message: `event log backlog exceeded ${maxLines} lines or ${MAX_PENDING_BACKLOG_BYTES} bytes; dropping oldest pending persisted entries`,
          kind: "event_log_backlog_overflow",
          dropped_lines: droppedLines,
          dropped_bytes: droppedBytes,
          max_pending_lines: maxLines,
          max_pending_bytes: MAX_PENDING_BACKLOG_BYTES,
          pending_lines: pending.length,
          pending_bytes: Math.max(totalBytes, 0)
        }
      }, { persist: false });
    }
  }
  pendingBacklogRecovered(user) {
    const pendingLines = this.pendingLines.get(user)?.length ?? 0;
    const pendingBytes = this.pendingBytes.get(user) ?? 0;
    return pendingLines <= Math.floor(this.maxPendingLineCount() / 2) && pendingBytes <= Math.floor(MAX_PENDING_BACKLOG_BYTES / 2);
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

// src/daemon/cursors.ts
var import_node_fs12 = __toESM(require("fs"));
var import_node_os2 = __toESM(require("os"));
var import_node_path12 = __toESM(require("path"));
var import_promises2 = require("timers/promises");
var CURSOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var SCHEMA_VERSION4 = 1;
var LOCK_RETRY_MS = 10;
var LOCK_TIMEOUT_MS = 2e3;
var LOCK_STALE_MS = 5 * 60 * 1e3;
var CursorStore = class {
  dataDir;
  users = /* @__PURE__ */ new Map();
  loaded = /* @__PURE__ */ new Set();
  writeChains = /* @__PURE__ */ new Map();
  pendingPersists = /* @__PURE__ */ new Map();
  constructor(dataDir) {
    this.dataDir = dataDir;
  }
  list(user) {
    const bucket = this.bucket(user);
    return sorted(bucket).map(cloneCursorRecord);
  }
  get(user, name) {
    validateCursorName(name);
    return cloneCursor(this.bucket(user).get(name) ?? null);
  }
  async ensure(user, input) {
    validateCursorName(input.name);
    const existing = this.bucket(user).get(input.name);
    if (existing) return cloneCursor(existing);
    return await this.save(user, input);
  }
  async save(user, input) {
    validateCursorName(input.name);
    const bucket = this.bucket(user);
    const existing = bucket.get(input.name);
    const cursor = {
      name: input.name,
      event_id: input.event_id ?? null,
      updated_at: (/* @__PURE__ */ new Date()).toISOString(),
      auto_update: input.auto_update ?? existing?.auto_update ?? true
    };
    bucket.set(cursor.name, cursor);
    this.discardPendingPersist(user, cursor.name);
    try {
      await this.enqueuePersist(user, { type: "upsert", cursor: cloneCursorRecord(cursor) });
    } catch (error) {
      if (existing) {
        bucket.set(existing.name, existing);
      } else {
        bucket.delete(cursor.name);
      }
      throw error;
    }
    return cloneCursor(cursor);
  }
  async saveBestEffort(user, input) {
    validateCursorName(input.name);
    const bucket = this.bucket(user);
    const existing = bucket.get(input.name);
    const cursor = {
      name: input.name,
      event_id: input.event_id ?? null,
      updated_at: (/* @__PURE__ */ new Date()).toISOString(),
      auto_update: input.auto_update ?? existing?.auto_update ?? true
    };
    bucket.set(cursor.name, cursor);
    this.discardPendingPersist(user, cursor.name);
    try {
      await this.enqueuePersist(user, { type: "upsert", cursor: cloneCursorRecord(cursor) });
    } catch (error) {
      logger.warn("failed to persist cursors.json", { user, err: error.message });
    }
    return cloneCursor(cursor);
  }
  saveBestEffortDebounced(user, input, debounceMs) {
    validateCursorName(input.name);
    const bucket = this.bucket(user);
    const existing = bucket.get(input.name);
    const cursor = {
      name: input.name,
      event_id: input.event_id ?? null,
      updated_at: (/* @__PURE__ */ new Date()).toISOString(),
      auto_update: input.auto_update ?? existing?.auto_update ?? true
    };
    bucket.set(cursor.name, cursor);
    this.scheduleBestEffortPersist(user, { type: "upsert", cursor: cloneCursorRecord(cursor) }, debounceMs);
    return cloneCursor(cursor);
  }
  async delete(user, name) {
    validateCursorName(name);
    const bucket = this.bucket(user);
    const existing = bucket.get(name);
    const deleted = bucket.delete(name);
    if (!deleted) return false;
    this.discardPendingPersist(user, name);
    try {
      await this.enqueuePersist(user, { type: "delete", name });
    } catch (error) {
      if (existing) bucket.set(name, existing);
      throw error;
    }
    return true;
  }
  async clearUser(user) {
    await this.flushUser(user);
    await (this.writeChains.get(user)?.catch(() => void 0) ?? Promise.resolve());
    this.writeChains.delete(user);
    this.clearPendingPersistState(user);
    this.users.delete(user);
    this.loaded.delete(user);
  }
  async flushUser(user) {
    while (true) {
      const state = this.pendingPersists.get(user);
      if (!state) {
        await (this.writeChains.get(user)?.catch(() => void 0) ?? Promise.resolve());
        return;
      }
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.flushing) {
        await state.flushing;
        continue;
      }
      if (state.ops.size === 0) {
        this.clearPendingPersistState(user);
        await (this.writeChains.get(user)?.catch(() => void 0) ?? Promise.resolve());
        return;
      }
      const ops = Array.from(state.ops.values(), clonePersistOp);
      state.ops.clear();
      const flushPromise = this.enqueuePersist(user, ops).catch((error) => {
        logger.warn("failed to persist cursors.json", { user, err: error.message });
      }).finally(() => {
        if (this.pendingPersists.get(user) !== state) return;
        state.flushing = null;
        if (!state.timer && state.ops.size === 0) {
          this.pendingPersists.delete(user);
        }
      });
      state.flushing = flushPromise;
      await flushPromise;
    }
  }
  async flush() {
    const users = /* @__PURE__ */ new Set([
      ...this.pendingPersists.keys(),
      ...this.writeChains.keys()
    ]);
    for (const user of users) {
      await this.flushUser(user);
    }
  }
  bucket(user) {
    this.loadForUser(user);
    let bucket = this.users.get(user);
    if (!bucket) {
      bucket = /* @__PURE__ */ new Map();
      this.users.set(user, bucket);
    }
    return bucket;
  }
  loadForUser(user) {
    if (this.loaded.has(user)) return;
    const bucket = /* @__PURE__ */ new Map();
    const filePath = cursorFilePath(user, this.dataDir);
    if (import_node_fs12.default.existsSync(filePath)) {
      try {
        for (const cursor of loadEnvelopeFromText(import_node_fs12.default.readFileSync(filePath, "utf8")).cursors.values()) {
          bucket.set(cursor.name, cloneCursor(cursor));
        }
      } catch (error) {
        throw new Error(`failed to load cursors.json for '${user}': ${error.message}`);
      }
    }
    this.users.set(user, bucket);
    this.loaded.add(user);
  }
  enqueuePersist(user, op) {
    const ops = Array.isArray(op) ? op.map(clonePersistOp) : [clonePersistOp(op)];
    const previous = this.writeChains.get(user) ?? Promise.resolve();
    const next = previous.catch(() => void 0).then(() => this.persistAsync(user, ops));
    this.writeChains.set(user, next);
    return next;
  }
  async persistAsync(user, ops) {
    const dir = userDir(user, this.dataDir);
    await import_node_fs12.default.promises.mkdir(dir, { recursive: true });
    const filePath = cursorFilePath(user, this.dataDir);
    const lock = await acquireCursorLock(filePath);
    const tmpPath = makeTempPath(filePath);
    try {
      const persisted = await loadEnvelopeFromFile(filePath);
      for (const op of ops) applyPersistOp(persisted, op);
      const payload = {
        schema_version: SCHEMA_VERSION4,
        cursors: sorted(persisted)
      };
      await import_node_fs12.default.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2));
      await import_node_fs12.default.promises.rename(tmpPath, filePath);
    } finally {
      await import_node_fs12.default.promises.unlink(tmpPath).catch(() => void 0);
      await lock.release();
    }
  }
  scheduleBestEffortPersist(user, op, debounceMs) {
    const state = this.getPendingPersistState(user);
    state.ops.set(persistKey(op), clonePersistOp(op));
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flushUser(user);
    }, Math.max(0, debounceMs));
    state.timer.unref();
  }
  discardPendingPersist(user, cursorName) {
    const state = this.pendingPersists.get(user);
    if (!state) return;
    state.ops.delete(cursorName);
    if (!state.timer && !state.flushing && state.ops.size === 0) {
      this.pendingPersists.delete(user);
    }
  }
  getPendingPersistState(user) {
    let state = this.pendingPersists.get(user);
    if (!state) {
      state = {
        timer: null,
        ops: /* @__PURE__ */ new Map(),
        flushing: null
      };
      this.pendingPersists.set(user, state);
    }
    return state;
  }
  clearPendingPersistState(user) {
    const state = this.pendingPersists.get(user);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.pendingPersists.delete(user);
  }
};
function cursorFilePath(user, dataDir) {
  return import_node_path12.default.join(userDir(user, dataDir), "cursors.json");
}
async function acquireCursorLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const created = await tryCreateCursorLock(lockPath);
      if (created) return created;
    } catch (error) {
      const err2 = error;
      if (err2.code !== "EEXIST") throw error;
      const reclaimed = await reclaimStaleCursorLock(lockPath);
      if (reclaimed) return reclaimed;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for cursor lock '${lockPath}'`);
    }
    await (0, import_promises2.setTimeout)(LOCK_RETRY_MS);
  }
}
async function reclaimStaleCursorLock(lockPath) {
  const lock = await readCursorLock(lockPath);
  if (!lock || !isStaleCursorLock(lock)) return null;
  try {
    await import_node_fs12.default.promises.unlink(lockPath);
  } catch (error) {
    const err2 = error;
    if (err2.code === "ENOENT") return null;
    throw error;
  }
  try {
    return await tryCreateCursorLock(lockPath);
  } catch (error) {
    const err2 = error;
    if (err2.code === "EEXIST") return null;
    throw error;
  }
}
function makeTempPath(filePath) {
  return `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
}
function makeCursorLockRecord() {
  return {
    pid: process.pid,
    started_at: (/* @__PURE__ */ new Date()).toISOString(),
    host: import_node_os2.default.hostname(),
    nonce: Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  };
}
async function loadEnvelopeFromFile(filePath) {
  try {
    const raw = await import_node_fs12.default.promises.readFile(filePath, "utf8");
    return loadEnvelopeFromText(raw).cursors;
  } catch (error) {
    const err2 = error;
    if (err2.code === "ENOENT") return /* @__PURE__ */ new Map();
    throw error;
  }
}
function loadEnvelopeFromText(raw) {
  const parsed = JSON.parse(raw);
  if (typeof parsed.schema_version === "number" && parsed.schema_version > SCHEMA_VERSION4) {
    throw new Error(`cursors.json schema_version ${parsed.schema_version} is newer than supported ${SCHEMA_VERSION4}`);
  }
  const bucket = /* @__PURE__ */ new Map();
  for (const cursor of parsed.cursors ?? []) {
    if (!isPersistedCursor(cursor)) continue;
    bucket.set(cursor.name, cloneCursor(cursor));
  }
  return { cursors: bucket };
}
async function readCursorLock(lockPath) {
  try {
    const raw = await import_node_fs12.default.promises.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid) || typeof parsed.started_at !== "string" || typeof parsed.host !== "string") {
      return null;
    }
    return {
      pid: parsed.pid,
      started_at: parsed.started_at,
      host: parsed.host,
      ...typeof parsed.nonce === "string" && parsed.nonce.length > 0 ? { nonce: parsed.nonce } : {}
    };
  } catch {
    return null;
  }
}
async function verifyCursorLockOwnership(lockPath, expected) {
  const current = await readCursorLock(lockPath);
  return current?.pid === expected.pid && current.started_at === expected.started_at && current.host === expected.host && current.nonce === expected.nonce;
}
function isStaleCursorLock(lock) {
  if (!isPidAlive2(lock.pid)) return true;
  if (lock.pid === process.pid) return false;
  const startedAt = Date.parse(lock.started_at);
  return Number.isFinite(startedAt) && Date.now() - startedAt > LOCK_STALE_MS;
}
function isPidAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function applyPersistOp(bucket, op) {
  if (op.type === "delete") {
    bucket.delete(op.name);
    return;
  }
  bucket.set(op.cursor.name, cloneCursorRecord(op.cursor));
}
function clonePersistOp(op) {
  if (op.type === "delete") return { type: "delete", name: op.name };
  return { type: "upsert", cursor: cloneCursorRecord(op.cursor) };
}
function persistKey(op) {
  return op.type === "delete" ? op.name : op.cursor.name;
}
function validateCursorName(name) {
  if (!CURSOR_NAME_RE.test(name)) {
    throw invalidParams("cursor name must match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/");
  }
}
function sorted(bucket) {
  return Array.from(bucket.values()).sort((a, b) => a.name.localeCompare(b.name));
}
function cloneCursor(cursor) {
  if (!cursor) return null;
  return cloneCursorRecord(cursor);
}
function cloneCursorRecord(cursor) {
  return {
    name: cursor.name,
    event_id: cursor.event_id,
    updated_at: cursor.updated_at,
    auto_update: cursor.auto_update
  };
}
async function tryCreateCursorLock(lockPath) {
  const handle = await import_node_fs12.default.promises.open(lockPath, "wx");
  const record = makeCursorLockRecord();
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
    if (!await verifyCursorLockOwnership(lockPath, record)) {
      await handle.close().catch(() => void 0);
      return null;
    }
    return {
      lockPath,
      record,
      release: async () => {
        const owned = await verifyCursorLockOwnership(lockPath, record);
        await handle.close().catch(() => void 0);
        if (owned) {
          await import_node_fs12.default.promises.unlink(lockPath).catch(() => void 0);
        }
      }
    };
  } catch (error) {
    await handle.close().catch(() => void 0);
    throw error;
  }
}
function isPersistedCursor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value;
  return typeof cursor.name === "string" && (typeof cursor.event_id === "string" || cursor.event_id === null || cursor.event_id === void 0) && typeof cursor.updated_at === "string" && typeof cursor.auto_update === "boolean";
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
  renameSession(user, oldSessionName, newSessionName) {
    let renamed = 0;
    for (const rec of this.allRequests()) {
      if (rec.user !== user || rec.session_name !== oldSessionName) continue;
      rec.session_name = newSessionName;
      renamed += 1;
    }
    return renamed;
  }
  removeForUser(user) {
    return this.removeMatching((rec) => rec.user === user);
  }
  abortForSession(user, sessionName, message, data) {
    return this.abortMatching((rec) => rec.user === user && rec.session_name === sessionName, message, data);
  }
  abortForUser(user, message, data) {
    return this.abortMatching((rec) => rec.user === user, message, data);
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
  abortMatching(predicate, message, data) {
    const aborted = [];
    for (const rec of this.allRequests()) {
      if (!predicate(rec)) continue;
      const removed = this.remove(rec.request_id);
      if (!removed || removed.responded_at) continue;
      removed.client = pendingAbortClient(message, data);
      aborted.push(removed);
    }
    return aborted;
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
function pendingAbortClient(message, data) {
  const error = new CodexTeamError("internal", message, data);
  return {
    respondAck: async () => await Promise.reject(error),
    respondErrorAck: async () => await Promise.reject(error),
    respondError: () => {
      throw error;
    }
  };
}

// src/daemon/queues.ts
var import_node_crypto4 = __toESM(require("crypto"));

// src/codex/retry.ts
var import_promises3 = require("timers/promises");

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
      if (sleepMs > 0) await (0, import_promises3.setTimeout)(sleepMs);
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
async function threadArchive(client, threadId, retry = DEFAULT_RETRY) {
  await retryOnOverload(() => client.request("thread/archive", { threadId }), retry);
}
async function threadUnarchive(client, threadId, retry = DEFAULT_RETRY) {
  await retryOnOverload(() => client.request("thread/unarchive", { threadId }), retry);
}
async function threadRename(client, threadId, name, retry = DEFAULT_RETRY) {
  await retryOnOverload(() => client.request("thread/name/set", { threadId, name }), retry);
}
async function threadSetName(client, threadId, name, retry = DEFAULT_RETRY) {
  await retryOnOverload(() => client.request("thread/name/set", { threadId, name }), retry);
}
async function threadList(client, params = {}, retry = DEFAULT_RETRY) {
  const requestParams = {};
  if (params.cursor !== void 0) requestParams.cursor = params.cursor;
  if (params.pageSize !== void 0) requestParams.limit = params.pageSize;
  if (params.includeArchived !== void 0) requestParams.includeArchived = params.includeArchived;
  if (params.sortKey !== void 0) requestParams.sortKey = params.sortKey;
  const result = await retryOnOverload(() => client.request("thread/list", requestParams), retry);
  const obj = asObject4(result);
  const data = Array.isArray(obj.data) ? obj.data : [];
  return {
    data,
    nextCursor: obj.nextCursor ?? null,
    backwardsCursor: obj.backwardsCursor ?? null
  };
}
async function threadLoadedList(client, retry = DEFAULT_RETRY) {
  const result = await retryOnOverload(() => client.request("thread/loadedList", {}), retry);
  const obj = asObject4(result);
  return {
    threads: Array.isArray(obj.threads) ? obj.threads : []
  };
}
async function threadRead(client, threadId, retry = DEFAULT_RETRY) {
  const result = await retryOnOverload(() => client.request("thread/read", { threadId }), retry);
  const obj = asObject4(result);
  const thread = asObject4(obj.thread);
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
  const obj = asObject4(result);
  return {
    data: Array.isArray(obj.data) ? obj.data : [],
    nextCursor: obj.nextCursor ?? null,
    backwardsCursor: obj.backwardsCursor ?? null
  };
}
async function turnStart(client, threadId, input, retry = DEFAULT_RETRY) {
  const result = await retryOnOverload(() => client.request("turn/start", { threadId, input }), retry);
  const obj = asObject4(result);
  const turn = asObject4(obj.turn);
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
  const obj = asObject4(result);
  const thread = asObject4(obj.thread);
  if (typeof thread.id !== "string" || !thread.id) {
    throw new Error(`${rpc}: response missing thread.id`);
  }
  return { ...obj, thread };
}
function asObject4(value) {
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
      if (state.currentTurnId || state.draining || state.pending.length > 0) {
        const queued = { id: queueId(), input, enqueuedAt: (/* @__PURE__ */ new Date()).toISOString(), failedAttempts: 0 };
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
    const state = this.states.get(sessionKey);
    if (!state) return true;
    return state.tearingDown;
  }
  markTeardown(sessionKey) {
    const state = this.getOrInit(sessionKey);
    state.tearingDown = true;
  }
  async beginTeardown(sessionKey) {
    this.markTeardown(sessionKey);
    const state = this.getOrInit(sessionKey);
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
      return await this.releaseCurrentTurnAndDrain(state, sessionKey, client, threadId, retry);
    });
  }
  async onTurnErrored(sessionKey, turnId, options, client, threadId, retry) {
    return await this.withSessionLock(sessionKey, async (state) => {
      if (options.willRetry) {
        return { turn_id: null, queue_id: null, failed: false, dropped: [] };
      }
      if (state.currentTurnId && turnId && state.currentTurnId !== turnId) {
        return { turn_id: null, queue_id: null, failed: false, dropped: [] };
      }
      return await this.releaseCurrentTurnAndDrain(state, sessionKey, client, threadId, retry);
    });
  }
  finalDispose(sessionKey) {
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
  dispose(sessionKey) {
    return this.finalDispose(sessionKey);
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
  async releaseCurrentTurnAndDrain(state, sessionKey, client, threadId, retry) {
    state.draining = true;
    state.currentTurnId = null;
    this.resolveIdleWaiters(state);
    const generation = state.generation;
    const dropped = [];
    try {
      while (state.pending.length > 0 && client && !state.disposed && !state.tearingDown) {
        const next = state.pending[0];
        try {
          if (!isStateUsable(state, generation)) {
            return { turn_id: null, queue_id: null, failed: false, dropped };
          }
          const res = await turnStart(client, threadId, next.input, retry);
          if (!isStateUsable(state, generation)) {
            return { turn_id: null, queue_id: null, failed: false, dropped };
          }
          state.pending.shift();
          state.currentTurnId = res.turnId;
          return { turn_id: res.turnId, queue_id: next.id, failed: false, dropped };
        } catch (e) {
          if (!isStateUsable(state, generation)) {
            return { turn_id: null, queue_id: null, failed: false, dropped };
          }
          const err2 = e;
          next.failedAttempts += 1;
          logger.warn("failed to dispatch queued turn", {
            session: sessionKey,
            err: err2.message,
            queue_id: next.id,
            failure_count: next.failedAttempts
          });
          if (next.failedAttempts < queueHeadRetryMax(retry)) {
            return {
              turn_id: null,
              queue_id: next.id,
              failed: true,
              error_message: err2.message,
              dropped
            };
          }
          state.pending.shift();
          dropped.push({
            queue_id: next.id,
            error_message: err2.message,
            failure_count: next.failedAttempts
          });
          logger.warn("dropping queued turn after repeated dispatch failures", {
            session: sessionKey,
            err: err2.message,
            queue_id: next.id,
            failure_count: next.failedAttempts
          });
        }
      }
      return { turn_id: null, queue_id: null, failed: false, dropped };
    } finally {
      if (isSameGeneration(state, generation)) {
        state.draining = false;
        this.resolveIdleWaiters(state);
      }
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
function queueHeadRetryMax(retry) {
  const candidate = retry?.maxAttempts;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }
  return 3;
}

// src/daemon/orphans.ts
var import_node_crypto5 = __toESM(require("crypto"));
var import_node_fs13 = __toESM(require("fs"));
var import_node_path13 = __toESM(require("path"));
var import_promises4 = require("timers/promises");
var SCHEMA_VERSION5 = 2;
var TERM_GRACE_MS = 2e3;
var KILL_GRACE_MS = 500;
var POLL_MS = 100;
function orphanPidsPath(dataDir) {
  return import_node_path13.default.join(dataDir, "codex-pids.json");
}
function readPidFile2(dataDir) {
  const p = orphanPidsPath(dataDir);
  if (!import_node_fs13.default.existsSync(p)) return [];
  try {
    const raw = import_node_fs13.default.readFileSync(p, "utf8");
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
    if (typeof obj.schema_version === "number" && obj.schema_version > SCHEMA_VERSION5) {
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
    import_node_fs13.default.mkdirSync(import_node_path13.default.dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    import_node_fs13.default.writeFileSync(tmp, JSON.stringify({
      schema_version: SCHEMA_VERSION5,
      processes: pids
    }));
    import_node_fs13.default.renameSync(tmp, p);
  } catch (e) {
    logger.warn("failed to persist codex pid file", { err: e.message });
  }
}
async function reapOrphans(dataDir) {
  const pids = readPidFile2(dataDir);
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
    await (0, import_promises4.setTimeout)(POLL_MS, void 0, { ref: false });
  }
  return inspectTrackedProcessLiveness(tracked) === "dead";
}

// src/codex/pool.ts
var import_node_events2 = require("events");

// src/codex/appServerClient.ts
var import_node_child_process4 = require("child_process");
var import_node_events = require("events");
var import_node_crypto6 = require("crypto");
var import_node_path14 = __toESM(require("path"));
var STDERR_TAIL_LINES = 400;
var DEFAULT_REQUEST_TIMEOUT_MS = 12e4;
var AppServerClient = class extends import_node_events.EventEmitter {
  proc = null;
  stdoutBuf = "";
  stderrBuf = "";
  pending = /* @__PURE__ */ new Map();
  stdoutLogTail = [];
  stderrLogTail = [];
  lastPid = null;
  nextLogSeq = 1;
  options;
  initialized = false;
  stdoutParser = this.createStdoutParser("app_server:unknown");
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
    return this.stderrLogTail.map((entry) => entry.line).join("\n");
  }
  stdoutTailText() {
    return this.stdoutLogTail.map((entry) => entry.line).join("\n");
  }
  stderrTail(n = this.options.stderrTailLines) {
    return this.sliceTail(this.stderrLogTail, n);
  }
  stdoutTail(n = this.options.stderrTailLines) {
    return this.sliceTail(this.stdoutLogTail, n);
  }
  logTail(stream, n = this.options.stderrTailLines) {
    if (stream === "stdout") return this.stdoutTail(n);
    if (stream === "stderr") return this.stderrTail(n);
    const merged = [...this.stdoutLogTail, ...this.stderrLogTail].sort((left, right) => left.seq - right.seq);
    return this.sliceTail(merged, n);
  }
  async start() {
    if (this.proc) throw new Error("app-server already started");
    const args = [...this.options.args];
    for (const kv of this.options.configOverrides) args.push("--config", kv);
    args.push("app-server", "--listen", "stdio://");
    const launch = resolveLaunch(this.options.bin, args);
    const env = { ...process.env, ...this.options.env ?? {} };
    logger.debug("spawning app-server", { bin: launch.command, args: launch.args });
    this.proc = (0, import_node_child_process4.spawn)(launch.command, launch.args, {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.lastPid = this.proc.pid ?? null;
    this.stdoutParser = this.createStdoutParser(this.peerLabel());
    this.proc.on("error", (err2) => {
      logger.error("app-server spawn error", { err: err2.message });
      this.failAllPending(new TransportClosedError(`spawn error: ${err2.message}`));
      this.emit("error", err2);
    });
    this.proc.on("exit", (code, signal) => {
      logger.info("app-server exited", { code, signal });
      this.flushLogBuffer("stdout", true);
      this.flushLogBuffer("stderr", true);
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
      clientInfo: this.options.clientInfo ?? { name: "codex-team", title: "codex-team", version: VERSION },
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
    this.stdoutParser.push(chunk);
    this.stdoutBuf += chunk;
    this.flushLogBuffer("stdout");
  }
  onStderr(chunk) {
    this.stderrBuf += chunk;
    this.flushLogBuffer("stderr");
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
  createStdoutParser(peer) {
    return createLineParser({
      maxFrameBytes: readMaxFrameBytes(),
      peer,
      onError: (error) => {
        this.failAllPending(error);
        this.emit("error", error);
        void this.close().catch(() => void 0);
      },
      onLine: (line) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          logger.warn("malformed line from app-server", { snippet: line.slice(0, 200) });
          return;
        }
        this.dispatchIncoming(parsed);
      }
    });
  }
  peerLabel() {
    return this.lastPid ? `app_server:${this.lastPid}` : "app_server:unknown";
  }
  flushLogBuffer(stream, includePartial = false) {
    const current = stream === "stdout" ? this.stdoutBuf : this.stderrBuf;
    let remaining = current;
    let idx;
    while ((idx = remaining.indexOf("\n")) >= 0) {
      const line = remaining.slice(0, idx);
      remaining = remaining.slice(idx + 1);
      this.recordLogLine(stream, line);
    }
    if (includePartial && remaining.length > 0) {
      this.recordLogLine(stream, remaining);
      remaining = "";
    }
    if (stream === "stdout") this.stdoutBuf = remaining;
    else this.stderrBuf = remaining;
  }
  recordLogLine(stream, line) {
    if (!line) return;
    const entry = {
      stream,
      line,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      seq: this.nextLogSeq++
    };
    const target = stream === "stdout" ? this.stdoutLogTail : this.stderrLogTail;
    target.push(entry);
    if (target.length > this.options.stderrTailLines) target.shift();
    const rendered = this.stripLogLine(entry);
    this.emit(`${stream}_line`, rendered);
  }
  sliceTail(lines, n) {
    const limit = normalizeTailCount(n, this.options.stderrTailLines);
    return lines.slice(Math.max(0, lines.length - limit)).map((entry) => this.stripLogLine(entry));
  }
  stripLogLine(entry) {
    return {
      stream: entry.stream,
      line: entry.line,
      ts: entry.ts
    };
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
  if (bin.includes("\\") || bin.includes("/") || import_node_path14.default.extname(bin).length > 0) return bin;
  try {
    const raw = (0, import_node_child_process4.execFileSync)("where", [bin], {
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
function normalizeTailCount(value, fallback) {
  if (!Number.isFinite(value)) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(value));
}

// src/codex/pool.ts
var AppServerPool = class extends import_node_events2.EventEmitter {
  options;
  byUser = /* @__PURE__ */ new Map();
  byClient = /* @__PURE__ */ new Map();
  bySession = /* @__PURE__ */ new Map();
  closedLogsBySession = /* @__PURE__ */ new Map();
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
      this.closedLogsBySession.delete(sessionKey);
      return managed.client;
    }
    const fresh = await this.spawn(user, clientOptions);
    fresh.sessions.add(sessionKey);
    this.bySession.set(sessionKey, fresh);
    this.closedLogsBySession.delete(sessionKey);
    return fresh.client;
  }
  release(sessionKey) {
    const m = this.bySession.get(sessionKey);
    if (!m) return;
    m.sessions.delete(sessionKey);
    this.bySession.delete(sessionKey);
    this.closedLogsBySession.delete(sessionKey);
  }
  rekeySession(oldKey, newKey) {
    if (oldKey === newKey) return;
    const m = this.bySession.get(oldKey);
    if (!m) return;
    m.sessions.delete(oldKey);
    m.sessions.add(newKey);
    this.bySession.delete(oldKey);
    this.bySession.set(newKey, m);
    const closed = this.closedLogsBySession.get(oldKey);
    if (closed) {
      this.closedLogsBySession.delete(oldKey);
      this.closedLogsBySession.set(newKey, cloneClosedSessionLogs(closed));
    }
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
  sessionBinding(sessionKey) {
    const m = this.bySession.get(sessionKey);
    return m ? { appServerId: m.id, pid: m.client.pid() } : null;
  }
  clientById(clientId) {
    return this.byClient.get(clientId)?.client ?? null;
  }
  closedLogsForSession(sessionKey) {
    const snapshot = this.closedLogsBySession.get(sessionKey);
    return snapshot ? cloneClosedSessionLogs(snapshot) : null;
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
    this.closedLogsBySession.clear();
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
      const closedLogs = {
        appServerId: id,
        pid: client.pid(),
        closedAt: (/* @__PURE__ */ new Date()).toISOString(),
        stderrTail: client.stderrTail(),
        stdoutTail: client.stdoutTail()
      };
      for (const s of sessions) this.bySession.delete(s);
      managed.sessions.clear();
      if (reason === "unexpected") {
        for (const sessionKey of sessions) {
          this.closedLogsBySession.set(sessionKey, cloneClosedSessionLogs(closedLogs));
        }
      } else {
        for (const sessionKey of sessions) this.closedLogsBySession.delete(sessionKey);
      }
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
function cloneClosedSessionLogs(value) {
  return {
    appServerId: value.appServerId,
    pid: value.pid,
    closedAt: value.closedAt,
    stderrTail: value.stderrTail.map((entry) => ({ ...entry })),
    stdoutTail: value.stdoutTail.map((entry) => ({ ...entry }))
  };
}

// src/daemon/context.ts
function buildContext(opts = {}) {
  const config = opts.config ?? new ConfigStore();
  const dataDir = config.resolvedDataDir();
  const sockPath = config.resolvedSockPath();
  const logPath = config.resolvedLogPath();
  const logLevel = config.getEffective("daemon.log_level");
  logger.configure({
    level: typeof logLevel === "string" ? logLevel : "info",
    logPath
  });
  const users = new UserRegistry(dataDir);
  const sessions = new SessionRegistry(dataDir, {
    persistDebounceMs: () => toInt2(config.getEffective("session.persist_debounce_ms"), 50)
  });
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
  const cursors = opts.cursors ?? new CursorStore(dataDir);
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
    cursors,
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

// src/daemon/pending-cancel.ts
var JSONRPC_CANCEL_ERROR_CODE = -32e3;
async function cancelPendingWithEvent(ctx, user, sessionName, threadId, reason, filter) {
  if (typeof ctx.pending.listForUser !== "function" || typeof ctx.pending.remove !== "function") return;
  const matching = pendingRequestsForSession(ctx, user, sessionName, filter);
  for (const pending of matching) {
    const removed = ctx.pending.remove(pending.request_id) ?? pending;
    if (removed.responded_at) continue;
    try {
      removed.client.respondError(
        removed.jsonrpc_id,
        JSONRPC_CANCEL_ERROR_CODE,
        cancellationClientMessage(reason)
      );
    } catch {
    }
    const eventType = cancellationEventType(removed.kind);
    if (!eventType) continue;
    await ctx.events.append(user, {
      type: eventType,
      session: removed.session_name ?? normalizeSessionName(sessionName),
      thread_id: removed.thread_id ?? normalizeThreadId(threadId),
      payload: {
        request_id: removed.request_id,
        kind: removed.kind,
        turn_id: removed.turn_id ?? null,
        reason
      }
    });
  }
}
function pendingRequestsForSession(ctx, user, sessionName, filter) {
  if (typeof ctx.pending.listForUser !== "function") return [];
  return ctx.pending.listForUser(user).filter((pending) => matchesSession(pending, sessionName) && (!filter || filter(pending)));
}
function matchesSession(pending, sessionName) {
  if (sessionName === "*") return true;
  return pending.session_name === sessionName;
}
function cancellationClientMessage(reason) {
  switch (reason) {
    case "user_detach":
      return "session detached";
    case "idle_unload":
      return "session idle_unloaded";
    case "user_destroyed":
      return "user destroyed";
    case "session_seized":
      return "session seized by another user";
    case "session_heal_force_reset":
    case "session_crashed":
    case "app_server_crashed_on_restart":
      return "session_crashed";
    default:
      return reason;
  }
}
function cancellationEventType(kind) {
  if (kind.startsWith("approval.")) return APPROVAL_REQUEST_CANCELLED_EVENT_TYPE;
  if (kind === "user_input.request") return USER_INPUT_REQUEST_CANCELLED_EVENT_TYPE;
  return null;
}
function normalizeSessionName(sessionName) {
  return sessionName.length > 0 && sessionName !== "*" ? sessionName : null;
}
function normalizeThreadId(threadId) {
  return threadId.length > 0 ? threadId : null;
}

// src/daemon/handlers/version.ts
var version = async (_ctx, _req) => {
  return {
    daemon_version: VERSION
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
  const retainedLimit = typeof ctx.config?.getEffective === "function" ? ctx.config.getEffective("monitor.event_log_retention") : null;
  const appServerCount = typeof ctx.pool?.processCount === "function" ? ctx.pool.processCount() : null;
  return {
    token: user.token,
    created_at: user.created_at,
    last_active_at: user.last_active_at,
    live_sessions: ctx.sessions.listLive(token).length,
    retained_events: ctx.events.retainedCount(token),
    retained_limit: typeof retainedLimit === "number" ? retainedLimit : null,
    pending_requests: ctx.pending.listForUser(token).length,
    app_server_count: typeof appServerCount === "number" ? appServerCount : null,
    daemon: {
      pid: process.pid,
      started_at: ctx.startedAt.toISOString(),
      data_dir: ctx.dataDir
    }
  };
};

// src/daemon/handlers/daemon.ts
var import_node_fs15 = __toESM(require("fs"));
var import_node_path15 = __toESM(require("path"));
var import_node_child_process5 = require("child_process");

// src/daemon/shutdown.ts
var import_node_fs14 = __toESM(require("fs"));
var shuttingDown = false;
async function shutdownDaemon(ctx, reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown initiated", { reason });
  try {
    for (const user of ctx.users.list()) {
      for (const rec of ctx.sessions.listLive(user.token)) {
        await ctx.events.append(user.token, {
          type: SESSION_CLOSED_EVENT_TYPE,
          session: rec.name,
          thread_id: rec.thread_id,
          payload: {
            session: rec.name,
            thread_id: rec.thread_id,
            reason: "daemon_shutdown",
            ts: (/* @__PURE__ */ new Date()).toISOString()
          }
        });
      }
    }
  } catch (e) {
    logger.error("session closed event flush error", { err: e.message });
  }
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
  try {
    await ctx.cursors.flush();
  } catch (e) {
    logger.error("cursor flush error", { err: e.message });
  }
  unlinkSockIfStale(ctx.sockPath);
  try {
    import_node_fs14.default.unlinkSync(pidFilePath(ctx.dataDir));
  } catch {
  }
  setTimeout(() => process.exit(exitCode), 10);
}

// src/daemon/handlers/daemon.ts
var daemonStatus = async (ctx) => {
  const uptimeMs = Date.now() - ctx.startedAt.getTime();
  const distFreshness = await getDistFreshness();
  const users = ctx.users.list();
  const sessionCount = users.reduce(
    (count, user) => count + ctx.sessions.listLive(user.token).length,
    0
  );
  return {
    pid: process.pid,
    version: getPkgVersion(),
    uptime_s: Math.floor(uptimeMs / 1e3),
    sock: ctx.sockPath,
    data_dir: ctx.dataDir,
    log_path: ctx.logPath,
    session_count: sessionCount,
    user_count: users.length,
    app_server_count: ctx.pool.processCount(),
    started_at: ctx.startedAt.toISOString(),
    ...distFreshness
  };
};
var daemonFleetStatus = async (ctx, req) => {
  const tokens = resolveFleetUsers(ctx, asString3(getFlag(req.params, "users")));
  const perUser = tokens.map((token) => {
    const sessions = ctx.sessions.listLive(token);
    const live = sessions.filter((session) => session.state === "live").length;
    const crashed = sessions.filter((session) => session.state === "crashed").length;
    const busy = sessions.filter((session) => {
      const sessionKey = `${token}::${session.name}`;
      const busyTurnId = session.current_turn_id ?? ctx.queues?.getCurrentTurn?.(sessionKey) ?? null;
      const client = ctx.pool?.clientForSession?.(sessionKey);
      const appServerAlive = typeof client?.isAlive === "function" ? client.isAlive() : Boolean(client);
      return session.state === "live" && appServerAlive && busyTurnId !== null;
    }).length;
    const pending = typeof ctx.pending?.listForUser === "function" ? ctx.pending.listForUser(token).length : 0;
    const user = ctx.users.get(token);
    const activitySource = user?.last_active_at ?? user?.created_at ?? null;
    return {
      token,
      live,
      busy,
      pending,
      crashed,
      last_event_id: ctx.events?.latestEvent?.(token)?.id ?? null,
      last_activity_age_s: activitySource ? Math.max(0, Math.floor((Date.now() - Date.parse(activitySource)) / 1e3)) : null
    };
  });
  return {
    total_users: perUser.length,
    total_live_sessions: perUser.reduce((sum, user) => sum + user.live, 0),
    total_pending: perUser.reduce((sum, user) => sum + user.pending, 0),
    total_app_servers: typeof ctx.pool?.processCount === "function" ? ctx.pool.processCount() : null,
    per_user: perUser
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
  (0, import_node_child_process5.spawn)(process.execPath, [entry, "--daemon-internal"], {
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
  const pending = typeof ctx.pending.listForUser === "function" ? ctx.pending.listForUser(token) : [];
  for (const p of pending) {
    await cancelPendingWithEvent(
      ctx,
      token,
      p.session_name ?? "*",
      p.thread_id ?? "",
      "user_destroyed",
      (entry) => entry.request_id === p.request_id
    );
  }
  await ctx.pool.closeUser(token);
  const sessions = await ctx.sessions.clearUser(token);
  for (const rec of sessions) {
    await ctx.events.append(token, {
      type: SESSION_CLOSED_EVENT_TYPE,
      session: rec.name,
      thread_id: rec.thread_id ?? null,
      payload: {
        session: rec.name,
        thread_id: rec.thread_id ?? null,
        reason: "user_destroyed",
        ts: (/* @__PURE__ */ new Date()).toISOString()
      }
    });
  }
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
  const level = asString3(getFlag(req.params, "level"));
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
      const stat = await import_node_fs15.default.promises.stat(logPath);
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
  const watcher = import_node_fs15.default.watch(import_node_path15.default.dirname(logPath), { persistent: true }, (_event, filename) => {
    if (!filename || filename.toString() === import_node_path15.default.basename(logPath)) scheduleSync();
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
function asString3(v) {
  return typeof v === "string" ? v : null;
}
function resolveFleetUsers(ctx, rawUsers) {
  if (!rawUsers || rawUsers === "all") {
    return ctx.users.list().map((user) => user.token);
  }
  const requested = Array.from(new Set(
    rawUsers.split(",").map((token) => token.trim()).filter(Boolean)
  ));
  if (requested.length === 0) {
    throw invalidParams("--users requires 'all' or a comma-separated token list");
  }
  const missing = requested.filter((token) => !ctx.users.has(token));
  if (missing.length > 0) {
    throw invalidParams(`unknown user token(s): ${missing.join(", ")}`);
  }
  return requested;
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
    return await import_node_fs15.default.promises.readFile(filePath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function readBytes(filePath, start, length) {
  if (length <= 0) return "";
  const handle = await import_node_fs15.default.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}
function getPkgVersion() {
  return VERSION;
}
async function getDistFreshness(packageRoot = PACKAGE_ROOT) {
  const distPath = import_node_path15.default.join(packageRoot, "dist", "main.js");
  const distStat = await statIfExists2(distPath);
  if (!distStat) {
    return {
      dist_built_at: null,
      dist_age_seconds: null,
      source_newer_than_dist: null
    };
  }
  const builtAt = new Date(distStat.mtimeMs).toISOString();
  const sourceNewestMtime = await getNewestMtime(import_node_path15.default.join(packageRoot, "src"));
  return {
    dist_built_at: builtAt,
    dist_age_seconds: Math.max(0, Math.floor((Date.now() - distStat.mtimeMs) / 1e3)),
    source_newer_than_dist: sourceNewestMtime === null ? null : sourceNewestMtime > distStat.mtimeMs
  };
}
async function statIfExists2(filePath) {
  try {
    return await import_node_fs15.default.promises.stat(filePath);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    return null;
  }
}
async function getNewestMtime(dirPath) {
  let entries;
  try {
    entries = await import_node_fs15.default.promises.readdir(dirPath, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return null;
    return null;
  }
  let newest = null;
  for (const entry of entries) {
    const entryPath = import_node_path15.default.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const childNewest = await getNewestMtime(entryPath);
      if (childNewest !== null && (newest === null || childNewest > newest)) newest = childNewest;
      continue;
    }
    const stat = await statIfExists2(entryPath);
    if (stat && (newest === null || stat.mtimeMs > newest)) newest = stat.mtimeMs;
  }
  return newest;
}

// src/daemon/handlers/session.ts
var import_node_fs16 = __toESM(require("fs"));
var import_node_path16 = __toESM(require("path"));

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
var INLINE_MAX_BYTES = 2048;
function renderTag(name, attrs, body) {
  const line = `<${name}> ${compactJson(attrs)}`;
  const normalizedBody = stripOuterNewlines(body);
  if (!normalizedBody) {
    return `${line}

<\\${name}>`;
  }
  return `${line}

${normalizedBody}

<\\${name}>`;
}
function renderInline(name, attrs) {
  return `<${name}>${compactJson(attrs)}<\\${name}>`;
}
function renderHistory(input, options = {}) {
  const ctx = createRenderContext(options);
  const attrs = {
    session: input.session,
    thread_id: input.thread_id,
    count: input.turns.length,
    generated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (input.nextCursor) attrs.next_cursor = input.nextCursor;
  const body = input.turns.map((turn) => renderTurn(turn, ctx)).join("\n\n");
  return renderTag("history", attrs, body);
}
function renderTail(input, options = {}) {
  const ctx = createRenderContext(options);
  const attrs = {
    session: input.session,
    thread_id: input.thread_id,
    count: input.turns.length,
    generated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (input.follow) attrs.follow = true;
  const body = input.turns.map((turn) => renderTurn(turn, ctx)).join("\n\n");
  return renderTag("tail", attrs, body);
}
function renderContext(input) {
  const ctx = createRenderContext();
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
  const turns = Array.isArray(t?.turns) ? t.turns.filter((turn) => !!turn && typeof turn === "object").map((turn) => renderTurn(turn, ctx)).filter(Boolean) : [];
  return renderTag(
    "context",
    attrs,
    turns.length > 0 ? turns.join("\n\n") : "<!-- thread/read only returns thread metadata; for turn-level content use 'message history' -->"
  );
}
function renderTurn(turn, ctx) {
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
  const body = items.filter((item) => !!item && typeof item === "object").map((item) => renderItemWithContext(item, ctx)).filter(Boolean).join("\n\n");
  return renderTag("turn", attrs, body);
}
function renderItemWithContext(item, ctx) {
  const type = normalizeItemType(item.type);
  switch (type) {
    case "userMessage":
      return renderUserMessage(item, ctx);
    case "agentMessage":
      return renderAgentMessage(item, ctx);
    case "commandExecution":
      return renderCommandExecution(item, ctx);
    case "fileChange":
    case "file-patch":
      return renderFileChange(item, ctx);
    case "mcpToolCall":
      return renderMcpToolCall(item, ctx);
    case "autoApprovalReview":
      return renderAutoApprovalReview(item, ctx);
    case "reasoning":
      return renderReasoning(item, ctx);
    default:
      if (type.startsWith("hook.")) return renderHook(item, type, ctx);
      return renderInline("item", sanitizeInlineAttrs(item, ctx));
  }
}
function createRenderContext(options = {}) {
  const normalized = normalizeTruncateOption(options.truncate);
  return {
    inlineMaxBytes: normalized === 0 ? INLINE_MAX_BYTES : Math.min(normalized ?? INLINE_MAX_BYTES, INLINE_MAX_BYTES),
    truncateBytes: normalized === 0 ? null : normalized ?? INLINE_MAX_BYTES
  };
}
function normalizeTruncateOption(value) {
  if (value === void 0 || value === null) return null;
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}
function compactJson(value) {
  return JSON.stringify(value ?? {});
}
function renderInlineValue(name, value) {
  return `<${name}>${compactJson(value)}<\\${name}>`;
}
function renderBodyTag(name, attrs, body, ctx) {
  return renderTag(name, attrs, applyBodyTruncation(body, ctx));
}
function renderJsonValueTag(name, value, ctx) {
  const compact = compactJson(value);
  if (byteLength(compact) <= ctx.inlineMaxBytes) {
    return renderInlineValue(name, value);
  }
  return renderBodyTag(name, {}, prettyJson(value), ctx);
}
function renderUserMessage(item, ctx) {
  const attrs = baseItemAttrs(item, { includeType: false });
  const text = extractMessageText(item);
  if (!text) return renderInline("user-input", attrs);
  if (byteLength(text) > ctx.inlineMaxBytes) {
    return renderBodyTag("user-input", attrs, text, ctx);
  }
  attrs.text = text;
  return renderInline("user-input", attrs);
}
function renderAgentMessage(item, ctx) {
  const attrs = baseItemAttrs(item, { includeType: false });
  const body = extractMessageText(item);
  if (!body) return renderInline("agent-message", attrs);
  return renderBodyTag("agent-message", attrs, body, ctx);
}
function renderCommandExecution(item, ctx) {
  const attrs = baseItemAttrs(item, { includeType: false });
  const cmd = extractCommand(item);
  if (cmd) attrs.cmd = fitInlineText(cmd, ctx);
  const cwd = asString4(item.cwd);
  if (cwd) attrs.cwd = cwd;
  const exit = item.exit ?? item.exitCode;
  if (exit !== void 0) attrs.exit = exit;
  const durationMs = item.duration_ms ?? item.durationMs;
  if (durationMs !== void 0) attrs.duration_ms = durationMs;
  const shellBody = extractCommandOutput(item) ?? "";
  return renderBodyTag("shell", attrs, shellBody, ctx);
}
function renderFileChange(item, ctx) {
  const attrs = baseItemAttrs(item, { includeType: false });
  const path19 = asString4(item.path);
  if (path19) attrs.path = path19;
  if (item.status !== void 0) attrs.status = item.status;
  const diffBody = extractDiff(item) ?? "";
  return renderBodyTag("file-patch", attrs, diffBody, ctx);
}
function renderMcpToolCall(item, ctx) {
  const attrs = baseItemAttrs(item, { includeType: false });
  const server = asString4(item.server) ?? asString4(item.serverName);
  if (server) attrs.server = server;
  const tool = extractToolName(item);
  attrs.tool = tool;
  const durationMs = item.duration_ms ?? item.durationMs;
  if (durationMs !== void 0) attrs.duration_ms = durationMs;
  const bodyParts = [];
  const args = extractMcpArgs(item);
  if (args !== void 0) bodyParts.push(renderJsonValueTag("mcp-args", args, ctx));
  const result = extractMcpResult(item);
  if (result) bodyParts.push(renderBodyTag("mcp-result", {}, result, ctx));
  return renderTag(`tool.${toTagSegment(tool)}`, attrs, bodyParts.join("\n\n"));
}
function renderHook(item, type, ctx) {
  const run = asObject5(item.run);
  const attrs = baseItemAttrs(item, { includeType: false });
  const hookId = asString4(item.hook_id) ?? asString4(item.hookId) ?? asString4(run.id);
  if (hookId) attrs.hook_id = hookId;
  const status2 = asString4(item.status) ?? asString4(run.status);
  if (status2) attrs.status = status2;
  const command = extractCommand(item) ?? extractCommand(run);
  if (command) attrs.command = fitInlineText(command, ctx);
  const cwd = asString4(item.cwd) ?? asString4(run.cwd);
  if (cwd) attrs.cwd = cwd;
  const exit = item.exit ?? item.exitCode ?? run.exit ?? run.exitCode;
  if (exit !== void 0) attrs.exit = exit;
  const durationMs = item.duration_ms ?? item.durationMs ?? run.duration_ms ?? run.durationMs;
  if (durationMs !== void 0) attrs.duration_ms = durationMs;
  const output = extractHookOutput(item, run);
  const tagName = typeToTagName(type);
  if (!output) return renderInline(tagName, attrs);
  return renderTag(tagName, attrs, renderBodyTag("hook-output", {}, output, ctx));
}
function renderAutoApprovalReview(item, ctx) {
  const review = asObject5(item.review);
  const attrs = baseItemAttrs(item, { includeType: false });
  const kind = asString4(item.kind) ?? asString4(review.kind) ?? asString4(review.request_kind) ?? asString4(review.requestKind) ?? asString4(review.approval_kind) ?? asString4(review.approvalKind);
  if (kind) attrs.kind = kind;
  const matchedPattern = asString4(item.matched_pattern) ?? asString4(item.matchedPattern) ?? asString4(review.matched_pattern) ?? asString4(review.matchedPattern) ?? asString4(review.pattern);
  if (matchedPattern) attrs.matched_pattern = fitInlineText(matchedPattern, ctx);
  const commandPreview = extractCommandPreview(item, review);
  if (commandPreview) attrs.command_preview = fitInlineText(commandPreview, ctx);
  const decision = asString4(item.decision) ?? asString4(item.action) ?? asString4(item.decision_source) ?? asString4(item.decisionSource) ?? asString4(review.decision) ?? asString4(review.action);
  if (decision) attrs.decision = fitInlineText(decision, ctx);
  return renderInline("auto-approval-review", attrs);
}
function renderReasoning(item, ctx) {
  const attrs = baseItemAttrs(item, { includeType: false });
  const text = extractReasoningText(item);
  if (!text) return renderInline("reasoning", attrs);
  if (byteLength(text) <= ctx.inlineMaxBytes) {
    attrs.text = text;
    return renderInline("reasoning", attrs);
  }
  return renderBodyTag("reasoning", attrs, text, ctx);
}
function baseItemAttrs(item, options = {}) {
  const attrs = {};
  if (typeof item.id === "string") attrs.id = item.id;
  if (options.includeType !== false) attrs.type = normalizeItemType(item.type);
  if (item.phase !== void 0) attrs.phase = item.phase;
  if (item.status !== void 0) attrs.status = item.status;
  if (item.kind !== void 0) attrs.kind = item.kind;
  if (item.role !== void 0) attrs.role = item.role;
  if (item.source !== void 0) attrs.source = item.source;
  return attrs;
}
function sanitizeInlineAttrs(item, ctx) {
  const attrs = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === void 0 || OMIT_INLINE_KEYS.has(key)) continue;
    attrs[key] = typeof value === "string" ? fitInlineText(value, ctx) : value;
  }
  if (!("id" in attrs) && typeof item.id === "string") attrs.id = item.id;
  if (!("type" in attrs)) attrs.type = normalizeItemType(item.type);
  return attrs;
}
function normalizeItemType(raw) {
  const type = typeof raw === "string" && raw ? raw : "unknown";
  return ITEM_TYPE_ALIASES[type] ?? type;
}
function typeToTagName(type) {
  return type.split(".").map(toTagSegment).join(".");
}
function toTagSegment(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").replace(/[^a-zA-Z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}
function extractMessageText(item) {
  return firstText(item.text, item.content);
}
function extractReasoningText(item) {
  return firstText(item.text, item.summaryText, item.summary, item.content);
}
function extractCommand(item) {
  const direct = asString4(item.command) ?? asString4(item.cmd);
  if (direct) return direct;
  const command = item.command;
  if (Array.isArray(command)) {
    const parts = command.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "number" || typeof part === "boolean") return String(part);
      return null;
    }).filter((part) => !!part);
    if (parts.length > 0) return parts.join(" ");
  }
  return null;
}
function extractCommandOutput(item) {
  const direct = asString4(item.output);
  if (direct) return direct;
  const output = item.output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const stdout = asString4(output.stdout);
    const stderr = asString4(output.stderr);
    const merged = joinText([stdout, stderr], "\n");
    if (merged) return merged;
  }
  return joinText([asString4(item.stdout), asString4(item.stderr)], "\n");
}
function extractDiff(item) {
  return asString4(item.diff) ?? asString4(item.patch) ?? asString4(item.changes);
}
function extractToolName(item) {
  return asString4(item.tool) ?? asString4(item.toolName) ?? asString4(item.name) ?? "unknown";
}
function extractMcpArgs(item) {
  const args = item.args ?? item.arguments ?? item.input ?? item.parameters;
  return args === void 0 ? void 0 : args;
}
function extractMcpResult(item) {
  return extractRichBody(item.result, item.output, item.content, item.text);
}
function extractHookOutput(item, run) {
  return extractCommandOutput(item) ?? extractCommandOutput(run) ?? extractRichBody(item.result, run.result);
}
function extractCommandPreview(...values) {
  for (const value of values) {
    const preview = asString4(value.command_preview) ?? asString4(value.commandPreview) ?? extractCommand(value);
    if (preview) return preview;
  }
  return null;
}
function extractRichBody(...values) {
  for (const value of values) {
    const text = extractText(value);
    if (text) return text;
    if (Array.isArray(value)) {
      const serialized = compactJson(value);
      if (serialized !== "[]") return serialized;
      continue;
    }
    if (value && typeof value === "object") {
      const serialized = JSON.stringify(value, null, 2);
      if (serialized && serialized !== "{}") return serialized;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return null;
}
function firstText(...values) {
  for (const value of values) {
    const text = extractText(value);
    if (text) return text;
  }
  return null;
}
function extractText(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (!Array.isArray(value)) return null;
  const parts = value.map((entry) => extractTextEntry(entry)).filter((entry) => !!entry);
  return parts.length > 0 ? parts.join("\n\n") : null;
}
function extractTextEntry(entry) {
  if (typeof entry === "string" && entry.length > 0) return entry;
  if (!entry || typeof entry !== "object") return null;
  const obj = entry;
  if (typeof obj.text === "string" && obj.text.length > 0) return obj.text;
  if (Array.isArray(obj.content)) return extractText(obj.content);
  return null;
}
function applyBodyTruncation(text, ctx) {
  if (ctx.truncateBytes === null) return text;
  const truncated = truncateText(text, ctx.truncateBytes);
  return truncated.truncatedBytes > 0 ? `${truncated.text}
${buildTruncationMarker(truncated.truncatedBytes)}` : text;
}
function fitInlineText(text, ctx) {
  if (ctx.truncateBytes === null) return text;
  const truncated = truncateText(text, ctx.truncateBytes);
  return truncated.truncatedBytes > 0 ? `${truncated.text}${buildTruncationMarker(truncated.truncatedBytes)}` : text;
}
function truncateText(text, maxBytes) {
  const totalBytes = byteLength(text);
  if (totalBytes <= maxBytes) {
    return { text, truncatedBytes: 0 };
  }
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = chars.slice(0, mid).join("");
    if (byteLength(candidate) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const truncatedText = chars.slice(0, low).join("");
  return {
    text: stripOuterNewlines(truncatedText),
    truncatedBytes: totalBytes - byteLength(truncatedText)
  };
}
function buildTruncationMarker(truncatedBytes) {
  return `\u2026[${truncatedBytes} bytes truncated; use --truncate 0 to disable]`;
}
function prettyJson(value) {
  if (value === void 0) return "{}";
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
function joinText(values, separator) {
  const present = values.filter((value) => !!value);
  return present.length > 0 ? present.join(separator) : null;
}
function stripOuterNewlines(value) {
  return value.replace(/^\n+/, "").replace(/\n+$/, "");
}
function asString4(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function asObject5(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}
var ITEM_TYPE_ALIASES = {
  agent_message: "agentMessage",
  auto_approval_review: "autoApprovalReview",
  command_execution: "commandExecution",
  file_change: "fileChange",
  mcp_tool_call: "mcpToolCall",
  user_message: "userMessage"
};
var OMIT_INLINE_KEYS = /* @__PURE__ */ new Set([
  "content",
  "stdout",
  "stderr",
  "output",
  "diff",
  "patch",
  "changes",
  "result",
  "review",
  "run"
]);

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

// src/util/glob.ts
function escapeRegex(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function globToRegExp(pattern) {
  const source = Array.from(pattern, (char) => {
    if (char === "*") return ".*";
    if (char === "?") return ".";
    return escapeRegex(char);
  }).join("");
  return new RegExp(`^${source}$`);
}
function matchesGlob(pattern, value) {
  return globToRegExp(pattern).test(value);
}

// src/daemon/handlers/session.ts
var attachLocks = /* @__PURE__ */ new Map();
var DEFAULT_SESSION_LIST_LIMIT = 50;
var LOCAL_SESSION_LIST_CURSOR_PREFIX = "local:";
var DEFAULT_SESSION_LOG_LINE_LIMIT = 100;
var DEFAULT_SESSION_LOG_TRUNCATE_BYTES = 2048;
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
  const autoApprovePatterns = resolveAutoApprovePatternsForCreate(ctx, flags);
  const cwd = resolveAndValidateRequestedCwd(asString5(flags["cwd"]));
  const startParams = await buildThreadStartParams(ctx, flags, experimentalTools, cwd);
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
    model: asString5(flags["model"]) ?? resolveDefault(ctx, "codex.default_model") ?? void 0,
    cwd,
    sandbox: asString5(flags["sandbox"]) ?? resolveDefault(ctx, "codex.default_sandbox") ?? void 0,
    approval: asString5(flags["approval"]) ?? resolveDefault(ctx, "codex.default_approval") ?? void 0,
    effort: asString5(flags["effort"]) ?? resolveDefault(ctx, "codex.default_effort") ?? void 0,
    profile: asString5(flags["profile"]) ?? void 0,
    base_instructions: asString5(flags["base-instructions"]) ?? void 0,
    developer_instructions: asString5(flags["developer-instructions"]) ?? void 0,
    experimental_tools: experimentalTools.length > 0 ? experimentalTools : void 0,
    autoApprovePatterns,
    created_at: now,
    last_active_at: now,
    turn_count: 0,
    ...sessionRuntimeDefaults()
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
      validateSessionAutoApprovePatterns(existing.autoApprovePatterns ?? []);
      ctx.sessions.touch(user, existing.name);
      return { session: existing, noop: true };
    }
    const anywhere = looksLikeThreadId(identifier) ? ctx.sessions.findLiveAnywhere(identifier) : ctx.sessions.findUniqueLiveByNameAnywhere(identifier);
    if (anywhere === "ambiguous") {
      throw invalidParams(`session name '${identifier}' is ambiguous across users; use a thread_id or attach within the owning user`);
    }
    const autoApprovePatterns = validateSessionAutoApprovePatterns(anywhere?.record.autoApprovePatterns ?? []);
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
        autoApprovePatterns,
        created_at: now,
        last_active_at: now,
        turn_count: 0,
        ...sessionRuntimeDefaults(),
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
  const flags = asFlags(req);
  const detachAll = isTrue2(flags["all"]);
  const match = asString5(flags["match"]);
  const graceful = isTrue2(flags["graceful"]);
  if (!detachAll && match !== null) {
    throw invalidParams("--match requires --all");
  }
  if (detachAll) {
    if (asPositionals(req).length > 0) {
      throw invalidParams("session detach --all does not accept positional targets");
    }
    const live = ctx.sessions.listLive(user).filter((rec2) => match === null || matchesGlob(match, rec2.name));
    const results = await Promise.all(live.map(async (rec2) => {
      try {
        const detached2 = await detachSessionRecord(ctx, user, rec2, graceful);
        return {
          session: detached2.name,
          detached: true,
          graceful
        };
      } catch (error) {
        return {
          session: rec2.name,
          ok: false,
          error: normalizeDetachError(error)
        };
      }
    }));
    return { results };
  }
  const identifier = asPositional(req, 0, "session");
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) {
    return { session: null, noop: true };
  }
  const detached = await detachSessionRecord(ctx, user, rec, graceful);
  return { session: detached, noop: false, graceful };
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
  if (typeof ctx.queues.rekey === "function") {
    ctx.queues.rekey(keyFor(user, oldName), keyFor(user, newName));
  }
  ctx.pool.rekeySession(keyFor(user, oldName), keyFor(user, newName));
  if (typeof ctx.pending.renameSession === "function") {
    ctx.pending.renameSession(user, oldName, newName);
  }
  return { session: updated };
};
var sessionFork = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const newNameRaw = asPositionalOptional(req, 1);
  const flags = asFlags(req);
  const atTurn = asString5(flags["at-turn"]);
  const source = ctx.sessions.get(user, identifier);
  if (!source) throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);
  let newName = newNameRaw ?? generateSessionName();
  if (newNameRaw) validateSessionName(newNameRaw);
  while (ctx.sessions.get(user, newName)) newName = generateSessionName();
  const autoApprovePatterns = validateSessionAutoApprovePatterns(source.autoApprovePatterns ?? []);
  const sourceCwd = source.cwd ? resolveAndValidatePersistedCwd(source.cwd, {
    label: "source session's cwd",
    missing: (cwd) => `source session's cwd '${cwd}' does not exist`,
    notDirectory: (cwd) => `source session's cwd '${cwd}' is no longer a directory`,
    inaccessible: (cwd) => `source session's cwd '${cwd}' is not accessible (permission denied or similar)`
  }) : void 0;
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
    cwd: sourceCwd,
    sandbox: source.sandbox,
    approval: source.approval,
    effort: source.effort,
    profile: source.profile,
    experimental_tools: source.experimental_tools,
    autoApprovePatterns,
    created_at: now,
    last_active_at: now,
    turn_count: 0,
    ...sessionRuntimeDefaults()
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
  const format = asString5(flags["format"]) ?? "json";
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
  const loadedOnly = isTrue2(flags["loaded-only"]);
  const sortField = asString5(flags["sort"]) ?? "last_active";
  const format = asString5(flags["format"]) ?? "json";
  const cursor = parseSessionListCursor(flags);
  const limit = parseSessionListLimit(flags);
  const archivedMode = parseArchivedMode(flags);
  const stateFilter = parseSessionStateFilter(flags);
  const ownerFilter = parseOwnerFilter(flags);
  if (format !== "json" && format !== "table") {
    throw invalidParams(`--format must be 'json' or 'table'`);
  }
  const response = { all, sort: sortField, format };
  if (loadedOnly) response.loaded_only = true;
  if (!all && !loadedOnly) {
    const live = listRegistrySessions(ctx, user, ownerFilter).filter((session) => matchesArchivedMode(session, archivedMode)).filter((session) => matchesStateFilter(session, stateFilter));
    const sorted2 = sortSessionRows(live, sortField);
    const page = paginateLocalSessionRows(sorted2, limit, cursor);
    response.sessions = page.sessions;
    response.next_cursor = page.nextCursor;
    if (format === "table") {
      response.table = renderTable2(page.sessions, [
        "name",
        "thread_id",
        "state",
        "model",
        "busy",
        "turn_count",
        "last_active_at"
      ]);
    }
    return response;
  }
  const client = await ctx.pool.acquireForAdhoc(user);
  if (loadedOnly) {
    const result2 = await threadLoadedList(client, ctx.retryOptions());
    const decorated = result2.threads.map((thread) => decorateThreadSession(ctx, user, thread)).filter((session) => matchesOwnerFilter(session, ownerFilter, user)).filter((session) => matchesArchivedMode(session, archivedMode)).filter((session) => matchesStateFilter(session, stateFilter));
    const page = paginateLocalSessionRows(sortSessionRows(decorated, sortField), limit, cursor);
    const sessions2 = page.sessions.map(stripInternalSessionMetadata);
    response.sessions = page.sessions;
    response.next_cursor = page.nextCursor;
    response.sessions = sessions2;
    if (format === "table") {
      response.table = renderTable2(page.sessions, [
        "name",
        "thread_id",
        "state",
        "model",
        "busy",
        "updated_at"
      ]);
    }
    return response;
  }
  const result = await threadList(client, {
    cursor: cursor ?? void 0,
    pageSize: limit,
    includeArchived: archivedMode !== "exclude"
  }, ctx.retryOptions());
  const sessions = result.data.map((thread) => decorateThreadSession(ctx, user, thread)).filter((session) => matchesOwnerFilter(session, ownerFilter, user)).filter((session) => matchesArchivedMode(session, archivedMode)).filter((session) => matchesStateFilter(session, stateFilter)).map(stripInternalSessionMetadata);
  Object.assign(response, {
    sessions,
    next_cursor: result.nextCursor
  });
  if (format === "table") {
    response.table = renderTable2(
      sessions,
      ["name", "thread_id", "state", "model", "busy", "updated_at"]
    );
  }
  return response;
};
var sessionHealth = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);
  const sessionKey = keyFor(user, rec.name);
  const busyTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
  const client = ctx.pool.clientForSession(sessionKey);
  const appServerAlive = isClientAlive(client);
  const currentTurnStartedAt = rec.current_turn_started_at ?? null;
  const pending = typeof ctx.pending.listForUser === "function" ? ctx.pending.listForUser(user).filter((entry) => entry.thread_id === rec.thread_id || entry.session_name === rec.name) : null;
  const pendingApprovals = pending ? pending.filter((entry) => entry.kind.startsWith("approval.")).length : rec.pending_approvals ?? 0;
  const pendingUserInputs = pending ? pending.filter((entry) => entry.kind === "user_input.request").length : rec.pending_user_inputs ?? 0;
  return {
    session: rec.name,
    thread_id: rec.thread_id,
    state: rec.state,
    busy: rec.state === "live" && appServerAlive && busyTurnId !== null,
    current_turn_id: busyTurnId,
    current_turn_started_at: currentTurnStartedAt,
    current_turn_elapsed_ms: currentTurnStartedAt ? Math.max(0, Date.now() - Date.parse(currentTurnStartedAt)) : null,
    current_item_type: rec.current_item_type ?? null,
    items_done_in_turn: rec.items_in_turn ?? 0,
    pending_approval_requests: pendingApprovals,
    pending_user_input_requests: pendingUserInputs,
    token_usage_last_turn: rec.token_usage_last_turn ?? null,
    app_server_alive: appServerAlive,
    last_event_id: ctx.events.latestEvent(user, { session: rec.name, thread_id: rec.thread_id })?.id ?? null
  };
};
var sessionHeal = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const force = isTrue2(flags["force"]);
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);
  if (rec.state !== "live" && rec.state !== "crashed") {
    throw invalidParams(`session '${rec.name}' is in unexpected state '${String(rec.state)}'`);
  }
  const sessionKey = keyFor(user, rec.name);
  const existingClient = ctx.pool.clientForSession(sessionKey);
  const appServerAlive = isClientAlive(existingClient);
  if (rec.state === "live" && appServerAlive) {
    return { ok: true, note: "already healthy", session: rec };
  }
  const sessionCwd = rec.cwd ? resolveAndValidatePersistedCwd(rec.cwd, {
    label: "session's cwd",
    missing: (cwd) => `session's cwd '${cwd}' does not exist`,
    notDirectory: (cwd, kind) => `session's cwd '${cwd}' is not a directory (it is a ${kind})`,
    inaccessible: (cwd) => `session's cwd '${cwd}' is not accessible (permission denied or similar)`
  }) : void 0;
  if (sessionCwd && sessionCwd !== rec.cwd) {
    ctx.sessions.update(user, rec.name, { cwd: sessionCwd });
  }
  if (!appServerAlive || force) {
    ctx.pool.release(sessionKey);
  }
  if (force) {
    ctx.queues.dispose(sessionKey);
    await cancelPendingWithEvent(ctx, user, rec.name, rec.thread_id, "session_heal_force_reset");
    ctx.sessions.update(user, rec.name, {
      pending_approvals: 0,
      pending_user_inputs: 0
    });
  }
  const client = await ctx.pool.acquire(
    user,
    sessionKey,
    buildExperimentalToolAppServerOptions(rec.experimental_tools ?? [])
  );
  await threadResume(client, rec.thread_id, ctx.retryOptions());
  const updated = ctx.sessions.update(user, rec.name, {
    state: "live",
    recovery_state: null,
    ...sessionRuntimeDefaults()
  });
  ctx.users.touch(user);
  return { ok: true, healed: true, forced: force, session: updated };
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
function asString5(v) {
  if (Array.isArray(v)) return v[v.length - 1] ?? null;
  return typeof v === "string" ? v : null;
}
function parseSessionListLimit(flags) {
  if (!hasFlag(flags, "limit")) return DEFAULT_SESSION_LIST_LIMIT;
  const raw = asString5(flags["limit"]);
  if (!raw) throw invalidParams("--limit requires a positive integer");
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw invalidParams("--limit must be a positive integer");
  }
  return value;
}
function parseSessionListCursor(flags) {
  if (!hasFlag(flags, "cursor")) return null;
  const cursor = asString5(flags["cursor"]);
  if (!cursor) throw invalidParams("--cursor requires a value");
  return cursor;
}
function parseArchivedMode(flags) {
  if (!hasFlag(flags, "archived")) return "exclude";
  const mode = asString5(flags["archived"]);
  if (mode === "only" || mode === "exclude" || mode === "include") return mode;
  throw invalidParams(`--archived must be one of: only / exclude / include`);
}
function parseSessionStateFilter(flags) {
  if (!hasFlag(flags, "state")) return null;
  const raw = asString5(flags["state"]);
  if (!raw) throw invalidParams("--state requires a comma-separated value");
  const entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) throw invalidParams("--state requires at least one value");
  const out = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (entry === "live" || entry === "crashed" || entry === "closed" || entry === "archived") {
      out.add(entry);
      continue;
    }
    throw invalidParams(`--state values must be drawn from: live, crashed, closed, archived`);
  }
  return out;
}
function parseOwnerFilter(flags) {
  if (!hasFlag(flags, "owner")) return { kind: "self" };
  const raw = asString5(flags["owner"]);
  if (!raw) throw invalidParams("--owner requires a value");
  if (raw === "self") return { kind: "self" };
  if (raw === "any") return { kind: "any" };
  return { kind: "token", token: raw };
}
function isTrue2(v) {
  return v === true || v === "true" || v === "1";
}
function resolveAndValidateRequestedCwd(rawCwd) {
  const daemonCwd = resolveDaemonProcessCwd();
  const resolved = rawCwd === null ? import_node_path16.default.normalize(daemonCwd) : resolveAbsoluteCwd(rawCwd, daemonCwd, "cwd");
  return validateResolvedCwd(resolved, {
    missing: (cwd) => `cwd '${cwd}' does not exist`,
    notDirectory: (cwd, kind) => `cwd '${cwd}' is not a directory (it is a ${kind})`,
    inaccessible: (cwd) => `cwd '${cwd}' is not accessible (permission denied or similar)`
  });
}
function resolveAndValidatePersistedCwd(rawCwd, messages) {
  const daemonCwd = resolveDaemonProcessCwd();
  const resolved = import_node_path16.default.isAbsolute(rawCwd) ? import_node_path16.default.normalize(rawCwd) : resolveAbsoluteCwd(rawCwd, daemonCwd, messages.label);
  return validateResolvedCwd(resolved, messages);
}
function resolveDaemonProcessCwd() {
  try {
    return process.cwd();
  } catch (error) {
    throw invalidParams(`cwd could not be resolved: ${error.message}`);
  }
}
function resolveAbsoluteCwd(rawCwd, daemonCwd, label) {
  try {
    return import_node_path16.default.normalize(import_node_path16.default.resolve(daemonCwd, rawCwd));
  } catch (error) {
    throw invalidParams(`${label} '${rawCwd}' could not be resolved: ${error.message}`);
  }
}
function validateResolvedCwd(cwd, messages) {
  if (!import_node_fs16.default.existsSync(cwd)) {
    throw invalidParams(messages.missing(cwd));
  }
  const stat = import_node_fs16.default.statSync(cwd);
  if (!stat.isDirectory()) {
    throw invalidParams(messages.notDirectory(cwd, describeFilesystemEntry(cwd, stat)));
  }
  try {
    import_node_fs16.default.accessSync(cwd, import_node_fs16.default.constants.R_OK | import_node_fs16.default.constants.X_OK);
  } catch {
    throw invalidParams(messages.inaccessible(cwd));
  }
  return cwd;
}
function describeFilesystemEntry(cwd, stat) {
  try {
    const entry = import_node_fs16.default.lstatSync(cwd);
    if (entry.isSymbolicLink()) return "symlink";
  } catch {
  }
  if (stat.isFile()) return "file";
  if (stat.isBlockDevice()) return "block device";
  if (stat.isCharacterDevice()) return "character device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "other";
}
async function buildThreadStartParams(ctx, flags, experimentalTools, cwd) {
  const p = {};
  const config = {};
  const model = asString5(flags["model"]) ?? resolveDefault(ctx, "codex.default_model");
  if (model) p.model = model;
  if (cwd) p.cwd = cwd;
  const sandbox = asString5(flags["sandbox"]) ?? resolveDefault(ctx, "codex.default_sandbox");
  if (sandbox) p.sandbox = sandbox;
  const approval = asString5(flags["approval"]) ?? resolveDefault(ctx, "codex.default_approval");
  if (approval) p.approvalPolicy = approval;
  const effort = asString5(flags["effort"]) ?? resolveDefault(ctx, "codex.default_effort");
  if (effort) config.model_reasoning_effort = effort;
  const profile = asString5(flags["profile"]);
  if (profile) config.profile = profile;
  const baseInstr = await readInstructionFile(flags["base-instructions"], "--base-instructions");
  if (baseInstr) p.baseInstructions = baseInstr;
  const devInstr = await readInstructionFile(flags["developer-instructions"], "--developer-instructions");
  if (devInstr) p.developerInstructions = devInstr;
  const personality = asString5(flags["personality"]);
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
function resolveAutoApprovePatternsForCreate(ctx, flags) {
  if (!hasFlag(flags, "auto-approve")) {
    return parseConfiguredAutoApprovePatterns(ctx.config.getEffective("session.auto_approve_command_patterns"));
  }
  const raw = asString5(flags["auto-approve"]);
  if (raw === null) throw invalidParams("--auto-approve requires a comma-separated value");
  const validationError = validateAutoApprovePatterns(raw);
  if (validationError) throw invalidParams(validationError);
  return parseAutoApprovePatterns(raw);
}
function resolveExperimentalToolsForAttach(ctx, flags, inherited) {
  if (hasFlag(flags, "experimental-tools")) return parseExperimentalTools(flags["experimental-tools"]);
  if (inherited && inherited.length > 0) return [...inherited];
  return parseExperimentalTools(resolveDefault(ctx, "experimental.default_tools"));
}
function keyFor(user, name) {
  return `${user}::${name}`;
}
function isClientAlive(client) {
  if (!client) return false;
  const maybe = client;
  if (typeof maybe.isAlive === "function") return maybe.isAlive();
  return true;
}
function hasFlag(flags, key) {
  return Object.prototype.hasOwnProperty.call(flags, key);
}
function validateSessionAutoApprovePatterns(patterns) {
  const validationError = validateParsedAutoApprovePatterns(patterns);
  if (validationError) throw invalidParams(validationError);
  return [...patterns];
}
async function detachSessionRecord(ctx, user, rec, graceful) {
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
  await cancelPendingWithEvent(ctx, user, rec.name, rec.thread_id, "user_detach");
  ctx.sessions.remove(user, rec.name);
  ctx.queues.finalDispose(sessionKey);
  await appendSessionClosed(ctx, user, rec, "user_detach");
  return rec;
}
function normalizeDetachError(error) {
  if (error instanceof CodexTeamError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : String(error)
  };
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
  const filePath = asString5(value);
  if (!filePath) return null;
  try {
    return await import_node_fs16.default.promises.readFile(filePath, "utf8");
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
  await cancelPendingWithEvent(ctx, fromUser, rec.name, rec.thread_id, "session_seized");
  ctx.sessions.remove(fromUser, rec.name);
  ctx.queues.finalDispose(sessionKey);
  await ctx.events.append(fromUser, {
    type: "session.seized",
    session: rec.name,
    thread_id: rec.thread_id,
    payload: { seized_by: toUser }
  });
}
async function appendSessionClosed(ctx, user, rec, reason) {
  await ctx.events.append(user, {
    type: SESSION_CLOSED_EVENT_TYPE,
    session: rec.name,
    thread_id: rec.thread_id,
    payload: {
      session: rec.name,
      thread_id: rec.thread_id,
      reason,
      ts: (/* @__PURE__ */ new Date()).toISOString()
    }
  });
}
function sortSessionRows(rows, field) {
  const canonical = (/* @__PURE__ */ new Set(["name", "last_active", "turn_count", "created_at"])).has(field) ? field : "last_active";
  const key = canonical === "last_active" ? "last_active_at" : canonical === "created_at" ? "created_at" : canonical;
  const copy = [...rows];
  copy.sort((a, b) => compareSessionListValues(b[key], a[key]));
  return copy;
}
function compareSessionListValues(left, right) {
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right);
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (left === void 0 && right !== void 0) return -1;
  if (left !== void 0 && right === void 0) return 1;
  return 0;
}
function listRegistrySessions(ctx, currentUser, ownerFilter) {
  const users = resolveRegistryUsers(ctx, currentUser, ownerFilter);
  const rows = [];
  for (const user of users) {
    for (const rec of ctx.sessions.listLive(user)) {
      rows.push(decorateLiveSession(ctx, user, rec));
    }
  }
  return rows;
}
function resolveRegistryUsers(ctx, currentUser, ownerFilter) {
  if (ownerFilter.kind === "self") return [currentUser];
  if (ownerFilter.kind === "token") return [ownerFilter.token];
  if (typeof ctx.users.list === "function") {
    return ctx.users.list().map((entry) => entry.token);
  }
  return [currentUser];
}
function decorateLiveSession(ctx, owner, rec) {
  const busyInfo = deriveBusyInfo(ctx, owner, rec);
  return {
    ...rec,
    busy: busyInfo.busy,
    current_turn_id: busyInfo.currentTurnId,
    model: rec.model ?? null
  };
}
function decorateThreadSession(ctx, currentUser, thread) {
  const threadId = typeof thread.id === "string" ? thread.id : null;
  const live = threadId ? ctx.sessions.findLiveAnywhere(threadId) : null;
  const rec = live?.record ?? null;
  const owner = live?.user ?? null;
  const busyInfo = rec && owner ? deriveBusyInfo(ctx, owner, rec) : { busy: false, currentTurnId: null };
  const state = deriveThreadState(rec, thread);
  const name = rec?.name ?? (typeof thread.name === "string" && thread.name.length > 0 ? thread.name : threadId ?? "unknown");
  const model = rec?.model ?? (typeof thread.model === "string" ? thread.model : null) ?? (typeof thread.model_provider === "string" ? thread.model_provider : null);
  const out = {
    ...thread,
    name,
    thread_id: threadId,
    state,
    model,
    busy: busyInfo.busy
  };
  if (rec) {
    out.turn_count = rec.turn_count;
    out.current_turn_id = busyInfo.currentTurnId;
    out.last_active_at = rec.last_active_at;
    out.created_at = out.created_at ?? rec.created_at;
    out.sandbox = out.sandbox ?? rec.sandbox;
    out.approval = out.approval ?? rec.approval;
    out.effort = out.effort ?? rec.effort;
    out.profile = out.profile ?? rec.profile;
    out.crash_reason = out.crash_reason ?? rec.crash_reason;
  } else {
    out.current_turn_id = null;
  }
  if (owner) out.owner = owner;
  return out;
}
function deriveBusyInfo(ctx, owner, rec) {
  const sessionKey = keyFor(owner, rec.name);
  const currentTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
  const busy = rec.state === "live" && isClientAlive(ctx.pool.clientForSession(sessionKey)) && currentTurnId !== null;
  return { busy, currentTurnId };
}
function deriveThreadState(rec, thread) {
  if (isArchivedThread(thread)) return "archived";
  if (rec?.state === "crashed") return "crashed";
  if (rec?.state === "live") return "live";
  return "closed";
}
function isArchivedThread(thread) {
  const record = thread;
  if (record.archived === true || record.isArchived === true) return true;
  const status2 = record.status;
  if (typeof status2 === "string") return status2 === "archived";
  if (status2 && typeof status2 === "object" && !Array.isArray(status2)) {
    const type = status2.type;
    return typeof type === "string" && type === "archived";
  }
  return false;
}
function matchesStateFilter(session, filter) {
  if (!filter) return true;
  const state = session.state;
  return typeof state === "string" && filter.has(state);
}
function matchesArchivedMode(session, archivedMode) {
  const archived = session.state === "archived";
  if (archivedMode === "include") return true;
  if (archivedMode === "only") return archived;
  return !archived;
}
function matchesOwnerFilter(session, ownerFilter, currentUser) {
  const owner = typeof session.owner === "string" ? session.owner : null;
  if (ownerFilter.kind === "any") return true;
  if (ownerFilter.kind === "self") {
    return owner === null || owner === currentUser;
  }
  return ownerFilter.token === currentUser ? owner === null || owner === currentUser : owner === ownerFilter.token;
}
function paginateLocalSessionRows(rows, limit, cursor) {
  const start = decodeLocalSessionListCursor(cursor);
  const sessions = rows.slice(start, start + limit);
  const nextOffset = start + sessions.length;
  return {
    sessions,
    nextCursor: nextOffset < rows.length ? encodeLocalSessionListCursor(nextOffset) : null
  };
}
function decodeLocalSessionListCursor(cursor) {
  if (!cursor) return 0;
  if (!cursor.startsWith(LOCAL_SESSION_LIST_CURSOR_PREFIX)) {
    throw invalidParams("invalid --cursor for local session list");
  }
  const raw = cursor.slice(LOCAL_SESSION_LIST_CURSOR_PREFIX.length);
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw invalidParams("invalid --cursor for local session list");
  }
  return value;
}
function encodeLocalSessionListCursor(offset) {
  return `${LOCAL_SESSION_LIST_CURSOR_PREFIX}${offset}`;
}
function stripInternalSessionMetadata(session) {
  const { owner: _owner, ...rest } = session;
  return rest;
}
var sessionArchive = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const andDetach = isTrue2(flags["and-detach"]);
  const live = ctx.sessions.get(user, identifier);
  if (live) {
    if (!andDetach) {
      throw invalidParams("session is live; pass --and-detach or run `session detach` first");
    }
    await detachLiveSessionHard(ctx, req, live);
    const archivedAt2 = (/* @__PURE__ */ new Date()).toISOString();
    const client2 = await ctx.pool.acquireForAdhoc(user);
    await threadArchive(client2, live.thread_id, ctx.retryOptions());
    return {
      thread_id: live.thread_id,
      archived: true,
      detached: true,
      archived_at: archivedAt2
    };
  }
  const target = await resolveSessionTarget(ctx, user, identifier);
  if (target.kind === "live") {
    if (target.session.name !== identifier && target.threadId !== identifier) {
      throw new CodexTeamError("session_busy", `session '${identifier}' is live under user '${user}'`);
    }
    if (!andDetach) {
      throw invalidParams("session is live; pass --and-detach or run `session detach` first");
    }
    await detachLiveSessionHard(ctx, req, target.session);
    const archivedAt2 = (/* @__PURE__ */ new Date()).toISOString();
    const client2 = await ctx.pool.acquireForAdhoc(user);
    await threadArchive(client2, target.threadId, ctx.retryOptions());
    return {
      thread_id: target.threadId,
      archived: true,
      detached: true,
      archived_at: archivedAt2
    };
  }
  const archivedAt = (/* @__PURE__ */ new Date()).toISOString();
  const client = await ctx.pool.acquireForAdhoc(user);
  await threadArchive(client, target.threadId, ctx.retryOptions());
  return {
    thread_id: target.threadId,
    archived: true,
    archived_at: archivedAt
  };
};
var sessionUnarchive = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const threadId = asPositional(req, 0, "thread_id");
  const live = ctx.sessions.findLiveAnywhere(threadId);
  if (live) {
    throw invalidParams("thread is live; unarchive applies only to detached archived threads");
  }
  await readDetachedThreadById(ctx, user, threadId);
  const unarchivedAt = (/* @__PURE__ */ new Date()).toISOString();
  const client = await ctx.pool.acquireForAdhoc(user);
  await threadUnarchive(client, threadId, ctx.retryOptions());
  return {
    thread_id: threadId,
    unarchived: true,
    unarchived_at: unarchivedAt
  };
};
var sessionRenameExtended = async (ctx, req) => {
  requireUser(ctx, req);
  const flags = asFlags(req);
  if (!isTrue2(flags["detached-ok"])) {
    return await sessionRename(ctx, req);
  }
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const newName = asPositional(req, 1, "new_name");
  validateSessionName(newName);
  const live = ctx.sessions.get(user, identifier);
  if (live) {
    return await sessionRename(ctx, req);
  }
  const target = await resolveSessionTarget(ctx, user, identifier);
  if (target.kind === "live") {
    return await sessionRename(ctx, req);
  }
  const renamedAt = (/* @__PURE__ */ new Date()).toISOString();
  const client = await ctx.pool.acquireForAdhoc(user);
  await threadRename(client, target.threadId, newName, ctx.retryOptions());
  return {
    session: { name: newName },
    thread_id: target.threadId,
    detached: true,
    renamed_at: renamedAt
  };
};
var sessionRollback = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "session");
  const flags = asFlags(req);
  const toTurnId = asString5(flags["to-turn"]);
  const detachAfter = isTrue2(flags["detach-after"]);
  if (!toTurnId) {
    throw invalidParams("--to-turn requires a value");
  }
  const source = await resolveSessionTarget(ctx, user, identifier);
  const sourceName = resolveRollbackSessionName(source, ctx, user);
  const sourceRecord = source.kind === "live" ? source.session : null;
  const sourceThread = source.kind === "live" ? { id: source.threadId, name: source.name, cwd: source.session.cwd } : source.thread;
  const sourceDefaults = resolveRollbackDefaults(ctx, sourceRecord, sourceThread);
  if (!detachAfter) {
    validateSessionName(sourceName);
    const existing = ctx.sessions.get(user, sourceName);
    if (existing && (source.kind !== "live" || existing.thread_id !== source.threadId)) {
      throw invalidParams(`session '${sourceName}' already exists`);
    }
  }
  const sourceClient = await clientForThreadTarget(ctx, user, source);
  await ensureRollbackTurnExists(ctx, sourceClient, source.threadId, toTurnId);
  const forkResult = await threadFork(sourceClient, source.threadId, toTurnId, ctx.retryOptions());
  const newThreadId = threadIdOf(forkResult);
  if (source.kind === "live") {
    await detachLiveSessionHard(ctx, req, source.session);
  }
  const archivedSourceName = `${sourceName}-pre-rollback-${(/* @__PURE__ */ new Date()).toISOString()}`;
  const lifecycleClient = await ctx.pool.acquireForAdhoc(user);
  await threadRename(lifecycleClient, source.threadId, archivedSourceName, ctx.retryOptions());
  await threadArchive(lifecycleClient, source.threadId, ctx.retryOptions());
  await threadRename(lifecycleClient, newThreadId, sourceName, ctx.retryOptions());
  if (!detachAfter) {
    await attachRollbackThread(ctx, user, sourceName, newThreadId, sourceDefaults);
  }
  return {
    name: sourceName,
    old_thread_id: source.threadId,
    new_thread_id: newThreadId,
    forked_at_turn: toTurnId,
    archived_source_name: archivedSourceName,
    detach_after: detachAfter
  };
};
function resolveRollbackSessionName(source, ctx, user) {
  if (source.kind === "live") return source.session.name;
  return source.name ?? deriveNameFromThreadId(source.threadId, ctx, user);
}
function resolveRollbackDefaults(ctx, sourceRecord, sourceThread) {
  const experimentalTools = sourceRecord?.experimental_tools ? [...sourceRecord.experimental_tools] : parseExperimentalTools(resolveDefault(ctx, "experimental.default_tools"));
  const autoApprovePatterns = sourceRecord ? validateSessionAutoApprovePatterns(sourceRecord.autoApprovePatterns ?? []) : validateSessionAutoApprovePatterns(
    parseConfiguredAutoApprovePatterns(ctx.config.getEffective("session.auto_approve_command_patterns"))
  );
  return {
    model: sourceRecord?.model ?? void 0,
    cwd: sourceRecord?.cwd ?? asString5(sourceThread.cwd) ?? process.cwd(),
    sandbox: sourceRecord?.sandbox ?? resolveDefault(ctx, "codex.default_sandbox") ?? void 0,
    approval: sourceRecord?.approval ?? resolveDefault(ctx, "codex.default_approval") ?? void 0,
    effort: sourceRecord?.effort ?? resolveDefault(ctx, "codex.default_effort") ?? void 0,
    profile: sourceRecord?.profile ?? void 0,
    baseInstructions: sourceRecord?.base_instructions ?? void 0,
    developerInstructions: sourceRecord?.developer_instructions ?? void 0,
    experimentalTools,
    autoApprovePatterns
  };
}
async function attachRollbackThread(ctx, user, name, threadId, defaults) {
  const sessionKey = keyFor(user, name);
  const client = await ctx.pool.acquire(
    user,
    sessionKey,
    buildExperimentalToolAppServerOptions(defaults.experimentalTools)
  );
  let result;
  try {
    result = await threadResume(client, threadId, ctx.retryOptions());
  } catch (e) {
    ctx.pool.release(sessionKey);
    throw e;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const record = {
    name,
    thread_id: threadId,
    state: "live",
    model: defaults.model ?? asString5(result.model) ?? void 0,
    cwd: defaults.cwd ?? asString5(result.cwd) ?? asString5(result.thread.cwd) ?? process.cwd(),
    sandbox: defaults.sandbox,
    approval: defaults.approval ?? asString5(result.approvalPolicy) ?? void 0,
    effort: defaults.effort,
    profile: defaults.profile,
    base_instructions: defaults.baseInstructions,
    developer_instructions: defaults.developerInstructions,
    experimental_tools: defaults.experimentalTools.length > 0 ? defaults.experimentalTools : void 0,
    autoApprovePatterns: defaults.autoApprovePatterns,
    created_at: now,
    last_active_at: now,
    turn_count: 0,
    ...sessionRuntimeDefaults()
  };
  ctx.sessions.add(user, record);
  ctx.users.touch(user);
  return record;
}
async function ensureRollbackTurnExists(ctx, client, threadId, turnId) {
  let cursor;
  let hasCompletedTurn = false;
  do {
    const page = await threadTurnsList(client, threadId, {
      limit: 100,
      ...cursor ? { cursor } : {},
      sortDirection: "desc"
    }, ctx.retryOptions());
    for (const turn of page.data) {
      if (turn.status === "completed") hasCompletedTurn = true;
      if (turn.id === turnId) return;
    }
    cursor = page.nextCursor ?? void 0;
  } while (cursor);
  if (!hasCompletedTurn) {
    throw invalidParams("session has no completed turns yet; rollback requires a completed turn from `message history`");
  }
  throw invalidParams(`turn '${turnId}' not found in thread '${threadId}'`);
}
async function clientForThreadTarget(ctx, user, target) {
  if (target.kind === "live") {
    const client = ctx.pool.clientForSession(keyFor(user, target.session.name));
    if (client) return client;
  }
  return await ctx.pool.acquireForAdhoc(user);
}
async function detachLiveSessionHard(ctx, req, rec) {
  await sessionDetach(ctx, {
    ...req,
    method: "session:detach",
    params: {
      positionals: [rec.name],
      flags: {}
    }
  });
}
async function resolveSessionTarget(ctx, user, identifier) {
  const live = ctx.sessions.get(user, identifier);
  if (live) {
    return {
      kind: "live",
      session: live,
      threadId: live.thread_id,
      name: live.name
    };
  }
  if (looksLikeThreadId(identifier)) {
    const owner = ctx.sessions.findLiveAnywhere(identifier);
    if (owner) {
      if (owner.user !== user) {
        throw new CodexTeamError("session_busy", `thread '${identifier}' is live under user '${owner.user}'`);
      }
      return {
        kind: "live",
        session: owner.record,
        threadId: owner.record.thread_id,
        name: owner.record.name
      };
    }
    const thread = await readDetachedThreadById(ctx, user, identifier);
    return {
      kind: "detached",
      thread,
      threadId: thread.id,
      name: asString5(thread.name)
    };
  }
  const liveByName = ctx.sessions.findUniqueLiveByNameAnywhere(identifier);
  if (liveByName === "ambiguous") {
    throw invalidParams(`session name '${identifier}' is ambiguous across users; use a thread_id`);
  }
  if (liveByName) {
    if (liveByName.user !== user) {
      throw new CodexTeamError("session_busy", `session '${identifier}' is live under user '${liveByName.user}'`);
    }
    return {
      kind: "live",
      session: liveByName.record,
      threadId: liveByName.record.thread_id,
      name: liveByName.record.name
    };
  }
  const detached = await findDetachedThreadByName(ctx, user, identifier);
  if (detached === "ambiguous") {
    throw invalidParams(`session name '${identifier}' is ambiguous across detached threads; use a thread_id`);
  }
  if (!detached) {
    throw new CodexTeamError("session_not_found", `session '${identifier}' not found in this user`);
  }
  return {
    kind: "detached",
    thread: detached,
    threadId: detached.id,
    name: asString5(detached.name)
  };
}
async function readDetachedThreadById(ctx, user, threadId) {
  try {
    const client = await ctx.pool.acquireForAdhoc(user);
    const result = await threadRead(client, threadId, ctx.retryOptions());
    return result.thread;
  } catch (e) {
    throw new CodexTeamError("session_not_found", `session '${threadId}' not found: ${e.message}`);
  }
}
async function findDetachedThreadByName(ctx, user, name) {
  const client = await ctx.pool.acquireForAdhoc(user);
  let cursor;
  let match = null;
  do {
    const page = await threadList(client, {
      pageSize: 200,
      includeArchived: true,
      ...cursor ? { cursor } : {}
    }, ctx.retryOptions());
    for (const thread of page.data) {
      if (asString5(thread.name) !== name) continue;
      if (match) return "ambiguous";
      match = thread;
    }
    cursor = page.nextCursor ?? void 0;
  } while (cursor);
  return match;
}
var sessionHealthAll = async (ctx, req) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const flags = asFlags(req);
  const positionals = asPositionals(req);
  if (positionals.length > 0) {
    throw invalidParams("session health --all does not take a session positional");
  }
  const onlyUnhealthy = isTrue2(flags["only-unhealthy"]);
  const stateFilter = parseSessionHealthStates(asString5(flags["state"]));
  const sessions = ctx.sessions.listLive(user).map((record) => buildSessionHealthSnapshot(ctx, user, record)).filter((snapshot) => matchesSessionHealthState(snapshot, stateFilter)).filter((snapshot) => !onlyUnhealthy || !isQuietHealthySession(snapshot));
  return {
    summary: summarizeSessionHealthSnapshots(sessions),
    sessions
  };
};
var sessionEvents = async (ctx, req, stream) => {
  if (!stream) throw new CodexTeamError("internal", "session events requires streaming");
  requireUser(ctx, req);
  const user = req.bearer;
  const target = asPositional(req, 0, "name|thread_id");
  const flags = asFlags(req);
  const follow = isTrue2(flags["follow"]);
  const summaryMode = isTrue2(flags["summary"]);
  const byTool = isTrue2(flags["by-tool"]);
  const byItemKind = isTrue2(flags["by-item-kind"]);
  if (byTool && byItemKind) throw invalidParams("--by-tool and --by-item-kind are mutually exclusive");
  if (follow && (byTool || byItemKind)) throw invalidParams("--follow cannot be used with --by-tool or --by-item-kind");
  if (summaryMode && (byTool || byItemKind)) throw invalidParams("--summary cannot be used with --by-tool or --by-item-kind");
  const typeFilter = parseCsvFlag(flags["type"]);
  const turnFilter = asString5(flags["turn"]);
  const sinceId = asString5(flags["since"]);
  const limit = parseSessionEventsLimit(flags["limit"], 50);
  const matchesTarget = buildSessionEventMatcher(ctx, user, target);
  const listed = await ctx.events.listSince(user, sinceId, { includeDelta: true });
  if (!listed.ok) {
    if (listed.reason === "id_rotated") {
      stream.end(new CodexTeamError("id_rotated", `event '${sinceId}' has been rotated out`, {
        oldest_available_id: listed.oldest_available_id
      }));
    } else {
      stream.end(invalidParams(`event '${sinceId}' not found`));
    }
    return { streaming: true };
  }
  const accept = (event) => {
    if (isSessionEventDeltaType(event.type)) return false;
    if (!matchesTarget(event)) return false;
    if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(event.type)) return false;
    if (turnFilter && !eventMatchesTurn(event, turnFilter)) return false;
    return true;
  };
  const initialMatching = listed.events.filter(accept);
  const initialWindow = sinceId ? initialMatching.slice(0, limit) : initialMatching.slice(Math.max(0, initialMatching.length - limit));
  if (byTool || byItemKind) {
    const grouping = byTool ? "tool" : "item_kind";
    const counts = tallySessionEvents(initialWindow, grouping);
    stream.chunk({
      target,
      group_by: grouping,
      summary: formatSessionEventTally(counts),
      counts,
      item_completed_events: Object.values(counts).reduce((sum, count) => sum + count, 0)
    });
    stream.end();
    return { streaming: true };
  }
  for (const event of initialWindow) {
    stream.chunk(summaryMode ? summarizeSessionEvent(event) : event);
  }
  if (!follow) {
    stream.end();
    return { streaming: true };
  }
  const sub = ctx.events.subscribe(user, (event) => {
    if (!accept(event)) return;
    stream.chunk(summaryMode ? summarizeSessionEvent(event) : event);
  });
  stream.onClose(() => sub.dispose());
  return { streaming: true };
};
var sessionLogs = async (ctx, req, stream) => {
  requireUser(ctx, req);
  const user = req.bearer;
  const identifier = asPositional(req, 0, "name|thread_id");
  const flags = asFlags(req);
  const follow = isTrue2(flags["follow"]) || isTrue2(flags["f"]);
  const lineLimit = parseSessionLogsIntFlag(flags["n"], DEFAULT_SESSION_LOG_LINE_LIMIT, "-n", { minimum: 1 });
  const truncateBytes = parseSessionLogsIntFlag(
    flags["truncate"],
    DEFAULT_SESSION_LOG_TRUNCATE_BYTES,
    "--truncate",
    { minimum: 0 }
  );
  const selectedStream = parseSessionLogsStream(flags["stream"]);
  const target = await resolveSessionLogsTarget(ctx, user, identifier);
  const initial = buildSessionLogsResponse(ctx, user, target.rec, selectedStream, lineLimit, truncateBytes);
  if (!follow || !stream || target.rec.state === "crashed") {
    if (follow && stream) {
      stream.chunk(initial);
      stream.end();
      return { streaming: true };
    }
    return initial;
  }
  const client = target.client;
  if (!client) {
    throw new CodexTeamError("session_not_live", `session '${target.rec.name}' is unhealthy; run 'codex-team -b ${user} session heal ${target.rec.name}'`);
  }
  const emitLiveLine = (entry) => {
    if (!matchesSessionLogStream(selectedStream, entry.stream)) return;
    stream.chunk(buildSessionLogsIncrement(ctx, user, target.rec, truncateBytes, entry));
  };
  const onClose = () => stream.end();
  if (selectedStream === "stderr" || selectedStream === "all") client.on("stderr_line", emitLiveLine);
  if (selectedStream === "stdout" || selectedStream === "all") client.on("stdout_line", emitLiveLine);
  client.on("close", onClose);
  stream.chunk(initial);
  stream.onClose(() => {
    client.off("stderr_line", emitLiveLine);
    client.off("stdout_line", emitLiveLine);
    client.off("close", onClose);
  });
  return { streaming: true };
};
function buildSessionHealthSnapshot(ctx, user, rec) {
  const sessionKey = keyFor(user, rec.name);
  const busyTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
  const client = ctx.pool.clientForSession(sessionKey);
  const appServerAlive = isClientAlive(client);
  const currentTurnStartedAt = rec.current_turn_started_at ?? null;
  const pending = typeof ctx.pending.listForUser === "function" ? ctx.pending.listForUser(user).filter((entry) => entry.session_name === rec.name) : null;
  const pendingApprovals = pending ? pending.filter((entry) => entry.kind.startsWith("approval.")).length : rec.pending_approvals ?? 0;
  const pendingUserInputs = pending ? pending.filter((entry) => entry.kind === "user_input.request").length : rec.pending_user_inputs ?? 0;
  return {
    session: rec.name,
    thread_id: rec.thread_id,
    state: rec.state,
    busy: rec.state === "live" && appServerAlive && busyTurnId !== null,
    current_turn_id: busyTurnId,
    current_turn_started_at: currentTurnStartedAt,
    current_turn_elapsed_ms: currentTurnStartedAt ? Math.max(0, Date.now() - Date.parse(currentTurnStartedAt)) : null,
    current_item_type: rec.current_item_type ?? null,
    items_done_in_turn: rec.items_in_turn ?? 0,
    pending_approval_requests: pendingApprovals,
    pending_user_input_requests: pendingUserInputs,
    token_usage_last_turn: rec.token_usage_last_turn ?? null,
    app_server_alive: appServerAlive,
    last_event_id: ctx.events.latestEvent(user, { session: rec.name, thread_id: rec.thread_id })?.id ?? null
  };
}
function parseSessionHealthStates(value) {
  if (!value) return null;
  const states = /* @__PURE__ */ new Set();
  for (const raw of value.split(",")) {
    const state = raw.trim();
    if (!state) continue;
    if (state !== "live" && state !== "crashed" && state !== "closed") {
      throw invalidParams(`--state must be a comma-separated list of live, crashed, or closed`);
    }
    states.add(state);
  }
  return states.size > 0 ? states : null;
}
function matchesSessionHealthState(snapshot, states) {
  if (!states) return true;
  const state = asString5(snapshot.state);
  return state !== null && states.has(state);
}
function isQuietHealthySession(snapshot) {
  return snapshot.state === "live" && snapshot.busy === false && snapshot.app_server_alive === true;
}
function isHealthySession(snapshot) {
  return snapshot.state === "live" && snapshot.app_server_alive === true;
}
function summarizeSessionHealthSnapshots(snapshots) {
  return {
    total: snapshots.length,
    healthy: snapshots.filter((snapshot) => isHealthySession(snapshot)).length,
    crashed: snapshots.filter((snapshot) => snapshot.state === "crashed").length,
    closed: snapshots.filter((snapshot) => snapshot.state === "closed").length,
    busy: snapshots.filter((snapshot) => snapshot.busy === true).length,
    pending_total: snapshots.reduce((sum, snapshot) => sum + numericValue2(snapshot.pending_approval_requests) + numericValue2(snapshot.pending_user_input_requests), 0)
  };
}
function parseSessionEventsLimit(value, fallback) {
  if (value === void 0) return fallback;
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw < 0) throw invalidParams("--limit must be a non-negative integer");
  return Math.floor(raw);
}
function parseCsvFlag(value) {
  const raw = asString5(value);
  if (!raw) return null;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}
function buildSessionEventMatcher(ctx, user, target) {
  const aliases = /* @__PURE__ */ new Set([target]);
  const rec = ctx.sessions.get(user, target);
  if (rec) {
    aliases.add(rec.name);
    aliases.add(rec.thread_id);
  }
  return (event) => {
    if (event.session && aliases.has(event.session)) return true;
    if (event.thread_id && aliases.has(event.thread_id)) return true;
    return false;
  };
}
function eventMatchesTurn(event, turnId) {
  return scalarString2(event.payload.turn_id) === turnId || scalarString2(event.payload.last_turn_id) === turnId;
}
function summarizeSessionEvent(event) {
  return {
    id: event.id,
    ts: event.ts,
    type: event.type,
    session: event.session,
    key: summarizeSessionEventKey(event)
  };
}
function summarizeSessionEventKey(event) {
  const payload = event.payload;
  if (event.type.startsWith("turn.")) return scalarString2(payload.turn_id);
  if (event.type === "session.crashed" || event.type === "session.closed") {
    return labeledSessionEventValue("reason", payload.reason ?? payload.crash_reason ?? payload.why);
  }
  if (event.type === "auto_approved") {
    return labeledSessionEventValue("matched_pattern", payload.matched_pattern ?? payload.matchedPattern) ?? scalarString2(payload.request_id);
  }
  if (event.type.startsWith("approval.") || event.type === "user_input.request" || event.type === "server_request_resolved") {
    return scalarString2(payload.request_id);
  }
  if (event.type.startsWith("item.")) {
    return scalarString2(payload.type) ?? scalarString2(payload.item_type) ?? scalarString2(payload.item_id);
  }
  if (event.type.startsWith("thread.")) return scalarString2(payload.thread_id) ?? event.thread_id;
  if (event.type.startsWith("hook.")) return scalarString2(payload.hook_id);
  if (event.type.startsWith("mcp_server.")) return scalarString2(payload.name);
  if (event.type.startsWith("fuzzy_file_search.")) return scalarString2(payload.search_session_id);
  if (event.type === "monitor.overflow") return scalarString2(payload.dropped_count);
  return scalarString2(payload.turn_id) ?? scalarString2(payload.request_id) ?? scalarString2(payload.type) ?? scalarString2(payload.item_id) ?? scalarString2(payload.thread_id) ?? scalarString2(payload.name) ?? event.thread_id;
}
function labeledSessionEventValue(label, value) {
  const rendered = scalarString2(value);
  return rendered ? `${label}=${rendered}` : null;
}
function tallySessionEvents(events, grouping) {
  const counts = {};
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const itemKind = normalizeSessionEventItemKind(event.payload.type ?? event.payload.item_type ?? event.payload.item_id);
    const bucket = grouping === "tool" ? sessionEventToolBucket(itemKind) : itemKind;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}
function formatSessionEventTally(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "(no item.completed events)";
  return entries.map(([key, value]) => `${key}=${value}`).join(" ");
}
function normalizeSessionEventItemKind(value) {
  const raw = scalarString2(value);
  if (!raw) return "unknown";
  const normalized = raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s./-]+/g, "_").toLowerCase();
  switch (normalized) {
    case "agentmessage":
      return "agent_message";
    case "autoapprovalreview":
      return "auto_approval_review";
    case "commandexecution":
      return "command_execution";
    case "filechange":
      return "file_change";
    case "mcptoolcall":
      return "mcp_tool_call";
    case "usermessage":
      return "user_message";
    default:
      return normalized;
  }
}
function sessionEventToolBucket(itemKind) {
  switch (itemKind) {
    case "command_execution":
      return "shell";
    case "file_patch":
      return "file_change";
    default:
      return itemKind;
  }
}
function scalarString2(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
function numericValue2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function isSessionEventDeltaType(type) {
  return type.endsWith("_delta");
}
async function resolveSessionLogsTarget(ctx, user, identifier) {
  const rec = ctx.sessions.get(user, identifier);
  if (rec) {
    const client2 = rec.state === "live" ? ctx.pool.clientForSession(keyFor(user, rec.name)) : null;
    if (rec.state === "live" && !isClientAlive(client2)) {
      throw new CodexTeamError("session_not_live", `session '${rec.name}' is unhealthy; run 'codex-team -b ${user} session heal ${rec.name}'`);
    }
    return { rec, client: client2 };
  }
  const target = await resolveSessionTarget(ctx, user, identifier);
  if (target.kind === "detached") {
    const attachTarget = target.name ?? target.threadId;
    throw new CodexTeamError(
      "session_not_live",
      `session '${attachTarget}' is detached; re-attach the session with 'codex-team -b ${user} session attach ${attachTarget}' first`
    );
  }
  const client = ctx.pool.clientForSession(keyFor(user, target.session.name));
  if (!isClientAlive(client)) {
    throw new CodexTeamError("session_not_live", `session '${target.session.name}' is unhealthy; run 'codex-team -b ${user} session heal ${target.session.name}'`);
  }
  return { rec: target.session, client };
}
function buildSessionLogsResponse(ctx, user, rec, selectedStream, lineLimit, truncateBytes) {
  const sessionKey = keyFor(user, rec.name);
  const binding = rec.state === "live" ? ctx.pool.sessionBinding(sessionKey) : null;
  const client = rec.state === "live" ? ctx.pool.clientForSession(sessionKey) : null;
  const closed = rec.state === "crashed" ? ctx.pool.closedLogsForSession(sessionKey) : null;
  const sourceLines = rec.state === "crashed" ? selectStoredSessionLogLines(closed, selectedStream) : selectLiveSessionLogLines(client, selectedStream);
  const rendered = projectSessionLogLines(sourceLines, lineLimit, truncateBytes);
  const response = {
    session: rec.name,
    thread_id: rec.thread_id,
    app_server_id: binding?.appServerId ?? closed?.appServerId ?? null,
    pid: binding?.pid ?? closed?.pid ?? null,
    lines: rendered.lines,
    truncated_from: rendered.truncatedFrom
  };
  if (rec.state === "crashed") response.state = "crashed";
  return response;
}
function buildSessionLogsIncrement(ctx, user, rec, truncateBytes, entry) {
  const binding = ctx.pool.sessionBinding(keyFor(user, rec.name));
  return {
    session: rec.name,
    thread_id: rec.thread_id,
    app_server_id: binding?.appServerId ?? null,
    pid: binding?.pid ?? null,
    lines: [truncateSessionLogLine(entry, truncateBytes)],
    truncated_from: null
  };
}
function parseSessionLogsIntFlag(value, fallback, label, options) {
  if (value === void 0) return fallback;
  const raw = asString5(value);
  if (!raw) throw invalidParams(`${label} requires a value`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < options.minimum) {
    const expectation = options.minimum === 0 ? "a non-negative integer" : "a positive integer";
    throw invalidParams(`${label} must be ${expectation}`);
  }
  return parsed;
}
function parseSessionLogsStream(value) {
  if (value === void 0) return "stderr";
  const raw = asString5(value);
  if (!raw) throw invalidParams("--stream requires a value");
  if (raw === "stderr" || raw === "stdout" || raw === "all") return raw;
  throw invalidParams("--stream must be one of stderr, stdout, or all");
}
function selectLiveSessionLogLines(client, selectedStream) {
  if (!client) return [];
  if (selectedStream === "stderr") return client.stderrTail(Number.MAX_SAFE_INTEGER);
  if (selectedStream === "stdout") return client.stdoutTail(Number.MAX_SAFE_INTEGER);
  return client.logTail("all", Number.MAX_SAFE_INTEGER);
}
function selectStoredSessionLogLines(snapshot, selectedStream) {
  if (!snapshot) return [];
  if (selectedStream === "stderr") return snapshot.stderrTail;
  if (selectedStream === "stdout") return snapshot.stdoutTail;
  return [...snapshot.stderrTail, ...snapshot.stdoutTail].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
}
function projectSessionLogLines(lines, lineLimit, truncateBytes) {
  const truncatedFrom = lines.length > lineLimit ? lines.length : null;
  return {
    lines: lines.slice(Math.max(0, lines.length - lineLimit)).map((entry) => truncateSessionLogLine(entry, truncateBytes)),
    truncatedFrom
  };
}
function matchesSessionLogStream(selectedStream, stream) {
  return selectedStream === "all" || selectedStream === stream;
}
function truncateSessionLogLine(entry, truncateBytes) {
  return {
    ...entry,
    line: truncateTextByBytes(entry.line, truncateBytes)
  };
}
function truncateTextByBytes(value, truncateBytes) {
  if (truncateBytes <= 0 || Buffer.byteLength(value, "utf8") <= truncateBytes) return value;
  const suffix = truncateBytes >= 3 ? "..." : "";
  const budget = Math.max(0, truncateBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= budget) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

// src/daemon/handlers/message.ts
var import_node_fs17 = __toESM(require("fs"));
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
var messageSendMany = async (ctx, req) => {
  const user = requireUser2(ctx, req);
  const positionals = asPositionals2(req);
  const promptPositional = hasPromptFlagSource(req) ? null : positionals[positionals.length - 1] ?? null;
  const identifiers = hasPromptFlagSource(req) ? positionals : positionals.slice(0, -1);
  if (identifiers.length < 2) {
    throw invalidParams("message send-many requires at least two target sessions");
  }
  const prompt = await readPromptInput(req, promptPositional);
  const input = await buildUserInput(prompt, []);
  const retry = ctx.retryOptions();
  const results = await Promise.all(identifiers.map(async (identifier) => {
    try {
      const { rec, client } = await resolveLiveTarget(ctx, user, identifier);
      const sessionKey = keyFor2(user, rec.name);
      const result = await ctx.queues.sendOrQueue(sessionKey, client, rec.thread_id, input, retry);
      ctx.sessions.touch(user, rec.name);
      return {
        session: rec.name,
        turn_id: result.turn_id,
        started: result.started,
        queue_id: result.queue_id,
        queued_depth: result.queued_depth
      };
    } catch (error) {
      return {
        session: identifier,
        ok: false,
        error: normalizeHandlerError(error)
      };
    }
  }));
  return { results };
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
  const sinceRaw = asString6(getFlag2(req, "since"));
  const format = asString6(getFlag2(req, "format")) ?? "json";
  const truncate = parseTruncateFlag(getFlag2(req, "truncate"));
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
    }, { truncate });
  }
  return response;
};
var messageTail = async (ctx, req, stream) => {
  const { user, rec, client } = await resolveLive(ctx, req);
  const nRaw = getFlag2(req, "n");
  const n = typeof nRaw === "string" ? parseInt(nRaw, 10) : typeof nRaw === "number" ? nRaw : 3;
  const format = asString6(getFlag2(req, "format")) ?? "json";
  const truncate = parseTruncateFlag(getFlag2(req, "truncate"));
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
      }, { truncate });
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
var messageWait = async (ctx, req) => {
  const user = requireUser2(ctx, req);
  const waitAll = isTrue3(getFlag2(req, "all"));
  const waitAny = isTrue3(getFlag2(req, "any"));
  if (waitAll && waitAny) {
    throw invalidParams("--all and --any are mutually exclusive");
  }
  const positionals = asPositionals2(req);
  const requestedTurnId = asString6(getFlag2(req, "for"));
  const timeoutSeconds = parseTimeoutSeconds(getFlag2(req, "timeout"));
  if (!waitAll && !waitAny) {
    if (positionals.length !== 1) {
      throw invalidParams("message wait accepts exactly one session unless --all or --any is set");
    }
    const rec = resolveSessionRecordTarget(ctx, user, positionals[0]);
    return await waitForSingleSession(ctx, user, rec, requestedTurnId, timeoutSeconds);
  }
  if (requestedTurnId) {
    throw invalidParams("--for is only supported when waiting on a single session");
  }
  if (positionals.length === 0) {
    throw invalidParams("message wait requires at least one session");
  }
  const records = positionals.map((identifier) => resolveSessionRecordTarget(ctx, user, identifier));
  if (waitAll) {
    return await waitForAllSessions(ctx, user, records, timeoutSeconds);
  }
  return await waitForAnySession(ctx, user, records, timeoutSeconds);
};
async function resolveLive(ctx, req) {
  const user = requireUser2(ctx, req);
  const identifier = asPositional2(req, 0, "session");
  const resolved = await resolveLiveTarget(ctx, user, identifier);
  return { user, ...resolved };
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
  setImmediate(() => {
    void ctx.events.append(user, {
      type: "warning",
      session,
      thread_id: threadId,
      payload
    }).catch(() => void 0);
  });
}
async function readPromptInput(req, positional = asPositionalOptional2(req, 1)) {
  const fromFile = asString6(getFlag2(req, "file"));
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
      return await import_node_fs17.default.promises.readFile(fromFile, "utf8");
    } catch (e) {
      throw invalidParams(`--file not readable: ${e.message}`);
    }
  }
  const stdinContent = asString6(req.params.stdin_content);
  if (stdinContent === null) throw invalidParams("--stdin requested but no content forwarded from cli");
  return stdinContent;
}
async function readJsonInput(req) {
  const jsonRaw = asString6(getFlag2(req, "json"));
  const fromFile = asString6(getFlag2(req, "file"));
  const fromStdin = isTrue3(getFlag2(req, "stdin"));
  const sources = [jsonRaw, fromFile, fromStdin].filter((v) => v !== null && v !== false).length;
  if (sources === 0) return null;
  if (sources > 1) throw invalidParams("json payload ambiguous: supply exactly one of --json, --file, --stdin");
  let raw;
  if (jsonRaw) raw = jsonRaw;
  else if (fromFile) {
    try {
      raw = await import_node_fs17.default.promises.readFile(fromFile, "utf8");
    } catch (e) {
      throw invalidParams(`--file not readable: ${e.message}`);
    }
  } else {
    const stdinContent = asString6(req.params.stdin_content);
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
  for (const path19 of attachments) {
    await assertAttachable(path19);
    items.push({ type: "localImage", path: path19 });
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
  return buildApprovalShortcutResponse(pending.kind, pending.raw, shortcut);
}
function buildApprovalShortcutResponse(kind, raw, shortcut) {
  switch (kind) {
    case "approval.command_execution":
    case "approval.file_change":
      return { decision: commandOrFileShortcut(shortcut, kind) };
    case "approval.permissions":
      return permissionsShortcut(shortcut, raw);
    case "approval.mcp_elicitation":
      return mcpElicitationShortcut(shortcut, raw);
    default:
      throw new CodexTeamError("invalid_decision", `unknown approval kind '${kind}'`);
  }
}
function preferredAutoApprovalShortcut(kind) {
  switch (kind) {
    case "approval.command_execution":
    case "approval.file_change":
    case "approval.permissions":
      return "accept-session";
    case "approval.mcp_elicitation":
      return "accept";
    default:
      return null;
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
function asPositionals2(req) {
  const positionals = req.params.positionals;
  return Array.isArray(positionals) ? positionals.filter((value) => typeof value === "string") : [];
}
function getFlag2(req, key) {
  const flags = req.params.flags;
  if (flags && typeof flags === "object") return flags[key];
  return void 0;
}
function asPositional2(req, idx, name) {
  const list = asPositionals2(req);
  const v = list[idx];
  if (typeof v !== "string" || v.length === 0) throw invalidParams(`missing positional '${name}'`);
  return v;
}
function asPositionalOptional2(req, idx) {
  const list = asPositionals2(req);
  const v = list[idx];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asString6(v) {
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
function isClientAlive2(client) {
  if (!client) return false;
  const maybe = client;
  if (typeof maybe.isAlive === "function") return maybe.isAlive();
  return true;
}
function parseTimeoutSeconds(value) {
  if (value === void 0) return 600;
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw < 0) throw invalidParams("--timeout must be a non-negative number of seconds");
  return Math.floor(raw);
}
function isTrue3(v) {
  return v === true || v === "true" || v === "1";
}
function hasPromptFlagSource(req) {
  return asString6(getFlag2(req, "file")) !== null || isTrue3(getFlag2(req, "stdin"));
}
function eventTurnId(event) {
  const turnId = event.payload.turn_id;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}
function eventCrashTurnId(event) {
  const turnId = event.payload.last_turn_id;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : null;
}
function terminalWaitResult(session, threadId, turnId, event) {
  const completedStatus = event.type === "turn.completed" ? event.payload.status : null;
  const completedFields = event.type === "turn.completed" ? pickDefined(event.payload, [
    "status",
    "duration_ms",
    "items_count",
    "token_usage",
    "ended_at",
    "turn_items_included"
  ]) : {};
  return {
    session,
    thread_id: threadId,
    turn_id: turnId,
    outcome: event.type === "turn.interrupted" ? "interrupted" : event.type === "turn.completed" && completedStatus === "completed" ? "completed" : "error",
    event_type: event.type,
    event_id: event.id,
    ...completedFields,
    ...event.type === "turn.error" ? { error: event.payload.error ?? event.payload } : {}
  };
}
async function findTerminalEvent(ctx, user, session, turnId) {
  const listed = await ctx.events.listSince(user, null, { includeDelta: true });
  if (!listed.ok) return null;
  for (let i = listed.events.length - 1; i >= 0; i--) {
    const event = listed.events[i];
    if (event.session !== session) continue;
    if (event.type !== "turn.completed" && event.type !== "turn.error" && event.type !== "turn.interrupted") continue;
    if (eventTurnId(event) !== turnId) continue;
    return event;
  }
  return null;
}
function requireUser2(ctx, req) {
  const user = req.bearer;
  if (!user) throw invalidParams("bearer token required");
  if (!ctx.users.has(user)) {
    throw new CodexTeamError("user_not_found", `user '${user}' not found`);
  }
  return user;
}
async function resolveLiveTarget(ctx, user, identifier) {
  const rec = resolveSessionRecordTarget(ctx, user, identifier);
  if (rec.state === "crashed") {
    throw new CodexTeamError("session_not_live", `session '${rec.name}' is crashed; run 'codex-team -b ${user} session heal ${rec.name}'`);
  }
  const client = ctx.pool.clientForSession(keyFor2(user, rec.name));
  if (!isClientAlive2(client)) {
    throw new CodexTeamError("session_not_live", `session '${rec.name}' is unhealthy; run 'codex-team -b ${user} session heal ${rec.name}'`);
  }
  return { rec, client };
}
function resolveSessionRecordTarget(ctx, user, identifier) {
  const rec = ctx.sessions.get(user, identifier);
  if (!rec) {
    throw new CodexTeamError("session_not_found", `session '${identifier}' not live in this user`);
  }
  return rec;
}
function normalizeHandlerError(error) {
  if (error instanceof CodexTeamError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "internal",
    message
  };
}
async function waitForSingleSession(ctx, user, rec, requestedTurnId, timeoutSeconds) {
  const observer = await createWaitObserver(ctx, user, rec, requestedTurnId);
  if (observer.immediateResult) return observer.immediateResult;
  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      observer.cancel();
      resolve(result);
    };
    void observer.promise.then((result) => {
      if (!result) return;
      settle(result);
    });
    if (timeoutSeconds > 0) {
      timer = setTimeout(() => {
        settle(timeoutWaitResult(rec, observer.currentTurnId(), timeoutSeconds));
      }, timeoutSeconds * 1e3);
      timer.unref();
    }
  });
}
async function waitForAllSessions(ctx, user, records, timeoutSeconds) {
  const observers = await Promise.all(records.map((rec) => createWaitObserver(ctx, user, rec, null)));
  const outcomes = observers.map((observer) => observer.immediateResult ? projectBatchWaitOutcome(observer.immediateResult) : null);
  let pending = outcomes.filter((outcome) => outcome === null).length;
  if (pending === 0) {
    const finalized = outcomes.filter((outcome) => outcome !== null);
    return {
      outcomes: finalized,
      overall: overallWaitOutcome(finalized)
    };
  }
  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finalize = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const observer of observers) observer.cancel();
      const finalized = outcomes.map((outcome, index) => outcome ?? timeoutBatchWaitOutcome(records[index], observers[index], timeoutSeconds));
      resolve({
        outcomes: finalized,
        overall: overallWaitOutcome(finalized)
      });
    };
    observers.forEach((observer, index) => {
      if (outcomes[index] !== null) return;
      void observer.promise.then((result) => {
        if (settled || !result) return;
        outcomes[index] = projectBatchWaitOutcome(result);
        pending -= 1;
        if (pending === 0) finalize();
      });
    });
    if (timeoutSeconds > 0) {
      timer = setTimeout(finalize, timeoutSeconds * 1e3);
      timer.unref();
    }
  });
}
async function waitForAnySession(ctx, user, records, timeoutSeconds) {
  const observers = await Promise.all(records.map((rec) => createWaitObserver(ctx, user, rec, null)));
  const immediateIndex = observers.findIndex((observer) => observer.immediateResult !== void 0);
  if (immediateIndex >= 0) {
    observers.forEach((observer, index) => {
      if (index !== immediateIndex) observer.cancel();
    });
    return projectAnyWaitResult(
      observers[immediateIndex].immediateResult,
      records.filter((_rec, index) => index !== immediateIndex && observers[index].immediateResult === void 0).map((rec) => rec.name)
    );
  }
  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      observers.forEach((observer) => observer.cancel());
      resolve(result);
    };
    observers.forEach((observer, index) => {
      void observer.promise.then((result) => {
        if (settled || !result) return;
        settle(projectAnyWaitResult(
          result,
          records.filter((_rec, otherIndex) => otherIndex !== index).map((rec) => rec.name)
        ));
      });
    });
    if (timeoutSeconds > 0) {
      timer = setTimeout(() => {
        settle({
          outcome: "timeout",
          timeout_s: timeoutSeconds,
          still_running: records.map((rec) => rec.name)
        });
      }, timeoutSeconds * 1e3);
      timer.unref();
    }
  });
}
async function createWaitObserver(ctx, user, rec, requestedTurnId) {
  if (rec.state !== "live") {
    return immediateWaitObserver(crashedWaitResult(rec));
  }
  const sessionKey = keyFor2(user, rec.name);
  let targetTurnId = requestedTurnId ?? rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
  if (requestedTurnId) {
    const historical = await findTerminalEvent(ctx, user, rec.name, requestedTurnId);
    if (historical) return immediateWaitObserver(terminalWaitResult(rec.name, rec.thread_id, requestedTurnId, historical));
  } else if (targetTurnId) {
    const historical = await findTerminalEvent(ctx, user, rec.name, targetTurnId);
    if (historical) return immediateWaitObserver(terminalWaitResult(rec.name, rec.thread_id, targetTurnId, historical));
  }
  let settled = false;
  let sub = null;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const settle = (result) => {
    if (settled) return;
    settled = true;
    sub?.dispose();
    resolvePromise(result);
  };
  sub = ctx.events.subscribe(user, (event) => {
    if (event.session !== rec.name) return;
    if (event.thread_id !== rec.thread_id) return;
    if (!targetTurnId) {
      targetTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
    }
    if (!targetTurnId) {
      if (event.type === "turn.started") {
        const turnId = eventTurnId(event);
        if (!turnId) return;
        targetTurnId = turnId;
      } else if (event.type === SESSION_CRASHED_EVENT_TYPE || event.type === SESSION_CLOSED_EVENT_TYPE) {
        settle(waitErrorResult(rec, null, event.type, event.id, event.payload));
      }
      return;
    }
    if (isTurnTerminalEvent(event) && eventTurnId(event) === targetTurnId) {
      settle(terminalWaitResult(rec.name, rec.thread_id, targetTurnId, event));
      return;
    }
    if (event.type === SESSION_CRASHED_EVENT_TYPE && eventCrashTurnId(event) === targetTurnId) {
      settle(waitErrorResult(rec, targetTurnId, event.type, event.id, event.payload));
      return;
    }
    if (event.type === SESSION_CLOSED_EVENT_TYPE) {
      settle(waitErrorResult(rec, targetTurnId, event.type, event.id, event.payload));
    }
  });
  return {
    promise,
    cancel: () => settle(null),
    currentTurnId: () => targetTurnId ?? null
  };
}
function immediateWaitObserver(result) {
  return {
    immediateResult: result,
    promise: Promise.resolve(result),
    cancel: () => void 0,
    currentTurnId: () => asString6(result.turn_id) ?? null
  };
}
function crashedWaitResult(rec) {
  return waitErrorResult(
    rec,
    rec.current_turn_id ?? rec.last_turn_id ?? null,
    SESSION_CRASHED_EVENT_TYPE,
    null,
    { reason: rec.crash_reason ?? "session_crashed" }
  );
}
function waitErrorResult(rec, turnId, eventType, eventId, error) {
  const result = {
    session: rec.name,
    thread_id: rec.thread_id,
    turn_id: turnId,
    outcome: "error",
    event_type: eventType,
    error
  };
  if (eventId !== null) result.event_id = eventId;
  return result;
}
function timeoutWaitResult(rec, turnId, timeoutSeconds) {
  return {
    session: rec.name,
    thread_id: rec.thread_id,
    turn_id: turnId,
    outcome: "timeout",
    timeout_s: timeoutSeconds
  };
}
function isTurnTerminalEvent(event) {
  return event.type === "turn.completed" || event.type === "turn.error" || event.type === "turn.interrupted";
}
function projectBatchWaitOutcome(result) {
  const projected = pickDefined(result, ["session", "outcome", "turn_id"]);
  const codexErrorInfo = extractCodexErrorInfo2(result);
  if (codexErrorInfo) projected.codex_error_info = codexErrorInfo;
  return projected;
}
function timeoutBatchWaitOutcome(rec, observer, timeoutSeconds) {
  return projectBatchWaitOutcome(timeoutWaitResult(rec, observer.currentTurnId(), timeoutSeconds));
}
function projectAnyWaitResult(result, stillRunning) {
  const projected = pickDefined(result, ["session", "outcome", "turn_id", "timeout_s"]);
  const codexErrorInfo = extractCodexErrorInfo2(result);
  if (codexErrorInfo) projected.codex_error_info = codexErrorInfo;
  projected.still_running = stillRunning;
  return projected;
}
function extractCodexErrorInfo2(result) {
  const error = result.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const info = error.codex_error_info;
  return typeof info === "string" && info.length > 0 ? info : null;
}
function overallWaitOutcome(outcomes) {
  const values = outcomes.map((outcome) => outcome.outcome);
  if (values.every((value) => value === "completed")) return "completed";
  const hasError = values.includes("error");
  const hasTimeout = values.includes("timeout");
  if (hasError && hasTimeout) return "partial";
  if (hasError) return "error";
  if (hasTimeout) return "timeout";
  return "partial";
}
function parseTruncateFlag(value) {
  if (value === void 0) return void 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    if (normalized >= 0) return normalized;
    throw invalidParams("--truncate must be a non-negative integer");
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  throw invalidParams("--truncate must be a non-negative integer");
}
function pickDefined(source, keys) {
  const picked = {};
  for (const key of keys) {
    if (source[key] !== void 0) picked[key] = source[key];
  }
  return picked;
}
async function assertAttachable(filePath) {
  let stat;
  try {
    stat = await import_node_fs17.default.promises.stat(filePath);
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
  const skip2 = Math.max(0, relativeSince - 1);
  let remainingSkip = skip2;
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

// src/daemon/handlers/cursor.ts
var cursorSave = async (ctx, req) => {
  const user = requireUser3(ctx, req);
  const name = reqPositional2(req, 0, "name");
  const explicitEventId = asString7(getFlag3(req, "event-id"));
  const eventId = explicitEventId ?? await currentTailEventId(ctx, user);
  const cursor = await ctx.cursors.save(user, {
    name,
    event_id: eventId,
    auto_update: true
  });
  return { cursor };
};
var cursorList = async (ctx, req) => {
  const user = requireUser3(ctx, req);
  return { cursors: ctx.cursors.list(user) };
};
var cursorGet = async (ctx, req) => {
  const user = requireUser3(ctx, req);
  const name = reqPositional2(req, 0, "name");
  const cursor = ctx.cursors.get(user, name);
  if (!cursor) throw invalidParams(`cursor '${name}' not found`);
  return { event_id: cursor.event_id };
};
var cursorDelete = async (ctx, req) => {
  const user = requireUser3(ctx, req);
  const name = reqPositional2(req, 0, "name");
  const deleted = await ctx.cursors.delete(user, name);
  if (!deleted) throw invalidParams(`cursor '${name}' not found`);
  return { deleted: true, name };
};
async function currentTailEventId(ctx, user) {
  const listed = await ctx.events.listSince(user, null, { includeDelta: true });
  if (!listed.ok) {
    throw new CodexTeamError("internal", `failed to resolve current event tail for '${user}'`);
  }
  const last = listed.events[listed.events.length - 1];
  return last?.id ?? null;
}
function requireUser3(ctx, req) {
  const user = req.bearer;
  if (!user) throw invalidParams("bearer token required");
  if (!ctx.users.has(user)) {
    throw new CodexTeamError("user_not_found", `user '${user}' not found`);
  }
  return user;
}
function reqPositional2(req, index, name) {
  const value = asPositionals3(req)[index];
  if (!value) throw invalidParams(`missing positional '${name}'`);
  return value;
}
function asPositionals3(req) {
  const positionals = req.params.positionals;
  return Array.isArray(positionals) ? positionals.filter((value) => typeof value === "string") : [];
}
function getFlag3(req, key) {
  const flags = req.params.flags;
  if (!flags || typeof flags !== "object") return void 0;
  return flags[key];
}
function asString7(value) {
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === "string" ? last : null;
  }
  return typeof value === "string" ? value : null;
}

// src/daemon/handlers/monitor.ts
var import_node_child_process6 = require("child_process");
var MAX_INTERVAL_QUEUE_EVENTS = 512;
var MAX_INTERVAL_QUEUE_BYTES = 512 * 1024;
var MAX_FLUSH_EVENTS_PER_TICK = 64;
var DEFAULT_CURSOR_PERSIST_DEBOUNCE_MS = 200;
var DEFAULT_ALARM_OUTPUT_CAP_BYTES = 16 * 1024;
var ACKABLE_EVENT_ID_RE = /^evt-\d+$/;
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
  const summaryMode = isTrue4(flags["summary"]);
  const filterTypes = parseTypeList(flags["filter"]);
  const excludeTypes = parseTypeList(flags["exclude"]);
  const cursorPersistDebounceMs = numConfig(ctx, "monitor.cursor_persist_debounce_ms", DEFAULT_CURSOR_PERSIST_DEBOUNCE_MS);
  const sinceId = asString8(flags["since"]);
  const cursorName = asString8(flags["cursor"]);
  if (sinceId && cursorName) throw invalidParams("--since and --cursor are mutually exclusive");
  const sessionFilter = asString8(flags["session"]);
  let effectiveSinceId = sinceId;
  let queuedCursorEventId = null;
  let lastAckedEventId = null;
  if (cursorName) {
    const cursor = await ctx.cursors.ensure(user, {
      name: cursorName,
      event_id: null,
      auto_update: true
    });
    effectiveSinceId = cursor.event_id;
    queuedCursorEventId = cursor.event_id;
    lastAckedEventId = cursor.event_id;
  }
  const emit = (event, ackable = isAckableMonitorEventId(event.id)) => {
    stream.chunk(summaryMode ? summarizeEvent(event, ackable) : withAckableState(event, ackable));
  };
  const scheduleCursorPersist = () => {
    if (!cursorName) return;
    const nextEventId = lastAckedEventId;
    if (!nextEventId || nextEventId === queuedCursorEventId) return;
    ctx.cursors.saveBestEffortDebounced(user, {
      name: cursorName,
      event_id: nextEventId,
      auto_update: true
    }, cursorPersistDebounceMs);
    queuedCursorEventId = nextEventId;
  };
  const flushCursorPersist = async () => {
    if (!cursorName) return;
    await ctx.cursors.flushUser(user);
  };
  stream.onAck((ack) => {
    if (!ack.event_id) return;
    if (!isAckableMonitorEventId(ack.event_id)) {
      logger.warn("ignoring non-event monitor ack for cursor update", {
        user,
        cursor: cursorName,
        event_id: ack.event_id
      });
      return;
    }
    lastAckedEventId = ack.event_id;
    scheduleCursorPersist();
  });
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
  const backlog = await ctx.events.listSince(user, effectiveSinceId, { includeDelta: true });
  if (!backlog.ok) {
    if (backlog.reason === "id_rotated") {
      stream.end(new CodexTeamError("id_rotated", `event '${effectiveSinceId}' has been rotated out`, {
        oldest_available_id: backlog.oldest_available_id
      }));
    } else {
      stream.end(invalidParams(`event '${effectiveSinceId}' not found`));
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
    for (const e of queue) emit(e);
    queue.length = 0;
    const sub2 = ctx.events.subscribe(user, (e) => {
      if (accept(e)) emit(e);
    });
    stream.onClose(async () => {
      sub2.dispose();
      await flushCursorPersist();
    });
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
    if (overflowEvent) emit(overflowEvent, false);
    const batch = queue.splice(0, MAX_FLUSH_EVENTS_PER_TICK);
    for (const event of batch) {
      queueBytes = Math.max(0, queueBytes - eventSize(event));
      emit(event);
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
  stream.onClose(async () => {
    closed = true;
    clearInterval(timer);
    if (drainTimer) clearTimeout(drainTimer);
    sub.dispose();
    await flushCursorPersist();
  });
  return { streaming: true };
};
var monitorAlarm = async (ctx, req, stream) => {
  if (!stream) throw new CodexTeamError("internal", "monitor alarm requires streaming");
  const positionals = asPositionals4(req);
  const intervalS = toInt4(positionals[0], 0);
  if (intervalS <= 0) throw invalidParams("first positional must be interval seconds (positive integer)");
  const command = positionals[1];
  if (!command) throw invalidParams("missing command string");
  const flags = asFlags2(req);
  const once = isTrue4(flags["once"]);
  const timeoutS = toInt4(flags["timeout"], 60);
  const outputCapBytes = numConfig(ctx, "monitor.alarm_output_cap_bytes", DEFAULT_ALARM_OUTPUT_CAP_BYTES);
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
        const child = (0, import_node_child_process6.spawn)(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        activeChild = child;
        activeTimedOut = false;
        const stdoutBuf = new CappedOutputBuffer(outputCapBytes);
        const stderrBuf = new CappedOutputBuffer(outputCapBytes);
        const timeoutTimer = setTimeout(() => {
          activeTimedOut = true;
          clearActiveTimeoutTimer();
          requestChildShutdown(child);
        }, timeoutS * 1e3);
        timeoutTimer.unref();
        activeTimeoutTimer = timeoutTimer;
        child.stdout.on("data", (c) => {
          stdoutBuf.append(c);
        });
        child.stderr.on("data", (c) => {
          stderrBuf.append(c);
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
            const stdout = stdoutBuf.render();
            const stderr = stderrBuf.render();
            const outputTruncated = stdoutBuf.truncated() || stderrBuf.truncated();
            if (stdout) stream.chunk({ stdout });
            if (stderr) stream.chunk({ stderr });
            stream.chunk({
              __alarm_event: activeTimedOut ? "timeout" : "exit",
              exit_code: code,
              signal,
              duration_ms: Date.now() - start,
              ...outputTruncated ? { output_truncated: true } : {}
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
var CappedOutputBuffer = class {
  headBytes;
  tailBytes;
  capBytes;
  totalBytes = 0;
  head = Buffer.alloc(0);
  tail = Buffer.alloc(0);
  full = Buffer.alloc(0);
  wasTruncated = false;
  constructor(capBytes) {
    this.capBytes = Math.max(1, Math.floor(capBytes));
    this.headBytes = Math.floor(this.capBytes / 2);
    this.tailBytes = this.capBytes - this.headBytes;
  }
  append(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (buf.length === 0) return;
    this.totalBytes += buf.length;
    if (!this.wasTruncated) {
      const next = this.full.length === 0 ? buf : Buffer.concat([this.full, buf]);
      if (next.length <= this.capBytes) {
        this.full = next;
        return;
      }
      this.wasTruncated = true;
      this.head = next.subarray(0, this.headBytes);
      this.tail = this.tailBytes > 0 ? next.subarray(Math.max(0, next.length - this.tailBytes)) : Buffer.alloc(0);
      this.full = Buffer.alloc(0);
      return;
    }
    if (this.tailBytes === 0) return;
    if (buf.length >= this.tailBytes) {
      this.tail = buf.subarray(buf.length - this.tailBytes);
      return;
    }
    const merged = this.tail.length === 0 ? buf : Buffer.concat([this.tail, buf]);
    this.tail = merged.length <= this.tailBytes ? merged : merged.subarray(merged.length - this.tailBytes);
  }
  render() {
    if (!this.wasTruncated) return this.full.toString("utf8");
    const truncatedBytes = Math.max(0, this.totalBytes - this.head.length - this.tail.length);
    const marker = Buffer.from(`[... ${truncatedBytes} bytes truncated ...]`, "utf8");
    return Buffer.concat([this.head, marker, this.tail]).toString("utf8");
  }
  truncated() {
    return this.wasTruncated;
  }
};
function asFlags2(req) {
  const f = req.params.flags;
  return f && typeof f === "object" ? f : {};
}
function asPositionals4(req) {
  const p = req.params.positionals;
  return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
}
function isTrue4(v) {
  return v === true || v === "true" || v === "1";
}
function asString8(v) {
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
  const s = asString8(v);
  if (!s) return null;
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function numConfig(ctx, key, fallback) {
  const v = ctx.config?.getEffective?.(key);
  return typeof v === "number" ? v : fallback;
}
function eventSize(event) {
  return Buffer.byteLength(JSON.stringify(event));
}
function summarizeEvent(event, ackable) {
  return stripUndefined2({
    id: event.id,
    ts: event.ts,
    type: event.type,
    session: event.session,
    key: summarizeEventKey2(event),
    ackable: ackable ? void 0 : false
  });
}
function withAckableState(event, ackable) {
  if (ackable) return event;
  return {
    ...event,
    ackable: false
  };
}
function isAckableMonitorEventId(eventId) {
  return ACKABLE_EVENT_ID_RE.test(eventId);
}
function stripUndefined2(value) {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === void 0) delete value[key];
  }
  return value;
}
function summarizeEventKey2(event) {
  const payload = event.payload;
  if (event.type.startsWith("turn.")) return asPayloadString(payload.turn_id);
  if (event.type === SESSION_CRASHED_EVENT_TYPE || event.type === SESSION_CLOSED_EVENT_TYPE) {
    return labeledSummaryValue2("reason", payload.reason ?? payload.crash_reason ?? payload.why);
  }
  if (event.type === AUTO_APPROVED_EVENT_TYPE) {
    return labeledSummaryValue2("matched_pattern", payload.matched_pattern ?? payload.matchedPattern) ?? asPayloadString(payload.request_id);
  }
  if (event.type.startsWith("approval.") || event.type === "user_input.request" || event.type === "server_request_resolved") {
    return asPayloadString(payload.request_id);
  }
  if (event.type.startsWith("item.")) {
    return asPayloadString(payload.type) ?? asPayloadString(payload.item_type) ?? asPayloadString(payload.item_id);
  }
  if (event.type.startsWith("thread.")) return asPayloadString(payload.thread_id) ?? event.thread_id;
  if (event.type.startsWith("hook.")) return asPayloadString(payload.hook_id);
  if (event.type.startsWith("mcp_server.")) return asPayloadString(payload.name);
  if (event.type.startsWith("fuzzy_file_search.")) return asPayloadString(payload.search_session_id);
  if (event.type === "monitor.overflow") return asPayloadString(payload.dropped_count);
  return asPayloadString(payload.turn_id) ?? asPayloadString(payload.request_id) ?? asPayloadString(payload.type) ?? asPayloadString(payload.item_id) ?? asPayloadString(payload.thread_id) ?? asPayloadString(payload.name) ?? event.thread_id;
}
function asPayloadString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
function labeledSummaryValue2(label, value) {
  const rendered = asPayloadString(value);
  return rendered ? `${label}=${rendered}` : null;
}

// src/daemon/dispatch.ts
var HANDLERS = {
  "version": version,
  "status": status,
  "daemon:status": daemonStatus,
  "daemon:fleet:status": daemonFleetStatus,
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
  "session:archive": sessionArchive,
  "session:unarchive": sessionUnarchive,
  "session:fork": sessionFork,
  "session:rename": sessionRenameExtended,
  "session:rollback": sessionRollback,
  "session:info": sessionInfo,
  "session:context": sessionContext,
  "session:list": sessionList,
  "session:health:all": sessionHealthAll,
  "session:events": sessionEvents,
  "session:logs": sessionLogs,
  "message:send": messageSend,
  "message:send-many": messageSendMany,
  "message:peer": messagePeer,
  "message:interrupt": messageInterrupt,
  "message:approval": messageApproval,
  "message:answer": messageAnswer,
  "message:history": messageHistory,
  "message:tail": messageTail,
  "monitor:events": monitorEvents,
  "monitor:alarm": monitorAlarm,
  "session:health": sessionHealth,
  "session:heal": sessionHeal,
  "message:wait": messageWait,
  "cursor:save": cursorSave,
  "cursor:list": cursorList,
  "cursor:get": cursorGet,
  "cursor:delete": cursorDelete
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
  const activeStreams = /* @__PURE__ */ new Map();
  onMessages(
    socket,
    async (msg) => {
      if (msg.kind === "notification") {
        handleNotification(msg, activeStreams);
        return;
      }
      if (msg.kind !== "request") return;
      try {
        await handleRequest(ctx, socket, msg, closeCallbacks, activeStreams);
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
      activeStreams.clear();
      closeCallbacks.clear();
    }
  );
  socket.on("error", (e) => {
    logger.debug("socket error", { err: e.message });
  });
}
async function handleRequest(ctx, socket, req, closeCallbacks, activeStreams) {
  ctx.activity.touch();
  const handler = getHandler(req.method);
  const streaming = req.params?.streaming === true;
  if (streaming) {
    const stream = createStreamHandle(socket, req.id, closeCallbacks, () => activeStreams.delete(req.id));
    activeStreams.set(req.id, stream);
    try {
      await handler(ctx, req, stream.handle);
    } catch (e) {
      stream.handle.end(toCodexTeamError(e));
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
function createStreamHandle(socket, id, closeCallbacks, onRetire) {
  let ended = false;
  let retired = false;
  let blocked = false;
  let queuedBytes = 0;
  const queuedFrames = [];
  const ackCallbacks = /* @__PURE__ */ new Set();
  const retire = () => {
    if (retired) return;
    retired = true;
    ackCallbacks.clear();
    onRetire();
  };
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
  closeCallbacks.add(() => {
    retire();
    socket.off("drain", onDrain);
  });
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
      retire();
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
    handle: {
      chunk(data) {
        if (ended) return;
        const msg = { kind: "stream_chunk", id, data };
        enqueueFrame(JSON.stringify(msg) + "\n");
      },
      end(error) {
        if (ended) return;
        ended = true;
        retire();
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
      },
      onAck(cb) {
        ackCallbacks.add(cb);
      }
    },
    ack(params) {
      if (ended || retired) return;
      const ack = normalizeStreamAck(params);
      if (!ack) return;
      for (const cb of ackCallbacks) cb(ack);
    }
  };
}
function handleNotification(msg, activeStreams) {
  if (msg.method !== "stream_ack") return;
  const streamId = asString9(msg.params?.id);
  if (!streamId) return;
  const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : {};
  activeStreams.get(streamId)?.ack(params);
}
function normalizeStreamAck(params) {
  const eventId = asString9(params.event_id);
  if (!eventId) return null;
  return { event_id: eventId };
}
function asString9(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
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

// src/daemon/wire.ts
var import_node_crypto7 = __toESM(require("crypto"));

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
  const params = asObject6(n.params);
  const threadId = extractThreadId(params);
  const payload = buildNotificationPayload(type, params);
  return { type, threadId, payload, isDelta: type.endsWith("_delta") };
}
function normalizeServerRequest(r) {
  const kind = REQUEST_MAP[r.method] ?? fallbackType(r.method);
  const params = asObject6(r.params);
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
    if (params.command !== void 0) payload.command = params.command;
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
  return { type: kind, threadId, payload, kind, autoApproveTarget: extractAutoApproveTarget(kind, payload) };
}
function buildNotificationPayload(type, params) {
  switch (type) {
    case "turn.started":
    case "turn.completed": {
      const turn = asObject6(params.turn);
      const items = Array.isArray(turn.items) ? turn.items : [];
      if (type === "turn.completed") {
        return {
          turn_id: turn.id ?? null,
          status: normalizeTurnCompletedStatus(turn.status),
          duration_ms: deriveDurationMs(turn),
          items_count: items.length,
          token_usage: deriveTurnTokenUsage(turn),
          ended_at: deriveTurnEndedAt(turn),
          turn_items_included: false
        };
      }
      return {
        turn_id: turn.id ?? null,
        status: turn.status ?? null,
        started_at: asNumber2(turn.startedAt),
        completed_at: asNumber2(turn.completedAt),
        duration_ms: deriveDurationMs(turn),
        item_count: items.length,
        turn
      };
    }
    case "turn.error": {
      const err2 = asObject6(params.error);
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
      const item = asObject6(params.item);
      return {
        item_id: params.itemId ?? item.id ?? null,
        turn_id: params.turnId ?? null,
        type: item.type ?? null,
        status: item.status ?? null
      };
    }
    case "thread.started": {
      const thread = asObject6(params.thread);
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
      const run = asObject6(params.run);
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
  const durationMs = asNumber2(turn.durationMs);
  if (durationMs !== null) return durationMs;
  const startedAt = asNumber2(turn.startedAt);
  const completedAt = asNumber2(turn.completedAt);
  if (startedAt !== null && completedAt !== null) {
    const deltaMs = (completedAt - startedAt) * 1e3;
    if (Number.isFinite(deltaMs)) return Math.max(0, Math.round(deltaMs));
  }
  return null;
}
function deriveTurnEndedAt(turn) {
  return asNumber2(turn.endedAt) ?? asNumber2(turn.completedAt);
}
function normalizeTurnCompletedStatus(value) {
  if (typeof value !== "string") return null;
  if (value === "completed") return "completed";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "errored" || value === "error" || value === "failed") return "errored";
  return null;
}
function deriveTurnTokenUsage(turn) {
  const usageSource = turn.tokenUsage ?? turn.token_usage ?? turn.usage;
  const usage = asObject6(usageSource);
  const prompt = asNumber2(usage.prompt) ?? asNumber2(usage.promptTokens) ?? asNumber2(usage.prompt_tokens) ?? asNumber2(usage.input) ?? asNumber2(usage.inputTokens) ?? asNumber2(usage.input_tokens);
  const completion = asNumber2(usage.completion) ?? asNumber2(usage.completionTokens) ?? asNumber2(usage.completion_tokens) ?? asNumber2(usage.output) ?? asNumber2(usage.outputTokens) ?? asNumber2(usage.output_tokens);
  const total = asNumber2(usage.total) ?? asNumber2(usage.totalTokens) ?? asNumber2(usage.total_tokens);
  return { prompt, completion, total };
}
function fallbackType(method) {
  return method.replace(/\//g, ".").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function extractAutoApproveTarget(kind, payload) {
  switch (kind) {
    case "approval.command_execution":
      return asString10(payload.command);
    case "approval.permissions":
      return asString10(payload.command) ?? asString10(payload.reason);
    case "approval.file_change":
      return asString10(payload.reason) ?? asString10(payload.grant_root);
    case "approval.mcp_elicitation":
      return asString10(payload.url) ?? asString10(payload.message) ?? asString10(payload.server_name);
    default:
      return null;
  }
}
function asString10(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function asObject6(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}
function asNumber2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function extractThreadId(params) {
  if (typeof params.threadId === "string") return params.threadId;
  const thread = asObject6(params.thread);
  return typeof thread.id === "string" ? thread.id : null;
}

// src/daemon/wire.ts
function wireDaemonEvents(ctx) {
  ctx.pool.on("notification", (e) => {
    void handleNotification2(ctx, e).catch((err2) => {
      logger.warn("notification handling failed", { err: err2.message });
    });
  });
  ctx.pool.on("server_request", (e) => {
    void handleServerRequest(ctx, e).catch((err2) => {
      logger.warn("server request handling failed", { err: err2.message });
    });
  });
  ctx.pool.on("client_close", (e) => {
    void handleClientClose(ctx, e).catch((err2) => {
      logger.warn("client close handling failed", { err: err2.message });
    });
  });
}
async function handleNotification2(ctx, e) {
  const norm = normalizeNotification(e.notification);
  const sessionName = resolveSession(ctx, e.user, norm.threadId);
  const rec = sessionName ? ctx.sessions.get(e.user, sessionName) : null;
  const logged = await ctx.events.append(e.user, {
    type: norm.type,
    session: sessionName,
    thread_id: norm.threadId,
    payload: norm.payload
  });
  if (norm.type === "turn.started" && sessionName && rec) {
    const turnId = norm.payload.turn_id ?? null;
    ctx.queues.setCurrentTurn(keyFor3(e.user, sessionName), turnId);
    ctx.sessions.update(e.user, sessionName, {
      state: "live",
      crash_reason: null,
      last_turn_id: turnId,
      current_turn_id: turnId,
      current_turn_started_at: isoFromUnixSeconds(norm.payload.started_at, logged.ts),
      current_item_type: null,
      items_in_turn: 0
    });
  }
  if (norm.type === "item.started" && sessionName && rec) {
    ctx.sessions.update(e.user, sessionName, {
      current_item_type: norm.payload.type ?? null,
      last_turn_id: norm.payload.turn_id ?? rec.last_turn_id ?? null
    });
  }
  if (norm.type === "item.completed" && sessionName && rec) {
    ctx.sessions.update(e.user, sessionName, {
      current_item_type: null,
      items_in_turn: (rec.items_in_turn ?? 0) + 1,
      last_turn_id: norm.payload.turn_id ?? rec.last_turn_id ?? null
    });
  }
  if (norm.type === "thread.token_usage_updated" && sessionName && rec) {
    const tokenUsage = normalizeTokenUsage(norm.payload.token_usage);
    if (tokenUsage) {
      ctx.sessions.update(e.user, sessionName, {
        token_usage_last_turn: tokenUsage,
        last_turn_id: norm.payload.turn_id ?? rec.last_turn_id ?? null
      });
    }
  }
  if (norm.type === "turn.error" && sessionName && rec) {
    const turnId = norm.payload.turn_id ?? rec.last_turn_id ?? null;
    const willRetry = Boolean(norm.payload.will_retry);
    ctx.sessions.update(e.user, sessionName, {
      last_turn_id: turnId,
      current_turn_id: willRetry ? rec.current_turn_id ?? turnId : null,
      current_turn_started_at: willRetry ? rec.current_turn_started_at ?? null : null,
      current_item_type: null,
      items_in_turn: willRetry ? rec.items_in_turn ?? 0 : 0
    });
    const client = ctx.pool.clientForSession(keyFor3(e.user, sessionName));
    void ctx.queues.onTurnErrored(
      keyFor3(e.user, sessionName),
      turnId,
      { willRetry },
      client,
      norm.threadId ?? rec.thread_id,
      ctx.retryOptions()
    ).then(async (next) => {
      await appendQueueDrainEvents(ctx, e.user, sessionName, norm.threadId ?? rec.thread_id, next, false);
    }).catch((err2) => {
      logger.warn("turn error queue drain failed", {
        session: sessionName,
        err: err2.message
      });
    });
  }
  if (norm.type === "turn.completed" && sessionName && norm.threadId) {
    const threadId = norm.threadId;
    if (rec) {
      ctx.sessions.update(e.user, sessionName, {
        last_turn_id: norm.payload.turn_id ?? rec.last_turn_id ?? null,
        current_turn_id: null,
        current_turn_started_at: null,
        current_item_type: null,
        items_in_turn: 0,
        turn_count: (rec.turn_count ?? 0) + 1
      });
    }
    const client = ctx.pool.clientForSession(keyFor3(e.user, sessionName));
    void ctx.queues.onTurnCompleted(keyFor3(e.user, sessionName), client, threadId, ctx.retryOptions()).then(async (next) => {
      await appendQueueDrainEvents(ctx, e.user, sessionName, threadId, next, true);
    }).catch((err2) => {
      logger.warn("turn completion queue drain failed", {
        session: sessionName,
        err: err2.message
      });
    });
  }
  if (norm.type === "thread.closed" && sessionName) {
    try {
      await closeSession(ctx, e.user, sessionName, "user_detach", false);
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
        const removed = ctx.pending.removeByJsonrpcId(client, jsonrpcId);
        if (removed?.session_name) {
          adjustPendingCounts(ctx, removed.user, removed.session_name, removed.kind, -1);
        }
      } else {
        logger.warn("ignoring server_request_resolved for unknown client", {
          user: e.user,
          client_id: e.clientId,
          jsonrpc_id: jsonrpcId
        });
      }
    }
  }
  if (norm.type === "client_close" && sessionName && norm.threadId) {
    if (isSessionIdle(ctx, e.user, sessionName)) {
      try {
        await closeSession(ctx, e.user, sessionName, "idle_unload", true);
      } catch (err2) {
        logger.warn("idle unload cleanup failed", { session: sessionName, err: err2.message });
      }
    }
  }
}
async function handleServerRequest(ctx, e) {
  const norm = normalizeServerRequest(e.request);
  const sessionName = resolveSession(ctx, e.user, norm.threadId);
  if (!sessionName) {
    e.respondError(-32e3, "session detached");
    return;
  }
  const rec = ctx.sessions.get(e.user, sessionName);
  if (!rec || rec.state !== "live" || rec.thread_id !== norm.threadId) {
    e.respondError(-32e3, "session torn down");
    return;
  }
  if (ctx.queues.isTeardown(keyFor3(e.user, sessionName))) {
    e.respondError(-32e3, "session torn down");
    return;
  }
  const effectiveClient = ctx.pool.clientById(e.clientId);
  if (!effectiveClient) {
    logger.warn("server_request: no client to track", { user: e.user, kind: norm.kind });
    e.respondError(-32e3, "no client available");
    return;
  }
  if (await maybeAutoApproveRequest(ctx, e.user, sessionName, norm, effectiveClient, e.request.id)) {
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
  adjustPendingCounts(ctx, e.user, sessionName, norm.kind, 1);
  await ctx.events.append(e.user, {
    type: norm.type,
    session: sessionName,
    thread_id: norm.threadId,
    payload
  });
}
async function handleClientClose(ctx, e) {
  if (e.reason !== "unexpected") return;
  for (const sessionKey of e.sessions) {
    const [user, sessionName] = parseKey(sessionKey);
    if (!user || !sessionName) continue;
    const rec = ctx.sessions.get(user, sessionName);
    if (!rec) continue;
    const currentTurnId = rec.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey);
    const reason = `app-server process exited unexpectedly (exit_code=${e.exitCode ?? "null"})`;
    ctx.sessions.update(user, sessionName, {
      state: "crashed",
      recovery_state: "degraded",
      crash_reason: reason,
      pending_approvals: 0,
      pending_user_inputs: 0,
      current_item_type: null
    });
    await appendSessionCrashed(ctx, user, rec.name, rec.thread_id, reason, currentTurnId ?? rec.last_turn_id ?? null);
    if (currentTurnId) {
      await ctx.events.append(user, {
        type: "turn.error",
        session: sessionName,
        thread_id: rec.thread_id,
        payload: {
          turn_id: currentTurnId,
          will_retry: false,
          error: {
            message: "app-server process exited unexpectedly",
            codex_error_info: "internal_server_error",
            additional_details: `exit_code=${e.exitCode ?? "null"}`
          }
        }
      });
    }
    await cancelPendingWithEvent(ctx, user, sessionName, rec.thread_id, "session_crashed");
    await appendSessionClosed2(ctx, user, rec.name, rec.thread_id, "app_server_crashed");
    ctx.queues.onClientClosed(sessionKey);
  }
}
function resolveSession(ctx, user, threadId) {
  if (!threadId) return null;
  const rec = ctx.sessions.get(user, threadId);
  return rec ? rec.name : null;
}
async function maybeAutoApproveRequest(ctx, user, sessionName, norm, client, jsonrpcId) {
  if (!norm.kind.startsWith("approval.")) return false;
  const rec = ctx.sessions.get(user, sessionName);
  const patterns = rec?.autoApprovePatterns ?? [];
  if (patterns.length === 0) return false;
  const shortcut = preferredAutoApprovalShortcut(norm.kind);
  if (!shortcut) return false;
  const match = matchAutoApprovePattern(patterns, norm.autoApproveTarget);
  if (!match) return false;
  const requestId = `req-${import_node_crypto7.default.randomBytes(4).toString("hex")}`;
  const response = buildApprovalShortcutResponse(norm.kind, norm.payload.raw, shortcut);
  let ack;
  try {
    ack = await client.respondAck(jsonrpcId, response);
  } catch (err2) {
    await emitWarning(ctx, user, sessionName, norm.threadId, {
      message: `auto-approval reply delivery failed: ${err2.message}`,
      kind: "auto_approval_reply_delivery_failed",
      request_id: requestId
    });
    return false;
  }
  await ctx.events.append(user, {
    type: AUTO_APPROVED_EVENT_TYPE,
    session: sessionName,
    thread_id: norm.threadId,
    payload: {
      request_id: requestId,
      kind: norm.kind,
      matched_pattern: match.matchedPattern,
      command_preview: match.commandPreview,
      decision: shortcut
    }
  }).catch(() => void 0);
  if (ack.backpressured) {
    await emitWarning(ctx, user, sessionName, norm.threadId, {
      message: "auto-approval reply is delayed by app-server stdin backpressure",
      kind: "auto_approval_reply_backpressured",
      request_id: requestId
    });
  }
  return true;
}
async function emitWarning(ctx, user, session, threadId, payload) {
  await ctx.events.append(user, {
    type: "warning",
    session,
    thread_id: threadId,
    payload
  }).catch(() => void 0);
}
function keyFor3(user, name) {
  return `${user}::${name}`;
}
function parseKey(sessionKey) {
  const idx = sessionKey.indexOf("::");
  if (idx < 0) return [null, null];
  return [sessionKey.slice(0, idx), sessionKey.slice(idx + 2)];
}
function adjustPendingCounts(ctx, user, sessionName, kind, delta) {
  const rec = ctx.sessions.get(user, sessionName);
  if (!rec) return;
  if (kind.startsWith("approval.")) {
    ctx.sessions.update(user, sessionName, {
      pending_approvals: Math.max(0, (rec.pending_approvals ?? 0) + delta)
    });
    return;
  }
  if (kind === "user_input.request") {
    ctx.sessions.update(user, sessionName, {
      pending_user_inputs: Math.max(0, (rec.pending_user_inputs ?? 0) + delta)
    });
  }
}
function isSessionIdle(ctx, user, sessionName) {
  const sessionKey = keyFor3(user, sessionName);
  const rec = ctx.sessions.get(user, sessionName);
  return Boolean(rec) && (rec?.state ?? "live") === "live" && (rec?.current_turn_id ?? ctx.queues.getCurrentTurn(sessionKey)) === null && ctx.queues.depth(sessionKey) === 0 && (rec?.pending_approvals ?? 0) === 0 && (rec?.pending_user_inputs ?? 0) === 0;
}
async function closeSession(ctx, user, sessionName, reason, unsubscribe) {
  const rec = ctx.sessions.get(user, sessionName);
  if (!rec) return;
  const sessionKey = keyFor3(user, sessionName);
  ctx.queues.markTeardown(sessionKey);
  const client = ctx.pool.clientForSession(sessionKey);
  if (unsubscribe && client) {
    try {
      await threadUnsubscribe(client, rec.thread_id, ctx.retryOptions());
    } catch {
    }
  }
  ctx.pool.release(sessionKey);
  await cancelPendingWithEvent(ctx, user, sessionName, rec.thread_id, reason);
  ctx.sessions.remove(user, sessionName);
  ctx.queues.finalDispose(sessionKey);
  await appendSessionClosed2(ctx, user, rec.name, rec.thread_id, reason);
}
async function appendQueueDrainEvents(ctx, user, sessionName, threadId, result, emitQueuedStarted) {
  for (const dropped of result.dropped) {
    logger.warn("dropping queued turn after repeated dispatch failures", {
      session: sessionName,
      queue_id: dropped.queue_id,
      err: dropped.error_message,
      failure_count: dropped.failure_count
    });
    await ctx.events.append(user, {
      type: "turn.queued_dropped",
      session: sessionName,
      thread_id: threadId,
      payload: {
        queue_id: dropped.queue_id,
        error: {
          message: dropped.error_message
        },
        failure_count: dropped.failure_count
      }
    });
  }
  if (result.turn_id && emitQueuedStarted) {
    logger.debug("drained queued turn", { session: sessionName, turn_id: result.turn_id, queue_id: result.queue_id });
    await ctx.events.append(user, {
      type: "turn.queued_started",
      session: sessionName,
      thread_id: threadId,
      payload: {
        turn_id: result.turn_id,
        queue_id: result.queue_id
      }
    });
    return;
  }
  if (result.failed && result.queue_id) {
    logger.warn("queued turn remains enqueued after dispatch failure", {
      session: sessionName,
      queue_id: result.queue_id,
      err: result.error_message
    });
    await ctx.events.append(user, {
      type: "turn.queued_failed",
      session: sessionName,
      thread_id: threadId,
      payload: {
        queue_id: result.queue_id,
        error: {
          message: result.error_message
        }
      }
    });
  }
}
async function appendSessionClosed2(ctx, user, session, threadId, reason) {
  await ctx.events.append(user, {
    type: SESSION_CLOSED_EVENT_TYPE,
    session,
    thread_id: threadId,
    payload: {
      session,
      thread_id: threadId,
      reason,
      ts: (/* @__PURE__ */ new Date()).toISOString()
    }
  });
}
async function appendSessionCrashed(ctx, user, session, threadId, reason, lastTurnId) {
  await ctx.events.append(user, {
    type: SESSION_CRASHED_EVENT_TYPE,
    session,
    thread_id: threadId,
    payload: {
      session,
      thread_id: threadId,
      reason,
      last_turn_id: lastTurnId
    }
  });
}

// src/daemon/run.ts
var APP_SERVER_CRASHED_ON_RESTART_REASON = "app_server_crashed_on_restart";
var DAEMON_STDERR_PATH_ENV = "CODEX_TEAM_DAEMON_STDERR_PATH";
async function runDaemon() {
  const config = new ConfigStore();
  const ctx = buildContext({
    config,
    cursors: new CursorStore(config.resolvedDataDir())
  });
  const socketBindPreflight = await probeSocketBind(ctx.sockPath);
  if (!socketBindPreflight.ok) {
    writeSocketBindPreflightFailure(socketBindPreflight.error, socketBindPreflight.probedPath);
    return 1;
  }
  warnLegacyWindowsDataDir((warning) => {
    logger.warn(warning.message);
  });
  const pidPath = pidFilePath(ctx.dataDir);
  const acquired = await acquireDaemonOwnership(ctx.sockPath, pidPath);
  if (!acquired.ok) {
    logger.info(acquired.message, acquired.details);
    return 1;
  }
  await reapOrphans(ctx.dataDir);
  await reconcileLoadedSessionsAfterRestart(ctx);
  const cleanup = () => {
    unlinkSockIfStale(ctx.sockPath);
    try {
      import_node_fs18.default.unlinkSync(pidPath);
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
      import_node_fs18.default.unlinkSync(pidPath);
    } catch {
    }
    throw translateBootstrapError(e, ctx.sockPath);
  }
  scheduleIdleShutdown(ctx);
  return await new Promise(() => {
  });
}
async function reconcileLoadedSessionsAfterRestart(ctx) {
  if (!ctx.users || typeof ctx.users.list !== "function") return;
  if (!ctx.sessions || typeof ctx.sessions.listLive !== "function" || typeof ctx.sessions.update !== "function") return;
  if (!ctx.pool || typeof ctx.pool.clientForSession !== "function") return;
  if (!ctx.events || typeof ctx.events.append !== "function") return;
  for (const user of ctx.users.list()) {
    for (const rec of ctx.sessions.listLive(user.token)) {
      if (rec.state !== "live") continue;
      const sessionKey = keyFor4(user.token, rec.name);
      if (isClientAlive3(ctx.pool.clientForSession(sessionKey))) continue;
      const hadPersistedPending = (rec.pending_approvals ?? 0) > 0 || (rec.pending_user_inputs ?? 0) > 0;
      const hadPendingMetadata = pendingRequestsForSession(
        ctx,
        user.token,
        rec.name
      ).length > 0;
      const lastTurnId = rec.current_turn_id ?? rec.last_turn_id ?? null;
      ctx.sessions.update(user.token, rec.name, {
        state: "crashed",
        recovery_state: "degraded",
        crash_reason: APP_SERVER_CRASHED_ON_RESTART_REASON,
        last_turn_id: lastTurnId,
        current_turn_id: null,
        current_turn_started_at: null,
        current_item_type: null,
        items_in_turn: 0,
        pending_approvals: 0,
        pending_user_inputs: 0
      });
      await ctx.events.append(user.token, {
        type: SESSION_CRASHED_EVENT_TYPE,
        session: rec.name,
        thread_id: rec.thread_id,
        payload: {
          session: rec.name,
          thread_id: rec.thread_id,
          reason: APP_SERVER_CRASHED_ON_RESTART_REASON,
          last_turn_id: lastTurnId
        }
      });
      await cancelPendingWithEvent(
        ctx,
        user.token,
        rec.name,
        rec.thread_id,
        APP_SERVER_CRASHED_ON_RESTART_REASON
      );
      if (hadPersistedPending && !hadPendingMetadata) {
        await ctx.events.append(user.token, {
          type: SESSION_PENDING_DROPPED_EVENT_TYPE,
          session: rec.name,
          thread_id: rec.thread_id,
          payload: {
            session: rec.name,
            thread_id: rec.thread_id,
            reason: "daemon_restart_pending_lost"
          }
        });
      }
    }
  }
}
function acquirePid(pidPath) {
  try {
    import_node_fs18.default.mkdirSync(import_node_path17.default.dirname(pidPath), { recursive: true });
    const fd = import_node_fs18.default.openSync(pidPath, "wx");
    try {
      import_node_fs18.default.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        created_at: (/* @__PURE__ */ new Date()).toISOString()
      }));
    } finally {
      import_node_fs18.default.closeSync(fd);
    }
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    return false;
  }
}
function isClientAlive3(client) {
  if (!client) return false;
  const maybe = client;
  if (typeof maybe.isAlive === "function") return maybe.isAlive();
  return true;
}
function keyFor4(user, sessionName) {
  return `${user}::${sessionName}`;
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
    const pidRecord = readPidFile3(pidPath);
    const pid = pidRecord?.pid ?? null;
    const pidAlive = pid !== null && isDaemonPidAlive(pid);
    const legacyPidRecord = legacyPidPath ? readPidFile3(legacyPidPath) : null;
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
      await sleep5(150);
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
      await sleep5(150);
      continue;
    }
    if (pid !== null && !pidAlive) {
      try {
        import_node_fs18.default.unlinkSync(pidPath);
      } catch {
      }
    }
    if (legacyPidPath && legacyPid !== null && !legacyPidAlive) {
      try {
        import_node_fs18.default.unlinkSync(legacyPidPath);
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
    await sleep5(150);
  }
}
function readPidFile3(pidPath) {
  try {
    const raw = import_node_fs18.default.readFileSync(pidPath, "utf8");
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
  const legacyPath = import_node_path17.default.join(legacyHome, `.${APP}`, "daemon.pid");
  if (legacyPath === currentPidPath) return null;
  if (legacyHome === homeDir()) return null;
  return legacyPath;
}
function sleep5(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
function translateBootstrapError(error, sockPath) {
  if (error instanceof CodexTeamError) return error;
  const err2 = error;
  if (err2?.code === "EPERM" || err2?.code === "EACCES") {
    return new CodexTeamError(
      "socket_bind_denied",
      `local Unix socket bind denied by environment (error: ${err2.code}). codex-team requires socket bind for daemon IPC - likely running in a restricted sandbox.`,
      {
        error: err2.code,
        sock_path: sockPath,
        suggested_action: "run `codex-team doctor` to diagnose"
      }
    );
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}
function writeSocketBindPreflightFailure(error, probedPath) {
  const line = JSON.stringify(buildSocketBindPreflightPayload(error, probedPath)) + "\n";
  const stderrPath = process.env[DAEMON_STDERR_PATH_ENV];
  if (stderrPath) {
    try {
      import_node_fs18.default.mkdirSync(import_node_path17.default.dirname(stderrPath), { recursive: true });
      import_node_fs18.default.appendFileSync(stderrPath, line, "utf8");
      return;
    } catch {
    }
  }
  if (typeof process.stderr.fd === "number") {
    try {
      import_node_fs18.default.writeSync(process.stderr.fd, line);
      return;
    } catch {
    }
  }
  process.stderr.write(line);
}
function buildSocketBindPreflightPayload(error, probedPath) {
  const errno = error?.code ?? "UNKNOWN";
  if (errno === "EPERM" || errno === "EACCES") {
    return {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level: "error",
      msg: "socket bind denied",
      kind: "socket_bind_denied",
      errno,
      probed_path: probedPath
    };
  }
  return {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level: "error",
    msg: error?.message ?? "socket bind probe failed",
    kind: "socket_bind_error",
    errno,
    probed_path: probedPath
  };
}

// src/main.ts
var DAEMON_STDERR_PATH_ENV2 = "CODEX_TEAM_DAEMON_STDERR_PATH";
async function main() {
  const argv = process.argv.slice(2);
  const hasDaemonInternal = argv.includes("--daemon-internal");
  const stderrPath = hasDaemonInternal ? takeOptionValue(argv, "--stderr-to") : null;
  const daemonIdx = argv.indexOf("--daemon-internal");
  if (daemonIdx >= 0) {
    argv.splice(daemonIdx, 1);
    if (stderrPath) {
      process.env[DAEMON_STDERR_PATH_ENV2] = stderrPath;
      redirectProcessStderr(stderrPath);
    } else {
      delete process.env[DAEMON_STDERR_PATH_ENV2];
    }
    const code2 = await runDaemonWithBootstrapReporting();
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
async function runDaemonWithBootstrapReporting() {
  try {
    return await runDaemon();
  } catch (e) {
    writeDaemonBootstrapError(e);
    return 1;
  }
}
function writeDaemonBootstrapError(error) {
  const payload = error instanceof CodexTeamError ? { code: error.code, message: error.message, ...error.data !== void 0 ? { data: error.data } : {} } : {
    code: "internal",
    message: error instanceof Error ? error.message : String(error)
  };
  process.stderr.write(`[codex-team-daemon-bootstrap] ${JSON.stringify(payload)}
`);
}
function takeOptionValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  argv.splice(idx, 2);
  return value;
}
function redirectProcessStderr(stderrPath) {
  import_node_fs19.default.mkdirSync(import_node_path18.default.dirname(stderrPath), { recursive: true });
  const stream = import_node_fs19.default.createWriteStream(stderrPath, { flags: "a" });
  stream.on("error", () => void 0);
  const write = stream.write.bind(stream);
  process.stderr.write = ((chunk, encoding, cb) => {
    if (typeof encoding === "function") return write(chunk, encoding);
    if (typeof encoding === "string") {
      return typeof cb === "function" ? write(chunk, encoding, cb) : write(chunk, encoding);
    }
    if (typeof cb === "function") return write(chunk, cb);
    return write(chunk);
  });
  process.on("exit", () => stream.end());
}
