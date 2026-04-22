# Config keys

Complete list. Change via `codex-team daemon config set <key> <value>`. Inspect via `daemon config list`.

## `daemon.*`

| Key | Type | Default | Hot/cold | Notes |
|---|---|---|---|---|
| `daemon.idle_shutdown_hours` | int | `6` | hot | Threshold for auto-shutdown after no activity (requires 0 live sessions) |
| `daemon.log_level` | enum | `info` | hot | `error` / `warn` / `info` / `debug` / `trace` |
| `daemon.log_path` | path | `<data_dir>/daemon.log` | restart | JSONL log destination |
| `daemon.data_dir` | path | `~/.codex-team` | restart | Root for all persistent state |
| `daemon.sock_path` | path | `<data_dir>/daemon.sock` (Unix) / named-pipe seed (Windows) | restart | Daemon IPC endpoint |
| `daemon.ready_timeout_seconds` | int | `15` | hot | How long cli waits for daemon readiness after spawn |
| `daemon.connect_timeout_seconds` | int | `5` | hot | Per-attempt cli connect timeout to the daemon |
| `daemon.connect_retry_attempts` | int | `3` | hot | Retry count for transient cli→daemon connect/request failures |
| `daemon.connect_retry_delay_seconds` | float | `0.25` | hot | Delay between transient cli→daemon retries |

## `monitor.*`

| Key | Type | Default | Hot/cold | Notes |
|---|---|---|---|---|
| `monitor.default_interval_seconds` | int | `30` | hot | `monitor events` `--interval` default |
| `monitor.event_log_retention` | int | `10000` | hot | Per-user ring buffer size |

## `app_server.*`

| Key | Type | Default | Hot/cold | Notes |
|---|---|---|---|---|
| `app_server.max_sessions_per_process` | int | `16` | hot (new processes only) | Cap for reusable app-server clients; live sessions are isolated by default, so this mainly affects adhoc/read-only clients |
| `app_server.idle_unload_minutes` | int | `60` | hot | Reserved config; idle unload is not implemented yet |
| `app_server.request_timeout_seconds` | int | `120` | hot | Per-request app-server JSON-RPC timeout; timeout closes that client for consistency |

## `retry.*`

Applied to wrapped app-server RPCs when codex returns transient overload / stream / connection errors (`server_overloaded`, `http_connection_failed`, `response_stream_connection_failed`, `response_stream_disconnected`). Request timeouts are **not** retried.

| Key | Type | Default | Hot/cold | Notes |
|---|---|---|---|---|
| `retry.max_attempts` | int | `3` | hot | |
| `retry.initial_delay_seconds` | float | `0.25` | hot | Starting backoff |
| `retry.max_delay_seconds` | float | `2.0` | hot | Backoff cap |

±20% jitter built in; not configurable.

## `codex.*` (defaults for `session new`)

| Key | Type | Default | Hot/cold | Notes |
|---|---|---|---|---|
| `codex.default_model` | string | empty (codex decides) | hot | Used when `--model` not given |
| `codex.default_sandbox` | enum | `workspace-write` | hot | `read-only` / `workspace-write` / `danger-full-access` |
| `codex.default_approval` | enum | `on-request` | hot | `never` / `on-request` / `on-failure` / `untrusted` |
| `codex.default_effort` | enum | `medium` | hot | `minimal` / `low` / `medium` / `high` / `xhigh` |

## When a key requires restart

Cold keys affect daemon bootstrap paths (log file, data root, sock binding). Set, then:

```bash
codex-team daemon restart
```

Most hot keys apply immediately. `daemon.idle_shutdown_hours` is checked on the next idle timer tick (up to one minute).
