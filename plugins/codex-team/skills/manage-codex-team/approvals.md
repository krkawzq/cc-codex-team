# Approvals & user input

Codex workers pause turns to ask you things. Two families:

- **`approval.*`** — permission decision. You say accept/decline/cancel (+ optional structured amendments).
- **`user_input.request`** — askUserQuestion. You provide structured answers to one or more questions.

Both block the turn until answered. A session with an outstanding request makes no progress.

## Tracking pending requests

Every approval / user_input event carries `payload.request_id = "req-<hex>"`. Daemon assigns this id and keeps the underlying app-server JSON-RPC id internal. You use the daemon id when responding.

Current pending requests for your user:

```bash
codex-team -b $TOK status
# returns { ..., "pending_requests": N }
```

For full listings, inspect your events log (`monitor events --since 0`) and look for `approval.*` / `user_input.request` events whose `request_id` hasn't been followed by `server_request_resolved`.

## Response commands

```bash
# shortcut form
codex-team -b $TOK message approval <session> <request_id> <shortcut>
codex-team -b $TOK message answer   <session> <request_id> "<free-text>"   # single-question only

# complete-JSON form (covers every case)
codex-team -b $TOK message approval <session> <request_id> --json '<response>'
codex-team -b $TOK message answer   <session> <request_id> --json '<response>'

# from file or stdin
... --file response.json
... --stdin
```

`<session>` can be name or thread_id.

## Approval response matrix

Each kind has a different wire-level response. Shortcuts expand to the right shape; use `--json` for anything non-trivial.

### `approval.command_execution`

Response: `{ "decision": "..." }` for the simple shortcut cases.

| Shortcut | Expands to | When |
|---|---|---|
| `accept` | `"accept"` | Standard yes |
| `accept-session` | `"acceptForSession"` | "Don't ask again for this kind of command this session" |
| `decline` | `"decline"` | No |
| `cancel` | `"cancel"` | Abort the entire turn |
| — | exact wire-shaped JSON | `--json` only — for exec-policy or network-policy amendments |

### `approval.file_change`

Response: `{ "decision": "..." }`

| Shortcut | Expands to |
|---|---|
| `accept` | `"accept"` |
| `accept-session` | `"acceptForSession"` |
| `decline` | `"decline"` |
| `cancel` | `"cancel"` |

### `approval.permissions`

Response: `{ "permissions": <profile>, "scope": "turn" | "session" }`

| Shortcut | Expands to |
|---|---|
| `accept` | full requested profile + `scope:"turn"` |
| `accept-session` | full requested profile + `scope:"session"` |
| `decline` | empty permissions + `scope:"turn"` |
| _(no `cancel`)_ | |

Partial grant? Use `--json`:

```bash
codex-team -b $TOK message approval <s> <req> --json '{
  "permissions": {
    "filesystem": {"write": ["/repo/src"]},
    "network": {}
  },
  "scope": "session"
}'
```

### `approval.mcp_elicitation`

Response: `{ "action": "accept" | "decline" | "cancel", "content"?: <json>, "_meta"?: {...} }`

Two modes:

**`mode: "url"`** — user completes an external flow.

| Shortcut | Expands to |
|---|---|
| `accept` | `{action:"accept"}` |
| `decline` | `{action:"decline"}` |
| `cancel` | `{action:"cancel"}` |

**`mode: "form"`** — schema-constrained user input. `accept` **requires** `--json`:

```bash
codex-team -b $TOK message approval <s> <req> --json '{
  "action": "accept",
  "content": {"name": "foo", "level": 3}
}'
```

`content` must satisfy `payload.requested_schema`. Primitive types + single/multi-select enums + simple objects.

## user_input response (askUserQuestion)

Response: `{ "answers": { "<question_id>": { "answers": ["<text>", ...] } } }`

Every question in `payload.questions` must appear in `answers`. Array form allows multi-select and free-text.

### Single question, single answer

```bash
codex-team -b $TOK message answer <s> <request_id> "Postgres"
```

Works only when the request contains exactly one question.

### Multi-question

Always `--json`:

```bash
codex-team -b $TOK message answer <s> <req_id> --json '{
  "answers": {
    "q1": {"answers": ["Postgres"]},
    "q2": {"answers": ["Drizzle"]},
    "q3": {"answers": ["sk_live_abc..."]}
  }
}'
```

### Multi-select

```json
"q1": {"answers": ["Postgres", "Redis"]}
```

### Free text (with `is_other: true`)

The free-text goes in the same `answers` array. Codex doesn't distinguish option-label from free-text at wire level — the tool that issued the question interprets it.

## Timeouts and cancellation

- No hard timeout in codex-team for a pending request. Codex's own turn-timeout applies, which is long (tens of minutes).
- If the session is detached (by you or takeover), daemon auto-responds with `-32000 session detached/seized` and the turn errors out.
- If you want to abort gracefully: `message approval <s> <req> cancel` for approvals; `message answer` has no cancel path — just pick something plausible and let the turn continue.

## Common mistakes

| Mistake | What actually happens |
|---|---|
| Responding with `accept` to an `approval.permissions` without a `scope` | shortcut inserts `scope:"turn"` for you — fine |
| Using `cancel` on `approval.permissions` | error `invalid_decision` — no cancel shortcut for this kind |
| Responding to a `user_input.request` with shortcut `accept` | error — use inline answer or `--json` |
| Using inline answer for a multi-question request | error `invalid_params` — must be `--json` |
| Sending response to a `request_id` you already answered | error `invalid_params` — one request, one response |

## Decision defaults (when you're not sure)

- `approval.command_execution` for `rm`, `chmod`, install commands → decline unless the turn goal clearly requires it
- `approval.command_execution` for reads / builds / tests → accept
- `approval.file_change` → accept if the diff matches the task, decline if it touches files outside scope
- `approval.permissions` for network → decline unless the task is explicitly about network ops
- `approval.mcp_elicitation` → usually accept; these are external services asking for normal config

For sensitive operations, prefer the `--json` full form so you see exactly what you're committing to.
