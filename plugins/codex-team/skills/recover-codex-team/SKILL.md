---
name: recover-codex-team
description: >-
  Authoritative source for the codex-team escalation ladder (`interrupt → restart → kill → forget`), failure triage, cross-workspace error handling, and the compaction ritual. Trigger on `session-down`, `turn-err`, `turn-stuck`, `status=errored`, `E_WRONG_WORKSPACE`, daemon unreachable, `E_NO_CODEX_BIN`, a `compact-suggest` event, or when a Codex reply mismatches the prompt for the second time in a row (first mismatch is the known long-context quirk — not this skill). Not for: routine session writes (`manage-codex-team`), picking a collaboration pattern (`codex-team-playbooks`), configuration (`configure-codex-team`).
---

# Recover codex-team

> **You are reading this because something broke, or is about to.** Close this file if you were just looking for how to respond to a normal `turn-done` — that's in `manage-codex-team/event-table.md`.

**Known symptom → known first move. Do not guess. Do not improvise.**

**Reference files in this skill:**

- `compaction-ritual.md` — the 2-step "dump, then compact" procedure for `compact-suggest` and pre-emptive compactions.
- `known-quirks.md` — Codex-side quirks that look like failures but aren't, chief among them the long-context prompt-apply skip.

---

## First: is this actually a failure?

Before climbing the ladder, rule out three false positives:

1. **Long-context prompt-apply skip.** A worker reply that doesn't match the prompt you just sent is **not a recovery case** on first occurrence. Re-send the same prompt unchanged; one re-send usually resolves it. Only two consecutive mismatches = real problem. → `known-quirks.md`.

2. **Worker mid-turn.** Turns can legitimately take minutes. Check `session status` for `currentTurnAgeMs`; only if it exceeds `heartbeat.turn_stuck_seconds` is it a real stuck turn.

3. **Wrong workspace.** `E_WRONG_WORKSPACE` means the session exists in a different workspace on the shared daemon. Not a failure — see §Wrong workspace below.

If none of the above, proceed.

## Escalation ladder (authoritative)

Persistent session:

```
interrupt  →  restart  →  kill  →  forget + create
```

Ephemeral session:

```
interrupt  →  restart (only while still live)  →  kill  →  create a fresh one
```

**Never skip rungs.** `forget` is destructive — it deletes the registry entry (Codex-side thread persists but you've lost its handle). Start at the lowest rung and climb only on failure.

## Symptom → action table

| Symptom | First action | If that fails |
|---|---|---|
| `session-down` and no `auto-heal` in ~10s | `codex-team session restart <name>` | See §Restart fails |
| `turn-stuck` (age exceeds threshold) | `codex-team interrupt <name>` | `codex-team session kill <name>` |
| `turn-err` / `status=errored` | `codex-team session dump <name>` then `session restart <name>` | `session kill <name>` |
| `E_WRONG_WORKSPACE` | §Wrong workspace | — |
| `E_INVALID_NAME` (create / attach) | Pick a name matching `[a-zA-Z0-9_.-]` ≤ 64 chars, alphanumeric/`_` first char; avoid Windows reserved names and trailing dots/spaces. → `manage-codex-team` §Create | — |
| Daemon unreachable | `codex-team daemon doctor` | §Daemon down |
| Stale pid / stale socket suspected | `codex-team daemon doctor` | Remove stale files, then `daemon start` |
| `E_NO_CODEX_BIN` | Install / repair Codex CLI | Pin `[daemon].codex_bin` in config |
| `dist/main.js missing` | `npm install && npm run build` in plugin checkout | Reinstall from a built tree |
| Ephemeral `session read` / `resume` fails after daemon restart | Create a fresh session | Ephemeral state is gone by design |
| Reply mismatches prompt **twice** in a row | `codex-team interrupt` then dump + inspect | Restart if transport broke |
| `compact-suggest` fired | `compaction-ritual.md` | — |
| `compact-suggest` during mid-work | Let the current turn finish, then `compaction-ritual.md` | — |
| An alarm seems to target the wrong workspace | `codex-team watch alarm list --all-workspaces` | `watch alarm delete` + recreate in correct workspace |

## Wrong workspace

`E_WRONG_WORKSPACE` means: a session named `<name>` exists, but in a different workspace than the CLI call's current workspace. The daemon refuses the operation to prevent cross-tenant accidents.

**Diagnose:**

```bash
codex-team workspace list                  # all workspaces + session counts
codex-team session list --all-workspaces   # every session + its workspace
codex-team workspace show                  # what the CLI thinks the current workspace is
```

**Three likely causes:**

1. **You're in the wrong workspace.** `CODEX_TEAM_WORKSPACE` / derived workspace doesn't match where the session was created. Export the correct one, or pass `--workspace <ws>` on this call.
2. **Name collision across workspaces.** Sessions are per-workspace-unique, not global. Same name in two workspaces is fine, but you must disambiguate with `--workspace`.
3. **Another Claude Code window manages this session.** A different CC in a different workspace owns it. Leave it alone.

**Never:**

- Edit `registry.json` directly to force the operation.
- `session forget` in your own workspace hoping it clears the collision (it doesn't — the other workspace's entry is separate).
- Blindly run with `--all-workspaces` to dodge the error (bypasses isolation; can hit someone else's work).

## Trust auto-heal briefly

When `session-down` fires, the daemon attempts one automatic `thread/resume` in a fresh `codex app-server` child. **Wait ~10 seconds** for an `auto-heal` event before intervening.

Exceptions:

- Ephemeral sessions are not auto-healed.
- A second immediate crash of the same session is rate-limited by backoff.

Both events carry `was_during_turn`, `turn_id`, `turn_age_ms`, `reason` / `heal_reason`. Use them to distinguish "worker died mid-turn — work lost" from "idle child recycled — nothing to do".

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

Ephemeral: steps 2–4 are only valid while the live app-server is still running. After daemon shutdown, the thread is gone by design.

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

Read `ipc_kind`, `ipc_ready`, `ipc_endpoint`, `socket_exists`, `pid`, `summary`, `log_path`.

- `ipc_ready: true` — daemon is listening. If your CLI still fails, suspect workspace mismatch or a routing bug.
- `ipc_ready: false` + `ipc_kind: "uds"` + `socket_exists: true` — stale socket from a crashed daemon; see stale-state block below.
- `ipc_ready: false` + `ipc_kind: "pipe"` (Windows) — no named pipe; `daemon start`.
- `ipc_ready: false` + `socket_exists: false` — daemon isn't running; `daemon start`.

Normal recovery:

```bash
codex-team daemon stop
codex-team daemon start
codex-team health report
```

Blocked by stale state (Unix only — Windows named pipes have no filesystem counterpart):

```bash
DATA_DIR="${CODEX_TEAM_DAEMON_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/codex-team}"
SOCKET_PATH="${CODEX_TEAM_DAEMON_SOCKET_PATH:-${XDG_RUNTIME_DIR:-/tmp}/codex-team/daemon.sock}"

rm -f "${DATA_DIR}/daemon.pid"
rm -f "${SOCKET_PATH}"
codex-team daemon start
```

Windows: if the pid file points at a dead process and `daemon start` still fails, delete `%LOCALAPPDATA%\codex-team\daemon.pid` manually and retry.

Then **re-arm any Monitor streams you were using**. Persistent Monitor children don't reconnect after the daemon socket disappears.

**Important:** stopping the daemon affects **every workspace**. Before `daemon stop`, check `codex-team workspace list` and confirm no other workspace is in active use. If non-closed sessions exist elsewhere, the CLI refuses unless `--force`; only use after explicit confirmation.

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

- `session restart` preserves the in-memory queue only if the process survives long enough to hand control back.
- `session kill` / `session close` / `queue clear` / `queue drop-oldest` reject queued waiters with an error (no silent hangs).

Useful commands:

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

The daemon keeps `<data_dir>/clients/<client-id>.json` per live Claude Code session. A client-sweep loop runs every 60 s and reaps records whose non-null `pid` is dead or whose `startedAt` is older than 7 days. `pid: null` is intentional when the hook cannot safely identify a long-lived Claude Code parent process. You normally don't need to touch this.

If you suspect a stale client is holding a subscription or alarm:

```bash
codex-team client list                # all workspaces
codex-team client detach <client-id>  # force-detach one
```

Forcing detach unsubscribes their monitors and removes their runtime alarms.

## Red flags

| Thought | Correction |
|---|---|
| "Worker reply doesn't match my prompt — let me restart." | First occurrence: re-send same prompt (long-context skip). Only escalate after two consecutive mismatches. → `known-quirks.md`. |
| "`E_WRONG_WORKSPACE` — let me bypass with `--all-workspaces`." | No. Bypasses isolation; can hit someone else's session. Verify your workspace first. |
| "Daemon is down; I'll keep retrying `send`." | Diagnose first: `daemon doctor`. |
| "Ephemeral resume failed; one more retry might work." | No. Thread died with the app-server. Recreate. |
| "Queue disappeared after `kill` — must be a bug." | Destructive recovery drops queued work by design. Inspect before killing. |
| "Persistent Monitors will reconnect after `daemon restart`." | They won't. Re-arm. |
| "`auto-heal` fired, so the problem is gone." | Check `was_during_turn`. If yes, the lost turn may need a re-send. |
| "`forget` is faster than the ladder." | `forget` is rung 5. Reach for it first and you've lost data you could have saved. |
| "Turn has been running 4 minutes — must be stuck." | Not until `turn-stuck` fires or `currentTurnAgeMs > turn_stuck_seconds`. |
| "I'll stop the daemon to fix this session." | Daemon stop kills every workspace's sessions. Per-session recovery first; daemon stop only if all workspaces agree. |
| "I'll just run `codex-team compact` to get tokens down." | Two-step ritual, always. → `compaction-ritual.md`. |

## Cross-references

- Routine session writes: `manage-codex-team`
- Known quirks (not failures): `known-quirks.md`
- Read-only inspection (first step of triage): `manage-codex-team` §Read-only inspection
- Config / runtime prereqs: `configure-codex-team`
- Cross-workspace visibility: `/codex-team:workspaces`
- Sweep errored sessions in one shot: `/codex-team:heal`
