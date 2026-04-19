import os from "node:os";

import { CliClient, sendRequest } from "../cli";
import { readFallbackClientEnv, writeHookEnvExports } from "../platform";
import { makeClientId, resolveWorkspace, validateWorkspace } from "../workspace";
import { maybePinWorkspace, projectDirFromHook, readStdinJson, sessionIdFromHook } from "./common";

export async function runSessionStartHook(): Promise<number> {
  try {
    const input = await readStdinJson();
    const projectDir = projectDirFromHook(input);
    const fallback = readFallbackClientEnv(projectDir);
    const workspace = validateWorkspace(
      process.env.CODEX_TEAM_WORKSPACE ||
        fallback.CODEX_TEAM_WORKSPACE ||
        resolveWorkspace({ projectDir }),
    );
    const sessionId = sessionIdFromHook(input);
    const clientId =
      process.env.CODEX_TEAM_CLIENT_ID ||
      makeClientId({
        workspace,
        sessionId,
        hostname: os.hostname(),
        pid: null,
        startedAtMs: Date.now(),
      });

    process.env.CODEX_TEAM_WORKSPACE = workspace;
    process.env.CODEX_TEAM_CLIENT_ID = clientId;
    process.env.CODEX_TEAM_SESSION_ID = sessionId;
    process.env.CODEX_TEAM_PROJECT_DIR = projectDir;

    maybePinWorkspace(projectDir, workspace);
    writeHookEnvExports(
      {
        CODEX_TEAM_WORKSPACE: workspace,
        CODEX_TEAM_CLIENT_ID: clientId,
        CODEX_TEAM_SESSION_ID: sessionId,
        CODEX_TEAM_PROJECT_DIR: projectDir,
      },
      projectDir || null,
    );

    const cli = new CliClient();
    await cli.ensureDaemon();
    await sendRequest(
      cli.socketPath,
      "client.register",
      {
        clientId,
        sessionId,
        hostname: os.hostname(),
        pid: null,
        claudeProjectDir: projectDir,
        startedAt: new Date().toISOString(),
      },
      { workspace, clientId, allWorkspaces: false },
    );
  } catch (error) {
    process.stderr.write(`codex-team hook session-start: ${(error as Error).message}\n`);
  }
  return 0;
}
