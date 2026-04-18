---
description: Cleanly shut codex-team down — close every session, then stop the daemon.
argument-hint: "[--force]  skip confirmation"
allowed-tools: Bash, AskUserQuestion
---

Bring codex-team to a graceful stop.

Raw user request:
$ARGUMENTS

Procedure:

1. **Confirm (unless --force).** If `$ARGUMENTS` does not contain
   `--force`, use `AskUserQuestion` once:
   - Question: "Confirm shutdown of codex-team? This closes all
     sessions (threads are preserved) and stops the daemon."
   - Options:
     - `Yes, shut down`
     - `No, keep running (Recommended)`

   If the user chooses "keep running," stop and say "Aborted."

2. **Close sessions.** `codex-team session list` via `Bash`. For each
   session whose status is not `closed`, run
   `codex-team session close <name>`. A failure on any single
   `close` is not fatal — note it and continue.

3. **Stop the daemon.**

   ```bash
   codex-team daemon stop
   ```

4. **Report.** Tell the user:
   - How many sessions were closed.
   - Whether `codex-team daemon stop` returned successfully.
   - A reminder: threads are preserved; `codex-team daemon start` +
     `session resume` restores every session.

Do not ask Codex to do any summary work as part of shutdown — that is
the compaction ritual, not shutdown. If the user wants a
progress-write first, they should run that separately before
`/codex-team:shutdown`.
