# REVIEW_R2_cli_r2

Validation note: static source audit plus targeted test inspection. I attempted a focused Vitest run under `plugins/codex-team/` (`npm test -- tests/short-format.test.ts tests/monitor-cursor.test.ts tests/paths-and-args.test.ts tests/cli-run.test.ts tests/help.test.ts tests/session-health.test.ts tests/session-heal.test.ts tests/status-and-format.test.ts`), but this worktree does not have the local dev dependency installed (`sh: 1: vitest: not found`).

## Round-1 Findings Re-Verification

### B1. `--short` drops pagination
Verdict: **resolved**

Evidence:
- `runCli()` still gates `--short` centrally and rejects `--short` with `--format markdown` or `--format table` before daemon contact, so the compact footer path is the only allowed mixed-format path now. File: `plugins/codex-team/src/cli/run.ts:52-61`
- `formatShort()` now appends footer lines for `session:list` and `message:history` instead of replacing the whole envelope with row text only. File: `plugins/codex-team/src/format/short.ts:3-30`, `plugins/codex-team/src/format/short.ts:348-407`
- The handlers still emit the metadata the footers need: `sessionList()` returns `next_cursor` / `all` / `sort` / `format`, and `messageHistory()` returns `next_cursor` / `relative_since` / `format` / `note`. File: `plugins/codex-team/src/daemon/handlers/session.ts:358-390`, `plugins/codex-team/src/daemon/handlers/message.ts:154-190`
- The formatter/unit expectations and CLI-level output checks both cover the compact footer contract. File: `plugins/codex-team/tests/short-format.test.ts:179-202`, `plugins/codex-team/tests/cli-run.test.ts:244-327`

Note:
- The live `messageHistory()` note string is now longer than the mock note string used in `tests/short-format.test.ts`, but the footer structure itself is preserved and the pagination metadata is no longer dropped.

### B2. `monitor events --cursor` advances on interrupted/overflow close
Verdict: **resolved**

Evidence:
- Cursor persistence is now keyed off `lastAckedEventId`, not `lastObservedEventId`; closing a stream without an ack leaves the persisted cursor unchanged. File: `plugins/codex-team/src/daemon/handlers/monitor.ts:50-91`
- The daemon stream layer exposes explicit ack callbacks and retires overflowed streams before any later ack can be processed. File: `plugins/codex-team/src/daemon/server.ts:88-105`, `plugins/codex-team/src/daemon/server.ts:128-153`, `plugins/codex-team/src/daemon/server.ts:182-205`
- The CLI only sends `stream_ack` for `monitor:events`, and only after the corresponding stdout write has completed or drained. File: `plugins/codex-team/src/cli/run.ts:230-255`, `plugins/codex-team/src/cli/run.ts:281-315`, `plugins/codex-team/src/cli/run.ts:524-552`
- There is direct coverage for “close before ack” and “ack only after stdout drains”. File: `plugins/codex-team/tests/monitor-cursor.test.ts:168-210`, `plugins/codex-team/tests/cli-run.test.ts:501-554`

Residual risk:
- I did not find a dedicated regression test for the specific “stream consumer too slow” overflow-close path, but the current code path shares the same no-ack/no-persist invariant.

### M1. `--flag=value` for globals
Verdict: **resolved**

Evidence:
- The first global-flag pass now splits `--name=value` before looking up the global flag spec. File: `plugins/codex-team/src/cli/args.ts:92-103`, `plugins/codex-team/src/cli/args.ts:179-183`
- Parser coverage includes both `--bearer=token-1` and `--daemon-sock=/tmp/codex-team.sock`. File: `plugins/codex-team/tests/paths-and-args.test.ts:139-149`
- CLI integration coverage verifies that `runCli(["--bearer=token-1", "status"])` forwards the bearer correctly after command resolution. File: `plugins/codex-team/tests/cli-run.test.ts:77-105`

### N1. Error envelope duplicated — `forwardDaemonError` helper
Verdict: **resolved**

Evidence:
- `cli/run.ts` now defines a shared `forwardDaemonError()` helper. File: `plugins/codex-team/src/cli/run.ts:554-556`
- All three daemon-error forwarding sites use that helper: one-shot response errors, streaming `stream_end` errors, and streaming `response` errors. File: `plugins/codex-team/src/cli/run.ts:171-173`, `plugins/codex-team/src/cli/run.ts:290-295`, `plugins/codex-team/src/cli/run.ts:302-307`

### N2. `-n` in `long` field of help schema
Verdict: **resolved**

Evidence:
- The affected help entries now model `-n` via the `short` field, not `long`. File: `plugins/codex-team/src/cli/help.ts:363-369`, `plugins/codex-team/src/cli/help.ts:893-899`
- Help tests assert the rendered output shows `-n` as a short-only flag and no longer formats it as `-n, ...`. File: `plugins/codex-team/tests/help.test.ts:109-117`

## New Findings

No new cross-boundary defects found in the requested areas.

## Cross-Boundary Checks

- `--short` with `--format markdown` or `--format table` is rejected in the CLI layer before daemon contact. File: `plugins/codex-team/src/cli/run.ts:53-61`, `plugins/codex-team/tests/cli-run.test.ts:322-327`
- `--truncate <N>` help text is current for both history and tail, and still documents `0` as “disable clipping.” File: `plugins/codex-team/src/cli/help.ts:857-863`, `plugins/codex-team/src/cli/help.ts:907-913`, `plugins/codex-team/tests/help.test.ts:102-106`
- The `cli/args.ts` changes do not show a source-level regression in the touched parser cases; coverage exists for repeated flags, negative numbers, `--flag=value`, subgroup help, cursor flags, and the newer `session health` / `session heal` / `message wait` commands. File: `plugins/codex-team/tests/paths-and-args.test.ts:98-217`
- `session health` and `session heal` are still outside `SHORT_COMMANDS`, and that looks acceptable rather than a regression. Help does not advertise `--short` for either command, `session health` already returns a compact fixed-shape JSON snapshot, and `session heal` is a mutating response where compact text would discard useful state. File: `plugins/codex-team/src/cli/args.ts:218-225`, `plugins/codex-team/src/cli/help.ts:667-707`, `plugins/codex-team/src/daemon/handlers/session.ts:400-487`, `plugins/codex-team/tests/session-health.test.ts:37-120`, `plugins/codex-team/tests/session-heal.test.ts:53-214`
