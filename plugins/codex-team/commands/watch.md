---
description: Arm the codex-team `watchdog` stream for long-horizon orchestration in the current workspace. Creates or updates a named runtime watchdog alarm (cadence + task-brief file + optional custom template) scoped to this workspace. Opt-in; do not run unless the task warrants a periodic reminder + self-check.
argument-hint: "[alarm-name] [--task-brief FILE] [--interval-seconds N] [--template-file FILE] [--emit-idle] [--disabled]"
allowed-tools: Bash, Monitor
---

Arm the `watchdog` stream in your current workspace. This is an opt-in step — only use on long-horizon work where you need a periodic reminder + self-check. See `watch-codex-team` §Watchdog for when this is appropriate.

Raw user request:
$ARGUMENTS

## Procedure

1. **Confirm the daemon is up.** `codex-team daemon status`. Not running → tell the user to run `/codex-team:bootstrap` first, and stop.

2. **Parse `$ARGUMENTS`.**
   - First positional token (if present) = alarm name. Default `default` if omitted.
   - `--task-brief PATH` → absolute path to a brief file. Maps to `--task-brief-file` on the CLI.
   - `--interval-seconds N` → cadence in seconds. Default `7200` (2h) if creating a new alarm.
   - `--template-file PATH` → absolute path to a template file. Omit for the default template.
   - `--emit-idle` → fire every tick regardless of signal. Default `false`.
   - `--disabled` → create/update the alarm with `enabled=false`. Skip step 5 unless another enabled alarm exists.

3. **Create/update the runtime alarm** — scoped to the current workspace:
   ```bash
   codex-team watch alarm create <alarm-name> \
     [--interval-seconds N] \
     [--task-brief-file PATH] \
     [--template-file PATH] \
     [--emit-idle] \
     [--disabled]
   ```
   Runtime alarms live at `<data_dir>/alarms/<workspace>/<name>.json`, not in `config.toml`. They survive daemon restarts.

4. **Verify.** `codex-team watch alarm list`. Confirm the alarm is present with the expected config.

5. **Arm the Monitor stream** — only once per Claude Code session. Before arming, check the task panel for an existing Monitor whose `description` matches `codex-team watchdog: …`. If present, skip.

   ```
   Monitor({
     description: "codex-team watchdog: periodic reminder + self-check",
     command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/main.js\" monitor watchdog",
     persistent: true,
     timeout_ms: 3600000
   })
   ```

   The Monitor command inherits `CODEX_TEAM_WORKSPACE`; if that env is missing, the Node entry reads `.codex-team/client.env` and subscribes scoped to your workspace.

6. **Report.** Short paragraph:
   - Alarm name + workspace.
   - Cadence (humanize: "every 2h").
   - `task_brief_file` path, if set.
   - `emit_idle` value.
   - Whether Monitor was armed now or already active.
   - Reminder: `[watchdog-tick]` notifications arrive at the next interval.

## Workspace

Operates on the resolved current workspace. Alarms do not span workspaces — each workspace needing a reminder needs its own alarm.

Remove or disable:

```bash
codex-team watch alarm delete <alarm-name>
codex-team watch alarm create <alarm-name> --disabled
```

Use `/codex-team:workspaces` to see alarms across all workspaces.

## Do not

- Arm the watchdog for short or interactive tasks. Events-only is the right default.
- Edit `[monitor].watchdog_interval_seconds` etc. in `config.toml` for one-off alarms. Runtime alarms are additive and workspace-scoped; config alarms are for permanent setups.
- Run `daemon restart` to pick up alarm changes. Runtime alarms restart background loops automatically; config alarms need `codex-team daemon reload-config`.

## Related

- When to arm the watchdog at all: `watch-codex-team` §Watchdog
- Alarm schema + template variables: `configure-codex-team` §Watchdog alarms
- Normal bootstrap (no watchdog): `/codex-team:bootstrap`
- Inspect alarms in all workspaces: `/codex-team:workspaces`
