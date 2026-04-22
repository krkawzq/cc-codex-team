---
name: configure-codex-team
description: >-
  CLI reference, daemon config, codex profiles, and environment overrides for codex-team. Trigger when looking up a command/flag, wanting to change a daemon knob (`daemon config set …`), adjusting codex.default_* values, verifying Node/codex prerequisites, or troubleshooting env var routing. Not for: session lifecycle (`manage-codex-team`), failure triage (`recover-codex-team`), collaboration patterns (`codex-team-playbooks`).
---

# Configure codex-team

> You need to look up a command, tune a daemon knob, or set a default. This skill is an index — jump straight to the reference you need.

## Reference files

| File | Use when |
|---|---|
| `cli-reference.md` | Every CLI command, positional, flag, error code |
| `config-keys.md` | Every `daemon config` key: type, default, hot vs restart |
| `profiles.md` | How to use codex profiles (`--profile`) with session new |
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

- **Hot keys** take effect without restart. Changes to `daemon.log_level`, `monitor.event_log_retention`, `codex.default_*`, `retry.*`, `monitor.default_interval_seconds`, `app_server.idle_unload_minutes`, `daemon.idle_shutdown_hours` are live immediately (or on next check cycle).
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
