import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP = "codex-team";
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const UNIX_SOCKET_MAX_BYTES = 90;

export function homeDir(): string {
  if (process.platform === "win32") {
    const nativeHome = os.homedir();
    if (nativeHome) return nativeHome;
    if (process.env.USERPROFILE) return process.env.USERPROFILE;
    if (process.env.HOMEDRIVE && process.env.HOMEPATH) return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`;
    if (process.env.HOME) return process.env.HOME;
    return "\\";
  }
  return process.env.HOME || os.homedir() || "/";
}

export function defaultDataDir(): string {
  const configured = process.env.CODEX_TEAM_DATA_DIR;
  if (configured) return expandUserPath(configured);
  return path.join(homeDir(), `.${APP}`);
}

export function clientOnlyDaemonSock(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const configured = env.CODEX_TEAM_DAEMON_SOCK?.trim();
  if (!configured) return null;
  return normalizeSockPath(expandUserPath(configured, platform), platform);
}

export function defaultSockPath(dataDir = defaultDataDir(), platform = process.platform): string {
  const configured = process.env.CODEX_TEAM_SOCK;
  if (configured) return normalizeSockPath(expandUserPath(configured, platform), platform);
  const resolvedDataDir = expandUserPath(dataDir, platform);
  if (platform === "win32") return namedPipePath(resolvedDataDir);
  const candidate = path.join(resolvedDataDir, "daemon.sock");
  if (Buffer.byteLength(candidate, "utf8") <= UNIX_SOCKET_MAX_BYTES) return candidate;
  return path.join(os.tmpdir(), `${APP}-${pathHash(resolvedDataDir)}.sock`);
}

export function defaultLogPath(dataDir = defaultDataDir()): string {
  return path.join(expandUserPath(dataDir), "daemon.log");
}

export function configFilePath(dataDir = defaultDataDir()): string {
  return path.join(expandUserPath(dataDir), "config.json");
}

export function pidFilePath(dataDir = defaultDataDir()): string {
  return path.join(expandUserPath(dataDir), "daemon.pid");
}

export function usersDir(dataDir = defaultDataDir()): string {
  return path.join(expandUserPath(dataDir), "users");
}

export function userDir(token: string, dataDir = defaultDataDir()): string {
  return path.join(usersDir(dataDir), encodeToken(token));
}

export function userMetadataPath(token: string, dataDir = defaultDataDir()): string {
  return path.join(userDir(token, dataDir), "metadata.json");
}

export function userEventLogPath(token: string, dataDir = defaultDataDir()): string {
  return path.join(userDir(token, dataDir), "events.log");
}

export function userSessionsPath(token: string, dataDir = defaultDataDir()): string {
  return path.join(userDir(token, dataDir), "sessions.json");
}

export function normalizeSockPath(sockPath: string, platform = process.platform): string {
  if (platform !== "win32") return sockPath;
  if (isNamedPipePath(sockPath)) return sockPath.replace(/\//g, "\\");
  return namedPipePath(sockPath);
}

export function formatPathForEnvHint(targetPath: string, platform = process.platform, home = homeDir()): string {
  if (platform !== "win32" && home && targetPath === home) return "$HOME";
  if (platform !== "win32" && home && targetPath.startsWith(`${home}/`)) {
    return `$HOME/${targetPath.slice(home.length + 1)}`;
  }
  return targetPath;
}

export function isNamedPipePath(sockPath: string): boolean {
  return /^\\\\\.\\pipe[\\/]/i.test(sockPath);
}

export function isFilesystemSockPath(sockPath: string, platform = process.platform): boolean {
  return !isNamedPipePath(normalizeSockPath(sockPath, platform));
}

export function expandUserPath(input: string, platform = process.platform, home = homeDir()): string {
  if (/^~[^\\/]/.test(input)) {
    throw new Error(`unsupported user-home path '${input}'; only '~' is supported`);
  }
  if (input !== "~" && !input.startsWith("~/") && !input.startsWith("~\\")) return input;
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const suffix = input === "~" ? "" : input.slice(1).replace(/^[\\/]+/, "");
  return suffix.length > 0 ? pathModule.join(home, suffix) : home;
}

export function encodeToken(token: string): string {
  return Buffer.from(token, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeToken(encoded: string): string {
  const pad = encoded.length % 4 === 0 ? "" : "=".repeat(4 - (encoded.length % 4));
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

interface LegacyWindowsDataDirWarning {
  legacyPath: string;
  newPath: string;
  message: string;
}

let legacyWindowsDataDirWarned = false;

export function warnLegacyWindowsDataDir(
  emit: (warning: LegacyWindowsDataDirWarning) => void,
  opts: {
    platform?: NodeJS.Platform;
    legacyHome?: string | null;
    nativeHome?: string;
    dataDirOverride?: string | undefined;
    exists?: (target: string) => boolean;
  } = {},
): LegacyWindowsDataDirWarning | null {
  if (legacyWindowsDataDirWarned) return null;
  const warning = getLegacyWindowsDataDirWarning(opts);
  if (!warning) return null;
  legacyWindowsDataDirWarned = true;
  emit(warning);
  return warning;
}

function namedPipePath(seed: string): string {
  return `${WINDOWS_PIPE_PREFIX}${APP}-${pathHash(seed)}`;
}

function pathHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function getLegacyWindowsDataDirWarning(opts: {
  platform?: NodeJS.Platform;
  legacyHome?: string | null;
  nativeHome?: string;
  dataDirOverride?: string | undefined;
  exists?: (target: string) => boolean;
}): LegacyWindowsDataDirWarning | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return null;
  if ((opts.dataDirOverride ?? process.env.CODEX_TEAM_DATA_DIR)?.trim()) return null;

  const legacyHome = (opts.legacyHome ?? process.env.HOME ?? "").trim();
  if (!legacyHome) return null;

  const nativeHome = opts.nativeHome ?? homeDir();
  if (!nativeHome || nativeHome === legacyHome) return null;

  const exists = opts.exists ?? fs.existsSync;
  const legacyPath = path.join(legacyHome, `.${APP}`);
  const newPath = path.join(nativeHome, `.${APP}`);
  if (!exists(legacyPath) || exists(newPath)) return null;

  return {
    legacyPath,
    newPath,
    message: `warning: Windows legacy HOME data dir '${legacyPath}' exists but new default '${newPath}' does not; move it manually to keep codex-team state.`,
  };
}

export const __private__ = {
  clientOnlyDaemonSock,
  formatPathForEnvHint,
  getLegacyWindowsDataDirWarning,
  resetLegacyWindowsDataDirWarning(): void {
    legacyWindowsDataDirWarned = false;
  },
};
