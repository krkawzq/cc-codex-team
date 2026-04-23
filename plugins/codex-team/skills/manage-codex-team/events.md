# Event catalogue

Every `monitor events` line is one JSON object:

```json
{
  "id": "evt-<seq>",
  "ts": "2026-04-22T12:30:00Z",
  "type": "<category.subtype>",
  "session": "<name> | null",
  "thread_id": "<uuid> | null",
  "payload": { "...": "..." }
}
```

`session` and `thread_id` are usually `null` for system events. Session-scoped warnings and queue events keep both.

## Turn lifecycle

### `turn.started`

`turn.started` keeps the richer start snapshot:

```json
payload: {
  "turn_id",
  "status",
  "started_at",
  "completed_at",
  "duration_ms",
  "item_count",
  "turn"
}
```

### `turn.completed`

`turn.completed` is the only terminal turn event in 0.5.5.

```json
payload: {
  "turn_id",
  "status",              // "completed" | "failed" | "cancelled" | "interrupted"
  "duration_ms",         // number | null
  "items_count",         // number
  "token_usage",         // { input, cached_input, output, reasoning_output, total } | null
  "ended_at",            // upstream turn end timestamp value
  "turn_items_included": false,
  "error": {             // only present when status == "failed" and details exist
    "message": "...",
    "codex_error_info": "server_overloaded" | "context_window_exceeded" | ... | null,
    "additional_details": "..." | null
  }
}
```

Notes:

- `status="completed"` is success.
- `status="failed"` is terminal failure. There is no separate turn-failure event.
- Retryable transient failures do not fan out as events in 0.5.5. The daemon retries internally and only emits a terminal event if the turn ultimately fails.
- `turn.completed` never includes the full turn items. Use `message tail` or `message history` for content.

Common `codex_error_info` values on failed turns:

| Value | Meaning | Typical action |
|---|---|---|
| `server_overloaded` | Backend overloaded | wait for daemon retry or re-run later |
| `http_connection_failed` / `response_stream_connection_failed` / `response_stream_disconnected` | Transport failure | usually retryable |
| `context_window_exceeded` | Context too large | compact, fork earlier, or start fresh |
| `usage_limit_exceeded` | Account quota exhausted | stop and check quota |
| `active_turn_not_steerable` | interrupt/peer during review or compact | wait for the turn to finish |
| `unauthorized` | Codex auth expired | refresh auth out of band |
| `sandbox_error` | sandbox blocked the required action | widen sandbox or decline |

## Item lifecycle

- `item.started`
- `item.completed`

Payload:

```json
payload: { "item_id", "turn_id", "type", "status" }
```

Useful `type` values include `agent_message`, `reasoning`, `command_execution`, `file_change`, `file_read`, `mcp_tool_call`, `web_search`, and `plan_update`.

## Thread lifecycle

- `thread.started`
- `thread.closed`
- `thread.status_changed`
- `thread.name_updated`
- `thread.archived`
- `thread.unarchived`
- `thread.token_usage_updated`

`thread.token_usage_updated` uses the same canonical usage shape:

```json
payload: {
  "turn_id",
  "token_usage": { "input", "cached_input", "output", "reasoning_output", "total" }
}
```

## Queue lifecycle

- `turn.queued_started` means a previously queued `message send` has just been dispatched.

```json
payload: { "turn_id", "queue_id" }
```

- `turn.queued_failed` means daemon auto-drain tried to dispatch the next queued prompt and failed. The item stays queued.

```json
payload: {
  "queue_id",
  "error": { "message": "..." }
}
```

- `turn.queued_dropped` means daemon gave up after repeated dispatch failures and dropped the queued item.

```json
payload: {
  "queue_id",
  "error": { "message": "..." },
  "failure_count": 3
}
```

## Approval and input events

These require a reply:

- `approval.command_execution`
- `approval.file_change`
- `approval.permissions`
- `approval.mcp_elicitation`
- `user_input.request`

All approval events include `request_id`, plus `turn_id` / `item_id` when applicable. `user_input.request` carries a `questions` array.

Related cancellation events:

- `approval.request_cancelled`
- `user_input.request_cancelled`

## Control-plane events

- `session.crashed`
- `session.closed`
- `session.pending_dropped`
- `session.seized`
- `server_request_resolved`
- `model_rerouted`
- `auto_approved`

`session.crashed` means the live app-server died. If there was an active turn, you should expect a matching `turn.completed` event with `status="failed"`.

## System events

- `warning`
- `error`
- `config_warning`
- `deprecation_notice`
- `account.updated`
- `account.rate_limits_updated`
- `account.login_completed`
- `mcp_server.status_updated`
- `mcp_server.oauth_login_completed`
- `monitor.overflow`

`monitor.overflow` payload:

```json
payload: {
  "dropped_count": 123,
  "dropped_bytes": 45678,
  "limit_events": 512,
  "limit_bytes": 524288
}
```

## High-frequency deltas

Hidden by default unless you pass `--include-delta`:

- `item.agent_message_delta`
- `item.command_exec_output_delta`
- `item.file_change_output_delta`
- `item.reasoning_text_delta`
- `item.reasoning_summary_text_delta`
- `item.plan_delta`

These are for live rendering, not control flow.

## Filtering strategy

Typical orchestration filter:

```bash
monitor events --stream --filter \
  turn.completed,turn.queued_started,turn.queued_failed,approval.command_execution,approval.file_change,approval.permissions,approval.mcp_elicitation,user_input.request,thread.closed,session.seized,warning
```

Add `session.crashed` if you want explicit crash notifications alongside the failed terminal turn event.

## Rotation and resume

Events live in a per-user ring buffer. If `--since <id>` points to a rotated-out event, the daemon returns `id_rotated` with `oldest_available_id`. For durable resumes, save a cursor and monitor with `--cursor <name>`.
