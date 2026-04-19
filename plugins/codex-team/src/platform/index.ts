export { currentPlatform, isLinux, isMacOS, isWindows } from "./os";
export type { Platform } from "./os";
export {
  alarmsDir,
  clientEnvFile,
  clientsDir,
  resolveConfigDir,
  resolveDataDir,
  resolveLogPath,
  resolvePidPath,
  resolveRegistryPath,
  resolveRuntimeDir,
  sessionDir,
  workspaceAlarmsDir,
  workspaceEnvFile,
} from "./paths";
export {
  ipcAddressForConfig,
  ipcAddressFromPath,
  ipcArtifactExists,
  ipcConnect,
  ipcListen,
  ipcReady,
  removeStaleIpcArtifact,
} from "./ipc";
export type { IpcAddress } from "./ipc";
export { isPidAlive, killProcessTree, spawnManaged } from "./process";
export type { ManagedChild, ManagedSpawnOptions } from "./process";
export { whichExecutable } from "./which";
export { readFallbackClientEnv, removeFallbackClientEnv, writeHookEnvExports } from "./env";
export type { HookEnvEntries } from "./env";
export { installShutdownSignalHandlers } from "./signals";
