---
name: configure-codex-team
description: >-
  Reference index for codex-team: complete CLI (every command, positional, flag, error code), daemon config keys (hot vs. restart), codex profiles (`--profile` contract, precedence), environment overrides (`CODEX_TEAM_DATA_DIR`, `CODEX_TEAM_SOCK`, `CLAUDE_PLUGIN_DATA`). **Load proactively when looking up any command/flag signature, changing a daemon knob (`daemon config set …`), tuning `codex.default_*` / `retry.*` / `monitor.*` / `app_server.*`, defining reusable codex profiles (`reviewer`, `fixer`, `planner`, `tester`, `explorer`), checking Node/codex prerequisites, troubleshooting env var routing, or verifying `dist` freshness.** Not for: session lifecycle (`manage-codex-team`), failure triage (`recover-codex-team`), collaboration patterns (`codex-team-playbooks`), first-time mental model (`using-codex-team`).
---

# Configure codex-team

> You need to look up a command, tune a daemon knob, or set a default. This skill is an index — jump straight to the reference you need.

## Reference files

| File | Use when |
|---|---|
| `cli-reference.md` | Every CLI command, positional, flag, error code |
| `config-keys.md` | Every `daemon config` key: type, default, hot vs restart |
| `profiles-library.md` | **Built-in role profiles (`fixer` / `reviewer` / `planner` / `tester` / `explorer`) — read this before any playbook work** |
| `profiles.md` | The two profile systems: skill-bundled library vs user-local `~/.codex/config.toml` `--profile <name>` |
| `env-vars.md` | `CODEX_TEAM_DATA_DIR`, `CODEX_TEAM_SOCK`, `CLAUDE_PLUGIN_DATA` routing |

## Quick lookups

### Change daemon idle threshold from 6h to 2h

```bash
codex-team daemon config set daemon.idle_shutdown_hours 2
```

Key is hot — effective next check cycle (next minute).

### Make every new session default to gpt-5.4

```bash
codex-team daemon config set codex.default_model gpt-5.4
```

Hot. `session new` without `--model` now uses this.

### Give new sessions a default auto-approve policy

```bash
codex-team daemon config set session.auto_approve_command_patterns 'git*,npm test,vitest*'
```

Hot. New sessions inherit this CSV only when `session new` omits `--auto-approve`.

### Override or opt out per session

```bash
codex-team -b $TOKEN session new audit --auto-approve 'git*,npm test'
codex-team -b $TOKEN session new careful --auto-approve ""
```

- Explicit `--auto-approve` replaces the daemon default for that session.
- `--auto-approve ""` opts out even when `session.auto_approve_command_patterns` is set.
- Values accept CSV plus JavaScript-style regex literals such as `/^npm (test|run lint)$/`.

### Enable experimental tools on a session

```bash
codex-team -b $TOKEN session new askq --experimental-tools ask-user-question
```

`ask-user-question` is the canonical tool name. Accepted aliases are:

- `ask_user_question`
- `askuserquestion`
- `request-user-input`
- `request_user_input`
- `requestuserinput`

`request-permissions` also exists for the permission-request tool.

### Increase retained events per user

```bash
codex-team daemon config set monitor.event_log_retention 50000
```

Hot. Buffer in memory grows on next `append`; runtime compaction now happens without waiting for a restart.

### Change the sock path (debug / isolate tests)

```bash
codex-team daemon config set daemon.sock_path /tmp/codex-team-test.sock
codex-team daemon restart  # cold key — restart required
```

Or one-off via env:

```bash
CODEX_TEAM_SOCK=/tmp/alt.sock codex-team daemon status
```

### Inspect all config

```bash
codex-team daemon config list
```

Returns every key with current value, default, type, whether explicit, and hot/cold.

### Check daemon freshness and session count

```bash
codex-team daemon status
```

In 0.5.2 this also reports:

- `session_count`
- `dist_built_at`
- `dist_age_seconds`
- `source_newer_than_dist`

If `source_newer_than_dist` is `true`, the checked-in source is newer than `dist/main.js`.

### Reset a single key

```bash
codex-team daemon config unset codex.default_sandbox
```

### Reset everything

```bash
codex-team daemon config reset --yes
```

## Prerequisites

codex-team expects:

- **Node ≥ 18** (ES2022 target; Node 24 tested)
- **`codex` binary on PATH** — the official Codex CLI. Any version with `codex app-server --listen stdio://` support.
- **Write access to `~/.codex-team/`** (or wherever `daemon.data_dir` points)

Verify:

```bash
node --version
which codex && codex --version
ls -la ~/.codex-team/ 2>/dev/null || echo "first run will create it"
```

## Invariants around config

- **Hot keys** take effect without restart. Changes to `daemon.log_level`, `monitor.event_log_retention`, `session.auto_approve_command_patterns`, `codex.default_*`, `experimental.default_tools`, `retry.*`, `monitor.default_interval_seconds`, `app_server.idle_unload_minutes`, `daemon.idle_shutdown_hours` are live immediately (or on next check cycle).
- **Cold keys** require `daemon restart`: `daemon.log_path`, `daemon.data_dir`, `daemon.sock_path`. Response includes `needs_restart: true`.
- **`app_server.max_sessions_per_process`** is hot but only affects *new* reusable app-server processes; live sessions are isolated by default.
- **Config is stored at `<data_dir>/config.json`**, written atomically (tmp + rename). Hand-editing works but run `daemon restart` if the daemon was already using the old value.

## Default data layout

```text
~/.codex-team/
├── config.json
├── daemon.log
├── daemon.pid
├── daemon.sock          # Unix only; Windows uses a named pipe derived from sock_path/data_dir
├── codex-pids.json
└── users/
    └── <url-safe-base64(token)>/
        ├── metadata.json
        ├── sessions.json
        └── events.log
```
