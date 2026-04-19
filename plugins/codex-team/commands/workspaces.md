---
description: Inspect all codex-team workspaces on the shared daemon — sessions per workspace, connected clients, scheduled runtime alarms. Useful for spotting cross-Claude-Code sharing, verifying your current workspace, or debugging an `E_WRONG_WORKSPACE` error. Read-only.
argument-hint: ""
allowed-tools: Bash
---

Show the state of every workspace on the shared daemon. Read-only: this command does not modify anything.

## Procedure

1. **Confirm the daemon is up.** `codex-team daemon status`. If connection refused, tell the user to run `/codex-team:bootstrap` first and stop.

2. **Get the workspace overview.**
   ```bash
   codex-team workspace list
   ```
   This returns every workspace on the daemon with session count + client count.

3. **Add context.** Run the following to enrich the view:
   ```bash
   codex-team workspace show                          # current workspace details
   codex-team client list                             # every connected Claude Code instance
   codex-team watch alarm list --all-workspaces       # runtime alarms across workspaces
   codex-team session list --all-workspaces           # all sessions, annotated with their workspace
   ```

4. **Format a single-screen report.** The user wants to understand at a glance:
   - **Your current workspace** (the one your CLI calls land in by default).
   - **Total workspaces on the daemon** and whether any of them belong to another Claude Code window.
   - **Sessions per workspace** (count + list of names).
   - **Clients per workspace** (count; flag any with a dead pid for the user — the daemon will sweep them automatically every 60s).
   - **Alarms per workspace** (name + interval + whether `emit_idle`).

   Example shape:

   ```
   Current workspace: proj-abcd1234  (active; 2 sessions; 1 client)

   All workspaces:
   | workspace       | sessions | clients | alarms |
   |-----------------|----------|---------|--------|
   | proj-abcd1234   | 2        | 1       | 0      | ← you
   | proj-55fa9e00   | 3        | 1       | 1 (task_brief, 2h) |
   | default         | 0        | 0       | 0      |

   Sessions across daemon:
   - proj-abcd1234 / reviewer   (running, no queue)
   - proj-abcd1234 / fixer      (idle)
   - proj-55fa9e00 / porter-py  (running, 1 queued)
   - ...
   ```

5. **Flag anything unusual.** In a one-line judgment at the bottom:
   - "You are alone on this daemon." — one non-`default` workspace, one client.
   - "Another Claude Code is using workspace `<ws>`." — multiple workspaces with active clients.
   - "The `default` workspace has N sessions." — these are sessions using the fallback workspace rather than a project-derived workspace.
   - "Client `<id>` in workspace `<ws>` shows `pid_alive=false`." — the sweep loop hasn't reaped yet; no action needed.

## When to run this

- `E_WRONG_WORKSPACE` came back — figure out which workspace holds the session.
- You see a session in the daemon log / `session list --all-workspaces` that you don't recognize.
- User asks "who else is on this daemon?" or "am I sharing state with my other CC window?"
- Before running `codex-team daemon stop` or `/codex-team:shutdown --global` — confirm no other workspace is in active use.
- Confirming a newly-created workspace's name after `CODEX_TEAM_WORKSPACE=foo` was exported.

## Do not

- Do not `session kill`, `session forget`, `daemon stop`, or any destructive command from this path. This command is purely informational.
- Do not cross workspace boundaries to help another CC — their sessions are theirs. If the user wants you to take over another workspace's work, they should export that workspace explicitly.
- Do not loop this command in place of the event stream. It is not a polling substitute; it is an occasional snapshot.

## Related

- Workspace concept + resolution order: `using-codex-team` §Workspaces
- Cross-workspace audit queries: `inspect-codex-team` §Cross-workspace audit
- `E_WRONG_WORKSPACE` handling: `recover-codex-team` §Wrong workspace
