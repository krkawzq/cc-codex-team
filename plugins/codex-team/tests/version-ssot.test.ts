import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.join(THIS_DIR, "..", "package.json");
const DIST_MAIN_PATH = path.join(THIS_DIR, "..", "dist", "main.js");

describe("VERSION", () => {
  it("matches package.json", () => {
    const pkg = require(PACKAGE_JSON_PATH) as { version?: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("matches package.json when the built dist CLI runs", () => {
    if (!fs.existsSync(DIST_MAIN_PATH)) {
      console.warn(`skipping post-build SSOT runtime check: ${DIST_MAIN_PATH} is missing`);
      return;
    }

    const pkg = require(PACKAGE_JSON_PATH) as { version?: string };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-version-"));

    try {
      const stdout = execFileSync(process.execPath, [DIST_MAIN_PATH, "version"], {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_TEAM_DATA_DIR: tempHome,
        },
      });
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
