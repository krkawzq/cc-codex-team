---
description: Sweep errored codex-team sessions in the current workspace and try to bring them back via restart / kill+resume. Does NOT touch healthy sessions, sessions in other workspaces, or run destructive `forget`.
argument-hint: ""
allowed-tools: Bash
---

Bring every errored session in the **current workspace** back, report per-session outcome. Never crosses workspace boundaries — the daemon rejects those attempts anyway (`E_WRONG_WORKSPACE`).

## Procedure

1. `codex-team health report` via Bash (workspace-scoped by default). Identify sessions with `status == "errored"` OR `transport_alive == false` (excluding `closed`).

2. If the list is empty → "No errored sessions in workspace <ws>." and stop. Mention the workspace so the user knows this is scoped.

3. For each errored session (in order):

   a. `codex-team session dump <name>` — capture `stderr_tail` and `last_error`. Keep for the final report; do not print mid-sweep.

   b. `codex-team session restart <name>`.
      - Success → note "restarted". Continue to next session.

   c. On restart failure: `codex-team session kill <name>` then `codex-team session resume <name>`.
      - Success → note "killed + resumed".

   d. On resume failure: **do NOT `forget`**. Note "needs manual forget+recreate; stderr: <tail>" and move on.

4. Final report:
   - Workspace name.
   - Count of errored sessions before the sweep.
   - Per-session outcome: `restarted` / `killed+resumed` / `needs-manual`.
   - Final `codex-team health report` summary line (workspace-scoped).

5. If any session still needs manual intervention, point at `recover-codex-team` and quote the stderr tail.

## Do not

- Use `--all-workspaces`. Destructive actions on another workspace's sessions are rejected and should never be your intent from this command.
- Touch the daemon itself. Connection refused on `health report` → stop and tell the user to run `codex-team daemon start` (see `recover-codex-team`).
- Run `session forget`. That's a decision for the user.
- Compact, send, or otherwise dispatch work.
