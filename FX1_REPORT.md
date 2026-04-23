# FX1 Report — daemon core fixes (Phase 2b)

Branch: `0.5.2-FX1-daemon`

Base reviewed scope:
- `REVIEW_R1_daemon.md`
- `REVIEW_R4_config_build.md`
- `AUDIT_A.md`
- `AUDIT_C.md`
- `XFIX_1_REPORT.md`

## Fixed review items

### 1. R1 B1 + R4 B — session-level `--auto-approve` validation
- Added explicit validation for session-supplied auto-approve patterns on:
  - `session new`
  - `session attach`
  - `session fork`
- Reused the same regex validation path as config validation via the shared auto-approve validator.
- Invalid session patterns now fail fast with `invalid_params` instead of persisting poisoned state.
- Persisted `sessions.json` loads now warn and drop malformed stored patterns instead of allowing them to break approval handling later.
- `matchAutoApprovePattern()` now catches per-pattern matcher failures, logs a warning, and treats the bad pattern as a non-match.

### 2. R1 B2 — `message wait` terminal status normalization
- `terminalWaitResult()` now derives `outcome` from normalized `turn.completed` status.
- `turn.completed` with `status: "completed"` returns `outcome: "completed"`.
- `turn.completed` with `status: "errored"` or `status: "cancelled"` returns `outcome: "error"`.
- CLI exit behavior remains correct because it already keys off `outcome`.

### 3. R1 B3 — restart reconciliation of stale live sessions
- Added startup reconciliation after `reapOrphans()`.
- Persisted sessions still marked `live` but lacking an active pool binding are now marked:
  - `state: "crashed"`
  - `recovery_state: "degraded"`
  - `crash_reason: "app_server_crashed_on_restart"`
- Restart reconciliation clears stale in-turn runtime state and zeroes pending counters.
- A synthetic `session.crashed` event is emitted with `reason: "app_server_crashed_on_restart"`.
- Pending approval and user-input requests associated with newly crashed sessions are cancelled and emit:
  - `approval.request_cancelled`
  - `user_input.request_cancelled`

### 4. R1 M1 — narrow `server_request_resolved` fallback
- Removed the cross-client per-user fallback that guessed pending requests by bare JSON-RPC id.
- Unknown-client `server_request_resolved` notifications are now logged and dropped.
- This avoids deleting unrelated pending approvals/user-input requests from other live clients.

### 5. R1 M2 — backfill lifecycle fields on persisted session load
- `loadForUser()` now normalizes pre-0.5.2 records with runtime defaults for missing lifecycle fields.
- Backfilled fields include:
  - `state`
  - `last_turn_id`
  - `current_turn_id`
  - `current_turn_started_at`
  - `current_item_type`
  - `items_in_turn`
  - `pending_approvals`
  - `pending_user_inputs`
  - `token_usage_last_turn`
  - `crash_reason`
- Verified that a pre-lifecycle `sessions.json` record now loads cleanly and `session heal` accepts it.

### 6. R1 N1 — dead persisted `app_server_client_id`
- Decision: drop it from persisted session state.
- Reason:
  - it represents an in-process pool binding, not durable session identity
  - it is meaningless across daemon restart
  - nothing in runtime uses it for correlation or recovery
- Load path now ignores legacy persisted copies by reconstructing normalized records.
- Subsequent persistence omits the field entirely.

## Tests added/updated
- `tests/auto-approve.test.ts`
  - matcher failure no longer poisons pending approval flow
- `tests/session-handlers.test.ts`
  - invalid session auto-approve patterns rejected on new/attach/fork
- `tests/session-registry.test.ts`
  - invalid persisted patterns warn + drop
  - pre-0.5.2 sessions backfill lifecycle fields
  - healed records persist without `app_server_client_id`
- `tests/message-wait.test.ts`
  - historical `turn.completed` fixtures for `completed` / `errored` / `cancelled`
- `tests/wire.test.ts`
  - unknown-client resolved notifications no longer remove arbitrary pending requests
- `tests/daemon-restart-reconcile.test.ts`
  - stale live session is crashed and emits cancellation events on restart
- `tests/events.test.ts`
  - new cancellation event type constants exported centrally

## Verification
- `npm run typecheck`
- `npm test`
- Result: green (`235` tests passing in this worktree)

## Commits
- `fix(FX1/session): validate and normalize persisted session state`
- `fix(FX1/message): normalize wait outcomes and resolved fallback`
- `fix(FX1/run): reconcile stale sessions after restart`

## Residuals / Phase 3 notes
- New cancellation event types are emitted and persisted, but no monitor/UI formatting changes were made in this worktree.
- Unknown-client `server_request_resolved` notifications are intentionally dropped rather than heuristically correlated; legitimate leftovers are expected to be cleaned by session teardown/restart paths.
