import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { __private__, warnLegacyWindowsDataDir } from "../src/paths";

describe("warnLegacyWindowsDataDir", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    __private__.resetLegacyWindowsDataDirWarning();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits one warning when the legacy HOME path exists and the new path does not", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-win-legacy-"));
    tempRoots.push(root);

    const legacyHome = path.join(root, "legacy-home");
    const nativeHome = path.join(root, "native-home");
    const legacyPath = path.join(legacyHome, ".codex-team");
    const newPath = path.join(nativeHome, ".codex-team");
    fs.mkdirSync(legacyPath, { recursive: true });
    fs.mkdirSync(nativeHome, { recursive: true });

    const warnings: string[] = [];
    const first = warnLegacyWindowsDataDir(
      (warning) => warnings.push(warning.message),
      { platform: "win32", legacyHome, nativeHome },
    );
    const second = warnLegacyWindowsDataDir(
      (warning) => warnings.push(warning.message),
      { platform: "win32", legacyHome, nativeHome },
    );

    expect(first?.legacyPath).toBe(legacyPath);
    expect(first?.newPath).toBe(newPath);
    expect(first?.message).toContain(legacyPath);
    expect(first?.message).toContain(newPath);
    expect(second).toBeNull();
    expect(warnings).toEqual([first!.message]);
  });

  it("skips the probe when the new path already exists or the platform is not Windows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-win-legacy-"));
    tempRoots.push(root);

    const legacyHome = path.join(root, "legacy-home");
    const nativeHome = path.join(root, "native-home");
    fs.mkdirSync(path.join(legacyHome, ".codex-team"), { recursive: true });
    fs.mkdirSync(path.join(nativeHome, ".codex-team"), { recursive: true });

    const warnings: string[] = [];
    expect(warnLegacyWindowsDataDir(
      (warning) => warnings.push(warning.message),
      { platform: "win32", legacyHome, nativeHome },
    )).toBeNull();
    expect(warnLegacyWindowsDataDir(
      (warning) => warnings.push(warning.message),
      { platform: "linux", legacyHome, nativeHome },
    )).toBeNull();
    expect(warnings).toEqual([]);
  });
});
