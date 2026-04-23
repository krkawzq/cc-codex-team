import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/rpc", () => ({
  threadResume: vi.fn(),
}));

import { threadResume } from "../src/codex/rpc";
import { sessionHeal } from "../src/daemon/handlers/session";
import { SessionRegistry } from "../src/daemon/sessions";
import { logger } from "../src/logger";
import { userSessionsPath } from "../src/paths";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-session-registry-"));
}

function writeSessionsFile(dataDir: string, user: string, sessions: Record<string, unknown>[]): string {
  const filePath = userSessionsPath(user, dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    schema_version: 1,
    sessions,
  }, null, 2));
  return filePath;
}

function makeHealReq() {
  return {
    kind: "request" as const,
    id: "req-1",
    method: "session:heal",
    bearer: "user-1",
    params: {
      positionals: ["sess-1"],
      flags: {},
    },
  };
}

describe("SessionRegistry persisted load", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and drops invalid persisted auto-approve patterns", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    writeSessionsFile(dir, "user-1", [{
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 1,
      autoApprovePatterns: ["git*", "/unterminated"],
    }]);

    const sessions = new SessionRegistry(dir);
    const loaded = sessions.get("user-1", "sess-1");

    expect(loaded?.autoApprovePatterns).toEqual(["git*"]);
    expect(warn).toHaveBeenCalledWith(
      "dropping invalid persisted auto-approve pattern",
      expect.objectContaining({
        session: "sess-1",
        pattern: "/unterminated",
      }),
    );
  });

  it("resets persisted volatile lifecycle fields on load, heals successfully, and stops persisting app_server_client_id", async () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const filePath = writeSessionsFile(dir, "user-1", [{
      name: "sess-1",
      thread_id: "th-1",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:05.000Z",
      turn_count: 2,
      last_turn_id: "turn-8",
      autoApprovePatterns: ["git*"],
      app_server_client_id: "as-99",
    }]);

    const sessions = new SessionRegistry(dir);
    const loaded = sessions.get("user-1", "sess-1");

    expect(loaded).toMatchObject({
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      last_turn_id: null,
      current_turn_id: null,
      current_turn_started_at: null,
      current_item_type: null,
      items_in_turn: 0,
      pending_approvals: 0,
      pending_user_inputs: 0,
      token_usage_last_turn: null,
      crash_reason: null,
    });

    vi.mocked(threadResume).mockResolvedValue(undefined as never);
    const client = { tag: "replacement" };
    const ctx = {
      users: {
        has: vi.fn().mockReturnValue(true),
        touch: vi.fn(),
      },
      sessions,
      pool: {
        clientForSession: vi.fn().mockReturnValue(null),
        release: vi.fn(),
        acquire: vi.fn().mockResolvedValue(client),
      },
      queues: {
        dispose: vi.fn(),
      },
      retryOptions: vi.fn().mockReturnValue({}),
    };

    await expect(sessionHeal(ctx as never, makeHealReq() as never)).resolves.toMatchObject({
      ok: true,
      healed: true,
      session: {
        name: "sess-1",
        state: "live",
      },
    });

    sessions.touch("user-1", "sess-1");
    await sessions.flush();
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(persisted.sessions[0]).not.toHaveProperty("app_server_client_id");
  });
});
