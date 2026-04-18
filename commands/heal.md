---
description: Attempt to restart every errored codex-team session in order, reporting per-session outcome. Does NOT touch healthy sessions.
allowed-tools: Bash
---

Sweep for errored sessions and try to bring them back.

Procedure:

1. `codex-team health report` via `Bash` — identify every session with
   `status == "errored"` or `transport_alive == false` that is not
   `closed`.
2. If the list is empty, tell the user "No errored sessions." and
   stop.
3. For each errored session, in the order returned:

   a. `codex-team session dump <name>` — capture the stderr tail and
      last_error string (do not print unless there is an actual
      failure).

   b. Try `codex-team session restart <name>`.

   c. If restart succeeds, note "restarted". Move on.

   d. If restart fails, try `codex-team session kill <name>` then
      `codex-team session resume <name>`. If that succeeds, note
      "killed + resumed".

   e. If resume also fails, do NOT `forget` — this command will not
      take the destructive step. Note "needs manual forget+recreate;
      stderr: <tail>" and move on.

4. Summary report to the user:
   - How many sessions were errored before the sweep.
   - Per-session outcome (restarted / killed+resumed / needs-manual).
   - A final `codex-team health report` line so the user can verify
     the current state.

5. If any session still needs manual intervention, direct the user to
   the `recover-codex-team` skill and point at the specific stderr.

Do not touch the daemon itself. If `health report` returns
connection-refused (daemon down), stop and tell the user to run
`codex-team daemon start` (see `recover-codex-team`).
