# XFIX 1 Report

Repo: `/home/wzq/Code/Projects/cc-codex-team`
Branch: `0.5.2-integration`
Start base: `5ebd97a`
End head: `893925a`

Note: `AUDIT_B.md` was not present at repo root. B-related intent was inferred from the integrated source tree and existing tests.

## Commits

- `c66cb05` `fix(xfix1): wire short output to real runtime fields`
- `aa83e73` `fix(xfix1): preserve compact turn data in message wait`
- `f1e8b5e` `fix(xfix1): normalize integration event projections`
- `aee4c9c` `fix(xfix1): harden session heal recovery paths`
- `893925a` `fix(xfix1): tighten help and recovery regression coverage`

## Item-by-item

1. `--short` formatters and real fields
- Fixed.
- `src/format/short.ts` now reads `current_turn_id` / `items_in_turn` instead of relying on old nested turn objects, and treats explicit `current_turn_id: null` as `busy=n`.
- `status` now returns real `retained_limit` and `app_server_count`, so `status --short` is end-to-end real instead of synthetic.
- Extended `tests/short-format.test.ts` to cover the real scalar fields, not just fallback behavior.

2. `message wait` and compact `turn.completed`
- Fixed.
- `src/daemon/handlers/message.ts` now carries through `status`, `duration_ms`, `items_count`, `token_usage`, `ended_at`, and `turn_items_included` from compact `turn.completed` events.
- Extended `tests/message-wait.test.ts` for both live-wait and historical-event paths.

3. `session.closed` / `session.crashed` in `monitor --summary`
- Fixed.
- `src/daemon/handlers/monitor.ts` now emits `reason=...` keys for both event types.
- Extended `tests/monitor-summary.test.ts`.

4. `auto_approved` in `monitor --summary`
- Fixed.
- `monitor --summary` now emits `matched_pattern=...` for `auto_approved`.
- Covered in `tests/monitor-summary.test.ts`.

5. `autoApprovalReview` renderer vs C event shape
- Harmonized.
- `auto_approved` events now include `decision`, matching the renderer’s expected shape more closely for future wiring.
- Existing defensive renderer in markdown stayed unchanged.
- Covered in `tests/auto-approve.test.ts`.

6. `session heal` and crashed state
- Fixed.
- `sessionHeal` now rejects unexpected persisted states instead of trying to heal them.
- Tests now cover:
- crashed happy path
- already-healthy path
- `--force` path
- weird-state rejection

7. Persistent cursor store after daemon restart
- Verified; behavior was already correct.
- Extended `tests/cursors.test.ts` to reopen a fresh `CursorStore` instance and assert `list()` still returns the saved cursor.

8. `--stderr-to` retry end-to-end
- Verified; behavior was already correct.
- Extended `tests/daemon-spawn-stderr.test.ts` to assert the first attempt is the clean detached spawn and the retry is the `--stderr-to <path>` spawn, with the path surfaced in the CLI error.

9. Help output coherence
- Fixed where needed.
- Added cross-references between `session health` and `session heal`.
- Added `--short` incompatibility text for `session list --format table` and `message history --format markdown`.
- Added an explicit `daemon config set session.auto_approve_command_patterns ...` example.
- Built `dist/main.js` and manually checked:
- `node dist/main.js --help`
- `node dist/main.js session health --help`
- `node dist/main.js session heal --help`
- `node dist/main.js message wait --help`
- `node dist/main.js cursor save --help`
- `node dist/main.js cursor list --help`
- `node dist/main.js cursor get --help`
- `node dist/main.js cursor delete --help`
- `node dist/main.js daemon config set --help`

10. Event type list completeness
- Fixed.
- Added exported constants in `src/daemon/events.ts` for:
- `AUTO_APPROVED_EVENT_TYPE`
- `SESSION_CLOSED_EVENT_TYPE`
- `SESSION_CRASHED_EVENT_TYPE`
- Rewired daemon code to use the new session lifecycle constants.
- Added coverage in `tests/events.test.ts`.

## Residual Findings For Phase 2

- `daemon user list --short` still depends on fields the handler does not currently populate for live-session counts, so it can still print `live=unknown`. This was outside the requested fix list and was left unchanged.
- `AUDIT_B.md` was missing from repo root, so the B-side audit had to be reconstructed from code/tests rather than the original worker notes.

## Validation

- After each commit: `npm run typecheck && npm test`
- Final result: `npm run typecheck` passes and `npm test` passes
- Final suite count: `225` tests passed
