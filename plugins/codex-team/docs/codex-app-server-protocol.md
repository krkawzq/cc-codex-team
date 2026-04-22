# Codex App-Server JSON-RPC Protocol Reference

Internal reference for codex-team daemon. Captures the v2 JSON-RPC protocol
spoken by `codex app-server`. Based on:

- Rust protocol crate (source of truth): `forks/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`
- Generated JSON Schema: `forks/codex/codex-rs/app-server-protocol/schema/json/v2/`
- TypeScript Schema (most readable): `forks/codex/codex-rs/app-server-protocol/schema/typescript/v2/`
- Python SDK (high-level wrappers): `forks/codex/sdk/python/src/codex_app_server/`

This is not an upstream OpenAI specification. Consult the Codex source for
authoritative semantics. This file only captures what codex-team needs.

## Transport

- **Binary**: `codex app-server --listen stdio://`. One subprocess per app-server instance.
- **Framing**: JSON-RPC 2.0 over stdio; one message per line (NDJSON, UTF-8).
- **Bidirectional**: the client sends requests/notifications; the server may also
  send **server-initiated requests** (approvals, user input) that the client must
  answer by echoing the original `id`.

## Message Shapes

```text
Request         { "jsonrpc": "2.0", "id": <int|str>, "method": <str>, "params": <obj> }
Response ok     { "jsonrpc": "2.0", "id": <same>, "result": <obj> }
Response err    { "jsonrpc": "2.0", "id": <same>, "error": { "code": <int>, "message": <str>, "data"?: <any> } }
Notification    { "jsonrpc": "2.0", "method": <str>, "params": <obj> }       (no id)
```

## Initialization

Client calls `initialize` first. Server responds with capabilities; after that
the client may make thread/turn calls.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "clientInfo": { "name": "codex-team", "version": "0.4.0" },
  "capabilities": { ... }
}}
```

## Thread (Session) Methods — Client → Server

All methods are v2. Params below list key fields only; see JSON schemas
for full definitions.

| Method | Purpose | Key Params | Key Response |
|---|---|---|---|
| `thread/start` | Create new thread | `model?`, `cwd?`, `approvalPolicy?`, `sandbox?`, `baseInstructions?`, `developerInstructions?`, `personality?`, `config?`, `source?` | `thread` |
| `thread/resume` | Load an existing thread into memory | `threadId` | `thread` |
| `thread/fork` | Create a branched thread from an earlier turn | `threadId`, `atTurnId?`, `source?` | `thread` |
| `thread/read` | Read thread metadata snapshot | `threadId` | `thread` |
| `thread/turns/list` | List turns in a thread | `threadId`, `limit?`, `cursor?`, `sortDirection?` | `data[]`, `nextCursor?` |
| `thread/list` | List persisted threads | `limit?`, `cursor?`, `sortKey?`, `includeArchived?` | `data[]`, `nextCursor?` |
| `thread/loadedList` | List threads currently in memory | — | `threads[]` |
| `thread/name/set` | Rename thread | `threadId`, `name` | — |
| `thread/metadataUpdate` | Update thread metadata (git info, etc.) | `threadId`, `metadata` | — |
| `thread/archive` / `thread/unarchive` | Archive / unarchive | `threadId` | — |
| `thread/injectItems` | Inject items (e.g. tool results) | `threadId`, `items[]` | — |
| `thread/rollback` | Roll back to an earlier turn | `threadId`, `turnId` | — |
| `thread/compact/start` | Start a context-compaction turn | `threadId` | — (emits notifications) |
| `thread/unsubscribe` | Stop receiving notifications for a thread | `threadId` | `status` |

## Turn Methods — Client → Server

| Method | Purpose | Key Params | Key Response |
|---|---|---|---|
| `turn/start` | Send user input, start an assistant turn | `threadId`, `input`, `environment?` | `turnId` |
| `turn/steer` | Soft interject — queue user input without aborting in-flight tool calls | `threadId`, `expectedTurnId`, `input` | — |
| `turn/interrupt` | Hard cancel the current turn | `threadId`, `turnId` | — |

`turn/steer` and `turn/interrupt` are rejected during certain turn kinds
(`Review`, `Compact`) with `codexErrorInfo = activeTurnNotSteerable`.

## Other Methods (selective)

| Method | Purpose |
|---|---|
| `model/list` | Enumerate available models |
| `config/read` / `config/valueWrite` / `config/batchWrite` | Read/write codex config |
| `fuzzy/file/search` | Agent-style fuzzy path lookup |
| `commandExec/start` / `write` / `terminate` / `resize` | Shell command execution inside the app-server sandbox |
| `fs/readFile` / `writeFile` / `readDirectory` / `watch` / `unwatch` / ... | Filesystem access |
| `mcp/server/toolCall` / `resourceRead` / `listStatus` | MCP server interop |
| `skills/list` / `skillsConfig/write` | Skills management |
| `plugins/install` / `list` / `uninstall` / `read` | Plugin management |

See `forks/codex/sdk/python/src/codex_app_server/api.py` for the authoritative
list of client-callable methods.

## Server Notifications (Server → Client, no response expected)

### Session-scoped (all carry `threadId`)

**Turn lifecycle**

| Method | Purpose / Payload |
|---|---|
| `turn/started` | `{ threadId, turn }` — turn began |
| `turn/completed` | `{ threadId, turn }` — **authoritative end signal** (payload carries full final `Turn`) |
| `error` (session form) | `{ threadId, turnId, error: TurnError, willRetry: bool }` |

**Item lifecycle**

| Method | Payload |
|---|---|
| `item/started` | `{ threadId, turnId, itemId }` |
| `item/completed` | `{ threadId, turnId, itemId, item }` |
| `item/mcpToolCall/progress` | `{ threadId, turnId, itemId, message }` |
| `item/fileChange/patchUpdated` | `{ threadId, turnId, itemId }` |
| `item/commandExecution/terminalInteraction` | `{ threadId, turnId, itemId, ... }` |

**Auto-approval review (UNSTABLE)**

| Method | Payload |
|---|---|
| `item/autoApprovalReview/started` | `{ threadId, turnId, reviewId, targetItemId?, review, action }` |
| `item/autoApprovalReview/completed` | `{ threadId, turnId, reviewId, targetItemId?, decisionSource, review, action }` |

**Thread lifecycle**

| Method | Payload |
|---|---|
| `thread/started` | `{ threadId, thread }` |
| `thread/closed` | `{ threadId }` — thread is gone, cannot be resumed |
| `thread/status/changed` | `{ threadId, status }` |
| `thread/tokenUsage/updated` | `{ threadId, tokenUsage }` |
| `thread/name/updated` | `{ threadId, threadName }` |
| `thread/archived` / `thread/unarchived` | `{ threadId }` |
| `thread/compacted` (deprecated) | `{ threadId, turnId }` |

**Other**

| Method | Payload |
|---|---|
| `model/rerouted` | `{ threadId, reason }` — rate limit / reroute notice |
| `serverRequest/resolved` | `{ threadId, requestId }` — pending server-initiated request was already answered by another client; stop waiting |
| `fuzzyFileSearch/sessionUpdated` / `sessionCompleted` | `{ threadId, turnId?, searchSessionId }` |
| `hook/started` / `hook/completed` | `{ threadId, turnId?, run }` |

### High-frequency streaming deltas

These fire token-by-token. **codex-team should filter them by default.**

| Method | Payload |
|---|---|
| `item/agentMessage/delta` | `{ ..., delta: string }` — assistant tokens |
| `item/commandExecution/outputDelta` | `{ ..., delta: string, stream: "stdout" \| "stderr" }` |
| `item/fileChange/outputDelta` | `{ ..., delta: string }` |
| `item/reasoning/textDelta` | `{ ..., delta: string, contentIndex: number }` |
| `item/reasoning/summaryTextDelta` | `{ ..., delta: string }` |
| `item/reasoning/summaryPartAdded` | `{ threadId, turnId, itemId, ... }` (coarser — per section, not per token) |
| `item/plan/delta` | `{ ..., delta: string }` |

### Non-session-scoped (system)

| Method | Payload |
|---|---|
| `warning` | `{ threadId?, message }` |
| `error` (no `threadId`) | global error form |
| `configWarning` | `{ summary, details?, path?, range? }` |
| `deprecationNotice` | `{ summary, details? }` |
| `account/updated` | `{ account }` |
| `account/rateLimits/updated` | `{ rateLimits }` |
| `account/login/completed` | `{ success, loginId?, error? }` |
| `mcpServer/startupStatus/updated` | `{ name, status: "Starting"\|"Ready"\|"Failed"\|"Cancelled", error? }` |
| `mcpServer/oauthLogin/completed` | `{ name, success, error? }` |
| `app/list/updated` | `{ apps: [...] }` |
| `skills/changed` | — |
| `fs/changed` | `{ ... }` |
| `externalAgentConfig/import/completed` | `{ success, details }` |
| `windows/worldWritableWarning` | `{ samplePaths, extraCount, failedScan }` |
| `windowsSandbox/setupCompleted` | `{ mode, success, error? }` |
| `thread/realtime/*` | Realtime (voice) API notifications — codex-team ignores by default |

## Server-Initiated Requests (Server → Client, response required)

These arrive as JSON-RPC requests with an `id`. The client **must** send a
matching response or the server may time out the turn. If another client
answers first, the losing client receives `serverRequest/resolved`.

### `item/commandExecution/requestApproval`

Sent when a command needs explicit user approval.

**Params**

```json
{
  "threadId": "t1",
  "turnId": "u1",
  "itemId": "i1",
  "approvalId": "a1",
  "reason": "...",
  "command": ["bash", "-lc", "rm -rf /tmp/x"],
  "cwd": "/path/to/repo",
  "commandActions": [...],
  "additionalPermissions": { ... },
  "proposedExecpolicyAmendment": { ... },
  "networkApprovalContext": { ... }
}
```

Fields beyond `threadId` / `turnId` / `itemId` are all optional; exact presence
depends on what triggered the approval.

**Response**

```json
{ "decision": <CommandExecutionApprovalDecision> }
```

`CommandExecutionApprovalDecision` is a string enum for the simple cases:

```json
"accept"
"acceptForSession"
"decline"
"cancel"
```

For amendment / network-policy variants, codex-team forwards whatever full wire-shaped
JSON you pass via `message approval --json`.

### `item/fileChange/requestApproval`

Sent when a file-change patch needs approval.

**Params**

```json
{
  "threadId": "...",
  "turnId": "...",
  "itemId": "...",
  "reason": "...",
  "grantRoot": "/path"     // optional, root for session-wide write grants
}
```

**Response**

```json
{ "decision": <FileChangeApprovalDecision> }
```

`FileChangeApprovalDecision` is a string enum:

```json
"accept"
"acceptForSession"
"decline"
"cancel"
```

### `item/permissions/requestApproval`

Request a permission escalation (more scope than the current policy).

**Params**

```json
{
  "threadId": "...",
  "turnId": "...",
  "itemId": "...",
  "cwd": "...",
  "reason": "...",
  "permissions": {           // RequestPermissionProfile — permissions being requested
    "filesystem": { ... },
    "network":    { ... },
    ...
  }
}
```

**Response**

```json
{
  "permissions": { ... },    // GrantedPermissionProfile — subset the client is granting
  "scope": "turn" | "session"
}
```

Returning a narrower `permissions` than requested is valid (partial grant).

### `mcpServer/elicitation/request`

An MCP server asks the user for structured input. Two modes.

**Form mode params**

```json
{
  "threadId": "...",
  "turnId": "...",                // optional — MCP may call outside a turn
  "serverName": "my-server",
  "mode": "form",
  "message": "Please confirm...",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "name":  { "type": "string", "title": "Name" },
      "level": { "type": "integer", "minimum": 0 }
    },
    "required": ["name"]
  },
  "_meta": { ... }
}
```

`requestedSchema` is a restricted JSON Schema subset (`type: "object"` + primitive
properties). Primitives: `string`, `number`, `integer`, `boolean`, single-select
enum, multi-select enum. No nested objects/arrays in `properties`.

**URL mode params**

```json
{
  "threadId": "...",
  "turnId": "...",
  "serverName": "my-server",
  "mode": "url",
  "url": "https://...",
  "elicitationId": "e1",
  "_meta": { ... }
}
```

**Response (both modes)**

```json
{
  "action": "accept" | "decline" | "cancel",
  "content": { ... },      // form mode + accept: structured input matching requestedSchema
  "_meta": { ... }
}
```

URL mode `accept` means the user completed the external flow; no `content` needed.

### `item/tool/requestUserInput` (EXPERIMENTAL — the **askUserQuestion** RPC)

A tool wants to pose one or more questions directly to the user.

**Params**

```json
{
  "threadId": "...",
  "turnId": "...",
  "itemId": "...",
  "questions": [
    {
      "id": "q1",
      "header": "Database",
      "question": "Which backend?",
      "isOther": false,
      "isSecret": false,
      "options": [
        { "label": "Postgres", "description": "Production" },
        { "label": "SQLite",   "description": "Dev-only" }
      ]
    },
    {
      "id": "q2",
      "header": "API Key",
      "question": "Paste your API key",
      "isOther": true,
      "isSecret": true,
      "options": null
    }
  ]
}
```

Field semantics:

- `isOther: true` → free-text answer allowed (even alongside options).
- `isSecret: true` → input should be masked in UI (passwords, tokens).
- `options: null` → free-text only.

**Response**

```json
{
  "answers": {
    "q1": { "answers": ["Postgres"] },
    "q2": { "answers": ["sk-..."] }
  }
}
```

The `answers` array per question supports multi-select and/or free text. Every
question id in the request must appear in the response.

## Error Model

### Standard JSON-RPC codes

| Code | Class |
|---|---|
| -32700 | Parse error |
| -32600 | Invalid request |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32603 | Internal error |
| -32099 to -32000 | Server-defined (implementation-specific) |

Python SDK error hierarchy (`forks/codex/sdk/python/src/codex_app_server/errors.py`):

```
JsonRpcError
└── AppServerRpcError
    ├── ParseError, InvalidRequestError, MethodNotFoundError, InvalidParamsError, InternalRpcError
    └── ServerBusyError                       (retryable)
        └── RetryLimitExceededError            (do NOT retry further)
```

### `CodexErrorInfo` enum

Carried in `error.data.codexErrorInfo` (camelCase on the wire). Values:

- `contextWindowExceeded`
- `usageLimitExceeded`
- `serverOverloaded` *(retryable)*
- `httpConnectionFailed` *(optional field: `httpStatusCode`)*
- `responseStreamConnectionFailed` *(optional `httpStatusCode`)*
- `responseStreamDisconnected` *(optional `httpStatusCode`)*
- `responseTooManyFailedAttempts` *(optional `httpStatusCode`; retry budget exhausted)*
- `internalServerError`
- `unauthorized`
- `badRequest`
- `threadRollbackFailed`
- `sandboxError`
- `activeTurnNotSteerable` *(field: `turnKind: "Review" | "Compact"`)*
- `other`

### `TurnError` payload

Carried in the `error` notification for session-scoped errors:

```json
{
  "message": "...",
  "codexErrorInfo": "serverOverloaded" | { "type": "httpConnectionFailed", "httpStatusCode": 503 } | null,
  "additionalDetails": "..." | null
}
```

### Retry semantics

From `retry.py`:

- On `ServerBusyError`: exponential backoff. Defaults: `max_attempts=3`,
  `initial_delay_s=0.25`, `max_delay_s=2.0`, `jitter_ratio=0.2`.
- `ServerBusyError` is detected when `error.data` contains (anywhere)
  `server_overloaded` in `codex_error_info` / `codexErrorInfo` / `errorInfo`.
- On `RetryLimitExceededError` (message contains `retry limit` or
  `too many failed attempts`): do **not** retry.
- All other errors: surface to caller.

codex-team mirrors this strategy on its wrapped app-server RPCs. It does **not**
retry request timeouts; a timeout closes that client to keep daemon state aligned
with app-server state.

## Example Exchange

Initialize, start a thread, run a turn, approve a command, complete.

```
--> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
<-- {"jsonrpc":"2.0","id":1,"result":{...}}

--> {"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"model":"gpt-5.1","cwd":"/repo"}}
<-- {"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"th-abc",...}}}

--> {"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"th-abc","input":"build the project"}}
<-- {"jsonrpc":"2.0","id":3,"result":{"turnId":"tu-1"}}

<-- {"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th-abc","turn":{...}}}
<-- {"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th-abc","turnId":"tu-1","itemId":"it-1"}}
<-- {"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{..., "delta":"Let"}}
<-- {"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{..., "delta":" me"}}
...

# server asks for approval
<-- {"jsonrpc":"2.0","id":100,"method":"item/commandExecution/requestApproval","params":{
       "threadId":"th-abc","turnId":"tu-1","itemId":"it-2",
       "command":["cargo","build"],"cwd":"/repo","reason":"..."}}

# client responds
--> {"jsonrpc":"2.0","id":100,"result":{"decision":"accept"}}

<-- {"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"th-abc","turnId":"tu-1","itemId":"it-2","item":{...}}}
<-- {"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th-abc","turn":{...final...}}}
```

## codex-team ↔ app-server Mapping

| codex-team surface | app-server concept |
|---|---|
| `session` (terminology) | thread (persisted) |
| `live session` | thread loaded in memory |
| `session new` | `thread/start` |
| `session attach` | `thread/resume` (+ register as live) |
| `session detach` | `turn/interrupt` (if turn in flight) + `thread/unsubscribe` + unload |
| `session fork --at-turn` | `thread/fork` |
| `session rename` | `thread/name/set` |
| `session info` | `thread/list` entry / cached metadata |
| `session context` | `thread/read` |
| `session list` | loaded subset of `thread/loadedList` (default) or `thread/list` (--all) |
| `message send` | `turn/start` |
| `message peer` | `turn/steer` |
| `message interrupt` | `turn/interrupt` |
| `message approval` | response to `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` / `item/permissions/requestApproval` / `mcpServer/elicitation/request` |
| `message answer` | response to `item/tool/requestUserInput` |
| `message history` | `thread/turns/list` |
| `message tail` | `thread/turns/list` last N + optional `thread/read` metadata snapshot |
| `monitor events` | stream of normalized notifications + server-initiated requests |

## Notes on Normalization

codex-team normalizes before emitting events:

- Method names → snake_case `type` (`turn/completed` → `turn.completed`, `item/commandExecution/requestApproval` → `approval.command_execution`).
- `camelCase` params → `snake_case` payload fields.
- Approval / user-input requests include a daemon-assigned `request_id` (`req-<hex>`);
  the raw app-server request id stays internal to the daemon.
- `codexErrorInfo` enum values are flattened to the discriminant name
  (`contextWindowExceeded` → `context_window_exceeded`); associated data (e.g.
  `httpStatusCode`, `turnKind`) moves into sibling fields on the payload.
