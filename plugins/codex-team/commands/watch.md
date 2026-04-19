---
description: Arm the codex-team `watchdog` stream for long-horizon orchestration. Optionally create or update a named watchdog alarm (cadence + task-brief file + custom template). Opt-in; do not run unless the task warrants a periodic reminder.
argument-hint: "[alarm-name] [--task-brief FILE] [--interval SECS] [--template FILE] [--emit-idle] [--disable]"
allowed-tools: Bash, Monitor, Edit, Read
---

Arm the `watchdog` stream. This is an opt-in step — only use on long-horizon work where you need a periodic reminder + self-check. See `watch-codex-team` §Watchdog for when this is appropriate.

Raw user request:
$ARGUMENTS

## Procedure

1. **Confirm the daemon is up.** `codex-team daemon status`. Not running → tell the user to run `codex-team daemon start` (or `/codex-team:bootstrap` first) and stop.

2. **Parse `$ARGUMENTS`.**
   - First positional token (if present) = alarm name. Default `default` if omitted.
   - `--task-brief PATH` → absolute path to a brief file (head N lines get injected into the payload).
   - `--interval SECS` → cadence in seconds (positive integer). Default `7200` (2h) if creating a new alarm.
   - `--template PATH` → absolute path to a template file. If omitted, the default template is used.
   - `--emit-idle` → set `emit_idle = true` (fire every tick regardless of signal). Default `false`.
   - `--disable` → set `enabled = false` on the named alarm (then reload). Skip steps 3-4.

3. **Update `config.toml`.** Locate at `$XDG_CONFIG_HOME/codex-team/config.toml` (usually `~/.config/codex-team/config.toml`).
   - If the file doesn't exist, create it with an empty preamble (daemon falls back to defaults for unspecified sections).
   - Upsert the `[monitor.watchdog_alarms.<alarm-name>]` block with the parsed values. Preserve any keys the user already set that weren't passed on this command.
   - Example block written:
     ```toml
     [monitor.watchdog_alarms.task_brief]
     enabled = true
     interval_seconds = 7200
     task_brief_file = "/abs/path/to/brief.md"
     emit_idle = true
     ```

4. **Reload.** `codex-team daemon reload-config`. If it fails, report the error and stop.

5. **Arm the Monitor stream** — only once per Claude Code session. Before arming, check the task panel for an existing Monitor whose `description` matches `codex-team watchdog: …`. If present, skip arming (one Monitor process serves all alarms).
   
   Otherwise:
   ```
   Monitor({
     description: "codex-team watchdog: periodic reminder + self-check",
     command: "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-watchdog.sh",
     persistent: true,
     timeout_ms: 3600000
   })
   ```

6. **Report.** Short paragraph:
   - Alarm name.
   - Cadence (humanize: "every 2h").
   - `task_brief_file` path, if set.
   - `emit_idle` value.
   - Whether Monitor was armed now or already active.
   - Reminder: `[watchdog-tick]` notifications will start arriving at the next interval.

## Do not

- Arm the watchdog for short or interactive tasks. Default is events-only for a reason.
- Edit the default `[monitor]` section (`watchdog_interval_seconds`, etc.) — that governs the built-in `default` alarm. Named alarms are additive.
- Run `daemon restart` to pick up config changes. `daemon reload-config` is sufficient.

## Related

- When to arm the watchdog at all: `watch-codex-team` §Watchdog
- Alarm schema + template variables: `configure-codex-team` §Watchdog alarms
- Normal bootstrap (no watchdog): `/codex-team:bootstrap`
