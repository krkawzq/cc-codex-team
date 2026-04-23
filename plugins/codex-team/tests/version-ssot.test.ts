import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.join(THIS_DIR, "..", "package.json");
const PLUGIN_JSON_PATH = path.join(THIS_DIR, "..", ".claude-plugin", "plugin.json");
const DIST_MAIN_PATH = path.join(THIS_DIR, "..", "dist", "main.js");

describe("VERSION", () => {
  it("matches package.json", () => {
    const pkg = require(PACKAGE_JSON_PATH) as { version?: string };
    expect(VERSION).toBe(pkg.version);
    expect((require(PLUGIN_JSON_PATH) as { version?: string }).version).toBe(pkg.version);
  });

  it("matches package.json when the built dist CLI runs", () => {
    if (!fs.existsSync(DIST_MAIN_PATH)) {
      console.warn(`skipping post-build SSOT runtime check: ${DIST_MAIN_PATH} is missing`);
      return;
    }
    if (!canSpawnChildProcess()) {
      console.warn("skipping post-build SSOT runtime check: child process spawn is not permitted in this environment");
      return;
    }

    const pkg = require(PACKAGE_JSON_PATH) as { version?: string };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-version-"));

    try {
      let stdout: string;
      try {
        stdout = execFileSync(process.execPath, [DIST_MAIN_PATH, "version"], {
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_TEAM_DATA_DIR: tempHome,
          },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          console.warn("skipping post-build SSOT runtime check: child process execution is not permitted in this environment");
          return;
        }
        throw error;
      }
      const parsed = JSON.parse(stdout) as {
        ok?: boolean;
        data?: { cli_version?: string };
      };

      expect(parsed.ok).toBe(true);
      expect(parsed.data?.cli_version).toBe(pkg.version);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

function canSpawnChildProcess(): boolean {
  try {
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const err = result.error as NodeJS.ErrnoException | undefined;
    if (err?.code === "EPERM") return false;
    if (err) throw err;
    return result.status === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}
