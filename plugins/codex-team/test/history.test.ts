import assert from "node:assert/strict";
import test from "node:test";

import { filterHistoryMarkdown, filterTurnsJsonl } from "../src/history";

test("filterHistoryMarkdown supports sinceTurnId and lastN", () => {
  const content = `
## Turn tr_1 · 1ms · status=ok · tier=trivial
- msg: one

## Turn tr_2 · 1ms · status=ok · tier=trivial
- msg: two

## Turn tr_3 · 1ms · status=ok · tier=trivial
- msg: three
`;
  const filtered = filterHistoryMarkdown(content, { sinceTurnId: "tr_1" });
  assert.equal(filtered.matchedSinceTurnId, true);
  assert.match(filtered.content, /tr_2/);
  assert.match(filtered.content, /tr_3/);
  assert.doesNotMatch(filtered.content, /tr_1/);

  const tail = filterHistoryMarkdown(content, { sinceTurnId: "tr_1", lastN: 1 });
  assert.match(tail.content, /tr_3/);
  assert.doesNotMatch(tail.content, /tr_2/);
});

test("filterHistoryMarkdown ignores nested headings inside fenced timeline bodies", () => {
  const content = `
## Turn tr_1 · 1ms · status=ok · tier=trivial

### Timeline

- **msg:**

  \`\`\`markdown
  ## Nested Heading
  ### Nested Detail
  body
  \`\`\`

## Turn tr_2 · 1ms · status=ok · tier=trivial

### Timeline

- **msg:**

  \`\`\`markdown
  ## Another Nested Heading
  done
  \`\`\`
`;

  const filtered = filterHistoryMarkdown(content, { lastN: 2 });

  assert.match(filtered.content, /## Turn tr_1/);
  assert.match(filtered.content, /## Turn tr_2/);
  assert.match(filtered.content, /## Nested Heading/);
  assert.match(filtered.content, /## Another Nested Heading/);

  const tail = filterHistoryMarkdown(content, { lastN: 1 });
  assert.doesNotMatch(tail.content, /## Turn tr_1/);
  assert.match(tail.content, /## Turn tr_2/);
  assert.match(tail.content, /## Another Nested Heading/);
});

test("filterTurnsJsonl supports sinceTurnId", () => {
  const content = [
    JSON.stringify({ turnId: "tr_1", completedAt: "2026-01-01T00:00:01Z" }),
    JSON.stringify({ turnId: "tr_2", completedAt: "2026-01-01T00:00:02Z" }),
    JSON.stringify({ turnId: "tr_3", completedAt: "2026-01-01T00:00:03Z" }),
  ].join("\n");

  const filtered = filterTurnsJsonl(content, { sinceTurnId: "tr_1" });
  assert.equal(filtered.matchedSinceTurnId, true);
  assert.match(filtered.content, /tr_2/);
  assert.match(filtered.content, /tr_3/);
  assert.doesNotMatch(filtered.content, /tr_1/);

  const missing = filterTurnsJsonl(content, { sinceTurnId: "tr_missing" });
  assert.equal(missing.matchedSinceTurnId, false);
  assert.equal(missing.content, "");
});
