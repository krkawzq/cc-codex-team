import fs from "node:fs";
import path from "node:path";

import type { User } from "../types";
import { userDir, userMetadataPath, usersDir, decodeToken, encodeToken } from "../paths";
import { CodexTeamError } from "../errors";

export class UserRegistry {
  private users = new Map<string, User>();
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const root = usersDir(this.dataDir);
    if (!fs.existsSync(root)) return;
    for (const dirname of fs.readdirSync(root)) {
      const metaPath = path.join(root, dirname, "metadata.json");
      if (fs.existsSync(metaPath)) {
        try {
          const raw = fs.readFileSync(metaPath, "utf8");
          const user = JSON.parse(raw) as User;
          if (user && typeof user.token === "string") {
            validateToken(user.token);
            this.users.set(user.token, user);
          }
        } catch {
          // skip invalid metadata instead of falling back to dirname decoding
        }
        continue;
      }
      // try decoding dirname as token fallback
      try {
        const token = decodeToken(dirname);
        validateToken(token);
        if (encodeToken(token) !== dirname) continue;
        this.users.set(token, { token, created_at: new Date().toISOString() });
      } catch {
        // skip
      }
    }
  }

  has(token: string): boolean {
    return this.users.has(token);
  }

  get(token: string): User | null {
    return this.users.get(token) ?? null;
  }

  list(): User[] {
    return Array.from(this.users.values());
  }

  create(token: string): User {
    validateToken(token);
    if (this.users.has(token)) {
      throw new CodexTeamError("user_already_exists", `user '${token}' already exists`);
    }
    const user: User = {
      token,
      created_at: new Date().toISOString(),
    };
    this.users.set(token, user);
    this.persist(user);
    return user;
  }

  destroy(token: string): void {
    if (!this.users.has(token)) {
      throw new CodexTeamError("user_not_found", `user '${token}' not found`);
    }
    this.users.delete(token);
    const dir = userDir(token, this.dataDir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  touch(token: string): void {
    const user = this.users.get(token);
    if (!user) return;
    user.last_active_at = new Date().toISOString();
    this.persist(user);
  }

  private persist(user: User): void {
    const dir = userDir(user.token, this.dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const metaPath = userMetadataPath(user.token, this.dataDir);
    const tmp = metaPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(user, null, 2));
    fs.renameSync(tmp, metaPath);
  }
}

function validateToken(token: string): void {
  if (!token) {
    throw new CodexTeamError("invalid_params", "token must be non-empty");
  }
  if (token.length > 256) {
    throw new CodexTeamError("invalid_params", "token too long (max 256)");
  }
}
