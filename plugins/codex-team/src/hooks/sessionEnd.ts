import { sendRequest } from "../cli";
import { loadConfig, resolveSocketPath } from "../config";
import { readFallbackClientEnv, removeFallbackClientEnv } from "../platform";
import { resolveWorkspace, validateWorkspace } from "../workspace";
import { projectDirFromHook, readStdinJson, sessionIdFromHook } from "./common";

export async function runSessionEndHook(): Promise<number> {
  let projectDir = "";
  try {
    const input = await readStdinJson();
    projectDir = projectDirFromHook(input);
    const fallback = readFallbackClientEnv(projectDir);
    const workspace = validateWorkspace(
      process.env.CODEX_TEAM_WORKSPACE ||
        fallback.CODEX_TEAM_WORKSPACE ||
        resolveWorkspace({ projectDir }),
    );
    const clientId = process.env.CODEX_TEAM_CLIENT_ID || fallback.CODEX_TEAM_CLIENT_ID || "";
    const sessionId = sessionIdFromHook(input) || fallback.CODEX_TEAM_SESSION_ID || "";
    const socketPath = resolveSocketPath(loadConfig());

    if (clientId) {
      await sendRequest(
        socketPath,
        "client.detach",
        { clientId },
        { workspace, clientId, allWorkspaces: false },
      ).catch(() => undefined);
    } else if (sessionId) {
      await sendRequest(
        socketPath,
        "client.detach",
        { sessionId },
        { workspace, clientId: null, allWorkspaces: false },
      ).catch(() => undefined);
    }
  } catch (error) {
    process.stderr.write(`codex-team hook session-end: ${(error as Error).message}\n`);
  } finally {
    removeFallbackClientEnv(projectDir || process.env.CODEX_TEAM_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || null);
  }
  return 0;
}
