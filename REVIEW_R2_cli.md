# REVIEW_R2_cli

Validation note: static source audit only. I could not run `npm run typecheck` or `npm test` in `plugins/codex-team/` because this worktree does not have the local dev dependencies installed (`tsc` could not find `@types/node`, and `vitest` was not on `PATH`).

## Blockers

1. `--short` silently drops pagination and contract metadata on paginated commands, which makes the compact form unsafe for scripts that need to continue reading results.
   File: `plugins/codex-team/src/cli/run.ts:175`, `plugins/codex-team/src/format/short.ts:83`, `plugins/codex-team/src/format/short.ts:123`, `plugins/codex-team/src/daemon/handlers/session.ts:376`, `plugins/codex-team/src/daemon/handlers/message.ts:173`
   Confidence: HIGH
   Why: `runCli()` replaces the entire JSON result with `formatShort(...)`. For `session list --all`, the JSON path includes `next_cursor`, `all`, `sort`, and `format`; for `message history`, the JSON path includes `next_cursor` plus the note that turn items are omitted by protocol. The short format emits only row lines, so callers lose the cursor and cannot page safely even though the JSON response would have allowed it.
   Suggested fix: either reject `--short` when the response carries required top-level metadata such as `next_cursor`, or preserve a machine-readable footer/envelope that carries pagination and notes alongside the compact rows.

2. `monitor events --cursor` advances the saved cursor past events that may never reach the caller on interrupted or overflowed streams.
   File: `plugins/codex-team/src/daemon/handlers/monitor.ts:160`, `plugins/codex-team/src/daemon/handlers/monitor.ts:164`, `plugins/codex-team/src/daemon/handlers/monitor.ts:214`, `plugins/codex-team/src/daemon/server.ts:106`, `plugins/codex-team/src/cli/run.ts:318`, `plugins/codex-team/src/main.ts:20`
   Confidence: HIGH
   Why: `monitorEvents()` updates `lastObservedEventId` before delivery and always calls `scheduleCursorUpdate()` from `onClose()`. The stream transport can drop queued frames and close with `"stream consumer too slow"`, and the CLI also closes immediately on `SIGINT` without waiting for blocked stdout to drain before `main()` calls `process.exit(code)`. In both cases the daemon can persist a cursor that points past events the client never printed.
   Suggested fix: only auto-update named cursors after a clean stream completion, or add an explicit ack/commit path for the last delivered event id. At minimum, do not advance the cursor on transport overflow, socket error, or client-interrupt close paths.

## Majors

1. Global flag parsing does not honor `--flag=value` parity even though command-local flags do.
   File: `plugins/codex-team/src/cli/args.ts:92`, `plugins/codex-team/src/cli/args.ts:132`
   Confidence: HIGH
   Why: the first parse pass only recognizes exact global tokens from `GLOBAL_FLAGS`, so `--bearer=tok` and `--daemon-sock=/tmp/daemon.sock` are treated as non-global tokens and can break command resolution with `unknown command`. The second pass supports `--foo=bar`, but only after the command path has already been matched.
   Suggested fix: teach the global-flag pass to split `--name=value`, or reuse the long-flag parsing logic for globals before command matching.

## Nits

1. The CLI does not consistently route daemon-originated errors through `err(code, message)`, so the error envelope is duplicated by hand in multiple places.
   File: `plugins/codex-team/src/cli/run.ts:172`, `plugins/codex-team/src/cli/run.ts:291`, `plugins/codex-team/src/cli/run.ts:303`
   Confidence: HIGH
   Why: these paths stringify `{ ok: false, error: ... }` directly instead of calling the shared helper. The current shape matches, but the contract is now duplicated in three places.
   Suggested fix: add a helper for forwarding daemon error objects through the shared result wrapper and use it in both one-shot and streaming paths.

2. Help metadata models `-n` as a “long” flag in two commands, which is inconsistent with the rest of the help tree.
   File: `plugins/codex-team/src/cli/help.ts:364`, `plugins/codex-team/src/cli/help.ts:894`
   Confidence: HIGH
   Why: `--follow` is represented as `short: "-f", long: "--follow"`, but `-n` is stuffed into the `long` field. The rendered help still works, but the schema is internally inconsistent and makes hyphenation/flag rendering brittle.
   Suggested fix: support short-only flags explicitly in the help schema/renderer, or add a canonical long form if one is intended.

## Non-findings

- `--truncate 0` is handled correctly end-to-end. `parseTruncateFlag()` accepts `0`, and the markdown renderer converts that to `truncateBytes: null`, which disables clipping without forcing everything into a zero-byte body.
- `--short` is rejected before daemon contact on non-whitelisted commands, and `--short` with `--format markdown` or `--format table` returns a clear `invalid_params` error from the CLI layer.
- `message wait` exit-code mapping is internally consistent with the audit claim: `completed -> 0`, `error -> 1`, `timeout -> 124`. Invalid sessions still fail with exit code `1` via the normal error response path.
- The raw-output contract for `cursor get` is at least documented in help (`"Print only the saved event ID for a cursor name."`), and the implementation matches that description.
- I found no remaining `--cursor-file` references in `plugins/codex-team/src`, `plugins/codex-team/tests`, or the phase audit notes.
