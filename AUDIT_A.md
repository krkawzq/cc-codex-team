# AUDIT_A

Worker: A / session-lifecycle
Branch: `0.5.2-A-lifecycle`

## Scope Delivered

- B.1: added `session health <name>`
- B.2: added `message wait <session> [--for <turn_id>] [--timeout <s>]`
- B.3: added `session.crashed` handling and explicit crashed session state
- F.4: added `session heal <name> [--force]`
- F.5: added `session.closed` events with reason payloads

## Commands Added

- `session health`
  - Returns live snapshot fields:
    - `session`
    - `thread_id`
    - `state`
    - `busy`
    - `current_turn_id`
    - `current_turn_started_at`
    - `current_turn_elapsed_ms`
    - `current_item_type`
    - `items_done_in_turn`
    - `pending_approval_requests`
    - `pending_user_input_requests`
    - `token_usage_last_turn`
    - `app_server_alive`
    - `last_event_id`

- `session heal`
  - Reattaches a crashed or dead live session to a fresh app-server
  - `--force` clears queued/pending in-memory state before resuming
  - Healthy sessions return `{ ok: true, note: "already healthy" }`

- `message wait`
  - Waits on the current turn by default
  - If idle, waits for the next turn that starts after the call
  - `--for <turn_id>` targets a specific turn
  - `--timeout 0` disables timeout
  - CLI exit codes:
    - `0` on `turn.completed`
    - `1` on `turn.error` or session failure
    - `124` on timeout

## Session Fields Added

Added to `plugins/codex-team/src/daemon/sessions.ts`:

- `state: "live" | "crashed"`
- `last_turn_id`
- `current_turn_id`
- `current_turn_started_at`
- `current_item_type`
- `items_in_turn`
- `pending_approvals`
- `pending_user_inputs`
- `token_usage_last_turn`
- `crash_reason`

Also added helpers:

- `sessionRuntimeDefaults()`
- `normalizeTokenUsage()`
- `isoFromUnixSeconds()`

## New Event Behavior

- `session.crashed`
  - Payload:
    - `session`
    - `thread_id`
    - `reason`
    - `last_turn_id`

- `session.closed`
  - Payload:
    - `session`
    - `thread_id`
    - `reason`
    - `ts`
  - Reasons emitted:
    - `user_detach`
    - `daemon_shutdown`
    - `app_server_crashed`
    - `idle_unload`
    - `user_destroyed`

## Runtime Lifecycle Changes

- Unexpected app-server process exit no longer auto-recovers
- Sessions are marked `crashed` with `crash_reason`
- Pending approval / user_input requests are aborted with deterministic `session_crashed` failure text/data
- Idle `client_close` notifications now unload idle sessions instead of rehydrating them
- Daemon shutdown and user destroy emit `session.closed` before cleanup

## Tests Added

- `plugins/codex-team/tests/session-health.test.ts`
- `plugins/codex-team/tests/message-wait.test.ts`
- `plugins/codex-team/tests/session-heal.test.ts`

Also updated existing CLI/help/lifecycle tests:

- `cli-run.test.ts`
- `help.test.ts`
- `paths-and-args.test.ts`
- `session-handlers.test.ts`
- `wire.test.ts`
- `shutdown.test.ts`
- `daemon-user-destroy.test.ts`
- `experimental-tools.test.ts`

## Validation

- `npm run typecheck`
- `npm test`

Both green at the end of this branch.

## Follow-ups Noted

- `session.closed` on `thread.closed` is currently mapped to `user_detach` because there is no more specific close reason in the current notification shape.
- `Thread.turns` was added to the RPC type to satisfy an existing renderer typecheck issue without touching Worker D's formatter file.
- The current event log API is still user-scoped; session health derives `last_event_id` by scanning the retained user buffer for the latest matching session event.
