---
description: Bring the codex-team plugin into a working state — daemon healthchecked and sessions created/resumed. Idempotent; re-runs safely. The plugin's own monitors auto-start; this command does not arm them.
argument-hint: "[session-spec...]  e.g. L-kernels:/path/to/wt1 L-bench:/path/to/wt2"
allowed-tools: Bash
---

Bring up the codex-team sessions for this Claude session. The two
background monitors (`codex-team-events`, `codex-team-watchdog`) are
plugin-declared in `monitors/monitors.json` and start automatically
when the plugin is active — this command does not touch them.

Raw user request:
$ARGUMENTS

Procedure (execute in order; stop at the first failure and report):

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

   If `$ARGUMENTS` is empty, create no sessions — the user wants a
   daemon healthcheck only. Report that clearly.

3. **Monitor sanity check (optional, do not arm).** The plugin
   monitors should already be running. If you can see the task panel,
   confirm `codex-team-events` and `codex-team-watchdog` appear. If
   they are missing, tell the user to run `/reload-plugins` — do
   not try to arm them with the `Monitor` tool (that would duplicate).

4. **Report.** One paragraph to the user:
   - Daemon status (started fresh / already running)
   - Sessions created / resumed / restarted / skipped (by name)
   - A note that plugin monitors are already watching and the user
     should see `[turn-done]` / `[watchdog-tick]` notifications as
     soon as work begins.

Do not send any prompts to sessions. Do not compact. Do not start
work. This command is pure setup.

If any step fails, stop and report the exact error — do not try to
clean up partial state on your own (that is `recover-codex-team`'s
job).
