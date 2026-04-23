# codex-team Quickstart

A zero-to-first-turn walkthrough. All commands assume you're already in the repo you want codex to work on.

## 1. Pick a bearer token

Any non-empty string. Reuse it for this whole agent conversation. Conventions:

- `claude-<unix_ts>` for one-off work
- `claude-<project>-<purpose>` for longer-running setups (stable across sessions)

```bash
TOKEN=claude-$(date +%s)
```

The token becomes your tenant namespace. Two agents using different tokens on the same daemon see nothing of each other.

## 2. Register the user (one-time)

```bash
codex-team daemon user create $TOKEN
```

Daemon auto-spawns if it wasn't running. Response (concise default):

```json
{"ok":true,"data":{"token":"claude-..."}}
```

Pass `--full` to also see `created_at`. If the user already exists (e.g. you reused a token from a prior conversation), you get `{"ok":false,"error":{"code":"user_already_exists",...}}` — treat as success.

## 3. Create a session

```bash
codex-team -b $TOKEN session new demo \
  --cwd "$(pwd)" \
  --model gpt-5.4 \
  --sandbox workspace-write \
  --approval on-request \
  --effort medium
```

Response (concise default):

```json
{"ok":true,"data":{"session":{"name":"demo","thread_id":"019db...","state":"live","model":"gpt-5.4","turn_count":0,"current_turn_id":null,"items_in_turn":0,"pending_approvals":0,"pending_user_inputs":0}}}
```

The session is now **live** (owned by the daemon and ready for turns). Pass `--full` to also see `cwd`, `sandbox`, `approval`, `effort`, `autoApprovePatterns`, `created_at`, and `last_active_at`.

Pick defaults consciously:

| Flag | Sensible default | Notes |
|---|---|---|
| `--sandbox` | `workspace-write` | Lets codex edit files in cwd but not escape |
| `--approval` | `on-request` | Codex will ask before risky shell/patch ops — fires `approval.*` events |
| `--effort` | `medium` | `high` / `xhigh` for tricky refactors |

## 4. Arm the events Monitor

Slash:

```
/codex-team:events -b $TOKEN --stream
```

Or raw:

```json
Monitor({
  "description": "codex-team events: claude-...",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/main.js\" -b claude-... monitor events --stream",
  "persistent": true,
  "timeout_ms": 3600000
})
```

Events arrive as NDJSON lines. Every event has `id`, `ts`, `type`, `session`, `thread_id`, `payload`. Delta events (token-level stream) are filtered out by default — good.

## 5. Send your first prompt

```bash
codex-team -b $TOKEN message send demo "Review src/auth.ts and list every risky pattern."
```

Response (concise default — only the fields you need to correlate the turn or decide if it queued):

```json
{"ok":true,"data":{"turn_id":"...","started":true,"queue_id":null,"queued_depth":0}}
```

Pass `--full` to also see `session` and `thread_id` echo.

The turn is now running. Your cli returned immediately. Watch the events panel:

```
{"id":"evt-3","type":"turn.started","session":"demo",...}
{"id":"evt-4","type":"item.started","payload":{"type":"reasoning",...}}
{"id":"evt-5","type":"item.completed","payload":{"type":"reasoning","status":"completed"}}
{"id":"evt-6","type":"item.started","payload":{"type":"agent_message",...}}
{"id":"evt-7","type":"item.completed","payload":{"type":"agent_message","status":"completed"}}
{"id":"evt-8","type":"turn.completed","payload":{"turn_id":"...","status":"completed","duration_ms":18420,"items_count":4,"token_usage":{...},"ended_at":1714300000,"turn_items_included":false}}
```

## 6. Fetch the turn content

```bash
codex-team -b $TOKEN message tail demo -n 1 --format markdown
```

The `markdown` field in the response is tag-structured — paste it into your working notes or parse it for downstream logic.

## 7. Second turn — queued automatically

```bash
codex-team -b $TOKEN message send demo "Now propose a patch for the first three issues."
```

If the previous turn is still running, `started` comes back `false`, `queue_id` is set, and `queued_depth` goes up. The daemon dispatches it when the previous turn completes and emits `turn.queued_started`.

## 8. Respond to an approval event

If you see:

```json
{"type":"approval.command_execution","payload":{"request_id":"req-abc123","command":["rm","-rf","build"],"reason":"cleanup","request_id":"req-abc123"}}
```

Reply:

```bash
codex-team -b $TOKEN message approval demo req-abc123 accept
```

Or use a full response JSON for amendments:

```bash
codex-team -b $TOKEN message approval demo req-abc123 \
  --json '{"decision":"acceptWithExecpolicyAmendment","execpolicyAmendment":{...}}'
```

## 9. Detach when done

```bash
codex-team -b $TOKEN session detach demo
```

This interrupts any in-flight turn, releases the app-server slot, and removes the session from live tracking. The thread file is preserved — you can `attach` the same thread_id in a future conversation.

## 10. Stop the daemon (optional)

Daemon auto-shuts down after 6h idle. If you want to be tidy:

```bash
codex-team daemon stop
```

No bearer needed.
