---
description: Bring codex-team to a "ready to dispatch work" state in the current workspace — daemon healthchecked, the `events` Monitor stream armed, N sessions created or resumed. Does NOT arm the `watchdog` stream (that's opt-in via `/codex-team:watch`). Idempotent; re-runs safely.
argument-hint: "[session-spec...]  e.g. <name>:/abs/path <name>:/abs/path:<profile>"
allowed-tools: Bash, Monitor
---

Bring up the codex-team environment for this Claude Code session, in the **current workspace** (see §Workspace below).

Raw user request:
$ARGUMENTS

The plugin's `SessionStart` hook runs `scripts/session-start.sh`, which starts the daemon, resolves the workspace, and registers this Claude Code as a client. Monitor arming and session creation are your responsibility. This command is the canonical "I am ready to dispatch work now" step for normal (not long-horizon) work. Stop at the first failure and report — do not clean up partial state.

## Procedure

1. **Daemon.** `codex-team daemon status` via Bash.
   - Healthy → do nothing.
   - Not running / connection refused → `codex-team daemon start`.

2. **Workspace sanity check.** `codex-team workspace show`. Confirm the reported workspace is what the user expects. If the user has a specific workspace in mind (`CODEX_TEAM_WORKSPACE`), this is where you verify it. If the number of existing sessions in the workspace is non-zero and none of them are in `$ARGUMENTS`, stop and ask: "Workspace <ws> already has sessions <list>. Proceed anyway?"

3. **Arm the `events` Monitor stream.** Skip only if the task panel already shows a Monitor with the matching `description`.

   ```
   Monitor({
     description: "codex-team events: turn completions, errors, compact suggestions",
     command: "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-events.sh",
     persistent: true,
     timeout_ms: 3600000
   })
   ```

   The script inherits `CODEX_TEAM_WORKSPACE` automatically and subscribes scoped to your workspace.

   **Do not arm the watchdog here.** If the user's work is long-horizon, run `/codex-team:watch` separately.

4. **Sessions.** Parse `$ARGUMENTS`. Each space-separated token is `NAME:CWD` or `NAME:CWD:PROFILE`.

   For each token:
   - `codex-team session status NAME`.
   - `idle` / `running` / `compacting` → skip.
   - `closed` → `codex-team session resume NAME`.
   - `errored` → `codex-team session restart NAME`.
   - Not found → `codex-team session create NAME --cwd CWD [--profile PROFILE]`.
   - Returned `E_WRONG_WORKSPACE` → **stop.** The name belongs to another workspace. Do not create/modify. Report to the user.

   Empty `$ARGUMENTS` → create no sessions; report that clearly.

5. **Report.** One short paragraph:
   - Current workspace.
   - Daemon status (started now / already running).
   - Events Monitor (armed now / already active).
   - Sessions: created / resumed / restarted / skipped (by name).
   - Note: `[turn-done]` notifications begin once work starts.
   - If the user's task is long-horizon (overnight, multi-hour, cross-day), suggest `/codex-team:watch` to add a watchdog alarm.

## Workspace

This command always operates in the resolved current workspace (see `using-codex-team` §Workspaces). If the user wants a named workspace other than the auto-derived one, they should export `CODEX_TEAM_WORKSPACE=<name>` **before** invoking this command (or write it to `${CLAUDE_PROJECT_DIR}/.codex-team/workspace.env`).

## Do not

- Arm the watchdog stream (see `/codex-team:watch`).
- Send prompts to sessions.
- Compact.
- Recover beyond straightforward resume/restart — escalation belongs to `recover-codex-team`.
- Touch sessions in other workspaces (the daemon rejects this; don't work around it).
