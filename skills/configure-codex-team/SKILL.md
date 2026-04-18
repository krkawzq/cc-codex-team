---
name: configure-codex-team
description: Reference for the codex-team `config.toml` schema, profile system, environment-variable overrides, and the plugin's `userConfig` prompts. Use when setting up profiles for new session roles, tuning daemon / digest / monitor / heartbeat / queue parameters, or debugging why a session was created with unexpected defaults.
---

# Configure codex-team

All session-level defaults and daemon runtime knobs live in a single
TOML file. This skill documents the schema and the design patterns
for building per-role `[profiles.<name>]` entries so that
`codex-team session create <name> --profile <role>` is all you ever
need on the command line.

## Config file location

```
$XDG_CONFIG_HOME/codex-team/config.toml     # usually ~/.config/codex-team/config.toml
```

If the file is missing, the daemon starts with built-in defaults. You
only need to write the keys you want to override — unspecified keys
fall back to defaults.

Every scalar key can also be overridden at runtime by an environment
variable of the form `CODEX_TEAM_<SECTION>_<KEY>` (uppercased,
underscore-joined). Intended for test scripts and one-off experiments;
prefer the TOML file for persistent config.

## Full schema

```toml
[daemon]
socket_path    = ""                  # blank → $XDG_RUNTIME_DIR/codex-team/daemon.sock
data_dir       = ""                  # blank → $XDG_DATA_HOME/codex-team
log_level      = "info"              # debug | info | warn | error
codex_bin      = ""                  # blank → resolved via PATH / codex-cli-bin package
codex_home     = ""                  # blank → ~/.codex
launch_args_override = []            # extra args forwarded to `codex app-server`
config_overrides     = []            # extra `--config key=val` forwarded to codex

[defaults]
model                       = "gpt-5.4"
reasoning_effort            = "xhigh"       # minimal | low | medium | high | xhigh
sandbox                     = "danger_full_access"   # danger_full_access | workspace_write | read_only
approval_policy             = "never"       # never | on_request | on_failure
cwd                         = ""            # blank → inherit CLI caller's cwd
auto_resume_on_daemon_start = true
service_tier                = ""            # "" | priority | flex
personality                 = ""            # style preset, codex-side enum
base_instructions           = ""            # system-prompt prefix, raw text
developer_instructions      = ""            # dev-message prefix, raw text
profile                     = ""            # default profile if none is passed on create

[digest]
history_md_enabled            = true        # per-session history.md on disk
turns_jsonl_enabled           = true        # machine-readable turn log
command_truncate_chars        = 120         # long bash commands truncated to this
agent_message_full            = true        # always show full final_answer text
reasoning_capture             = false       # keep reasoning items in jsonl (not in monitor)
stderr_tail_lines_on_fail     = 20          # how many stderr lines to attach on command failure
max_files_listed              = 8           # in digest, list up to N changed files
tool_args_truncate_chars      = 80          # MCP/tool call arg preview width
history_rotation_mb           = 32          # (reserved; not enforced yet)

[compaction]
threshold_tokens      = 500_000             # [compact-suggest] fires when usage crosses this
mode                  = "manual"            # currently only "manual" is supported
progress_doc_template = ""                  # e.g. "docs/refactor/{session_name}/progress.md"

[monitor]
events_max_buffer              = 1000
watchdog_interval_seconds      = 1200       # 20 min; lower only with reason
watchdog_task_brief_file       = ""         # blank → watchdog block omits the brief
watchdog_task_brief_head_lines = 30
watchdog_stale_minutes         = 30         # advisory when a session idles past this
subscriber_queue_max           = 200

[heartbeat]
interval_seconds         = 60               # health probe cadence
turn_stuck_seconds       = 600              # a turn running > this → [turn-stuck]
self_heal_once           = true
health_timeout_seconds   = 15
health_check_concurrency = 8
resume_timeout_seconds   = 30
self_heal_backoff_seconds = 30

[queue]
max_per_session = 5
overflow_policy = "warn"                    # warn | reject | drop_oldest
```

## Profiles — the recommended way to configure sessions

A profile is a named bundle of per-session defaults. When you create a
session with `--profile <name>`, values from `[profiles.<name>]`
override `[defaults]` for that session. Unset keys fall through.

### Minimal profile

```toml
[profiles.reviewer]
reasoning_effort = "high"
developer_instructions = """
You review code for security, correctness, and style. Never write
production code; only comment and propose diffs.
"""
```

Usage:

```bash
codex-team session create reviewer --cwd /path/to/repo --profile reviewer
```

### Worked examples

**Refactor worker** — write-capable, xhigh reasoning, instructions
embedded:

```toml
[profiles.refactor]
model = "gpt-5.4"
reasoning_effort = "xhigh"
sandbox = "danger_full_access"
approval_policy = "never"
developer_instructions = """
You execute a specific refactor task. Follow the per-session progress
file in docs/refactor/<session>/progress.md. Never run git. Never
touch files outside the current worktree.
"""
```

**Read-only auditor** — cannot edit, only reads:

```toml
[profiles.auditor]
model = "gpt-5.4"
reasoning_effort = "xhigh"
sandbox = "read_only"
approval_policy = "never"
developer_instructions = """
You produce audit reports only. Do not write files or edit anything.
Your deliverable is a Markdown report streamed as your final message.
"""
```

**Test runner** — fast iteration, trivial reasoning:

```toml
[profiles.test]
model = "gpt-5.4-mini"
reasoning_effort = "low"
sandbox = "workspace_write"
approval_policy = "never"
developer_instructions = """
You run tests and report failures concisely. Do not fix tests; only
report and move on.
"""
```

### Profile design checklist

When adding a new profile, answer these before committing:

1. **Role boundary** — what is this session allowed to do, and what
   must it refuse? Put the refusal in `developer_instructions`.
2. **Model tier** — heavy reasoning (gpt-5.4 + xhigh) vs fast iteration
   (mini + low). Cost and latency scale together.
3. **Sandbox level** — `danger_full_access` only when the session must
   edit; use `workspace_write` or `read_only` otherwise to narrow the
   blast radius.
4. **Approval policy** — always `never` in this plugin; approval
   interactions would deadlock the async monitor loop.
5. **Stable cwd or per-call?** — if the role has a fixed worktree,
   embed `cwd`; otherwise leave blank and pass `--cwd` on create.

## Environment overrides

Useful patterns:

```bash
# Temporarily raise compaction threshold for a heavy session
CODEX_TEAM_COMPACTION_THRESHOLD_TOKENS=900000 codex-team daemon start

# Point daemon at an alternate codex binary for local dev
CODEX_TEAM_DAEMON_CODEX_BIN=/opt/codex-dev/bin/codex codex-team daemon start

# Verbose daemon logs while diagnosing
CODEX_TEAM_DAEMON_LOG_LEVEL=debug codex-team daemon start

# Change watchdog cadence for a test run (short, forces wakes)
CODEX_TEAM_MONITOR_WATCHDOG_INTERVAL_SECONDS=60 codex-team daemon start
```

Env overrides are read once at daemon startup. Changing them after the
daemon is running has no effect; edit `config.toml` and use
`codex-team daemon reload-config` (if available) or bounce the daemon.

## When to tune which knob

| You want to… | Change | Section |
|---|---|---|
| Run more sessions at once | (no knob) just create more | — |
| See fewer `[compact-suggest]` events | Raise `threshold_tokens` | `[compaction]` |
| Force compaction earlier | Lower `threshold_tokens` | `[compaction]` |
| Get woken more often by the watchdog | Lower `watchdog_interval_seconds` | `[monitor]` |
| Stop watchdog brief injection | Clear `watchdog_task_brief_file` | `[monitor]` |
| Capture reasoning chains for audit | Enable `reasoning_capture` | `[digest]` |
| Drop history.md (keep only jsonl) | Disable `history_md_enabled` | `[digest]` |
| Reject new sends instead of queuing | Set `overflow_policy = "reject"` | `[queue]` |
| Detect stuck turns sooner | Lower `turn_stuck_seconds` | `[heartbeat]` |
| Disable single-shot self-heal | Set `self_heal_once = false` | `[heartbeat]` |

## Red flags

| Thought | Correction |
|---|---|
| "I'll hand-edit defaults for every session create." | Use profiles. One definition, many sessions. |
| "I'll set `approval_policy = on_request` to be safe." | Async monitor loop has no approval channel. Keep `never` and control via `sandbox`. |
| "`danger_full_access` is default — that's scary." | It is. But the plugin is designed as a YOLO orchestrator; tune per-role with `read_only` / `workspace_write` profiles instead of changing defaults. |
| "I'll lower `watchdog_interval_seconds` to 60 for faster feedback." | 20 min is chosen to avoid drowning you in context. Events stream handles fast feedback; don't confuse the two. |

## Cross-references

- Create a session using a profile: `manage-codex-team` §create
- Understanding events/watchdog payloads: `watch-codex-team`
- Compaction threshold meaning: `compact-codex-team`
- After editing config: bounce daemon via `recover-codex-team` or
  reload with `codex-team daemon reload-config`
