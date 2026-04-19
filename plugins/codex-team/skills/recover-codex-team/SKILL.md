---
name: recover-codex-team
description: Authoritative source for the codex-team escalation ladder (`interrupt → restart → kill → forget`), failure triage, and cross-workspace error handling. Trigger on `session-down`, `turn-err`, `turn-stuck`, `status=errored`, `E_WRONG_WORKSPACE`, daemon unreachable, or `E_NO_CODEX_BIN`. Also trigger when a Codex reply twice in a row doesn't match the sent prompt (first occurrence is the known long-context quirk — not this skill). Not for: routine session writes (`manage-codex-team`), inspection without action (`inspect-codex-team`).
---

# Recover codex-team

Known symptom → known first move. Do not guess. Do not improvise.

## First: is this actually a failure?

Before climbing the ladder, rule out three false positives:

1. **Long-context prompt-apply skip.** A worker reply that doesn't match the prompt you just sent is **not a recovery case** on first occurrence. Re-send the same prompt unchanged; one re-send usually resolves it. Only if two consecutive re-sends behave the same way is it a real problem. → `philosophy.md` §5, `manage-codex-team` §Known quirks.

2. **Worker mid-turn.** Turns can legitimately take minutes. Check `session status` for `currentTurnAgeMs`; only if it exceeds `heartbeat.turn_stuck_seconds` is it a real stuck turn.

3. **Wrong workspace.** If a command returns `E_WRONG_WORKSPACE`, the session exists in another workspace on the shared daemon. Not a failure — your CLI call needs `--workspace <correct-one>` or you should leave that session alone. → §Wrong workspace below.

If none, proceed.

## Escalation ladder (authoritative)

Persistent session:

```
interrupt  →  restart  →  kill  →  forget + create
```

Ephemeral session:

```
interrupt  →  restart (only while still live)  →  kill  →  create a fresh one
```

**Never skip rungs.** `forget` is destructive — it deletes the registry entry; the Codex-side thread persists but you've lost its handle. Start at the lowest rung and climb only on failure.

## Symptom → action table

| Symptom | First action | If that fails |
|---|---|---|
| `session-down` and no `auto-heal` in ~10s | `codex-team session restart <name>` | See "Restart fails" |
| `turn-stuck` (age exceeds threshold) | `codex-team interrupt <name>` | `codex-team session kill <name>` |
| `turn-err` / `status=errored` | `codex-team session dump <name>` then `session restart <name>` | `session kill <name>` |
| `E_WRONG_WORKSPACE` | See §Wrong workspace | — |
| Daemon unreachable | `codex-team daemon doctor` | See "Daemon down" |
| Stale pid / stale socket suspected | `codex-team daemon doctor` | Remove stale files, then `daemon start` |
| `E_NO_CODEX_BIN` | Install / repair Codex CLI | Pin `[daemon].codex_bin` in config |
| `dist/main.js missing` | `npm install && npm run build` in plugin checkout | Reinstall from a built tree |
| Ephemeral `session read` / `resume` fails after daemon restart | Create a fresh session | Ephemeral state is gone by design — stop retrying |
| Reply mismatched prompt **twice** in a row | `codex-team interrupt` then dump + inspect | Restart if transport broke |
| An alarm seems to target the wrong workspace | `codex-team watch alarm list --all-workspaces` | `codex-team watch alarm delete` + recreate in correct workspace |

## Wrong workspace

`E_WRONG_WORKSPACE` means: a session named `<name>` exists, but in a different workspace than the CLI call's current workspace. The daemon refuses the operation to prevent cross-tenant accidents.

**Diagnose:**

```bash
codex-team workspace list                  # all workspaces + session counts
codex-team session list --all-workspaces   # every session + its workspace
codex-team workspace show                  # what the CLI thinks the current workspace is
```

**Three likely causes:**

1. **You're in the wrong workspace.** Your `CODEX_TEAM_WORKSPACE` / derived workspace doesn't match where you created the session earlier. Fix: export the correct one, or pass `--workspace <ws>` on this call.
2. **Name collision across workspaces.** Sessions are per-workspace-unique, not global. Same name in two workspaces is fine, but you must disambiguate with `--workspace`.
3. **Another Claude Code window manages this session.** A different CC is in a different workspace; the session is theirs, not yours. Leave it alone.

**Never:**

- Force the operation by editing `registry.json` directly.
- `session forget` in your own workspace hoping it clears the collision (it doesn't — the other workspace's entry is separate).
- Blindly run with `--all-workspaces` to dodge the error (that bypasses isolation and can hit someone else's work).

## First, trust auto-heal briefly

When `session-down` fires, the daemon attempts one automatic `thread/resume` in a fresh `codex app-server` child. Wait ~10 seconds for an `auto-heal` event before intervening.

Exceptions:

- **Ephemeral sessions are not auto-healed.**
- A second immediate crash of the same session is rate-limited by backoff.

Both events carry `was_during_turn`, `turn_id`, `turn_age_ms`, `reason` / `heal_reason`. Use these to distinguish "worker died mid-turn" from "idle child recycled".

## Restart fails

```
1. codex-team session dump <name>
     → read transport_alive, stderr_tail, registry fields
2. codex-team session read <name>
     → if this succeeds, thread exists; issue is process-side
3. codex-team session kill <name>
     → hard-reset the child
4. codex-team session resume <name>
     → re-attach fresh child to stored thread
5. codex-team session forget <name> && codex-team session create <name> ...
     → only if the thread itself is unusable
```

Ephemeral: steps 2-4 are only valid while the live app-server is still running. After daemon shutdown, the thread is gone by design.

## Turn stuck

`turn-stuck` = heartbeat saw a running turn older than `heartbeat.turn_stuck_seconds`.

```bash
codex-team interrupt <name>
codex-team session dump <name>
codex-team tail <name> --stderr
```

If the worker keeps streaming after interrupt, or the child is wedged:

```bash
codex-team session kill <name>
codex-team session resume <name>
```

## Daemon down

Facts first:

```bash
codex-team daemon doctor
```

Inspect `socket_exists`, `pid`, `summary`, `log_path`. Normal recovery:

```bash
codex-team daemon stop
codex-team daemon start
codex-team health report
```

If startup is blocked by stale state:

```bash
DATA_DIR="${CODEX_TEAM_DAEMON_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-team}"
SOCKET_PATH="${CODEX_TEAM_DAEMON_SOCKET_PATH:-${XDG_RUNTIME_DIR:-/tmp}/codex-team/daemon.sock}"

rm -f "${DATA_DIR}/daemon.pid"
rm -f "${SOCKET_PATH}"
codex-team daemon start
```

Then **re-arm any Monitor streams you were using**. Persistent Monitor children don't reconnect after the daemon socket disappears.

**Important:** stopping the daemon affects **every workspace**, not just yours. Before `daemon stop`, check `codex-team workspace list` and confirm no other workspace is in active use. If non-closed sessions exist, the CLI refuses unless `--force` is passed; only use `--force` after explicit confirmation.

## Codex binary missing

On `E_NO_CODEX_BIN`:

```bash
npm install -g @openai/codex
codex login
codex --version
```

If a plain shell finds it but the daemon still fails, pin the path:

```toml
[daemon]
codex_bin = "/absolute/path/to/codex"
```

Then `codex-team daemon reload-config`. If the daemon is already unhealthy, do a full restart instead.

## Unbuilt checkout

`bin/codex-team` printing `dist/main.js missing` = unbuilt dev checkout:

```bash
cd /path/to/plugin
npm install
npm run typecheck
npm run build
codex-team daemon start
```

## Queue state during recovery

Queued sends matter. Inspect before destroying.

- `session restart` preserves the in-memory queue only if the current process survives long enough to hand control back.
- `session kill` / `session close` / `queue clear` / `queue drop-oldest` reject queued waiters with an error (no silent hangs).
- Useful commands:
  ```bash
  codex-team queue show <name>
  codex-team queue retry-last <name>
  codex-team queue clear <name>
  ```

## Ephemeral sessions

`--ephemeral` is intentionally sharp:

- Fast scratch pads.
- Not durable across daemon shutdown.
- Skipped by `auto_resume_on_daemon_start`.
- `session resume` after child exit is expected to fail.

Need durability? Don't use `--ephemeral`.

## Stale client records

The daemon keeps `<data_dir>/clients/<client-id>.json` per live Claude Code session. A client-sweep loop runs every 60 s and reaps records whose `pid` is dead or whose `startedAt` is older than 7 days. You normally don't need to touch this.

If you suspect a stale client is holding a subscription or alarm:

```bash
codex-team client list                # all workspaces
codex-team client detach <client-id>  # force-detach one
```

Forcing detach unsubscribes their monitors and removes their runtime alarms.

## Red flags

| Thought | Correction |
|---|---|
| "Worker reply doesn't match my prompt — let me restart." | First occurrence: re-send same prompt (long-context skip). Only escalate after two consecutive mismatches. |
| "`E_WRONG_WORKSPACE` — let me bypass with `--all-workspaces`." | No. That bypasses isolation and can hit someone else's session. Verify your workspace first. |
| "Daemon is down; I'll keep retrying `send`." | Diagnose first: `daemon doctor`. |
| "Ephemeral resume failed; one more retry might work." | No. Thread died with the app-server. Recreate. |
| "Queue disappeared after `kill` — must be a bug." | Destructive recovery drops queued work by design. Inspect before killing. |
| "Persistent Monitors will reconnect after `daemon restart`." | They won't. Re-arm. |
| "`auto-heal` fired, so the problem is gone." | Check `was_during_turn`. If yes, the lost turn may need a re-send. |
| "`forget` is faster than the ladder." | `forget` is rung 5. If you reach for it first, you've lost data you could have saved. |
| "Turn has been running 4 minutes — must be stuck." | Not until `turn-stuck` fires or `currentTurnAgeMs > turn_stuck_seconds`. |
| "I'll stop the daemon to fix this session." | Daemon stop kills every workspace's sessions. Per-session recovery first; daemon stop only if all workspaces agree. |

## Cross-references

- Routine session writes: `manage-codex-team`
- Known long-context quirk (re-send, not recovery): `philosophy.md` §5, `manage-codex-team` §Known quirks
- Read-only inspection (first step of triage): `inspect-codex-team`
- Config / runtime prereqs: `configure-codex-team`
- Cross-workspace visibility: `/codex-team:workspaces`
- Sweep-everything shortcut: `/codex-team:heal`
