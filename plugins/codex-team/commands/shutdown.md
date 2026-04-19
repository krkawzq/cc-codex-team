---
description: Cleanly shut the current codex-team workspace down — close its sessions, unregister watchdog alarms, detach this Claude Code as a client. Daemon is stopped only when no workspace has active sessions, or when `--global` is passed. Threads are preserved.
argument-hint: "[--force] [--global]  skip confirmation / stop daemon even with other active workspaces"
allowed-tools: Bash, AskUserQuestion
---

Bring the current workspace's codex-team state to a graceful stop. Daemon lifecycle is handled carefully: stopping it affects every workspace, so by default we only stop when truly idle.

Raw user request:
$ARGUMENTS

## Procedure

1. **Confirm** (unless `$ARGUMENTS` contains `--force`). `AskUserQuestion` once:
   - Question: "Confirm shutdown of codex-team workspace? This closes the workspace's sessions (threads preserved) and will stop the daemon if no other workspace is active."
   - Options:
     - `Yes, shut down`
     - `No, keep running (Recommended)`

   User picks "keep running" → "Aborted." and stop.

2. **Close sessions.** `codex-team session list` in the current workspace. For each with `status != closed`:
   ```
   codex-team session close <name>
   ```
   A single `close` failure is not fatal — note and continue.

3. **Delete workspace-scoped runtime alarms** (so old alarms don't fire when a later Claude Code session picks this workspace back up):
   ```bash
   codex-team watch alarm list                  # current workspace
   codex-team watch alarm delete <name>         # for each name returned
   ```
   Skip this step if the alarm is in `config.toml` (persistent by design).

4. **Daemon lifecycle.**
   - If `$ARGUMENTS` contains `--global`: stop the daemon unconditionally. **Warn** the user first — this terminates every other workspace's sessions running on the daemon. Only proceed if they explicitly confirmed or used `--force --global`.
     ```bash
     codex-team daemon stop --force
     ```
   - Otherwise: check `codex-team workspace list`. If any other workspace has sessions or clients → leave the daemon running; report "Daemon still active for workspaces: <list>." If no other workspace has sessions → stop the daemon:
     ```bash
     codex-team daemon stop
     ```
     (The daemon may auto-stop when all clients detach and no non-closed sessions remain. Running `daemon stop` explicitly is defense-in-depth.)

5. **Report.** Short summary:
   - Workspace name.
   - How many sessions were closed.
   - How many runtime alarms were deleted.
   - Daemon status: stopped now / still running for other workspaces.
   - Reminder: threads are preserved. `codex-team daemon start` + `session resume` restores every session.

## Do not

- Ask Codex to summarize or "wrap up" — that's the compaction ritual (`compact-codex-team`), not shutdown. If the user wants a progress-write first, they should run that **before** `/codex-team:shutdown`.
- Run `session forget`. That's a deliberate destructive decision.
- Use `--global` casually. It terminates other Claude Code sessions' work. Prefer the default (per-workspace).
- Kill the daemon with `kill -9` or pkill. Use `codex-team daemon stop`.
- Run `daemon stop` from a different workspace than the user intended — the daemon is shared and affects everyone.
