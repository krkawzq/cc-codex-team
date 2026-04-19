import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DigestConfig } from "../src/config";
import { buildTurnSummary, digestItem, writeHistoryMd } from "../src/digest";

const DIGEST_CONFIG: DigestConfig = {
  historyMdEnabled: true,
  turnsJsonlEnabled: true,
  commandTruncateChars: 120,
  agentMessageFull: true,
  reasoningCapture: false,
  stderrTailLinesOnFail: 2,
  maxFilesListed: 8,
  toolArgsTruncateChars: 80,
  historyRotationMb: 32,
};

function digestConfig(overrides: Partial<DigestConfig> = {}): DigestConfig {
  return { ...DIGEST_CONFIG, ...overrides };
}

test("digestItem keeps single-line command inline below threshold", () => {
  const line = digestItem(
    {
      type: "commandExecution",
      command: "npm test",
      exitCode: 0,
      durationMs: 10,
    },
    digestConfig(),
  );

  assert.equal(line?.kind, "command");
  assert.equal(line?.text, "npm test");
  assert.equal(line?.fullText, null);
});

test("digestItem truncates single-line command above threshold", () => {
  const line = digestItem(
    {
      type: "commandExecution",
      command: "npm run test:with-a-very-long-command-name",
      exitCode: 0,
      durationMs: 10,
    },
    digestConfig({ commandTruncateChars: 12 }),
  );

  assert.equal(line?.kind, "command");
  assert.match(line?.text ?? "", /truncated, 42 chars/);
  assert.equal(line?.fullText, null);
});

test("digestItem stores full multi-line command", () => {
  const command = "awk '\n  { print $0 }\n' file.txt";
  const line = digestItem(
    {
      type: "commandExecution",
      command,
      exitCode: 0,
      durationMs: 10,
    },
    digestConfig(),
  );

  assert.equal(line?.kind, "command");
  assert.equal(line?.text, "awk '");
  assert.equal(line?.fullText, command);
});

test("digestItem captures failed command stderr tail", () => {
  const line = digestItem(
    {
      type: "commandExecution",
      command: "npm test",
      aggregatedOutput: "a\nb\nc",
      exitCode: 1,
      durationMs: 10,
    },
    digestConfig(),
  );

  assert.equal(line?.kind, "command");
  assert.equal(line?.stderrTail, "b\nc");
});

test("digestItem maps file change kinds", () => {
  const cases = [
    ["add", "A"],
    ["modify", "M"],
    ["delete", "D"],
    ["rename", "R"],
  ] as const;

  for (const [rawKind, expected] of cases) {
    const line = digestItem(
      {
        type: "fileChange",
        changes: [{ path: `/tmp/${rawKind}.txt`, kind: rawKind, linesAdded: 1, linesRemoved: 0 }],
      },
      digestConfig(),
    );

    assert.equal(line?.kind, "file_change");
    assert.equal(line?.changeKind, expected);
  }
});

test("digestItem infers added files and counts content-only changes", () => {
  const inferred = digestItem(
    {
      type: "fileChange",
      changes: [{ path: "/tmp/inferred.txt", linesAdded: 3, linesRemoved: 0 }],
    },
    digestConfig(),
  );

  assert.equal(inferred?.kind, "file_change");
  assert.equal(inferred?.changeKind, "A");

  const contentOnly = digestItem(
    {
      type: "fileChange",
      changes: [{ path: "/tmp/content.txt", content: "one\ntwo\nthree" }],
    },
    digestConfig(),
  );

  assert.equal(contentOnly?.kind, "file_change");
  assert.equal(contentOnly?.changeKind, "A");
  assert.equal(contentOnly?.linesAdded, 3);
  assert.equal(contentOnly?.linesRemoved, 0);
});

test("digestItem marks final-answer agent messages", () => {
  const finalLine = digestItem(
    { type: "agentMessage", text: "done", phase: "final_answer" },
    digestConfig(),
  );
  const legacyFinalLine = digestItem({ type: "agentMessage", text: "legacy", phase: null }, digestConfig());
  const interimLine = digestItem({ type: "agentMessage", text: "working", phase: "interim" }, digestConfig());

  assert.equal(finalLine?.kind, "agent_message");
  assert.equal(finalLine?.isFinal, true);
  assert.equal(legacyFinalLine?.kind, "agent_message");
  assert.equal(legacyFinalLine?.isFinal, true);
  assert.equal(interimLine?.kind, "agent_message");
  assert.equal(interimLine?.isFinal, false);
});

test("buildTurnSummary classifies message-only success as trivial", () => {
  const summary = buildTurnSummary({
    session: "alpha",
    turnId: "tr_1",
    elapsedMs: 100,
    status: "ok",
    lines: [{ kind: "agent_message", text: "done" }],
    finalMessage: "done",
    completedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(summary.tier, "trivial");
});

test("writeHistoryMd renders chronological timeline with fenced bodies", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-history-"));
  const historyPath = path.join(tmpDir, "history.md");
  const summary = buildTurnSummary({
    session: "alpha",
    turnId: "tr_1",
    elapsedMs: 100,
    status: "ok",
    finalMessage: "final\n- item",
    usageLastTokens: 7,
    usageTotalTokens: 70,
    completedAt: "2026-01-01T00:00:00.000Z",
    lines: [
      { kind: "command", text: "git status", exitCode: 0, durationMs: 1, fullText: null },
      { kind: "agent_message", text: "hello\nworld", isFinal: false },
      {
        kind: "command",
        text: "awk '",
        fullText: "awk '\n  { print $0 }\n' file.txt",
        exitCode: 0,
        durationMs: 2,
      },
      {
        kind: "file_change",
        text: "/tmp/new.txt (+2/-0)",
        path: "/tmp/new.txt",
        linesAdded: 2,
        linesRemoved: 0,
        changeKind: "A",
      },
      { kind: "agent_message", text: "final\n- item", isFinal: true },
    ],
  });

  writeHistoryMd(historyPath, summary, digestConfig());
  const rendered = fs.readFileSync(historyPath, "utf8");

  const anchors = [
    "**[cmd ok 1ms]** `git status`",
    "**msg:**",
    "**[cmd ok 2ms]**",
    "**[file A]** `/tmp/new.txt` (+2/-0)",
    "**msg (final):**",
  ];
  const positions = anchors.map((anchor) => rendered.indexOf(anchor));
  for (const position of positions) {
    assert.notEqual(position, -1);
  }
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right),
  );

  assert.match(rendered, /### Usage\ntokens_last=7 · tokens_total=70 · files=\+2\/-0/);
  assert.match(rendered, /\n### Timeline\n\n/);
  assert.match(rendered, /  ```markdown\n  hello\n  world\n  ```/);
  assert.match(rendered, /  ```sh\n  awk '\n    \{ print \$0 \}\n  ' file\.txt\n  ```/);
  assert.match(rendered, /  ```markdown\n  final\n  - item\n  ```/);
  assert.doesNotMatch(rendered, /^### File changes$/m);
  assert.doesNotMatch(rendered, /^### Commands$/m);
  assert.doesNotMatch(rendered, /^### Messages$/m);
  assert.doesNotMatch(rendered, /^### Final answer$/m);
});

test("writeHistoryMd renders failed command stderr as a fenced block", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-history-"));
  const historyPath = path.join(tmpDir, "history.md");
  const summary = buildTurnSummary({
    session: "alpha",
    turnId: "tr_2",
    elapsedMs: 100,
    status: "ok",
    finalMessage: null,
    completedAt: "2026-01-01T00:00:00.000Z",
    lines: [
      {
        kind: "command",
        text: "npm test",
        exitCode: 1,
        durationMs: 3,
        stderrTail: "line b\nline c",
      },
    ],
  });

  writeHistoryMd(historyPath, summary, digestConfig());
  const rendered = fs.readFileSync(historyPath, "utf8");

  assert.match(rendered, /\*\*\[cmd FAIL exit=1 3ms\]\*\* `npm test`/);
  assert.match(rendered, /  stderr:\n\n  ```\n  line b\n  line c\n  ```/);
});

test("writeHistoryMd uses longer fences for content containing fenced blocks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-history-"));
  const historyPath = path.join(tmpDir, "history.md");
  const summary = buildTurnSummary({
    session: "alpha",
    turnId: "tr_3",
    elapsedMs: 100,
    status: "ok",
    finalMessage: null,
    completedAt: "2026-01-01T00:00:00.000Z",
    lines: [
      {
        kind: "agent_message",
        text: "Here is code:\n```ts\nconst answer = 42;\n```\nDone.",
        isFinal: false,
      },
      {
        kind: "command",
        text: "cat <<'EOF'",
        fullText: "cat <<'EOF'\n```markdown\nnested\n```\nEOF",
        exitCode: 0,
        durationMs: 4,
      },
    ],
  });

  writeHistoryMd(historyPath, summary, digestConfig());
  const rendered = fs.readFileSync(historyPath, "utf8");

  assert.match(rendered, /  ````markdown\n  Here is code:\n  ```ts\n  const answer = 42;\n  ```\n  Done\.\n  ````/);
  assert.match(rendered, /  ````sh\n  cat <<'EOF'\n  ```markdown\n  nested\n  ```\n  EOF\n  ````/);
});

test("writeHistoryMd renders inline code spans containing backticks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-history-"));
  const historyPath = path.join(tmpDir, "history.md");
  const summary = buildTurnSummary({
    session: "alpha",
    turnId: "tr_4",
    elapsedMs: 100,
    status: "ok",
    finalMessage: null,
    completedAt: "2026-01-01T00:00:00.000Z",
    lines: [
      {
        kind: "command",
        text: "echo `pwd`",
        exitCode: 0,
        durationMs: 1,
      },
      {
        kind: "file_change",
        text: "/tmp/`generated`.txt (+1/-0)",
        path: "/tmp/`generated`.txt",
        linesAdded: 1,
        linesRemoved: 0,
        changeKind: "A",
      },
    ],
  });

  writeHistoryMd(historyPath, summary, digestConfig());
  const rendered = fs.readFileSync(historyPath, "utf8");

  assert.match(rendered, /\*\*\[cmd ok 1ms\]\*\* `` echo `pwd` ``/);
  assert.match(rendered, /\*\*\[file A\]\*\* `` \/tmp\/`generated`\.txt `` \(\+1\/-0\)/);
});
