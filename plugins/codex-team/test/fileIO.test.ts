import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJsonlTail, readLastLines, rotateFileIfNeeded } from "../src/fileIO";

test("readLastLines reads only the requested tail", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-fileio-"));
  const filePath = path.join(tempDir, "tail.log");
  fs.writeFileSync(filePath, "a\nb\nc\nd\n", "utf8");
  assert.equal(readLastLines(filePath, 2), "c\nd");
});

test("readJsonlTail returns the last N jsonl rows", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-fileio-"));
  const filePath = path.join(tempDir, "turns.jsonl");
  fs.writeFileSync(filePath, '{"n":1}\n{"n":2}\n{"n":3}\n', "utf8");
  assert.deepEqual(readJsonlTail(filePath, 2), ['{"n":2}', '{"n":3}']);
});

test("rotateFileIfNeeded rotates oversized files to .1", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-node-fileio-"));
  const filePath = path.join(tempDir, "history.md");
  fs.writeFileSync(filePath, "x".repeat(2048), "utf8");
  rotateFileIfNeeded(filePath, 0.001);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(`${filePath}.1`), true);
});
