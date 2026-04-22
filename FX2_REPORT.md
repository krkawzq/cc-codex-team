# FX2 Report

Date: 2026-04-23
Worktree: `/home/wzq/Code/Projects/cct-worktrees/FX2-cli-events`
Branch: `0.5.2-FX2-cli-events`
Base: `0.5.2-integration @ 3a8ee18`

## Scope Completed

All 8 requested FX2 items were implemented in owned files only.

1. `R2 B1` short output now preserves contract metadata with compact footer lines.
   - `session list --all --short` keeps `next_cursor`, `all`, `sort`, and `format`.
   - `message history --short` keeps `format` and the protocol `note`.

2. `R2 B2` monitor cursor auto-advance now follows explicit delivery acks instead of observation.
   - Added stream-ack plumbing between CLI and daemon.
   - Monitor cursor writes are driven by acked event IDs only.
   - Abrupt close without ack no longer advances the saved cursor.

3. `R2 M1` global `--flag=value` parsing now works in the first pass.
   - Verified for `--bearer=...` and `--daemon-sock=...`.

4. `R3 B1` markdown render context no longer lets `--truncate` raise the inline threshold above `INLINE_MAX_BYTES`.
   - The inline threshold is now capped, not replaced.
   - Low truncate values still force block rendering as before.

5. `R3 B2` cursor persistence is now cross-process safe.
   - Replaced fixed `.tmp` writes with unique temp files.
   - Added a simple lock file to serialize cross-process writes.
   - Concurrent saves now leave a valid merged `cursors.json`.

6. `R3 M1` strict cursor persistence failures now propagate.
   - `save()` / `delete()` reject on disk failure.
   - Added explicit `saveBestEffort()` for monitor auto-updates.

7. `R2 N1` daemon error forwarding is centralized through `err(...)`.
   - Added `forwardDaemonError(...)` and used it in all duplicated paths.

8. `R2 N2` help schema now supports short-only `-n` flags cleanly.
   - `daemon logs` and `message tail` render `-n` as a short-only flag.

## Files Changed

- `plugins/codex-team/src/cli/args.ts`
- `plugins/codex-team/src/cli/help.ts`
- `plugins/codex-team/src/cli/run.ts`
- `plugins/codex-team/src/daemon/cursors.ts`
- `plugins/codex-team/src/daemon/dispatch.ts`
- `plugins/codex-team/src/daemon/handlers/monitor.ts`
- `plugins/codex-team/src/daemon/server.ts`
- `plugins/codex-team/src/format/markdown.ts`
- `plugins/codex-team/src/format/short.ts`
- `plugins/codex-team/tests/cli-run.test.ts`
- `plugins/codex-team/tests/cursors.test.ts`
- `plugins/codex-team/tests/help.test.ts`
- `plugins/codex-team/tests/monitor-cursor.test.ts`
- `plugins/codex-team/tests/monitor-events.test.ts`
- `plugins/codex-team/tests/monitor-summary.test.ts`
- `plugins/codex-team/tests/paths-and-args.test.ts`
- `plugins/codex-team/tests/short-format.test.ts`
- `plugins/codex-team/tests/status-and-format.test.ts`

## Verification

Dependencies were missing in this worktree, so local dev dependencies were installed with:

```bash
cd plugins/codex-team
npm ci
```

Validation commands:

```bash
cd plugins/codex-team
npm run typecheck
npm test
```

Result:

- `npm run typecheck` passed
- `npm test` passed
- Full suite: `45` files passed, `237` tests passed

## Notes

- No prohibited FX1 / FX3 source files were edited.
- `tests/markdown-snapshot.test.ts` and snapshot fixtures were left untouched.
- No push, merge, or version bump was performed.
