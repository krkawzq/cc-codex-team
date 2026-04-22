# REVIEW R3 — events + render re-audit (round 2)

Validation note: this re-audit is from source inspection plus checked-in tests/fixtures. I could not run `npm run typecheck` or `npm test` in `plugins/codex-team` because the worktree does not currently have the required Node dev dependencies installed (`tsc` cannot find `@types/node`, and `vitest` is not on `PATH`).

## Round-1 verdicts

- `B1` Fixed.  
  `createRenderContext()` now clamps `inlineMaxBytes` to `INLINE_MAX_BYTES` while keeping `truncateBytes` separate, so `--truncate` no longer widens the inline/block boundary (`plugins/codex-team/src/format/markdown.ts:187-192`). The added regression test covers the `truncate: 4096` case with a payload larger than `INLINE_MAX_BYTES` and still expects block form (`plugins/codex-team/tests/status-and-format.test.ts:166-175`).

- `B2` Fixed for the original cross-process clobber race.  
  `persistAsync()` now acquires a per-file lock, reloads the on-disk envelope while holding that lock, writes through a unique temp name, and renames into place (`plugins/codex-team/src/daemon/cursors.ts:158-204`). The concurrent-save regression test now verifies two `CursorStore` instances can save without corrupting `cursors.json` (`plugins/codex-team/tests/cursors.test.ts:108-127`). See `M2` below for a new stale-lock liveness hole in the replacement locking scheme.

- `M1` Fixed.  
  `save()` / `delete()` now reject on persist failure and roll back in-memory state (`plugins/codex-team/src/daemon/cursors.ts:57-77,100-111`). A separate best-effort path exists (`plugins/codex-team/src/daemon/cursors.ts:81-98`), and the monitor cursor auto-update path uses that best-effort variant (`plugins/codex-team/src/daemon/handlers/monitor.ts:71-85`).

- `N1` Fixed.  
  `EventLog.append()` now enforces `EVENT_ID_SOFT_LIMIT = 2 ** 52`, emits a one-shot warning event with `kind: "event_id_overflow"`, and refuses further appends (`plugins/codex-team/src/daemon/events.ts:38,321-340`). The regression test covers the one-shot warning event plus refusal of subsequent appends (`plugins/codex-team/tests/events.test.ts:229-248`).

## New findings

### Major

- `plugins/codex-team/src/daemon/run.ts:114-126`  
  `plugins/codex-team/src/daemon/wire.ts:265-288`  
  `plugins/codex-team/src/daemon/handlers/session.ts:213-216,462-469,692-700`  
  `plugins/codex-team/src/daemon/handlers/daemon.ts:80-83`  
  Confidence: high  
  Finding: the new `approval.request_cancelled` / `user_input.request_cancelled` events are only emitted during restart reconciliation. `reconcileLoadedSessionsAfterRestart()` appends them and has coverage (`plugins/codex-team/tests/daemon-restart-reconcile.test.ts:102-129`), but the live teardown/reset paths that also cancel pending approvals or user inputs only abort/remove the registry entries and send JSON-RPC errors back to the waiting client. They do not append the matching cancellation events on live crash, detach, seize, force-heal, or user-destroy paths. Result: monitor/event-log consumers cannot rely on the new event types as authoritative cancellation signals; they appear after restart, but disappear for the same logical outcome during normal runtime.  
  Suggested fix: centralize pending-request cancellation into a helper that both aborts/removes the requests and emits `approval.request_cancelled` / `user_input.request_cancelled`, then call it from all teardown/reset paths.

- `plugins/codex-team/src/daemon/cursors.ts:162-204`  
  Confidence: medium  
  Finding: the new cursor lock has no stale-lock recovery. `acquireCursorLock()` uses `open(lockPath, "wx")` and retries `EEXIST` until a 2s timeout, but the lock file stores no owner metadata and is never reclaimed. If a process dies after taking the lock but before `releaseLock()` runs, every future cursor write for that user times out indefinitely until someone manually deletes `cursors.json.lock`. The original data-clobber race is fixed, but crash recovery for the replacement lock is incomplete.  
  Suggested fix: record owner metadata and reclaim stale locks via PID/mtime validation, or switch to an OS-level advisory lock that is released automatically on process exit.

## Cross-boundary checks

- Compact `turn.completed` payload consumption still looks consistent. `normalize.ts` keeps the payload lean (`plugins/codex-team/src/daemon/normalize.ts:124-138`), `messageWait` forwards the compact fields (`plugins/codex-team/src/daemon/handlers/message.ts:646-665`, `plugins/codex-team/tests/message-wait.test.ts:77-104`), and `wire.ts` only needs `turn_id` for session bookkeeping (`plugins/codex-team/src/daemon/wire.ts:103-112`). I did not find a current consumer still depending on embedded `turn.items`.

- Snapshot fixture stability looks intact by inspection. The snapshot harness freezes time before rendering (`plugins/codex-team/tests/markdown-snapshot.test.ts:50-66`), and the new `context-with-turns` fixture / expected pair matches the current `renderContext()` behavior.

- `auto_approved` summary still prefers `matched_pattern=...` (`plugins/codex-team/src/daemon/handlers/monitor.ts:434-436`, `plugins/codex-team/tests/monitor-summary.test.ts:166-203`), even though the event now also carries `decision`.

- The new cancellation event types would still summarize sanely when they exist: `approval.request_cancelled` hits the `approval.*` branch, and `user_input.request_cancelled` falls back to `request_id`. I did not flag summary projection itself.

- Delta filtering is unchanged in the two relevant boundaries. `EventLog.listSince()` still drops `*_delta` unless `includeDelta` is requested (`plugins/codex-team/src/daemon/events.ts:190-207`), and `monitor events` still applies the same `isDeltaType()` gate (`plugins/codex-team/src/daemon/handlers/monitor.ts:93-96`).
