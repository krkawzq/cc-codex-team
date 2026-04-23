# Review: format (0.5.5 dogfood)

## P0 — crash / data loss / security / protocol
- none

## P1 — wrong behavior
- [P1] plugins/codex-team/src/format/markdown.ts:345 — `createRenderContext()` shrinks `inlineMaxBytes` to the user-supplied `--truncate` budget, so `--truncate 80` changes inline/body shape instead of only clipping content.
  Why it's P1: the shipped contract says truncation clips rendered bodies without changing the inline/block threshold, but current code flips `<user-input>`, `<reasoning>`, and large JSON sub-tags between inline and block forms under normal use.
  Fix sketch: keep `inlineMaxBytes` pinned to `INLINE_MAX_BYTES` and use the parsed flag only for `truncateBytes`.

- [P1] plugins/codex-team/src/daemon/handlers/message.ts:214 — `message history --format markdown` and `message tail --format markdown` render `thread/turns/list` results as if they contained turn items, but that RPC only returns turn metadata.
  Why it's P1: the main read path advertised as a transcript cannot show user/assistant text, shell output, file patches, or tool summaries in production; it degrades to mostly empty `<turn>` wrappers.
  Fix sketch: either reconstruct item content from a real source before rendering, or explicitly downgrade the markdown contract to a metadata-only format and surface that limitation inside the rendered output.

## P2 — polish / smell / docs drift
- [P2] plugins/codex-team/src/format/markdown.ts:71 — `renderContext()` plus the `context` snapshot fixtures model a markdown `session context` view that no CLI path can emit.
  Why it's P2: this is dead formatter surface, but it gives false confidence that `session context` markdown is supported and covered when the handler rejects it.
  Fix sketch: remove the unused renderer/fixtures, or wire them to a real command and add handler/CLI coverage.

## Contract drift (docs vs code)
- skill:plugins/codex-team/skills/configure-codex-team/cli-reference.md:19,133-134 says `session context` accepts `--format markdown`, but code at plugins/codex-team/src/daemon/handlers/session.ts:357-360 only accepts `json`.
- skill:plugins/codex-team/skills/using-codex-team/SKILL.md:134 says `session context` / `message history` / `message tail` all return tag-structured markdown, but code at plugins/codex-team/src/daemon/handlers/session.ts:357-360 rejects `session context` markdown and code at plugins/codex-team/src/daemon/handlers/message.ts:214-264 only has `thread/turns/list` / `thread/read` metadata to render.
- doc:plugins/codex-team/docs/html-md-format.md:17-19,70-76,125-190 describes transcript-style `history` / `tail` output and context-only tags like `<system>`, `<developer>`, and `<compacted>`, but plugins/codex-team/skills/recover-codex-team/known-quirks.md:11-21 says those RPCs do not return past items, and plugins/codex-team/src/format/markdown.ts:71 is unused by production code.
- doc:plugins/codex-team/docs/html-md-format.md:92-110 says `tool.*` carries `args` in attrs and omits `auto-approval-review`, `mcp-args`, `mcp-result`, and `hook-output`, but plugins/codex-team/src/format/markdown.ts:420-492 emits those tags and fixtures under plugins/codex-team/tests/fixtures/markdown/*.expected.md snapshot them.
- skill:plugins/codex-team/skills/using-codex-team/quickstart.md:113 says the CLI response contains a `markdown` field, but plugins/codex-team/src/cli/run.ts:219-221 and 371-375 strip the wrapper and print raw markdown directly.
- skill:plugins/codex-team/skills/configure-codex-team/cli-reference.md:176 and skill:plugins/codex-team/skills/manage-codex-team/SKILL.md:116 say concise `message send` output uses `{started, turn_id, queue_id, queued_depth}`, but plugins/codex-team/src/format/compact.ts:335-347 emits `{status:"started"|"queued", ...}`.

## Test gaps
- plugins/codex-team/tests/status-and-format.test.ts — missing a case where `truncate < INLINE_MAX_BYTES` must not change inline vs block rendering.
- plugins/codex-team/tests/message-handlers.test.ts / plugins/codex-team/tests/cli-run.test.ts — missing a production-shaped markdown history/tail case where `threadTurnsList()` returns turns without `items`, so the current transcript failure never appears.
- plugins/codex-team/tests/markdown-snapshot.test.ts — snapshots an unreachable `context` renderer instead of asserting the real `session context --format markdown` rejection path.

## Notes
- Focused suites pass today (`status-and-format`, `markdown-snapshot`, `compact-format`, `short-format`, `cli-run`), so the current failures are contract/coverage gaps rather than red tests.
- I did not find a standalone JSONL/NDJSON emitter bug in this scope: successful JSON paths write one object plus one trailing newline, markdown bypasses the JSON wrapper intentionally, and the error envelope from `result.ts` / `errors.ts` stays structurally stable.
