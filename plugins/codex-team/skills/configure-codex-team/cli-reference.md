# CLI reference

Every command in `codex-team`. Successful non-streaming commands return one JSON object per line by default; errors still use the standard `{"ok":false,"error":{...}}` envelope. Streaming commands emit JSONL/NDJSON unless you request markdown.

## Output modes (0.5.3+)

Most leaf commands accept the same three output modes — pick based on what you're going to do with the result, not which command you're running. `doctor` is the carve-out: human-readable by default, `--short` for a one-line summary, `--json` for the structured result body.

| Mode | Flag | What you get |
|---|---|---|
| **Concise (default)** | _none_ | Single-line JSONL with only the fields Claude needs to decide what to do next (correlation ids, flow-control flags, outcome). ~2–6× smaller than `--full`. |
| **Verbose** | `--full` | Multi-line pretty-printed JSON with the complete record including timestamps, config echo, nested objects. Use when you need a field the concise form omits. |
| **Plain-text** | `--short` | One-line `key=value` for dashboards / `grep`. Not JSON. Available on state-heavy commands only (`status`, `profiles list`, `profiles show`, `session list`, `session info`, `session health`, `daemon status`, `daemon user list`, `message history`, `cursor list`, and the new action-command subset), plus `doctor` as a verdict summary line. |

**Rules**:
- `--short` and `--full` are mutually exclusive (→ `invalid_params`).
- `--short` cannot combine with `--format markdown|table`.
- Errors are never projected — error envelopes always surface in full regardless of mode.
- `--format markdown` (available on `message tail` / `message history` / `session context`) overrides JSON projection and renders tag-structured markdown.

## Global

```
codex-team [global-flags] <command> [args] [flags]
```

| Flag | Type | Required | Default | Notes |
|---|---|---|---|---|
| `-b, --bearer <token>` | string | Yes (except `daemon` group + `version`) | — | User identity |
| `-v, --verbose` | bool | No | false | cli-side debug to stderr |
| `--daemon-sock <path>` | path | No | from config | Override sock for debug/test |
| `-h, --help` | bool | No | false | Print help |

Top-level convenience: `codex-team version` (no `-b`), `codex-team doctor` (no `-b`).
`--full` is not a global flag; it appears on leaf commands that support JSON projection.
Per-command help works too: `codex-team session --help`, `codex-team session new --help`, `codex-team daemon config set --help`, etc.
`--help` is a parse terminator: `codex-team daemon --help user create` prints help for `daemon` and ignores the trailing `user create`.

## doctor (no `-b` required)

```
codex-team doctor [--short|--json]
```

Runs eight ordered environment checks and exits `0` (HEALTHY) / `1` (DEGRADED) / `2` (BROKEN). Default output is human-readable with inline remediation hints when a check fails. `--short` emits a single plain-text summary line. `--json` emits `{verdict, checks, exit_code}` directly with no outer `{ok,data}` wrapper. Checks: Node version, `codex` binary on PATH, `codex-team` launcher on PATH, `data_dir` writable, local socket bind permitted, daemon pid/sock consistency, daemon socket reachable, dist freshness. First thing to run if any `codex-team` command hangs or returns `daemon_unreachable` / `socket_bind_denied`.

## profiles (no `-b` required)

| Command | Purpose |
|---|---|
| `profiles list` | List the bundled canonical profiles and their `session new` flag bundles |
| `profiles show <name>` | Show one bundled profile plus a paste-safe `session new` command |

## daemon group (no `-b` required)

| Command | Purpose |
|---|---|
| `daemon status` | Daemon pid / uptime / sock / data_dir / user count / app-server count |
| `daemon start` | Explicit spawn (idempotent; noop if running) |
| `daemon stop [--force]` | Graceful shutdown. `--force` = SIGKILL |
| `daemon restart` | Hand off to a new daemon process (3s sock-vacate window) |
| `daemon logs [-f] [-n <N>] [--level <lvl>]` | Stream daemon log file |
| `daemon user create <token>` | Register a user |
| `daemon user destroy <token> [--force]` | Remove user + their sessions, pending requests, and retained events (`--force` required if live sessions remain) |
| `daemon user list` | All registered users |
| `daemon config get <key>` | `{value, default, source, needs_restart}` |
| `daemon config set <key> <value>` | Apply (hot) or queue for restart (cold) |
| `daemon config unset <key>` | Revert to default |
| `daemon config list [--explicit-only]` | Dump all config |
| `daemon config reset --yes` | Wipe all overrides |

## status (user-scoped, requires `-b`)

```
codex-team -b <token> status
```

Returns your user's live session count, retained event count, pending requests, plus a daemon summary.

## session group

### `session new [name]`

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--model <m>` | string | `codex.default_model` config | Codex model id |
| `--cwd <path>` | path | current dir | Codex working directory |
| `--sandbox <mode>` | enum | `codex.default_sandbox` | `read-only` / `workspace-write` / `danger-full-access` |
| `--approval <policy>` | enum | `codex.default_approval` | `never` / `on-request` / `on-failure` / `untrusted` |
| `--effort <level>` | enum | `codex.default_effort` | `minimal` / `low` / `medium` / `high` / `xhigh` |
| `--personality <preset>` | string | — | Codex personality preset |
| `--base-instructions <file>` | path | — | System-level instructions file |
| `--developer-instructions <file>` | path | — | Developer-level instructions file |
| `--profile <name>` | string | — | Codex config profile. Single flags override same-name fields |

Session auto-goes live on creation. Name rules: `^[A-Za-z0-9_\-]{1,128}$`, not UUID, not `th-*`.

### `session attach <name|thread_id>`

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--takeover` | bool | false | Seize a session currently live under another user |

Notes:
- By name, attach only resolves your own live registry entry or a uniquely live session under another user.
- For detached threads, use the `thread_id`.
- If another user has the same session name live and the name is ambiguous, attach errors instead of picking one arbitrarily.

### `session detach <name|thread_id>`

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--graceful` | bool | false | Skip `turn/interrupt`; wait for the current turn to go idle before detaching |

### `session fork <source> [new_name]`

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--at-turn <turn_id>` | string | tip | Fork point |

### `session rename <name|thread_id> <new_name>`

No flags. Target must already be live in your user registry.

### `session info <name|thread_id>`

No flags. Live names work directly; detached lookup is only reliable by `thread_id`, and the fallback returns thread metadata only.

### `session context <name|thread_id>`

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--format <fmt>` | enum | `json` | `json` / `markdown` |

### `session list`

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--all` | bool | false | Include non-live threads (from `thread/list`) |
| `--sort <field>` | enum | `last_active` | `name` / `last_active` / `turn_count` / `created_at` |
| `--format <fmt>` | enum | `json` | `json` / `table` |
| `--short` | bool | false | One compact line per session to stdout; cannot combine with `--format table` |

### `session health <name|thread_id>`

Returns a compact live snapshot. Default JSONL keeps `session`, `state`, `busy`, and only the conditional fields needed to act next (`current_turn_id` when busy, pending counts when non-zero, `app_server_alive:false` when unhealthy). Read-only.

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--short` | bool | false | One-line summary for grep/dashboards |

If state is `crashed` or `app_server_alive` is `false`, run `session heal`.

### `session heal <name|thread_id>`

Re-attach a crashed or dead live session to a fresh `codex app-server`. Healthy sessions return `{ ok: true, note: "already healthy" }`.

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--force` | bool | false | Drop half-baked in-memory queue state before retrying the resume — use only after a plain `session heal` fails |

## message group

### `message send <session> [prompt]`

| Input | | |
|---|---|---|
| `[prompt]` positional | conditional | Or use `--stdin` / `--file` / `--attach` |

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--stdin` | bool | false | Read prompt from stdin |
| `--file <path>` | path | — | Read prompt from file |
| `--attach <path>` | repeatable | — | Attach local image file(s) only (`png/jpg/jpeg/gif/webp/bmp/svg`) |

Non-blocking. Returns `{"status":"started","turn_id":"..."}` when the turn starts immediately, or `{"status":"queued","queue_id":"...","queued_depth":N}` when it queues.

### `message peer <session> [prompt]`

Same flags as `send`. Calls `turn/steer` — only valid during an active turn.

### `message interrupt <session>`

No flags. Hard cancel.

### `message approval <session> <request_id> [shortcut]`

| Input | |
|---|---|
| `<request_id>` | From the `approval.*` event `payload.request_id` |
| `[shortcut]` | `accept` / `accept-session` / `decline` / `cancel` |

| Flag | | Notes |
|---|---|---|
| `--json <payload>` | string | Complete response JSON |
| `--file <path>` | path | Read JSON from file |
| `--stdin` | bool | Read JSON from stdin |

Shortcut validity depends on approval kind:

- `approval.permissions` allows `accept`, `accept-session`, `decline`; `cancel` is invalid.
- `approval.mcp_elicitation` allows `accept`, `decline`, `cancel`; `accept-session` is invalid.
- `approval.mcp_elicitation` in `mode:"form"` requires `--json` for `accept` because `content` must be supplied.

### `message answer <session> <request_id> [answer]`

| Input | |
|---|---|
| `[answer]` | Inline free text — only works if request has exactly one question |

Flags: `--json` / `--file` / `--stdin` for multi-question.

### `message wait <session>`

Blocks until a turn on `<session>` finishes, errors, or times out.

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--for <turn_id>` | string | current/next | Specific turn ID; without `--for`, waits for the current in-flight turn or the next one if idle |
| `--timeout <s>` | int | 600 | Seconds before returning `outcome: "timeout"`; use `0` to disable |

Exit codes:

- `0` — turn completed
- `1` — turn errored / cancelled / crashed
- `124` — timeout

### `message history <session>`

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--limit <n>` | int | 50 | Max turns returned |
| `--since <cursor\|-N>` | string\|int | tip | Pagination cursor from a previous response, or relative `-N` = start N turns back from tip |
| `--format <fmt>` | enum | `json` | `json` / `markdown` |

Output is newest-to-oldest.

### `message tail <session>`

| Flag | Type | Default | Notes |
|---|---|---|---|
| `-n <count>` | int | 3 | Return last N turns |
| `-f, --follow` | bool | false | Stream new turn snapshots as they complete |
| `--format <fmt>` | enum | `json` | `json` / `markdown` |

## monitor group

### `monitor events`

Streaming. Emits NDJSON.

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--interval <s>` | int | `monitor.default_interval_seconds` | Batch-push cadence (mutually exclusive with `--stream`) |
| `--stream` | bool | false | Push each event as it arrives |
| `--filter <type,...>` | string | — | Whitelist |
| `--exclude <type,...>` | string | — | Blacklist |
| `--include-delta` | bool | false | Include `*_delta` events |
| `--summary` | bool | false | Ask the daemon to pre-summarize events. Visible CLI output already uses the same concise summary shape unless you pass `--full`. |
| `--since <id>` | string | — | Resume from event id. `id_rotated` if evicted; `invalid_params` if the id never existed in the current log. Mutually exclusive with `--cursor` |
| `--cursor <name>` | string | — | Resume from a saved named cursor and auto-advance it as events are delivered. Mutually exclusive with `--since` |
| `--session <name\|uuid>` | string | — | Only events for this session |

### `monitor alarm <interval_s> <command>`

Streaming. Runs `<command>` via the platform shell every `<interval_s>` seconds (`$SHELL -c` on Unix, `cmd.exe /d /s /c` on Windows).

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--once` | bool | false | Run once and end |
| `--timeout <s>` | int | 60 | SIGTERM after this many seconds, SIGKILL 5s later; emits `__alarm_event: timeout` |

Emits `{stdout, stderr, __alarm_event: exit|timeout|spawn_error, exit_code, duration_ms}` per run.

## cursor group

Named, daemon-persisted resume points in your event log. Survive daemon restarts. Pair with `monitor events --cursor <name>` to resume cleanly after Claude reconnects.

| Command | Purpose |
|---|---|
| `cursor save <name> [--event-id <id>]` | Save the current tail event id (or an explicit id) under `<name>`; `--event-id` lets you seed a cursor at a known earlier point |
| `cursor list [--short]` | List every saved cursor with its current event id |
| `cursor get <name>` | Return one JSONL object like `{"event_id":"evt-..."}` |
| `cursor delete <name>` | Remove the named cursor |

Cursors automatically advance when used via `monitor events --cursor <name>`.

## Error codes

| Code | Typical cause |
|---|---|
| `daemon_unreachable` | Sock missing / daemon not ready (cli waits up to 15s, with per-attempt connect retries) |
| `user_not_found` | Bearer token hasn't been `daemon user create`'d |
| `user_already_exists` | Idempotent signal; treat as success for re-register |
| `session_not_found` | Session name/thread_id not in your user's live set |
| `session_not_live` | Command requires live; target is detached |
| `session_busy` | Target is live under another user — use `--takeover` |
| `invalid_params` | Missing positional, mutually-exclusive flags, bad enum |
| `invalid_decision` | Shortcut mismatches approval kind |
| `id_rotated` | `--since <id>` points at an evicted event |
| `codex_error` | codex JSON-RPC returned an error — `data.codex_error_info` has the type (`context_window_exceeded`, `usage_limit_exceeded`, `unauthorized`, `sandbox_error`, `active_turn_not_steerable`, `server_overloaded`, …). See `skills/recover-codex-team/` for per-case handling |
| `internal` | Daemon bug — check `daemon logs` |
| `not_implemented` / `method_not_found` | Typo in the command path |

`codex_error` envelope `data`:

```json
{
  "rpc_code": -32602,
  "rpc_message": "...",
  "codex_error_info": "context_window_exceeded" | "server_overloaded" | ... | null,
  "additional_details": null | "..."
}
```
