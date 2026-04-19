export const isWindows = process.platform === "win32";
export const isMacOS = process.platform === "darwin";
export const isLinux = process.platform === "linux";

export type Platform = "windows" | "macos" | "linux" | "unknown";

export function currentPlatform(): Platform {
  if (isWindows) {
    return "windows";
  }
  if (isMacOS) {
    return "macos";
  }
  if (isLinux) {
    return "linux";
  }
  return "unknown";
}
