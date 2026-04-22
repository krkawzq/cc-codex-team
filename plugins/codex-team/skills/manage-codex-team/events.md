# Event catalogue

Every `monitor events` line is a JSON object with the shape:

```json
{
  "id": "evt-<seq>",
  "ts": "2026-04-22T12:30:00Z",
  "type": "<category.subtype>",
  "session": "<name> | null",
  "thread_id": "<uuid> | null",
  "payload": { ... }
}
```

`session` and `thread_id` are `null` for system-level events.

## Session events

### `turn.started` / `turn.completed`

Turn lifecycle. `completed` is the authoritative end signal.

```json
payload: { "turn_id", "status", "started_at", "completed_at", "duration_ms", "item_count", "turn" }
```

Status values: `inProgress` / `completed` / `failed` / `interrupted`.

### `turn.error`

Turn failed. Often followed by daemon auto-retry if `will_retry: true`.

```json
payload: {
  "turn_id",
  "will_retry": bool,
  "error": {
    "message": "...",
    "codex_error_info": "server_overloaded" | "context_window_exceeded" | ... | null,
    "additional_details": "..." | null
  }
}
```

Common `codex_error_info`:

| Value | Meaning | Action |
|---|---|---|
| `server_overloaded` | Codex backend busy | daemon auto-retries |
| `http_connection_failed` / `response_stream_connection_failed` / `response_stream_disconnected` | Transient app-server transport failure | daemon auto-retries |
| `context_window_exceeded` | Context too large | compact or start fresh session |
| `usage_limit_exceeded` | Account quota | stop; nothing to retry |
| `active_turn_not_steerable` | You tried interrupt/steer during review/compact | wait for that turn |
| `unauthorized` | Codex auth expired | run `codex login` out-of-band |
| `sandbox_error` | Shell/file op blocked by sandbox | check `--sandbox` flag |

### `item.started` / `item.completed`

Fine-grained step lifecycle. `payload: { item_id, turn_id, type, status }`.

`type` values: `agent_message`, `reasoning`, `command_execution`, `file_change`, `file_read`, `mcp_tool_call`, `web_search`, `plan_update`, etc.

Most of the time you only care about `item.completed` with `type: agent_message` or `type: file_change` — those tell you the agent produced output.

### Thread lifecycle

- `thread.started` — thread creation (often fires right after `session new`)
- `thread.closed` — thread permanently closed by codex. **codex-team auto-detaches.** The session cannot be attached again.
- `thread.status_changed` — status transition
- `thread.token_usage_updated` — running token usage
- `thread.name_updated` / `thread.archived` / `thread.unarchived` — metadata

### Queue lifecycle

- `turn.queued_started` — a previously queued `message send` has just been dispatched. Payload carries the stable `queue_id` returned by `message send` plus the real `turn_id`.

## Approval / input events (needs response)

### `approval.command_execution`

Codex wants to run a shell command that the approval policy doesn't auto-approve.

```json
payload: {
  "kind": "approval.command_execution",
  "request_id": "req-<hex>",
  "turn_id", "item_id",
  "command": ["bash","-lc","rm -rf build"],
  "cwd": "/repo",
  "reason": "cleanup old artefacts",
  "raw": { ... }
}
```

Respond:

```bash
codex-team -b $TOK message approval <session> <request_id> accept
```

### `approval.file_change`

Codex wants to apply a patch (file edit).

```json
payload: {
  "kind": "approval.file_change",
  "request_id", "turn_id", "item_id",
  "reason": "...",
  "grant_root": "/repo",
  "raw": { ... }
}
```

Response shortcuts: `accept` / `accept-session` / `decline` / `cancel`.

### `approval.permissions`

Codex wants a permission escalation beyond the current policy.

```json
payload: {
  "kind": "approval.permissions",
  "request_id", "turn_id", "item_id",
  "reason": "...",
  "cwd": "...",
  "permissions": { "filesystem": {...}, "network": {...} },
  "raw": { ... }
}
```

Shortcut `accept` grants the entire requested profile with `scope: "turn"`. For partial grants or session-wide scope, use `--json`.

### `approval.mcp_elicitation`

MCP server asks for structured user input (two modes):

- `mode: "url"` — user completes an external flow. `accept` means "I finished". No content.
- `mode: "form"` — user fills a schema. `accept` requires `--json` with matching `content`.

```json
payload: {
  "kind": "approval.mcp_elicitation",
  "request_id",
  "server_name", "mode", "message",
  "requested_schema": { ... } | undefined,
  "url": "..." | undefined,
  "raw": { ... }
}
```

### `user_input.request` — askUserQuestion

Tool wants to pose questions.

```json
payload: {
  "request_id", "turn_id", "item_id",
  "questions": [
    {
      "id": "q1", "header": "Database", "question": "Which backend?",
      "is_other": false, "is_secret": false,
      "options": [{"label":"Postgres",...}, {"label":"SQLite",...}]
    }
  ],
  "raw": { ... }
}
```

Respond:

```bash
# single question, single answer
codex-team -b $TOK message answer <s> <request_id> "Postgres"

# multi-question / multi-select / free-text
codex-team -b $TOK message answer <s> <request_id> --json \
  '{"answers":{"q1":{"answers":["Postgres"]},"q2":{"answers":["idx1","idx2"]}}}'
```

## Control-plane events

### `session.seized`

Your live session was taken over by another user via `session attach --takeover`. Pending approvals on this session were cancelled. You can `attach --takeover` it back if you want.

### `server_request_resolved`

A pending approval/input request you had was already answered by another client (rare; mostly multi-agent scenarios). Internal cleanup — no action needed.

### `model_rerouted`

Your turn was routed to a fallback model due to rate limits.

## System events

`session` and `thread_id` are both `null`.

- `warning` / `error` — generic codex-side alerts
- `config_warning` — codex config issue (invalid key, conflicting overrides)
- `deprecation_notice` — codex API deprecation
- `account.updated` / `account.rate_limits_updated` / `account.login_completed` — auth/quota state
- `mcp_server.status_updated` — MCP server startup transitions
- `mcp_server.oauth_login_completed` — MCP OAuth flow result

## High-frequency deltas (default filtered)

These fire token-by-token. Off by default; enable with `--include-delta`:

- `item.agent_message_delta` — assistant text stream
- `item.command_exec_output_delta` — shell output stream
- `item.file_change_output_delta` — patch preview stream
- `item.reasoning_text_delta` / `item.reasoning_summary_text_delta`
- `item.plan_delta`

Use case: real-time UI rendering. Anti-use: programmatic decisions — wait for `item.completed` instead.

## Filtering strategy

For a typical orchestration loop, subscribe with:

```
monitor events --stream --filter \
  turn.completed,turn.queued_started,turn.error,approval.command_execution,approval.file_change,approval.permissions,approval.mcp_elicitation,user_input.request,thread.closed,session.seized
```

That covers: decision points + errors + ownership changes. Skip `item.*` unless you want fine-grained progress visibility.

## Rotation / resumption

Events are a per-user ring buffer (default 10000). If you reconnect with `--since <id>` and the id has been rotated out, you get an `id_rotated` error with `data.oldest_available_id` so you can resume from there.

Daemon restart preserves events to disk; `monitor events --since` works across restarts.
