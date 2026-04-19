---
name: configure-codex-team
description: Authoritative source for the codex-team `config.toml` schema, the profile system, the per-workspace watchdog alarm schema, runtime alarm storage, environment-variable overrides, and runtime prerequisites. Trigger when setting up a new profile, defining a persistent watchdog alarm, tuning a daemon / monitor / queue knob, debugging unexpected session defaults, or verifying Node / Codex CLI prerequisites. Not for: session lifecycle (`manage-codex-team`), failure triage (`recover-codex-team`), arming monitors (`watch-codex-team`).
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

Two kinds of env vars matter:

**Plugin-wide** (affect daemon + CLI):

```
CODEX_TEAM_<SECTION>_<KEY>
```

```bash
export CODEX_TEAM_DAEMON_LOGLEVEL=debug
export CODEX_TEAM_QUEUE_MAXPERSESSION=8
export CODEX_TEAM_MONITOR_WATCHDOGINTERVALSECONDS=600
```

**Workspace** (affect which tenant the CLI sees):

```bash
export CODEX_TEAM_WORKSPACE=<name>          # highest-priority resolver
```

→ `using-codex-team` §Workspaces for the full resolution order.

## Data-dir resolution

| Mode | `data_dir` | `socket_path` |
|---|---|---|
| Plugin in Claude Code | `${CLAUDE_PLUGIN_DATA}/data` | `${CLAUDE_PLUGIN_DATA}/runtime/daemon.sock` |
| Standalone shell | `$XDG_DATA_HOME/codex-team` | `$XDG_RUNTIME_DIR/codex-team/daemon.sock` |

The daemon is one process per `data_dir`; workspaces are virtual tenants *inside* that daemon. Setting `[daemon].data_dir` or `[daemon].socket_path` explicitly in `config.toml` overrides both modes.

### Under the data dir

```
<data_dir>/
├── registry.json                     # multi-workspace session registry
├── daemon.pid
├── daemon.log
├── sessions/
│   └── <workspace>/<name>/           # per-session work
│       ├── history.md
│       ├── turns.jsonl
│       └── app-server.stderr.log
├── clients/
│   └── c-<client-id>.json            # one file per live Claude Code
└── alarms/
    └── <workspace>/<alarm-name>.json # runtime watchdog alarms
```

You don't normally read these files — use `codex-team` commands. Useful to know when debugging.

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
history_rotation_mb = 32

[compaction]
threshold_tokens = 500000
mode = "manual"
progress_doc_template = ""
retry_attempts = 2
retry_delay_ms = 1500
timeout_seconds = 120

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

# Persistent per-workspace alarms — see §Watchdog alarms below
# [monitor.watchdog_alarms.<workspace>.<alarm-name>]
# enabled = true
# interval_seconds = 7200
# ...

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

The watchdog stream carries one named alarm at a time; each alarm is scoped to exactly one workspace. **Alarms come from two places:**

### Persistent (config.toml)

For alarms you want stable across daemon restarts and across every Claude Code session in a given workspace:

```toml
[monitor.watchdog_alarms.<workspace>.<alarm-name>]
enabled = true                   # set false to disable without deleting the section
interval_seconds = 7200          # positive integer
task_brief_file = ""             # optional; head N lines injected
task_brief_head_lines = 30
emit_idle = false                # false = silent on no signal
template = ""                    # inline template string
template_file = ""               # file path; wins over `template`
```

After editing config:

```bash
codex-team daemon reload-config
```

Or:

```bash
codex-team --workspace <ws> watch alarm create ... # runtime-registered, does not touch config.toml
```

### Runtime (CLI-registered, stored under data dir)

Preferred for one-off task-specific alarms you don't want polluting `config.toml`:

```bash
codex-team watch alarm create <alarm-name> \
  [--interval-seconds N] \
  [--task-brief-file PATH] \
  [--task-brief-head-lines N] \
  [--template-file PATH | --template "inline text"] \
  [--emit-idle] \
  [--disabled]

codex-team watch alarm list                   # current workspace
codex-team watch alarm list --all-workspaces  # all (audit)
codex-team watch alarm delete <alarm-name>    # current workspace
```

Runtime alarms are stored at `<data_dir>/alarms/<workspace>/<alarm-name>.json` and survive daemon restarts.

The slash command `/codex-team:watch` wraps `alarm create` and arms the Monitor stream in one step.

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
| `{{workspace}}` | Workspace name |
| `{{taskBrief}}` | First N lines of `task_brief_file`, or empty |
| `{{summary.total}}` | Session count (workspace-scoped) |
| `{{summary.running}}` | Running-now count |
| `{{summary.errored}}` | Errored count |
| `{{summary.queued}}` | Queued-items total across sessions |
| `{{sessionsText}}` | Pre-formatted per-session lines |

`{{#if var}}…{{/if}}` blocks render only when `var` is truthy / non-empty.

### Example alarm configurations

Task-brief reminder (every 2 hours, always emit, show brief) — persistent:

```toml
[monitor.watchdog_alarms.proj-abcd1234.task_brief]
interval_seconds = 7200
task_brief_file = "/abs/path/to/brief.md"
emit_idle = true
```

Silent drift detector (every 30 minutes, only emit on advisory) — runtime:

```bash
codex-team watch alarm create drift --interval-seconds 1800
```

Fixed-cadence standup with custom template — persistent:

```toml
[monitor.watchdog_alarms.proj-abcd1234.standup]
interval_seconds = 28800
emit_idle = true
template_file = "/abs/path/to/standup-template.md"
```

See `watch-codex-team` for when to arm at all.

## Hot-reload behavior

- `session create`, `session resume`, `session restart`, `health repair` refresh `config.toml` from disk before acting. New profiles do **not** require a daemon restart.
- `daemon reload-config` reapplies heartbeat / watchdog intervals + alarm definitions immediately; no full restart needed for cadence-only changes.
- Runtime alarms (`watch alarm create|delete`) restart background loops automatically.
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
| One-off task reminder | `codex-team watch alarm create ...` (runtime) |
| Permanent project-wide reminder | `[monitor.watchdog_alarms.<ws>.<name>]` (config) |
| Silent drift detector | Any alarm with `emit_idle = false` (the default) |
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
| "I'll write a runtime alarm that spans multiple workspaces." | Alarms are workspace-scoped by design. Create one per workspace. |
| "Edit config then restart the daemon." | Most changes hot-reload. Try `daemon reload-config` first. |
| "I'll put one-off task reminders in `config.toml`." | Use the runtime CLI (`watch alarm create`). Config alarms are for permanent, multi-session setups. |

## Cross-references

- Session lifecycle: `manage-codex-team`
- When to arm the watchdog stream at all: `watch-codex-team` §Watchdog
- Quick runtime alarm + Monitor arming: `/codex-team:watch`
- Workspace resolution + concept: `using-codex-team` §Workspaces
- Failure triage: `recover-codex-team`
