---
description: Arm the `watchdog` stream for long-horizon orchestration in the current workspace. Creates/updates a named runtime alarm + arms the Monitor. Opt-in — only for long-horizon work.
argument-hint: "[alarm-name] [--task-brief FILE] [--interval-seconds N] [--template-file FILE] [--emit-idle] [--disabled]"
allowed-tools: Bash, Monitor
---

Only arm the watchdog when the work is long-horizon. See `manage-codex-team` §Watchdog for when this is appropriate.

Raw user request: $ARGUMENTS

## Decision tree

1. `codex-team daemon status`. Not running → tell the user to run `/codex-team:bootstrap` first. Stop.

2. Parse `$ARGUMENTS`:
   - First positional = alarm name. Default `default`.
   - `--task-brief PATH` → absolute. Maps to `--task-brief-file`.
   - `--interval-seconds N` → default 7200 (2h) for a new alarm.
   - `--template-file PATH` → omit for default template.
   - `--emit-idle` → default false.
   - `--disabled` → create with `enabled=false`; skip step 4 unless another enabled alarm exists.

3. Create/update runtime alarm in current workspace:
   ```
   codex-team watch alarm create <alarm-name> \
     [--interval-seconds N] \
     [--task-brief-file PATH] \
     [--template-file PATH] \
     [--emit-idle] \
     [--disabled]
   ```

4. Verify: `codex-team watch alarm list`. Confirm present + expected config.

5. Arm the `watchdog` Monitor — once per Claude Code session. Skip if the task panel already has a matching Monitor (`description` begins with `codex-team watchdog:`).
   ```
   Monitor({
     description: "codex-team watchdog: periodic reminder + self-check",
     command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/main.js\" monitor watchdog",
     persistent: true,
     timeout_ms: 3600000
   })
   ```

6. Report: alarm name, workspace, cadence (human-friendly), `task_brief_file` path if set, `emit_idle`, whether Monitor was armed now or already active. Note: `[watchdog-tick]` notifications arrive at next interval.

## Do not

- Arm watchdog for short or interactive tasks. Default is events-only.
- Edit `[monitor].watchdog_interval_seconds` in `config.toml` for a one-off alarm. Runtime alarms are additive + workspace-scoped.
- Run `daemon restart` to pick up alarm changes. Runtime alarms reload automatically; config alarms use `daemon reload-config`.

## Related

- When to arm watchdog at all: `manage-codex-team` §Watchdog
- Alarm schema + template variables: `configure-codex-team/config-schema.md` §Watchdog alarms
- Normal bootstrap (no watchdog): `/codex-team:bootstrap`
- Inspect alarms across workspaces: `/codex-team:workspaces`
