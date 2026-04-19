---
name: configure-codex-team
description: Authoritative source for the codex-team `config.toml` schema, the profile system, the `watchdog_alarms` multi-alarm schema + template variables, environment-variable overrides, and runtime prerequisites. Trigger when setting up a new profile, defining a watchdog alarm, tuning a daemon / monitor / queue knob, debugging unexpected session defaults, or verifying Node / Codex CLI prerequisites. Not for: session lifecycle (`manage-codex-team`), failure triage (`recover-codex-team`), arming monitors (`watch-codex-team`).
---

# Configure codex-team

The Node daemon talks directly to `codex app-server` over JSON-RPC. No Python bootstrap, no SDK package. Config is TOML-first; profiles layer on top; env vars override scalar keys at runtime.

## Runtime prerequisites

| Dependency | Role |
|---|---|
| Node.js 18+ | Runs `dist/main.js` and the wrapper |
| `codex` CLI | Daemon spawns `codex app-server --listen stdio://` subprocesses |

Verify:

```bash
node --version
codex --version
codex login
# from plugin checkout:
npm install && npm run typecheck && npm run build
```

Common failures:

| Symptom | Fix |
|---|---|
| `node: command not found` | Install Node 18+ |
| `dist/main.js missing` | `npm install && npm run build` in plugin checkout |
| `E_NO_CODEX_BIN` | `npm install -g @openai/codex && codex login`; or pin `[daemon].codex_bin` |

## Config file location

```
$XDG_CONFIG_HOME/codex-team/config.toml      # usually ~/.config/codex-team/config.toml
```

Missing file → built-in defaults. Write only keys you want to override.

## Env var overrides (runtime)

```
CODEX_TEAM_<SECTION>_<KEY>
```

Examples:

```bash
export CODEX_TEAM_DAEMON_LOGLEVEL=debug
export CODEX_TEAM_QUEUE_MAXPERSESSION=8
export CODEX_TEAM_MONITOR_WATCHDOGINTERVALSECONDS=600
```

For test runs and shell-local experiments. Prefer `config.toml` for persistent setup.

## Data-dir resolution

| Mode | `data_dir` | `socket_path` |
|---|---|---|
| Plugin in Claude Code | `${CLAUDE_PLUGIN_DATA}/data` | `${CLAUDE_PLUGIN_DATA}/runtime/daemon.sock` |
| Standalone shell | `$XDG_DATA_HOME/codex-team` | `$XDG_RUNTIME_DIR/codex-team/daemon.sock` |

Setting `[daemon].data_dir` or `[daemon].socket_path` explicitly in `config.toml` overrides both modes.

## Full schema (authoritative)

```toml
[daemon]
socket_path = ""                 # blank → wrapper / XDG default
data_dir = ""                    # blank → wrapper / XDG default
log_level = "info"               # debug | info | warn | error
codex_bin = ""                   # blank → PATH / CODEX_TEAM_CODEX_BIN
codex_home = ""                  # blank → inherit env
launch_args_override = []        # replaces default app-server args
config_overrides = []            # repeated `--config key=value` for codex
rpc_timeout_seconds = 60

[defaults]
model = "gpt-5.4"
model_provider = ""
sandbox = "danger_full_access"   # normalized to danger-full-access
approval_policy = "never"        # never | on-request | on-failure
cwd = ""
auto_resume_on_daemon_start = true
service_tier = ""
reasoning_effort = ""            # blank → codex runtime default
personality = ""
base_instructions = ""
developer_instructions = ""
profile = ""

[digest]
history_md_enabled = true
turns_jsonl_enabled = true
command_truncate_chars = 120
agent_message_full = true
reasoning_capture = false
stderr_tail_lines_on_fail = 20
max_files_listed = 8
tool_args_truncate_chars = 80
history_rotation_mb = 32         # rotates to .1 when crossed

[compaction]
threshold_tokens = 500000
mode = "manual"
progress_doc_template = ""
retry_attempts = 2
retry_delay_ms = 1500

[monitor]
events_max_buffer = 1000
watchdog_interval_seconds = 1200
watchdog_task_brief_file = ""
watchdog_task_brief_head_lines = 30
watchdog_stale_minutes = 30
subscriber_queue_max = 200
watchdog_emit_idle = false
watchdog_template = ""
watchdog_template_file = ""

# Named alarms — see §Watchdog alarms below
# [monitor.watchdog_alarms.<alarm-name>]
# enabled = true
# interval_seconds = 7200
# task_brief_file = ""
# task_brief_head_lines = 30
# emit_idle = false
# template = ""
# template_file = ""

[heartbeat]
interval_seconds = 60
turn_stuck_seconds = 600
self_heal_once = true
health_timeout_seconds = 15
health_check_concurrency = 8
resume_timeout_seconds = 30
self_heal_backoff_seconds = 30

[queue]
max_per_session = 5
overflow_policy = "warn"         # warn | reject | drop_oldest
```

## Profiles

Recommended way to specialize a session. Profiles layer over `[defaults]`.

```toml
[profiles.reviewer]
model = "gpt-5.4"
reasoning_effort = "high"
approval_policy = "never"
developer_instructions = """
Review correctness, risk, and tests. Do not commit.
"""
```

Usage:

```bash
codex-team session create <name> --cwd <abs-path> --profile reviewer
```

### Suggested shapes

```toml
[profiles.quickfix]
model = "gpt-5.4-mini"
reasoning_effort = "low"

[profiles.refactor]
model = "gpt-5.4"
reasoning_effort = "high"
developer_instructions = """
Keep the work doc current. Prefer small verified edits.
"""

[profiles.scratch]
model = "gpt-5.4-mini"
reasoning_effort = "medium"
```

Ephemeral scratch:

```bash
codex-team session create <name> --cwd <abs-path> --profile scratch --ephemeral
```

Ephemeral sessions die with their app-server; cannot be resumed after daemon shutdown.

## Watchdog alarms

The watchdog stream supports a built-in "default" alarm plus any number of named custom alarms. Each alarm has its own cadence, task brief, template, and idle policy. All alarms share the single `watchdog` Monitor stream; payloads carry `alarm: <name>` so you can distinguish them.

### Schema

```toml
[monitor.watchdog_alarms.<alarm-name>]
enabled = true                   # set false to disable without deleting the section
interval_seconds = 7200          # positive integer; cadence of this alarm
task_brief_file = ""             # optional; absolute path or relative to cwd
task_brief_head_lines = 30       # max lines of the brief to inject into payload
emit_idle = false                # false = skip tick if no signal; true = always fire
template = ""                    # inline template string; overrides default
template_file = ""               # file path; wins over `template` if both set
```

Reload after adding / editing:

```bash
codex-team daemon reload-config
```

Or use `/codex-team:watch <name> [--task-brief PATH] [--interval SECS] [--template PATH]` which writes the block and reloads for you.

### `emit_idle` behavior

- `emit_idle = false` (default): the alarm **skips** its tick when there's no signal — i.e., no running session, no advisories, no task brief. Keeps the stream quiet when nothing needs attention.
- `emit_idle = true`: the alarm **always** emits on cadence. Use when you want a fixed-cadence briefing (morning standup pattern).

### Template variables

The template is rendered with `{{var}}` and `{{#if var}}...{{/if}}`. Available variables:

| Variable | Value |
|---|---|
| `{{at}}`, `{{sentAt}}` | ISO timestamp |
| `{{localTime}}` | Human-readable local time |
| `{{alarm}}` | Name of the firing alarm |
| `{{taskBrief}}` | First N lines of `task_brief_file`, or empty |
| `{{summary.total}}` | Session count |
| `{{summary.running}}` | Running-now count |
| `{{summary.errored}}` | Errored count |
| `{{summary.queued}}` | Queued-items total across sessions |
| `{{sessionsText}}` | Pre-formatted per-session lines |

`{{#if var}}…{{/if}}` blocks render only when `var` is truthy / non-empty.

### Example alarm configurations

Task-brief reminder (every 2 hours, always emit, show brief):

```toml
[monitor.watchdog_alarms.task_brief]
interval_seconds = 7200
task_brief_file = "/abs/path/to/brief.md"
emit_idle = true
```

Silent drift detector (every 30 minutes, only emit on advisory):

```toml
[monitor.watchdog_alarms.drift]
interval_seconds = 1800
emit_idle = false
```

Fixed-cadence standup with custom template file:

```toml
[monitor.watchdog_alarms.standup]
interval_seconds = 28800
emit_idle = true
template_file = "/abs/path/to/standup-template.md"
```

See `watch-codex-team` §Watchdog for usage patterns and when to arm this stream at all.

## Hot-reload behavior

- `session create`, `session resume`, `session restart`, `health repair` refresh `config.toml` from disk before acting. New profiles do **not** require a daemon restart.
- `daemon reload-config` reapplies heartbeat / watchdog intervals + alarm definitions immediately; no full restart needed for cadence-only changes.
- `compact` retries automatically on failure — tune with `compaction.retry_attempts` / `compaction.retry_delay_ms`.
- `history_rotation_mb` enforces rotation for both `history.md` and `turns.jsonl`; over threshold → current file → `.1`, new file starts.
- `launch_args_override` replaces the default app-server argv entirely. Use `config_overrides` for single-flag tweaks; reach for `launch_args_override` only when you need complete control.

## When to tune which knob

| Goal | Knob |
|---|---|
| Different default model | `[defaults].model` or `[profiles.X].model` |
| Change session-level effort | `[profiles.X].reasoning_effort` |
| Lower cost on one turn | `codex-team send ... --effort low` (no config change) |
| More/fewer parallel queued sends | `[queue].max_per_session` |
| Stricter queue behavior | `[queue].overflow_policy = "reject"` |
| Periodic task reminder for long-horizon work | `[monitor.watchdog_alarms.<name>]` with `task_brief_file` |
| Silent drift detector | `[monitor.watchdog_alarms.<name>]` with `emit_idle = false` |
| Faster turn-stuck detection | `[heartbeat].turn_stuck_seconds` |
| Different compact threshold | `[compaction].threshold_tokens` |
| Pin a specific Codex binary | `[daemon].codex_bin` |

## Red flags

| Thought | Correction |
|---|---|
| "I need to install a Python SDK first." | No. Node talks to app-server directly. |
| "I'll set `launch_args_override` for a tiny tweak." | Use `config_overrides`. Replace argv only when necessary. |
| "Cut `watchdog_interval_seconds` to 30 for fast feedback." | Fast feedback = `events` stream. Watchdog is low-frequency reminder. |
| "Define an alarm so I'll know the moment a session breaks." | That's the `events` stream's job (`session-down`, `turn-err`). Watchdog is reminder + self-check. |
| "Add `emit_idle = true` to every alarm." | Only for fixed-cadence briefings. Otherwise silence-on-no-signal is a feature. |
| "Edit config then restart the daemon." | Most changes hot-reload. Try `daemon reload-config` first. |

## Cross-references

- Session lifecycle: `manage-codex-team`
- When to arm the watchdog stream at all: `watch-codex-team` §Watchdog
- Quick alarm wiring: `/codex-team:watch`
- Failure triage: `recover-codex-team`
