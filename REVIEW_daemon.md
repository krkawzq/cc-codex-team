# Review: daemon (0.5.5 dogfood)

## P0 — crash / data loss / security / protocol
- none

## P1 — wrong behavior
- [P1] plugins/codex-team/src/daemon/sessions.ts:126 — callers in plugins/codex-team/src/daemon/run.ts:191, plugins/codex-team/src/daemon/handlers/daemon.ts:114, and plugins/codex-team/src/daemon/handlers/status.ts:24 treat crashed records as live because `listLive()` returns every tracked session.
  Why it's P1: normal crashed-session cleanup gets stuck in hot paths: idle auto-shutdown never fires, `status` lies about live sessions, and `daemon user destroy` spuriously requires `--force`.
  Fix sketch: split the API into true live-vs-all accessors, or filter `state === "live"` at every callsite that means “live”.

- [P1] plugins/codex-team/src/daemon/run.ts:224 — the stale-pidfile recovery path never cleans up malformed/empty `daemon.pid` files because `readPidFile()` returning `null` skips the unlink branch at plugins/codex-team/src/daemon/run.ts:266.
  Why it's P1: a torn pidfile after crash or disk-full turns startup into a 3s retry loop followed by a hard failure until someone deletes the file manually.
  Fix sketch: when the sock is unreachable, treat unreadable pidfiles as stale artifacts and unlink them (or fail fast with a specific diagnostic instead of timing out).

- [P1] plugins/codex-team/src/daemon/events.ts:355 — one malformed line in `events.log` makes `parsePersistedEvents()` throw at plugins/codex-team/src/daemon/events.ts:761, and the async loader then resets the user to empty state at plugins/codex-team/src/daemon/events.ts:369-371.
  Why it's P1: a crash during append can erase the entire retained event window on next start, breaking `--since`/`--cursor` resume even when most of the file is still valid.
  Fix sketch: preserve the valid prefix (especially tolerate a torn final line), then compact or trim the bad suffix instead of dropping the whole buffer.

- [P1] plugins/codex-team/src/daemon/handlers/daemon.ts:151 — `daemon:user:destroy` clears sessions and events but never calls `CursorStore.clearUser()` even though the cleanup exists at plugins/codex-team/src/daemon/cursors.ts:161.
  Why it's P1: destroying and then re-creating the same token in the same daemon can surface stale cursors from memory, and pending debounced cursor flushes can recreate `cursors.json` after the user was deleted.
  Fix sketch: clear cursor state as part of user destroy before removing the user directory, and cancel any pending per-user cursor persists.

- [P1] plugins/codex-team/src/daemon/handlers/session.ts:56 — `session new`/`session attach` only validate user ownership before awaited RPCs, while plugins/codex-team/src/daemon/handlers/daemon.ts:108 and plugins/codex-team/src/daemon/shutdown.ts:11 can tear the user/daemon down concurrently, and plugins/codex-team/src/daemon/server.ts:59 still accepts new requests once shutdown starts.
  Why it's P1: concurrent `daemon user destroy` or daemon shutdown can race with session creation/attach and leave resurrected live state under a deleted or exiting daemon.
  Fix sketch: add daemon/user lifecycle gates, re-check them after awaits, and reject new IPC requests once shutdown begins.

- [P1] plugins/codex-team/src/ipc/sock.ts:24 — malformed JSON, batched arrays, and other wrong-shaped frames are silently ignored, and plugins/codex-team/src/daemon/server.ts:28-32 then drops anything that is not a custom single `request`.
  Why it's P1: protocol mistakes become “hung request” failures, which is especially bad for request-id matching on a single socket and for explicitly unsupported batch input.
  Fix sketch: validate the top-level frame shape, reject arrays/unknown kinds deterministically, and either emit a structured error or close the connection immediately.

## P2 — polish / smell / docs drift
- [P2] plugins/codex-team/src/ipc/protocol.ts:22 — `stream_start` is part of the declared IPC surface, but plugins/codex-team/src/daemon/server.ts:63-80 never emits it.
  Why it's P2: this is confusing rather than directly user-breaking today, but it leaves dead protocol surface area for future clients/tests.
  Fix sketch: either remove `stream_start` from the protocol type or emit it consistently before the first chunk.

- [P2] plugins/codex-team/src/daemon/cursors.ts:343 — malformed `.lock` files are never reclaimable because `readCursorLock()` returns `null` at plugins/codex-team/src/daemon/cursors.ts:401-421 and `reclaimStaleCursorLock()` only unlinks syntactically valid stale locks.
  Why it's P2: a torn lock file is rare, but after a crash it turns cursor saves into repeated 2s timeouts until manual cleanup.
  Fix sketch: treat unreadable lock records as stale after ownership verification fails or after timeout, then log the recovery.

## Contract drift (docs vs code)
- skill:plugins/codex-team/skills/using-codex-team/mental-model.md:34 says app-server death “re-acquire[s] a client, and attempt[s] `thread/resume`”, but code at plugins/codex-team/src/daemon/wire.ts:241-279 marks sessions crashed, cancels pending requests, and requires explicit `session heal`.
- skill:plugins/codex-team/skills/using-codex-team/mental-model.md:50 says live app-server bindings are “lazy re-spawn on next interactive command”, but code at plugins/codex-team/src/daemon/handlers/message.ts:646-652 rejects unhealthy sessions and code at plugins/codex-team/src/daemon/handlers/session.ts:517-573 requires an explicit `session heal`.
- skill:plugins/codex-team/skills/recover-codex-team/SKILL.md:19 says restart emits synthetic `session.pending_dropped` when pending requests existed, but code at plugins/codex-team/src/daemon/sessions.ts:14-23 and plugins/codex-team/src/daemon/run.ts:138-151 no longer persists the counters needed to synthesize that event after a full restart.
- skill:plugins/codex-team/skills/recover-codex-team/SKILL.md:21 and skill:plugins/codex-team/skills/recover-codex-team/known-quirks.md:101 say orphan reaping verifies `pid + start_time + nonce`, but code at plugins/codex-team/src/daemon/orphans.ts:191-200 never consults `nonce` during identity checks.

## Test gaps
- `daemon-run-platform.test.ts` — missing malformed/empty `daemon.pid` recovery and malformed legacy pidfile cases.
- `daemon-user-destroy.test.ts` / `monitor-cursor.test.ts` — missing user-destroy coverage for cursor cleanup, pending debounced cursor flush, and token re-create after destroy.
- `events.test.ts` / `monitor-cursor.test.ts` — missing restart/load coverage for truncated `events.log` and malformed `cursors.json.lock` after crash.
- `server.test.ts` / `ipc-sock.test.ts` — missing explicit invalid/batch frame rejection, duplicate streaming request-id reuse, and wrong-shaped id handling.
- `session-handlers.test.ts` / `shutdown.test.ts` — missing concurrent `session new` / `session attach` against `daemon user destroy` or daemon shutdown.

## Notes
- Targeted baseline I ran: `npx vitest run tests/daemon-run-platform.test.ts tests/daemon-user-destroy.test.ts tests/server.test.ts tests/monitor-cursor.test.ts tests/events.test.ts tests/daemon-restart-reconcile.test.ts` (all passing).
