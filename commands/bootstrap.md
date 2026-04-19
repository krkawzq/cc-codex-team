---
description: Bring codex-team to a "ready to dispatch work" state — daemon healthchecked, the `events` Monitor stream armed, N sessions created or resumed. Does NOT arm the `watchdog` stream (that's opt-in via `/codex-team:watch`). Idempotent; re-runs safely.
argument-hint: "[session-spec...]  e.g. <name>:/abs/path <name>:/abs/path:<profile>"
allowed-tools: Bash, Monitor
---

Bring up the codex-team environment for this Claude Code session.

Raw user request:
$ARGUMENTS

The plugin only auto-runs `codex-team daemon start` at `SessionStart`. Monitor arming, session creation, and recovery are your responsibility. This command is the canonical "I am ready to dispatch work now" step for normal (not long-horizon) work. Stop at the first failure and report — do not clean up partial state.

## Procedure

1. **Daemon.** `codex-team daemon status` via Bash.
   - Healthy → do nothing.
   - Not running / connection refused → `codex-team daemon start`.

2. **Arm the `events` Monitor stream.** Skip only if the task panel already shows a Monitor with the matching `description`.

   ```
   Monitor({
     description: "codex-team events: turn completions, errors, compact suggestions",
     command: "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-events.sh",
     persistent: true,
     timeout_ms: 3600000
   })
   ```

   **Do not arm the watchdog here.** If the user's work is long-horizon, they can run `/codex-team:watch` separately.

3. **Sessions.** Parse `$ARGUMENTS`. Each space-separated token is `NAME:CWD` or `NAME:CWD:PROFILE`.

   For each token:
   - `codex-team session status NAME`.
   - `idle` / `running` / `compacting` → skip.
   - `closed` → `codex-team session resume NAME`.
   - `errored` → `codex-team session restart NAME`.
   - Not found → `codex-team session create NAME --cwd CWD [--profile PROFILE]`.

   Empty `$ARGUMENTS` → create no sessions; report that clearly.

4. **Report.** One short paragraph:
   - Daemon status (started now / already running).
   - Events Monitor (armed now / already active).
   - Sessions: created / resumed / restarted / skipped (by name).
   - Note: `[turn-done]` notifications begin once work starts.
   - If the user's task is long-horizon (overnight, multi-hour, cross-day), suggest `/codex-team:watch` to add a watchdog alarm.

## Do not

- Arm the watchdog stream (see `/codex-team:watch`).
- Send prompts to sessions.
- Compact.
- Recover beyond straightforward resume/restart — escalation belongs to `recover-codex-team`.
