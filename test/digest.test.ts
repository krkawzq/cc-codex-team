import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnSummary, digestItem } from "../src/digest";

test("digestItem captures failed command stderr tail", () => {
  const line = digestItem(
    {
      type: "commandExecution",
      command: "npm test",
      aggregatedOutput: "a\nb\nc",
      exitCode: 1,
      durationMs: 10,
    },
    {
      historyMdEnabled: true,
      turnsJsonlEnabled: true,
      commandTruncateChars: 120,
      agentMessageFull: true,
      reasoningCapture: false,
      stderrTailLinesOnFail: 2,
      maxFilesListed: 8,
      toolArgsTruncateChars: 80,
      historyRotationMb: 32,
    },
  );
  assert.equal(line?.kind, "command");
  assert.equal(line?.stderrTail, "b\nc");
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
