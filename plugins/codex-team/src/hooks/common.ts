import fs from "node:fs";
import path from "node:path";

import { workspaceEnvFile } from "../platform";
import { validateWorkspace } from "../workspace";

export async function readStdinJson(): Promise<Record<string, unknown>> {
  const body = await new Promise<string>((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
  if (!body.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function projectDirFromHook(input: Record<string, unknown>): string {
  const workspace = typeof input.workspace === "object" && input.workspace !== null
    ? (input.workspace as Record<string, unknown>)
    : {};
  return String(
    process.env.CLAUDE_PROJECT_DIR ||
      input.cwd ||
      workspace.current_dir ||
      process.env.CODEX_TEAM_PROJECT_DIR ||
      "",
  );
}

export function sessionIdFromHook(input: Record<string, unknown>): string {
  return String(input.session_id || input.sessionId || process.env.CODEX_TEAM_SESSION_ID || "");
}

export function maybePinWorkspace(projectDir: string, workspace: string): void {
  if (!projectDir || process.env.CODEX_TEAM_PIN_WORKSPACE !== "1") {
    return;
  }
  const filePath = workspaceEnvFile(projectDir);
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `CODEX_TEAM_WORKSPACE=${validateWorkspace(workspace)}\n`, "utf8");
}
