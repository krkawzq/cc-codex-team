---
description: Bring codex-team to a "ready to dispatch work" state in the current workspace — daemon healthchecked, `events` Monitor armed, N sessions created or resumed. Idempotent. Does NOT arm `watchdog` (that's `/codex-team:watch`).
argument-hint: "[NAME:CWD ...]  e.g. reviewer:/abs/repo fixer:/abs/repo:reviewer-profile"
allowed-tools: Bash, Monitor
---

Operates in the resolved current workspace (see `using-codex-team` §Workspaces). Stop at the first failure and report — do not clean up partial state.

Raw user request: $ARGUMENTS

## Decision tree

1. **Daemon.** `codex-team daemon status`.
   - Healthy → skip.
   - Not running → `codex-team daemon start`.
   - Failure → stop, report, suggest `recover-codex-team` §Daemon down.

2. **Workspace sanity.** `codex-team workspace show`. If the workspace has existing sessions that aren't named in `$ARGUMENTS`, ask:
   > "Workspace `<ws>` already has sessions `<list>`. Proceed anyway?"

3. **Arm `events`.** Skip if the task panel already has a matching Monitor.
   ```
   Monitor({
     description: "codex-team events: turn completions, errors, compact suggestions",
     command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/main.js\" monitor events",
     persistent: true,
     timeout_ms: 3600000
   })
   ```
   Do not arm `watchdog` here.

4. **Sessions.** Parse `$ARGUMENTS` (space-separated `NAME:CWD` or `NAME:CWD:PROFILE`). For each:
   - `codex-team session status NAME`.
   - `idle` / `running` / `compacting` → skip.
   - `closed` → `session resume NAME`.
   - `errored` → `session restart NAME` (if this fails, stop and point at `recover-codex-team`).
   - not found → `session create NAME --cwd CWD [--profile PROFILE]`.
   - `E_WRONG_WORKSPACE` → stop; report. The name belongs to another workspace.

5. **Report.** One short paragraph: workspace, daemon status, events armed, per-session outcome. Close with: "`[turn-done]` notifications arrive once work starts." If the task is long-horizon, mention `/codex-team:watch`.

## Do not
- Arm `watchdog`.
- Send prompts to sessions.
- Run compaction or recovery beyond resume/restart.
- Touch sessions in other workspaces.
