---
description: Cleanly shut codex-team down — close every session, then stop the daemon. Threads are preserved.
argument-hint: "[--force]  skip confirmation"
allowed-tools: Bash, AskUserQuestion
---

Bring codex-team to a graceful stop.

Raw user request:
$ARGUMENTS

## Procedure

1. **Confirm** (unless `$ARGUMENTS` contains `--force`). `AskUserQuestion` once:
   - Question: "Confirm shutdown of codex-team? This closes all sessions (threads are preserved) and stops the daemon."
   - Options:
     - `Yes, shut down`
     - `No, keep running (Recommended)`

   User picks "keep running" → "Aborted." and stop.

2. **Close sessions.** `codex-team session list` via Bash. For each whose `status` is not `closed`:

   ```
   codex-team session close <name>
   ```

   A single `close` failure is not fatal — note and continue.

3. **Stop the daemon.**

   ```bash
   codex-team daemon stop
   ```

4. **Report.** Short summary:
   - How many sessions were closed.
   - Whether `codex-team daemon stop` returned successfully.
   - Reminder: threads are preserved. `codex-team daemon start` + `session resume` restores every session.

## Do not

- Ask Codex to summarize or "wrap up" — that's the compaction ritual (`compact-codex-team`), not shutdown. User wants a progress-write first? They should run that separately **before** `/codex-team:shutdown`.
- Run `session forget`.
- Kill the daemon with `kill -9` or pkill. Use `codex-team daemon stop`.
