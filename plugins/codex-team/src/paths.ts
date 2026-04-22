import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const APP = "codex-team";
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const UNIX_SOCKET_MAX_BYTES = 90;

export function homeDir(): string {
  if (process.platform === "win32") return os.homedir() || process.env.USERPROFILE || process.env.HOME || "\\";
  return process.env.HOME || os.homedir() || "/";
}

export function defaultDataDir(): string {
  const configured = process.env.CODEX_TEAM_DATA_DIR;
  if (configured) return expandUserPath(configured);
  return path.join(homeDir(), `.${APP}`);
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

export function isNamedPipePath(sockPath: string): boolean {
  return /^\\\\\.\\pipe[\\/]/i.test(sockPath);
}

export function isFilesystemSockPath(sockPath: string, platform = process.platform): boolean {
  return !isNamedPipePath(normalizeSockPath(sockPath, platform));
}

export function expandUserPath(input: string, platform = process.platform, home = homeDir()): string {
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

function namedPipePath(seed: string): string {
  return `${WINDOWS_PIPE_PREFIX}${APP}-${pathHash(seed)}`;
}

function pathHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}
