---
description: Bring the codex-team plugin into a working state — daemon healthchecked, and the requested sessions created or resumed. Idempotent; re-runs safely. This command does NOT arm event streams or watchdog — those are separate, opt-in decisions (see `watch-codex-team` skill).
argument-hint: "[session-spec...]  e.g. L-kernels:/path/to/wt1 L-bench:/path/to/wt2"
allowed-tools: Bash
---

Bring up the codex-team environment: daemon healthcheck + session
lifecycle for the names in `$ARGUMENTS`. Nothing else.

Raw user request:
$ARGUMENTS

The plugin only auto-runs `codex-team daemon start` at `SessionStart`.
This command extends that with session create/resume. Event streams
are **not** armed here — the agent decides if/when to call the
`Monitor` tool on the `monitor-events.sh` / `monitor-watchdog.sh`
scripts, because many tasks don't need them (single-turn work,
explicit user-prompted sessions, debugging sessions etc.). See the
`watch-codex-team` skill for when and how to arm.

## Procedure (stop at the first failure and report)

1. **Daemon.** Run `codex-team daemon status` via `Bash`. If it
   reports "not running" or connection refused, run
   `codex-team daemon start`. If `status` returns healthy data, do
   nothing.

2. **Sessions.** Parse `$ARGUMENTS`. Each space-separated token has
   the form `NAME:CWD` and optionally `:PROFILE` suffix
   (`NAME:CWD:PROFILE`). For each token:
   - Check if the session already exists: `codex-team session status NAME`.
   - If it exists and its `status` is `idle` / `running` / `compacting`,
     skip.
   - If it exists but `closed` / `errored`, run
     `codex-team session resume NAME` (for closed) or
     `codex-team session restart NAME` (for errored).
   - If it does not exist, run
     `codex-team session create NAME --cwd CWD [--profile PROFILE]`.

   If `$ARGUMENTS` is empty, create no sessions — the user just wanted
   the daemon healthcheck. Report that clearly.

3. **Report.** One paragraph to the user:
   - Daemon status (started fresh / already running)
   - Sessions created / resumed / restarted / skipped (by name)
   - A one-line hint: "Event streams not armed — see the
     `watch-codex-team` skill if you want turn notifications."

Do not arm monitors. Do not send prompts to sessions. Do not compact.
Do not start work. This command is pure session setup.

If any step fails, stop and report the exact error — do not try to
clean up partial state on your own (that is `recover-codex-team`'s
job).
