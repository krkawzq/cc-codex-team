---
description: Gracefully shut the current codex-team workspace down — close sessions, remove runtime alarms, detach this Claude Code as a client. Daemon is stopped only when no other workspace is active (or `--global`). Threads preserved.
argument-hint: "[--force] [--global]"
allowed-tools: Bash, AskUserQuestion
---

Raw user request: $ARGUMENTS

## Decision tree

1. **Confirm** (skip if `--force`). One `AskUserQuestion`:
   - "Confirm shutdown of codex-team workspace `<ws>`? Closes sessions (threads preserved); stops daemon if no other workspace is active."
   - Options: `Yes, shut down` · `No, keep running (Recommended)`.
   User says keep running → "Aborted." Stop.

2. **Close sessions.** `codex-team session list` in current workspace. For each with `status != closed`:
   ```
   codex-team session close <name>
   ```
   A single close failure isn't fatal — note and continue.

3. **Remove runtime alarms** (so stale alarms don't fire when the workspace is reused):
   ```
   codex-team watch alarm list
   codex-team watch alarm delete <name>      # for each
   ```
   Alarms defined in `config.toml` are persistent by design — skip.

4. **Daemon.**
   - `--global` → warn user this affects every other workspace's sessions. Only proceed with explicit confirmation or `--force --global`. Then: `codex-team daemon stop --force`.
   - Otherwise → `codex-team workspace list`. If other workspaces have sessions/clients, leave daemon running; report "Daemon still active for workspaces: `<list>`." Else: `codex-team daemon stop`.
   - `E_INVALID_REQUEST` with "non-closed session(s)…" → a session somewhere didn't close. `codex-team session list --all-workspaces`. If straggler is yours, retry close; otherwise leave daemon running or `--global`.

5. **Report.** Short: workspace, sessions closed count, alarms deleted count, daemon status, note about thread preservation.

## Do not

- Ask Codex to "wrap up" — that's the compaction ritual (`recover-codex-team/compaction-ritual.md`), run it **before** shutdown if needed.
- Run `session forget` — destructive, deliberate.
- Use `--global` casually.
- `kill -9` or `pkill` the daemon. Use `codex-team daemon stop`.
