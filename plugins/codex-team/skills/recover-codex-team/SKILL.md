---
name: recover-codex-team
description: >-
  Recovery playbook for codex-team failures — error code triage, auto-recovery guarantees, manual intervention paths. Trigger on `turn.error`, `codex_error` envelopes, `session_busy`, `daemon_unreachable`, or repeated mismatched replies. Not for: routine turn handling (`manage-codex-team`), tuning (`configure-codex-team`), topology choice (`codex-team-playbooks`).
---

# Recover codex-team

> The codex-team daemon auto-recovers from most failures. This skill is for the cases where you need to intervene.

## What auto-recovers (you don't need to do anything)

| Failure | Daemon response |
|---|---|
| `server_overloaded` / transient app-server stream/network failures | Retries with backoff (default 3× / 0.25s–2s). If budget exhausted → `response_too_many_failed_attempts` surfaces as `codex_error` |
| app-server process crash | Pool detects EOF; fires `turn.error` for the affected live session(s); re-acquires a client, then attempts `thread/resume` automatically. The lost in-flight turn does not recover, but the live session usually does |
| daemon crash / sudden restart | Persistent state (users, sessions, events, config) reloads. Live sessions keep their `live` flag; no running turn survives, but the session can be used again on next interactive command (lazy re-spawn of app-server) |
| Stale sock file / pidfile | Startup: `connect()` probes; on refusal, pid ownership is checked before aborting. A live pid only blocks startup if it still looks like a `codex-team --daemon-internal` process |
| Orphan codex processes from previous daemon | Startup: `reapOrphans()` reads `codex-pids.json`, verifies identity via `pid + start_time + nonce`, and SIGTERMs only surviving codex app-server children |
| `thread.closed` from codex | Auto-detach: session removed from registry, pending requests cancelled |

### Daemon ownership on startup

The startup guard is stricter than "pidfile exists". codex-team now checks:

- is the socket already reachable?
- does the pidfile pid still exist?
- if it exists, does it still look like the codex-team daemon process that owns this socket path?

If the pid is alive but has been reused by some unrelated process, startup treats the pidfile as stale and continues. Only a live daemon owner blocks a second daemon from starting.

## Symptom → action

| Symptom | First move |
|---|---|
| `daemon_unreachable` on any cli call | Wait up to 15s; cli already retries transient connect/request failures. If still failing: `codex-team daemon logs -n 100` or `ps | grep codex-team` |
| `user_not_found` | Run `codex-team daemon user create <token>` once; treat `user_already_exists` as success |
| `session_not_found` on a session you created | Was it auto-detached via `thread.closed`? Check events log. Re-create or attach by thread_id |
| `session_not_live` | Session was detached. Run `codex-team -b $TOK session attach <name>` |
| `session_busy` | Another user has it live. Either pick a different thread, or `--takeover` (emits `session.seized` to the original holder) |
| `codex_error` with `codex_error_info: context_window_exceeded` | Start a fresh session or fork from an earlier turn. Codex doesn't auto-compact |
| `codex_error` with `codex_error_info: usage_limit_exceeded` | Stop. Nothing to retry. Check codex account quota |
| `codex_error` with `codex_error_info: unauthorized` | Codex auth expired. Run `codex login` out-of-band, then resume |
| `codex_error` with `codex_error_info: active_turn_not_steerable` | Wait for the blocking turn (review or compact). Do not retry `interrupt`/`steer` |
| `codex_error` with `codex_error_info: sandbox_error` | The `--sandbox` on session new is too restrictive for the command codex wants to run. Recreate the session with a wider sandbox, or decline the approval |
| `id_rotated` on `monitor events --since` | Use the `data.oldest_available_id` to resume from the earliest still-retained event |
| `invalid_decision` when approving | You used a shortcut that doesn't fit this approval kind. See `manage-codex-team/approvals.md` |
| Repeated reply mismatches from codex | Known quirk under long context. See `known-quirks.md`. First mismatch: ignore; second mismatch: `session fork` + give fresh context |
| Approvals visible in events but cli says "no pending request" | The request was already resolved (by another client, by takeover, or by timeout). Ignore |

## Manual interventions

### Drain a user's state

```bash
codex-team daemon user destroy <token> --force
```

Without `--force`, destroy is rejected if the user still has live sessions. With `--force`, codex-team closes live sessions, cancels pending requests, clears retained events, and removes the user in one operation.

### Force-kill the daemon (rare)

```bash
codex-team daemon stop --force
```

Bypasses orderly pool shutdown. Leaves events in the log (ring buffer state may be truncated). app-server processes get SIGTERM via orphan-tracking on next daemon start.

### Wipe everything and start fresh (development only)

```bash
bash scripts/dev-reset.sh
```

Stops daemon, `rm -rf ~/.codex-team`, rebuilds. Loses all sessions, events, config.

### Cancel an in-flight turn that's truly stuck

```bash
codex-team -b $TOK message interrupt <session>
```

If interrupt is rejected (`active_turn_not_steerable`), the turn is in a review or compact phase — wait it out. If interrupt succeeds but a pending approval hangs anyway, `session detach` tears the session down and pending requests fail with `-32000 session detached`.

### Recover a session after `thread.closed`

`thread.closed` is permanent on codex's side. The session cannot be attached again with the same thread_id. Options:

- Fork from an earlier turn if you have the turn_id: `session fork <old-name> <new-name> --at-turn <turn_id>` — but only while the original session is still live (i.e. BEFORE codex closes it)
- Start a fresh session and hand-replay necessary context

## Diagnostic commands

```bash
# daemon state
codex-team daemon status
codex-team daemon logs -n 200 --level debug

# your user state
codex-team -b $TOK status
codex-team -b $TOK session list --format table

# recent events
codex-team -b $TOK monitor events --interval 60 --filter turn.error,approval.command_execution
# (run this as a foreground Bash for a quick drain)

# stderr from a specific app-server
# (currently only available via daemon log inspection — grep "app-server")
grep "app-server" ~/.codex-team/daemon.log | tail -20
```

## What to tell the human user

When you hit a `codex_error`, surface:

- `codex_error_info` (the well-known codex error type)
- a one-line interpretation (use the table above)
- a concrete next step (retry, widen sandbox, check auth, give up)

Don't bury it in the raw JSON. Example:

> "Worker hit `context_window_exceeded` on the refactor session — the thread is too large. I'll fork from turn abc123 into a new session and continue from there."

## See also

- `known-quirks.md` — protocol quirks you'll hit once
- `manage-codex-team/approvals.md` — for approval-related errors
- `configure-codex-team/cli-reference.md` — error code table
