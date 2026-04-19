# Refactor: history display — chronological + agent-friendly

**Status:** ready for implementation
**Scope:** `src/digest.ts` + `src/history.ts` + `src/models.ts` (types only)
**Non-goals:** daemon protocol, event bus, session lifecycle, CLI argv parsing
**Audience:** an implementer agent with no prior context on this plugin

---

## 1. Executive summary

`codex-team history <name> --format md` currently renders each Codex turn as three fixed, re-grouped sections (**File changes**, **Commands**, **Messages**) followed by a **Final answer** block. This loses the arrival order of items, mangles multi-line content, and duplicates the final agent message. Downstream agents reading this output cannot reconstruct the worker's actual reasoning path.

This refactor replaces the three-section layout with a single chronological **Timeline** that:

1. Preserves the order in which Codex emitted items.
2. Renders each agent-authored message in a fenced ```` ```markdown ```` block so multi-line replies survive intact.
3. Renders each multi-line shell command in a fenced ```` ```sh ```` block instead of truncating at the first newline.
4. Reports the correct file-change kind (Added / Modified / Deleted / Renamed) rather than always printing `M`.
5. Tags the final-answer message inline with `(final)` and drops the now-duplicative **Final answer** section.

The ordering data is already present (see §3), so the change is mostly in `writeHistoryMd` and `formatLine` with small schema additions.

---

## 2. Current behaviour (what's wrong)

### 2.1 Sample of current output

Given a turn that wrote two files, ran nine shell commands, and emitted four interleaved messages, the current renderer produces:

```markdown
## Turn 019da615-0ee3-7d82-806b-a4f441910bbe · 161675ms · status=ok · tier=normal

### File changes
- M /abs/path/perf-round4-summary.md (+0/-0)
- M /abs/path/L-perf-progress.md (+0/-0)

### Commands
- [ok 0ms] /usr/bin/zsh -lc "test -f docs/refactor/perf-round4-summary.md && sed -n '1,220p' docs/refact ...
    (truncated, 127 chars)
- [ok 101ms] /usr/bin/zsh -lc "sed -n '1,260p' docs/refactor/L-perf-progress.md 2>/dev/null || true"
- [ok 489ms] /usr/bin/zsh -lc 'git status --short'
- [ok 0ms] /usr/bin/zsh -lc "awk '
- [ok 115ms] /usr/bin/zsh -lc "sed -n '260,520p' docs/refactor/perf-round4-summary.md"
- [ok 2422ms] /usr/bin/zsh -lc 'git status --short'

### Messages
- msg: I'll write the summary doc and append the stand-down note only; no commit. ...
- msg: I'm going to write the team-facing summary ...
- msg: The summary doc is drafted ...
- msg: a) Doc path:
- [perf-round4-summary.md](/abs/path/perf-round4-summary.md)
- Also appended stand-down to ...
  ( markdown of the final reply bleeds into the bullet list )

### Final answer
> a) Doc path:
> - [perf-round4-summary.md](/abs/path/perf-round4-summary.md)
> ...
  ( same content as the last `msg:` line, duplicated, re-wrapped as a blockquote )
```

### 2.2 Defect list (with source references)

| ID | Defect | Location | Root cause |
|---|---|---|---|
| D1 | Three-section re-grouping destroys arrival order | `digest.ts:170-195` (`writeHistoryMd`) | `filter(kind === X)` emits each kind in its own section regardless of original order. |
| D2 | Multi-line shell commands truncated at first newline | `digest.ts:57-72` (`digestCommand`) + `digest.ts:18-20` (`firstLine`) | `firstLine(raw)` drops every line after `\n`. |
| D3 | File operation always shown as `M` | `digest.ts:150-152` (`formatLine` `file_change` branch) | Hard-coded `M` prefix; `kind` field from codex not consulted. |
| D4 | Newly-created files report `+0/-0` even when content exists | `digest.ts:74-87` (`digestFileChange`) | Reads `changes[0].linesAdded` / `linesRemoved` but codex may emit added files with only a `content` field. |
| D5 | Multi-line agent messages mangled as single-line bullets | `digest.ts:154-156` (`formatLine` `agent_message` branch) | `- msg: <text>` bullet; embedded newlines break the list. |
| D6 | Final answer duplicated with the last agent_message | `digest.ts:191-194` (`writeHistoryMd` final-answer append) + `session.ts:529-533` (`finalMessage` captured from last `agent_message` line) | Both kept; no de-duplication. |
| D7 | `tool_call` / `web_search` / `collab_agent` lines are in the correct order but have no reserved section; today they fall through `formatLine`'s fallback and render as plain `- <text>` | `digest.ts:156-162` | Not really a bug now (they rarely appear) but the new timeline must handle them uniformly. |

---

## 3. Ordering is already preserved upstream

`src/session.ts:512-536` handles Codex notifications in a `while (true)` loop and pushes each digested line into `lines` in arrival order:

```ts
while (true) {
  const notification = await this.client.nextNotification();
  ...
  if (notification.method === "item/completed") {
    const item = asRecord(params.item);
    const line = digestItem(item, this.cfg.digest);
    if (line) {
      lines.push(line);     // <-- preserves arrival order
      ...
    }
  }
  ...
}
```

No upstream change is required. The renderer is the sole source of ordering loss.

---

## 4. Target output format

For the same turn shown in §2.1, the new renderer must produce (exact markdown, whitespace included):

````markdown
## Turn 019da615-0ee3-7d82-806b-a4f441910bbe · 161675ms · status=ok · tier=normal

### Usage
tokens_last=8321 · tokens_total=192000 · files=+527/-0

### Timeline

- **[cmd ok 0ms]** `/usr/bin/zsh -lc "test -f docs/refactor/perf-round4-summary.md && sed -n '1,220p' docs/refactor/perf-round4-summary.md 2>/dev/null || true"`
- **[cmd ok 101ms]** `/usr/bin/zsh -lc "sed -n '1,260p' docs/refactor/L-perf-progress.md 2>/dev/null || true"`
- **[cmd ok 489ms]** `/usr/bin/zsh -lc 'git status --short'`
- **msg:**

  ```markdown
  I'll write the summary doc and append the stand-down note only; no commit. I'll also keep the requested future commit subject in the doc context if useful, but I won't run commit commands.
  ```

- **[cmd ok 0ms]**

  ```sh
  /usr/bin/zsh -lc "awk '
    BEGIN { ... }
    { ... }
    END { ... }
  ' docs/refactor/*.md"
  ```

- **[cmd ok 115ms]** `/usr/bin/zsh -lc "sed -n '260,520p' docs/refactor/perf-round4-summary.md"`
- **[file A]** `/abs/path/perf-round4-summary.md` (+527/-0)
- **[file A]** `/abs/path/L-perf-progress.md` (+48/-0)
- **[cmd ok 2422ms]** `/usr/bin/zsh -lc 'git status --short'`
- **msg (final):**

  ```markdown
  a) Doc path:
  - [perf-round4-summary.md](/abs/path/perf-round4-summary.md)
  - Also appended stand-down to [L-perf-progress.md](/abs/path/L-perf-progress.md)

  b) Section word-count概要:

  | Section | Words |
  |---|---:|
  | Scope | 77 |
  | ... | ... |

  c) Top-3 lessons...
  ```
````

Key properties:

- One bullet per item. Each bullet's first line is a labelled header; body (if any) lives in a fenced block below.
- Label format is `**[<kind> <status> <duration>]**` for commands, `**[file <kind>]**` for file changes, `**msg:**` or `**msg (final):**` for agent messages, `**[tool]** <tool-name>` for tool calls, `**[search]** <query>` for web searches, `**[subagent]** <tool>` for collab agent calls.
- Commands that fit on one line (≤ `commandTruncateChars`, no embedded newlines) are rendered inline as code spans; otherwise they go into a ```` ```sh ```` fenced block, full content, no truncation.
- Agent messages always go into a ```` ```markdown ```` fenced block, full content, no truncation.
- The final-answer message (the one whose source `item.phase === "final_answer"`) is labelled `**msg (final):**` instead of `**msg:**`. It still appears in its chronological position.
- No separate **Final answer** section. No **File changes** / **Commands** / **Messages** sections.
- A short **Usage** line appears immediately after the turn header when `usageLastTokens` / `usageTotalTokens` / `filesAdded` / `filesRemoved` are available.
- Error turns add an extra line under **Usage**: `error: <message>` when `errorMessage` is non-null.

---

## 5. Required code changes

### 5.1 `src/models.ts`

Add optional fields to `DigestLine` to support the timeline:

```ts
export type DigestLineKind =
  | "command"
  | "file_change"
  | "agent_message"
  | "tool_call"
  | "web_search"
  | "collab_agent";

export interface DigestLine {
  kind: DigestLineKind;
  text: string;

  // --- existing (keep) ---
  path?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  exitCode?: number | null;
  durationMs?: number | null;
  stderrTail?: string | null;
  toolName?: string | null;

  // --- NEW (required by this refactor) ---
  /**
   * For command: the *full* command text (may be multi-line). `text` stays
   * as the short/inline form for single-line commands.
   * For agent_message / tool_call / web_search: unused or equals `text`.
   */
  fullText?: string | null;

  /**
   * For file_change: one of "A" (add), "M" (modify), "D" (delete),
   * "R" (rename). Default "M" when the codex payload does not supply a kind.
   */
  changeKind?: "A" | "M" | "D" | "R" | null;

  /**
   * For agent_message: true when the source codex item had
   * `phase === "final_answer"`. Exactly one agent_message per turn will
   * normally have this set; zero is possible on error turns.
   */
  isFinal?: boolean | null;
}
```

The JSONL format (see `writeTurnsJsonl` at `digest.ts:198-204`) is `JSON.stringify(summary)` — these new fields flow through automatically. Existing consumers that do not know these fields will ignore them.

### 5.2 `src/digest.ts` — `digestCommand` (replace)

Replace first-line truncation with a dual-form output:

```ts
function digestCommand(item: Record<string, unknown>, cfg: DigestConfig): DigestLine {
  const raw = String(item.command ?? "");
  const isMultiLine = raw.includes("\n");
  const inlineText = isMultiLine
    ? firstLine(raw)                                // preview for `text` only
    : raw.length > cfg.commandTruncateChars
      ? truncate(raw, cfg.commandTruncateChars)
      : raw;
  const exitCode = item.exitCode == null ? null : Number(item.exitCode);
  const stderr = String(item.aggregatedOutput ?? "");
  return {
    kind: "command",
    text: inlineText,                               // short form for inline
    fullText: isMultiLine ? raw : null,             // NEW: full body for fence
    exitCode,
    durationMs: item.durationMs == null ? null : Number(item.durationMs),
    stderrTail: exitCode == null || exitCode === 0 ? null : tailLines(stderr, cfg.stderrTailLinesOnFail),
  };
}
```

### 5.3 `src/digest.ts` — `digestFileChange` (replace)

Detect the change kind from codex's payload. Codex emits one of (based on observed payload shapes; verify against actual protocol):

- `changes[i].kind === "add" | "modify" | "delete" | "rename"` — map to `A|M|D|R`.
- If `kind` is missing, infer from `linesAdded > 0 && linesRemoved === 0 && !prevPath` → `A`, `linesRemoved > 0 && linesAdded === 0` → `D`, else `M`.
- For added files with only `content` (no `linesAdded`), compute `linesAdded = content.split("\n").length` and `linesRemoved = 0`.

```ts
function digestFileChange(item: Record<string, unknown>): DigestLine {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const first = (changes[0] as Record<string, unknown> | undefined) || {};
  const pathValue = String(first.path ?? "");
  const content = typeof first.content === "string" ? (first.content as string) : "";

  let linesAdded = Number(first.linesAdded ?? first.lines_added ?? 0);
  let linesRemoved = Number(first.linesRemoved ?? first.lines_removed ?? 0);

  // Infer counts from content for added files that lack explicit counts.
  if (linesAdded === 0 && linesRemoved === 0 && content) {
    linesAdded = content === "" ? 0 : content.split(/\r?\n/).length;
  }

  const rawKind = String(first.kind ?? "").toLowerCase();
  let changeKind: "A" | "M" | "D" | "R";
  if (rawKind === "add" || rawKind === "added" || rawKind === "create" || rawKind === "created") {
    changeKind = "A";
  } else if (rawKind === "delete" || rawKind === "deleted" || rawKind === "remove") {
    changeKind = "D";
  } else if (rawKind === "rename" || rawKind === "renamed" || rawKind === "move") {
    changeKind = "R";
  } else if (rawKind === "modify" || rawKind === "modified" || rawKind === "update") {
    changeKind = "M";
  } else {
    // Infer when kind is absent.
    if (linesRemoved === 0 && linesAdded > 0 && !first.previousPath) {
      changeKind = "A";
    } else if (linesAdded === 0 && linesRemoved > 0) {
      changeKind = "D";
    } else {
      changeKind = "M";
    }
  }

  return {
    kind: "file_change",
    text: `${pathValue} (+${linesAdded}/-${linesRemoved})`,
    path: pathValue,
    linesAdded,
    linesRemoved,
    changeKind,
  };
}
```

### 5.4 `src/digest.ts` — `digestItem` agent_message branch

Propagate the `phase === "final_answer"` flag:

```ts
if (itemType === "agentMessage") {
  const phase = item.phase == null ? null : String(item.phase);
  return {
    kind: "agent_message",
    text: String(item.text ?? ""),
    isFinal: phase === "final_answer" || phase === null,  // null phase = legacy default-final
  };
}
```

Note: `session.ts:529-533` already uses the same `phase === "final_answer" || phase === null` condition to capture `finalMessage`. Keep both in sync.

### 5.5 `src/digest.ts` — `formatLine` (replace)

New bullet formatter with dual inline/fenced emission:

```ts
function formatLine(line: DigestLine): string {
  if (line.kind === "command") {
    const status = line.exitCode === 0 ? "ok" : `FAIL exit=${line.exitCode}`;
    const duration = line.durationMs || 0;
    const header = `- **[cmd ${status} ${duration}ms]**`;
    const stderrSuffix = line.stderrTail
      ? `\n\n  stderr:\n\n  \`\`\`\n  ${line.stderrTail.split("\n").join("\n  ")}\n  \`\`\``
      : "";
    if (line.fullText) {
      const body = line.fullText;
      return `${header}\n\n  \`\`\`sh\n  ${body.split("\n").join("\n  ")}\n  \`\`\`${stderrSuffix}`;
    }
    const inline = "`" + line.text.replace(/`/g, "\\`") + "`";
    return `${header} ${inline}${stderrSuffix}`;
  }

  if (line.kind === "file_change") {
    const k = line.changeKind || "M";
    return `- **[file ${k}]** \`${line.path || ""}\` (+${line.linesAdded || 0}/-${line.linesRemoved || 0})`;
  }

  if (line.kind === "agent_message") {
    const label = line.isFinal ? "**msg (final):**" : "**msg:**";
    const body = (line.text || "").trimEnd();
    return `- ${label}\n\n  \`\`\`markdown\n  ${body.split("\n").join("\n  ")}\n  \`\`\``;
  }

  if (line.kind === "tool_call") {
    return `- **[tool]** \`${line.toolName || line.text}\``;
  }

  if (line.kind === "web_search") {
    return `- **[search]** \`${line.text}\``;
  }

  if (line.kind === "collab_agent") {
    return `- **[subagent]** \`${line.text}\``;
  }

  return `- ${line.text}`;
}
```

Notes:

- Every body that goes into a fenced block is indented by exactly two spaces so the fence stays attached to its list item under CommonMark rules.
- `trimEnd()` on agent messages avoids trailing blank lines inside the fence.
- Command inline form escapes any stray backtick with `\``.
- The `stderr` fenced block for failed commands indents identically.

### 5.6 `src/digest.ts` — `writeHistoryMd` (replace)

Drop the three-section grouping + Final answer append. Emit header + Usage + chronological Timeline:

```ts
export function writeHistoryMd(filePath: string, summary: TurnSummary, cfg?: DigestConfig): void {
  ensureDirFor(filePath);
  if (cfg) {
    rotateFileIfNeeded(filePath, cfg.historyRotationMb);
  }

  const parts: string[] = [];
  parts.push(`\n## Turn ${summary.turnId} · ${summary.elapsedMs}ms · status=${summary.status} · tier=${summary.tier}\n`);

  // Usage line (when any token/file metric is available)
  const usageBits: string[] = [];
  if (summary.usageLastTokens != null) usageBits.push(`tokens_last=${summary.usageLastTokens}`);
  if (summary.usageTotalTokens != null) usageBits.push(`tokens_total=${summary.usageTotalTokens}`);
  if (summary.filesAdded || summary.filesRemoved) {
    usageBits.push(`files=+${summary.filesAdded}/-${summary.filesRemoved}`);
  }
  if (usageBits.length > 0) {
    parts.push("\n### Usage\n");
    parts.push(usageBits.join(" · "));
    parts.push("\n");
  }
  if (summary.errorMessage) {
    parts.push(`\nerror: ${summary.errorMessage}\n`);
  }

  // Timeline — chronological, no re-grouping.
  if (summary.lines.length > 0) {
    parts.push("\n### Timeline\n\n");
    parts.push(summary.lines.map(formatLine).join("\n"));
    parts.push("\n");
  }

  fs.appendFileSync(filePath, parts.join(""), "utf8");
}
```

`writeTurnsJsonl` is unchanged.

### 5.7 `src/history.ts`

No change to the filter logic. The existing `splitMarkdownSections` regex `/^## Turn ([^\s]+).*$/gm` still works because the turn header line format is preserved verbatim.

**Verify:** the filter must still correctly split when a turn body contains fenced blocks with their own `##` or `###` headings inside (e.g. a user message pasted into a fence). The current regex is anchored to `^## Turn ` which remains unique — fenced blocks don't start with `## Turn`. No change needed. Add a unit test that confirms this.

---

## 6. Configuration

No new config keys are required. The existing `DigestConfig` keys stay:

| Key | Still used by |
|---|---|
| `commandTruncateChars` | Inline command form only (multi-line commands are not truncated). |
| `toolArgsTruncateChars` | Unchanged (`digestToolCall`). |
| `stderrTailLinesOnFail` | Unchanged (command stderr block). |
| `agentMessageFull` | **Deprecated** — agent messages are always full-text now. Leave the key in config for backwards compat but stop reading it. Add a comment: `// agent_message is always full-text in 0.4.0; flag retained for forward compat but ignored.` |
| `reasoningCapture` | Unchanged. |
| `historyRotationMb` | Unchanged. |
| `maxFilesListed` | **Deprecated** — the timeline emits every file change. Retain key, stop reading. |

---

## 7. Testing expectations

Add tests under `test/` (follow the existing tsx-based test style — see `test/*.test.ts` for conventions). Target coverage:

### 7.1 `digestCommand`

- Single-line command under threshold → `text` == raw, `fullText` null.
- Single-line command over threshold → `text` truncated with `... (truncated, N chars)`, `fullText` null.
- Multi-line command → `text` == first line, `fullText` == raw.
- Failed command → `stderrTail` populated with last N lines of `aggregatedOutput`.

### 7.2 `digestFileChange`

- `kind: "add"` → `changeKind: "A"`.
- `kind: "modify"` → `changeKind: "M"`.
- `kind: "delete"` → `changeKind: "D"`.
- `kind: "rename"` → `changeKind: "R"`.
- Missing `kind`, `linesAdded > 0`, `linesRemoved === 0` → inferred `A`.
- Missing `kind`, `linesAdded` and `linesRemoved` both 0, `content` present → counts computed from content.

### 7.3 `digestItem` agent_message

- `phase: "final_answer"` → `isFinal: true`.
- `phase: null` → `isFinal: true` (legacy default).
- `phase: "interim"` or anything else → `isFinal: false`.

### 7.4 `writeHistoryMd` — ordering

Given a fixture with lines in order `[cmd, msg, cmd, file_change, msg(final)]`, assert that the rendered markdown contains them in exactly that order (find each anchor string and assert ascending positions).

### 7.5 `writeHistoryMd` — fencing

- Agent message fenced in ```` ```markdown ```` with two-space indentation.
- Multi-line command fenced in ```` ```sh ```` with two-space indentation.
- Failed command with stderr: expect a second fenced block labelled `stderr`.

### 7.6 No "Final answer" / "File changes" / "Commands" / "Messages" sections

Assert none of these strings appear as headings in the rendered output. The only permitted `###` sections are `Usage` and `Timeline`.

### 7.7 `filterHistoryMarkdown` regression

Feed a two-turn history where one turn body contains a fenced block with nested `##` lines. Confirm `splitMarkdownSections` still returns two sections and each body is intact.

---

## 8. Out of scope

- No changes to the event bus payload (`turn-done` etc.) — the `lines` array there is the same ordered list; consumers get the improvement transparently.
- No changes to `codex-team history --format jsonl` — JSONL is machine format, stays as-is.
- No new CLI flags. The new format is default and only format for md.
- No migration tool. Existing `history.md` files were written by the old renderer; leave them. New turns use the new format. Mixed files are readable.
- No changes to `session.ts` runTurn loop; the ordering it produces is already correct.
- No change to monitor event rendering — that's a separate shape emitted in the `turn-done` payload from `events` stream; consumers render it themselves.

---

## 9. Rollout checklist

1. Extend `DigestLine` in `models.ts`.
2. Update `digestCommand`, `digestFileChange`, `digestItem` in `digest.ts`.
3. Replace `formatLine` and `writeHistoryMd` in `digest.ts`.
4. Add tests per §7.
5. `npm run typecheck && npm run build && npm test`.
6. Smoke-test end-to-end: create a session, send a prompt that exercises multi-line commands + file adds + multiple messages, run `codex-team history <name> --format md --last-n 1`, confirm the output matches §4.
7. Grep the repo for references to "File changes" / "Commands" / "Messages" / "Final answer" headings — update any tests or docs that assumed the old shape.

## 10. Files touched

| File | Change kind |
|---|---|
| `src/models.ts` | +3 optional fields on `DigestLine` |
| `src/digest.ts` | rewrite `digestCommand`, `digestFileChange`, `agentMessage` branch, `formatLine`, `writeHistoryMd` |
| `src/history.ts` | no change (verify regex survives fenced content) |
| `test/digest.test.ts` (or add new) | new tests per §7 |
| `test/history.test.ts` (if present) | add regression test per §7.7 |
