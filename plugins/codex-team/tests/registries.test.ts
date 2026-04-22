import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeToken, userSessionsPath, usersDir } from "../src/paths";
import { SessionRegistry } from "../src/daemon/sessions";
import { UserRegistry } from "../src/daemon/users";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-registry-"));
}

describe("UserRegistry", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates, touches, and destroys users on disk", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const users = new UserRegistry(dir);

    const created = users.create("token-1");
    expect(users.has("token-1")).toBe(true);
    expect(created.token).toBe("token-1");

    users.touch("token-1");
    expect(users.get("token-1")?.last_active_at).toBeTypeOf("string");

    users.destroy("token-1");
    expect(users.has("token-1")).toBe(false);
  });

  it("only loads canonical encoded-token fallback directories", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const root = usersDir(dir);
    fs.mkdirSync(root, { recursive: true });

    const good = encodeToken("good-token");
    fs.mkdirSync(path.join(root, good), { recursive: true });

    fs.mkdirSync(path.join(root, "not-valid-token-dir"), { recursive: true });
    fs.writeFileSync(path.join(root, "not-valid-token-dir", "metadata.json"), "{bad json");

    const users = new UserRegistry(dir);
    expect(users.has("good-token")).toBe(true);
    expect(users.list().map((u) => u.token)).toEqual(["good-token"]);
  });

  it("ignores invalid metadata tokens", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const badDir = path.join(usersDir(dir), encodeToken("bad-token"));
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "metadata.json"), JSON.stringify({
      token: "",
      created_at: "2025-01-01T00:00:00.000Z",
    }));

    const users = new UserRegistry(dir);
    expect(users.list()).toEqual([]);
  });

  it("rejects newer persisted metadata schema versions", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const userPath = path.join(usersDir(dir), encodeToken("token-1"));
    fs.mkdirSync(userPath, { recursive: true });
    fs.writeFileSync(path.join(userPath, "metadata.json"), JSON.stringify({
      schema_version: 2,
      user: {
        token: "token-1",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    }));

    expect(() => new UserRegistry(dir)).toThrow(/schema_version/i);
  });
});

describe("SessionRegistry", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds, resolves, renames, and removes live sessions", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);

    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
    });

    expect(sessions.get("user-1", "sess-1")?.thread_id).toBe("th-1");
    expect(sessions.get("user-1", "th-1")?.name).toBe("sess-1");
    expect(sessions.findLiveAnywhere("th-1")).toMatchObject({
      user: "user-1",
      record: { name: "sess-1" },
    });
    expect(sessions.findUniqueLiveByNameAnywhere("sess-1")).toMatchObject({
      user: "user-1",
      record: { name: "sess-1" },
    });

    sessions.update("user-1", "sess-1", { name: "renamed" });
    expect(sessions.get("user-1", "renamed")?.thread_id).toBe("th-1");
    expect(sessions.remove("user-1", "renamed")?.thread_id).toBe("th-1");
    expect(sessions.findLiveAnywhere("th-1")).toBeNull();
  });

  it("removeAllForUser clears global thread lookup", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);

    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
    });

    expect(sessions.removeAllForUser("user-1").map((x) => x.thread_id)).toEqual(["th-1"]);
    expect(sessions.findLiveAnywhere("th-1")).toBeNull();
  });

  it("ignores malformed persisted session records missing thread_id", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    fs.mkdirSync(path.dirname(userSessionsPath("user-1", dir)), { recursive: true });
    fs.writeFileSync(userSessionsPath("user-1", dir), JSON.stringify({
      schema_version: 1,
      sessions: [
        {
          name: "broken",
          state: "live",
        },
      ],
    }));

    const sessions = new SessionRegistry(dir);
    expect(sessions.listLive("user-1")).toEqual([]);
  });

  it("rejects newer persisted session schema versions", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    fs.mkdirSync(path.dirname(userSessionsPath("user-1", dir)), { recursive: true });
    fs.writeFileSync(userSessionsPath("user-1", dir), JSON.stringify({
      schema_version: 2,
      sessions: [],
    }));

    const sessions = new SessionRegistry(dir);
    expect(() => sessions.listLive("user-1")).toThrow(/schema_version/i);
  });

  it("debounces touch persistence and flushes pending writes", async () => {
    vi.useFakeTimers();
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);

    sessions.add("user-1", {
      name: "sess-1",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
    });
    await sessions.flush();
    const filePath = userSessionsPath("user-1", dir);
    const before = fs.readFileSync(filePath, "utf8");

    sessions.touch("user-1", "sess-1");
    const immediate = fs.readFileSync(filePath, "utf8");
    expect(immediate).toBe(before);

    await vi.advanceTimersByTimeAsync(300);
    await sessions.flush();
    const afterTimer = fs.readFileSync(filePath, "utf8");
    expect(JSON.parse(afterTimer).sessions[0].last_active_at).not.toBe("2025-01-01T00:00:00.000Z");

    sessions.touch("user-1", "sess-1");
    await sessions.flush();
    const afterFlush = fs.readFileSync(filePath, "utf8");
    expect(afterFlush).toContain("\"last_active_at\"");

    vi.useRealTimers();
  });

  it("marks duplicate cross-user names as ambiguous", () => {
    const dir = mkTmpDir();
    dirs.push(dir);
    const sessions = new SessionRegistry(dir);

    sessions.add("user-1", {
      name: "shared",
      thread_id: "th-1",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
    });
    sessions.add("user-2", {
      name: "shared",
      thread_id: "th-2",
      state: "live",
      created_at: "2025-01-01T00:00:00.000Z",
      last_active_at: "2025-01-01T00:00:00.000Z",
      turn_count: 0,
    });

    expect(sessions.findUniqueLiveByNameAnywhere("shared")).toBe("ambiguous");
  });
});
