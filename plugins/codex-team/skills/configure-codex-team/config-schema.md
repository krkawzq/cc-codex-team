# Config schema

Reference for `configure-codex-team`. Authoritative TOML schema + env overrides + data-dir layout + watchdog alarm definitions.

---

## Config file location

| Platform | Config file |
|---|---|
| Linux / macOS | `$XDG_CONFIG_HOME/codex-team/config.toml` or `~/.config/codex-team/config.toml` |
| Windows | `%APPDATA%\codex-team\config.toml` |

Missing file → built-in defaults. Write only keys you want to override.

## Env var overrides (runtime)

**Plugin-wide** (affect daemon + CLI):

```
CODEX_TEAM_<SECTION>_<KEY>
```

```bash
export CODEX_TEAM_DAEMON_LOGLEVEL=debug
export CODEX_TEAM_QUEUE_MAXPERSESSION=8
export CODEX_TEAM_MONITOR_WATCHDOGINTERVALSECONDS=600
```

**Workspace** (affects which tenant the CLI sees):

```bash
export CODEX_TEAM_WORKSPACE=<name>          # highest-priority resolver
```

→ `using-codex-team` §Workspaces for full resolution order.

## Data-dir resolution

| Mode | `data_dir` | IPC endpoint |
|---|---|---|
| Plugin in Claude Code, Linux / macOS | `${CLAUDE_PLUGIN_DATA}/data` | `${CLAUDE_PLUGIN_DATA}/runtime/daemon.sock` |
| Standalone shell, Linux / macOS | `$XDG_DATA_HOME/codex-team` | `$XDG_RUNTIME_DIR/codex-team/daemon.sock` |
| Windows | `%LOCALAPPDATA%\codex-team` | `\\.\pipe\codex-team-<data-dir-hash>` |

One daemon per `data_dir`; workspaces are virtual tenants *inside* that daemon. Setting `[daemon].data_dir` or `[daemon].socket_path` explicitly overrides both modes. On Windows, an explicit `socket_path` must be a named pipe path.

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
agent_message_full = true        # 0.4.0+: always full text; flag retained but ignored
reasoning_capture = false
stderr_tail_lines_on_fail = 20
max_files_listed = 8             # 0.4.0+: Timeline emits every change; flag retained but ignored
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

## Watchdog alarms

The `watchdog` stream carries one named alarm at a time; each alarm is scoped to exactly one workspace. **Alarms come from two places.**

### Persistent (config.toml)

For alarms stable across daemon restarts and across every Claude Code session in a workspace:

```toml
[monitor.watchdog_alarms.<workspace>.<alarm-name>]
enabled = true                   # false to disable without deleting the section
interval_seconds = 7200          # positive integer
task_brief_file = ""             # optional; head N lines injected
task_brief_head_lines = 30
emit_idle = false                # false = silent on no signal
template = ""                    # inline template string
template_file = ""               # file path; wins over `template`
```

After editing:

```bash
codex-team daemon reload-config
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
codex-team watch alarm delete <alarm-name>
```

Runtime alarms live at `<data_dir>/alarms/<workspace>/<alarm-name>.json` and survive daemon restarts.

`/codex-team:watch` wraps `alarm create` and arms the Monitor stream in one step.

### `emit_idle`

- `emit_idle = false` (default): the alarm **skips** its tick when there's no signal (no running session, no advisories, no task brief).
- `emit_idle = true`: the alarm **always** emits on cadence. Use for fixed-cadence briefings (morning standup).

### Template variables

Rendered with `{{var}}` and `{{#if var}}...{{/if}}`:

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

### Example alarm configurations

**Task-brief reminder** (every 2 hours, always emit, show brief) — persistent:

```toml
[monitor.watchdog_alarms.proj-abcd1234.task_brief]
interval_seconds = 7200
task_brief_file = "/abs/path/to/brief.md"
emit_idle = true
```

**Silent drift detector** (every 30 minutes, only emit on advisory) — runtime:

```bash
codex-team watch alarm create drift --interval-seconds 1800
```

**Fixed-cadence standup** — persistent:

```toml
[monitor.watchdog_alarms.proj-abcd1234.standup]
interval_seconds = 28800
emit_idle = true
template_file = "/abs/path/to/standup-template.md"
```
