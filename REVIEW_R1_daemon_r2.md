# Review R1 round 2 — daemon core

Base: 0.5.2-integration @ 195ecd085692536d0ccc5b7e10d8a223b28a6725
Original: REVIEW_R1_daemon.md

## Verdict on Round-1 findings
- **B1**: partial — `src` now rejects invalid `session new --auto-approve` regexes and treats matcher throws as logged non-matches, but the shipped `dist/main.js` still accepts invalid regexes and can still throw during matching through `bin/codex-team`.
- **B2**: partial — `src` now derives `message wait` outcome from `turn.completed.payload.status`, but the checked-in runtime bundle still marks every `turn.completed` as success, so the real CLI path remains wrong until `dist` is rebuilt.
- **B3**: partial — `src` now reconciles stale live sessions to `crashed` and emits `session.crashed`, but restart-time per-request cancellation is not recoverable from the fresh in-memory `PendingRegistry`, and the checked-in `dist/main.js` still skips restart reconciliation entirely.
- **M1**: partial — `src` now ignores unknown-client `server_request_resolved`, but the executable bundle still falls back to user-wide bare-id matching and can clear the wrong pending request.
- **M2**: partial — `src` now backfills pre-0.5.2 session records with lifecycle defaults, but the checked-in bundle still loads legacy records raw and still carries dead `app_server_client_id` state.

## New findings (from Phase 2b)
### NB1. Checked-in runtime bundle is stale, so `bin/codex-team` still ships the old daemon behavior
- File: `plugins/codex-team/bin/codex-team`, `plugins/codex-team/dist/main.js`
- Lines: `bin/codex-team` 14-21; `dist/main.js` 3011-3033, 6819-6825, 7506-7518, 8718-8734, 8966-8978
- Confidence: HIGH
- Issue: The launcher executes `dist/main.js`, but that checked-in bundle predates the FX1/FX2/FX3 source fixes. The stale bundle still has the original B1/B2/B3/M1/M2 behavior: no `--auto-approve` regex validation, `turn.completed` always treated as success, unknown-client `server_request_resolved` still does user-wide fallback removal, no persisted-session backfill, and no startup restart reconciliation.
- Suggested fix: Rebuild and commit `plugins/codex-team/dist/main.js` with these merges, or stop vendoring `dist` as an execution boundary; add a CI/release guard that fails when checked-in `dist` is out of sync with `src`.

### NB2. Restart reconciliation cannot emit per-request cancellation events after a real daemon restart
- File: `plugins/codex-team/src/daemon/context.ts`, `plugins/codex-team/src/daemon/run.ts`
- Lines: `context.ts` 49-75; `run.ts` 76-169
- Confidence: HIGH
- Issue: `buildContext()` creates a fresh empty `PendingRegistry` before `reconcileLoadedSessionsAfterRestart()` runs. Because pending request ids are not persisted anywhere, a real daemon restart has no way to recover the lost approval/user-input requests, so the new `approval.request_cancelled` / `user_input.request_cancelled` emission path only works in injected test contexts, not on actual restart.
- Suggested fix: Persist minimal restart-relevant pending metadata (`request_id`, `kind`, `session`, `thread_id`, `turn_id`) or downgrade the contract and emit a single session-scoped synthetic recovery event/warning instead of pretending to cancel specific requests.

## Summary
The TypeScript source-side Phase 2b fixes are mostly coherent: the new event constants are exported, `recovery_state: "degraded"` does not crash the inspected handlers/formatters, and no session schema v2 migration is needed because `sessions.json` remains schema_version 1. The main residual risk is boundary integrity: the executable `dist/main.js` is stale, and restart-time per-request cancellation is still only best-effort because pending requests are not persisted across daemon restarts.
