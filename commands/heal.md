---
description: Sweep errored codex-team sessions and try to bring them back via restart / kill+resume. Does NOT touch healthy sessions. Does NOT run destructive `forget`.
allowed-tools: Bash
---

Bring every errored session back, report per-session outcome.

## Procedure

1. `codex-team health report` via Bash. Identify sessions with `status == "errored"` OR `transport_alive == false` (excluding `closed`).

2. If the list is empty → "No errored sessions." and stop.

3. For each errored session (in order):

   a. `codex-team session dump <name>` — capture `stderr_tail` and `last_error`. Keep for the final report; do not print mid-sweep.

   b. `codex-team session restart <name>`.
      - Success → note "restarted". Continue to next session.

   c. On restart failure: `codex-team session kill <name>` then `codex-team session resume <name>`.
      - Success → note "killed + resumed".

   d. On resume failure: **do NOT `forget`**. Note "needs manual forget+recreate; stderr: <tail>" and move on.

4. Final report:
   - Count of errored sessions before the sweep.
   - Per-session outcome: `restarted` / `killed+resumed` / `needs-manual`.
   - Final `codex-team health report` summary line.

5. If any session still needs manual intervention, point at `recover-codex-team` and quote the stderr tail.

## Do not

- Touch the daemon itself. Connection refused on `health report` → stop and tell the user to run `codex-team daemon start` (see `recover-codex-team`).
- Run `session forget`. That's a decision for the user.
- Compact, send, or otherwise dispatch work.
