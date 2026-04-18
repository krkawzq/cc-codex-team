---
name: recover-codex-team
description: Triage and recover errored, stuck, or down codex-team sessions, and recover from daemon-level failures. Use when the events stream emits `session-down`, `turn-err`, `turn-stuck`, when a session ends up in `errored` status, when a subprocess is zombie, or when the daemon is unreachable.
---

# Recover codex-team

Known-symptom → known-command tree. No guessing. Every row below has
a deterministic first move; escalate only if that fails.

## First principle: trust the auto-heal, briefly

When `session-down` fires, the daemon attempts one automatic
`thread_resume(thread_id)` in a fresh `AsyncCodex` — you'll see
`auto-heal` arrive within ~10 seconds if it works. **Wait those 10
seconds.** If `auto-heal` fires, send the next prompt normally; the
thread state is preserved.

Auto-heal has a built-in backoff. A second immediate crash of the same
session will *not* auto-heal — you get `session-down` and must
intervene manually.

## Symptom → action table

| Symptom (what you saw) | First action | If that fails |
|---|---|---|
| `session-down` + 10s elapsed, no `auto-heal` | `codex-team session restart <name>` | see "restart fails" below |
| `turn-err` with recoverable=yes | `codex-team send <name> "<retry with clarification>"` | `session restart` |
| `turn-err` with recoverable=no | `codex-team session dump <name>`, read stderr, then `session restart` | `session kill` + `session resume` |
| `turn-stuck` (turn running > `heartbeat.turn_stuck_seconds`) | `codex-team interrupt <name>` | `session kill` if interrupt returns but turn keeps streaming |
| session `status = errored` (from health report) | `codex-team session ack-error <name>` (if code is transient), else `session restart` | `session kill` |
| subprocess gone but registry says idle | `codex-team health repair` | `session kill` + `session resume` |
| zombie subprocess (PID alive, UDS not responding) | `codex-team session kill <name>` (SIGKILLs the child) | `session forget` + re-create |
| daemon unreachable (`daemon status` refused) | see "daemon down" below | — |

## Restart fails

If `codex-team session restart <name>` returns an error:

1. `codex-team session dump <name>` — read `transport_alive`,
   `stderr_tail`. Common culprits:
   - auth token expired → run `codex login` in a separate shell, then
     retry.
   - `codex` binary missing / broken install → re-install (`npm i -g @openai/codex`).
   - thread state on Codex's side is corrupted (rare) → go to
     `session forget` path.
2. `codex-team session kill <name>` — harder reset, SIGKILLs the
   subprocess and marks the session `errored`.
3. `codex-team session resume <name>` — re-attach a fresh subprocess
   to the saved `thread_id`.
4. If (3) still fails with `SessionNotFound` or a thread error:
   `codex-team session forget <name>` deletes the registry entry
   (Codex thread itself is untouched on disk) and then
   `codex-team session create <name> --cwd ...` starts over. Your
   first send on the new session should be: *"Read
   docs/refactor/<name>/progress.md to recover context, then continue
   the most recent Next up item."*

## Daemon down

```
codex-team daemon status
→ ConnectionRefusedError
```

Normal procedure:

```bash
codex-team daemon stop     # best-effort cleanup of pid file and socket
codex-team daemon start    # fresh daemon; auto-resumes every non-closed session
```

If `daemon stop` itself fails (e.g., the process is already gone but a
stale pid file blocks startup), escalate:

```bash
# 1. Force-kill any lingering daemon process.
pkill -TERM -f codex_team.daemon
sleep 1
pkill -KILL -f codex_team.daemon 2>/dev/null || true

# 2. Clean up stale socket and pid file.
rm -f "${XDG_RUNTIME_DIR:-/tmp}/codex-team/daemon.sock"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/codex-team/daemon.pid"

# 3. Start fresh.
codex-team daemon start
```

After `daemon start`, verify:

```bash
codex-team health report
```

and confirm every session you expected is back in `idle`. The plugin
monitors should reconnect to the fresh daemon on their own (the
scripts ensure `daemon start` before execing `monitor events`). If
events stay silent, run `/reload-plugins` and see `watch-codex-team`.

## The escalation ladder

When recovering a single session, escalate in this order and never
skip rungs unless the prior one is clearly unavailable:

```
1. interrupt           (current turn cancelled, thread preserved)
2. restart             (subprocess refreshed via thread_resume)
3. kill                (SIGKILL subprocess, thread preserved)
4. resume              (new subprocess re-attaches thread)
5. forget + create     (thread orphaned; new session created)
6. session recreate with --thread-id <old>  [v2 feature — not available yet]
```

Rung 5 loses the session name binding but the Codex-side thread still
exists on disk. If you really need to continue the same conversation
after `forget`, the new session's first send should tell Codex to
load context from `progress.md` — that is what the progress file
exists for.

## Queue state during recovery

When you `restart` a session mid-run, queued sends are preserved in
memory — they will dispatch once the session returns to `idle`. But
`kill` or `forget` destroys the queue. Before the destructive steps:

```
codex-team queue show <name>
```

If important prompts are in the queue, jot them down or re-send them
after the session is back.

## When to give up and recreate the worktree

Very rare. Only if:

- The Codex thread is persistently refusing to start turns, AND
- The worktree itself is in an unrecoverable state (e.g., merge
  conflict the session cannot resolve), AND
- `forget` + `create` has already been tried and failed the same way.

Then:

```bash
git worktree remove --force <worktree-path>
git worktree add <worktree-path> -B <branch-name> main
codex-team session create <name> --cwd <worktree-path> --profile ...
```

And let Codex re-do the work from `progress.md`.

## Red flags

| Thought | Correction |
|---|---|
| "`session restart` didn't work, I'll forget and recreate." | Run `session dump` first. The stderr almost always tells you why. |
| "Daemon seems stuck — let me just restart everything." | Run `daemon status` first; often only one session is misbehaving. Recover per-session before bouncing the daemon. |
| "I'll just kill all sessions and start over." | Your progress is in `progress.md` per session; you can usually recover one at a time. |
| "session-down — I'll restart immediately." | Wait 10 seconds for `auto-heal` first. You'll often save yourself the step. |
| "The daemon log says X crashed — I should ignore it, it recovered." | Daemon `auto-heal` is single-shot with backoff. Next crash is on you. Open a bug / patch. |

## Cross-references

- Before triaging: `inspect-codex-team` for the initial readout
- After recovery: `manage-codex-team` to resume sends
- Monitors silent too? `watch-codex-team` for plugin-monitor diagnosis
- For daemon-level persistent issues, escalate to the user with
  `PushNotification` — see `watch-codex-team`.
