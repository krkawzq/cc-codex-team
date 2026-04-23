#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(pluginDir, "..", "..");
const packageJsonPath = path.join(pluginDir, "package.json");
const pluginJsonPath = path.join(pluginDir, ".claude-plugin", "plugin.json");

const { skipDirtyCheck, version } = parseArgs(process.argv.slice(2));

if (!SEMVER_RE.test(version)) {
  fail(`invalid semver: ${version}`);
}

const dirty = git(["status", "--porcelain"], repoRoot).stdout.trim();
if (dirty && !skipDirtyCheck) {
  fail("git tree is not clean; rerun with -y or --yes to continue");
}
if (dirty && skipDirtyCheck) {
  console.warn("warning: proceeding with a dirty git tree");
}

updateJsonVersion(packageJsonPath, version);
updateJsonVersion(pluginJsonPath, version);

const build = spawnSync("npm", ["run", "build"], {
  cwd: pluginDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

console.log(`updated release artifacts for ${version}:`);
process.stdout.write(git([
  "status",
  "--short",
  "--",
  "plugins/codex-team/package.json",
  "plugins/codex-team/.claude-plugin/plugin.json",
  "plugins/codex-team/dist/main.js",
], repoRoot).stdout);
console.log();
console.log(`next: git add plugins/codex-team/package.json plugins/codex-team/.claude-plugin/plugin.json plugins/codex-team/dist/main.js && git commit -m "release: ${version}"`);

function parseArgs(args) {
  let skipDirtyCheck = false;
  const positionals = [];

  for (const arg of args) {
    if (arg === "-y" || arg === "--yes") {
      skipDirtyCheck = true;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length !== 1) {
    fail("usage: node scripts/bump-version.mjs [-y|--yes] <version>");
  }

  return {
    skipDirtyCheck,
    version: positionals[0],
  };
}

function updateJsonVersion(filePath, version) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  json.version = version;
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
