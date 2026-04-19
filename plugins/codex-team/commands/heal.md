---
description: Sweep errored sessions in the current workspace; try restart → kill+resume. Never touches healthy sessions, other workspaces, or runs destructive `forget`.
argument-hint: ""
allowed-tools: Bash
---

Bring every errored session in the **current workspace** back. Never crosses workspace boundaries (the daemon rejects those calls anyway).

## Decision tree

1. `codex-team health report`. Identify sessions with `status == "errored"` OR `transport_alive == false` (excluding `closed`).

2. Empty → "No errored sessions in workspace `<ws>`." Stop.

3. For each errored session, in order:

   a. `codex-team session dump <name>` — capture `stderr_tail` + `last_error`. Save for final report.

   b. `codex-team session restart <name>`.
      - Success → note "restarted". Next session.

   c. On restart failure: `codex-team session kill <name>` then `codex-team session resume <name>`.
      - Success → "killed + resumed".

   d. On resume failure: **do not `forget`**. Note "needs manual forget+recreate; stderr: `<tail>`". Move on.

4. Final report:
   - Workspace name.
   - Errored count before sweep.
   - Per-session outcome: `restarted` / `killed+resumed` / `needs-manual`.
   - Final health line.

5. Any `needs-manual` → point at `recover-codex-team` and include stderr tail.

## Do not

- Use `--all-workspaces`. Destructive actions against other workspaces are rejected; never your intent here.
- Touch the daemon. Connection refused on `health report` → stop; tell the user `codex-team daemon start` (see `recover-codex-team`).
- Run `session forget` — user's decision.
- Compact, send, or dispatch work.
