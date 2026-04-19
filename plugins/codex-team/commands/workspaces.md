---
description: Inspect every workspace on the shared daemon — sessions, clients, runtime alarms. Useful for cross-window sharing detection, verifying your workspace, or debugging `E_WRONG_WORKSPACE`. Read-only.
argument-hint: ""
allowed-tools: Bash
---

Show state of every workspace on the shared daemon. Read-only.

## Decision tree

1. `codex-team daemon status`. Connection refused → tell the user `/codex-team:bootstrap` first. Stop.

2. Run in parallel:
   ```
   codex-team workspace list
   codex-team workspace show
   codex-team client list
   codex-team watch alarm list --all-workspaces
   codex-team session list --all-workspaces
   ```

3. Format a single-screen report:
   - Current workspace (default landing zone).
   - Per-workspace table:
     ```
     | workspace | sessions | clients | alarms |
     ```
   - Session list across daemon (workspace/name/status summary).

4. Flag anything unusual, one line at the bottom:
   - Alone → "You are alone on this daemon."
   - Multi-tenant → "Another Claude Code is using workspace `<ws>`."
   - Fallback workspace has sessions → "`default` has N sessions."
   - `pid_alive=false` client → "Client `<id>` in workspace `<ws>` shows pid_alive=false." Mention the 60s sweep.

## When to run this

- `E_WRONG_WORKSPACE` came back.
- Session in daemon log you don't recognise.
- User asks "who else is on this daemon?"
- Before `codex-team daemon stop` / `/codex-team:shutdown --global`.
- Confirming a newly-exported `CODEX_TEAM_WORKSPACE` value resolved correctly.

## Do not

- Dispatch, restart, kill, forget, or any destructive command — informational only.
- Cross workspace boundaries to "help" another CC. Their work is theirs.
- Poll this command in place of the event stream.

## Related

- Workspace resolution order: `using-codex-team` §Workspaces
- Cross-workspace queries: `manage-codex-team` §Read-only inspection
- `E_WRONG_WORKSPACE` handling: `recover-codex-team` §Wrong workspace
