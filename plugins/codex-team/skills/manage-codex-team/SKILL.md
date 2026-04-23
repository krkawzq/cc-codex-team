---
name: manage-codex-team
description: >-
  Authoritative operational manual for driving codex-team sessions day-to-day — creating / sending / peering / interrupting / detaching sessions, arming the event stream, blocking with `message wait`, inspecting with `session health`, and responding to events (`turn.completed`, `turn.error`, `turn.queued_started`, `turn.queued_failed`, `approval.*`, `user_input.request`, `session.crashed`, `session.closed`, `session.seized`). **Proactively load this skill whenever you are about to dispatch work to a worker, read its state, respond to an event the Monitor just delivered, or handle an approval/user-input request.** Not for: one-shot CLI reference (`configure-codex-team`), failure recovery (`recover-codex-team`), picking a collaboration pattern (`codex-team-playbooks`), or first-time mental model (`using-codex-team`).
---

# Manage codex-team

> You've read `using-codex-team` and have a bearer token + at least one live session. Now you're running the operational loop: send, observe, respond.

## Operational loop

```
    ┌──────────────────────────────┐
    │  send / peer / interrupt     │  (outbound)
    │              │               │
    │              ▼               │
    │  turn.started  ──►  item.*   │  (event stream)
    │              │               │
    │              ▼               │
    │  approval.* / user_input ───►│  (needs response)
    │              │               │
    │              ▼               │
    │  session.crashed / closed ──►│  (inspect / recover)
    │              │               │
    │              ▼               │
    │       turn.completed         │  (fetch via message tail)
    │              │               │
    │              ▼               │
    │       ready for next turn    │
    └──────────────────────────────┘
```

## Output modes (0.5.3+)

**Default output is concise** — single-line JSONL with only the fields Claude needs to act. You don't pass any flag to get it.

```bash
# default — no flag, concise JSON
codex-team -b $TOK message send audit "..."
# → {"status":"started","turn_id":"..."}

codex-team -b $TOK session new audit --cwd /repo
# → {"name":"audit","thread_id":"th-..."}

codex-team -b $TOK session health audit
# → {"session":"audit","state":"live","busy":true,"current_turn_id":"..."}
```

Opt in to the verbose shape only when you need a field that's not in the default:

```bash
# --full — multi-line JSON with the full record, timestamps, config echo, etc.
codex-team -b $TOK session new audit --cwd /repo --full
codex-team -b $TOK session info audit --full   # includes created_at, last_active_at, auto_approve patterns, …
```

`--short` is for dashboards / grep — plain text, even more compact than default:

```bash
codex-team -b $TOK session list --short      # audit  live  gpt-5.4  busy=y
codex-team -b $TOK session health audit --short  # audit state=live busy=y pending=0 app_server=y turn=...
```

Rule: **never use `--full` preemptively.** If the default is missing a field, re-query with `--full`. `--short` and `--full` are mutually exclusive.

## Creating work

### `session new` — start a fresh thread

```bash
codex-team -b $TOKEN session new <name> \
  --cwd <abs-path> \
  [--model <m>] [--sandbox <mode>] [--approval <policy>] [--effort <level>] \
  [--personality <preset>] [--profile <cfg-name>] [--experimental-tools <csv>] \
  [--auto-approve <csv-or-/regex/flags>] \
  [--base-instructions <file>] [--developer-instructions <file>]
```

Returns a record with the UUID `thread_id`. Session is **live** immediately.

Name rules: `^[A-Za-z0-9_\-]{1,128}$`, not a UUID, not starting with `th-`. Leave `[name]` empty to auto-generate `s-<hex>`.

`--auto-approve` replaces any daemon default for that session; `--auto-approve ""` opts out explicitly.

### `session attach` — resume an existing thread

```bash
codex-team -b $TOKEN session attach <name|thread_id> [--takeover] [--experimental-tools <csv>]
```

- By name: if the name is in your user's registry, idempotent noop. If another user has that name live, it must be unique across users or attach errors.
- By UUID: resumes any thread codex has on disk, regardless of who created it.
- If another user has it live: `session_busy` unless `--takeover`. Takeover makes the original user see `session.seized`.

### `session fork` — branch from a turn

```bash
codex-team -b $TOKEN session fork <source> [new-name] [--at-turn <turn_id>]
```

Default fork point is tip. New session is live immediately.

## Sending prompts

### `message send` — non-blocking, auto-queued

```bash
codex-team -b $TOKEN message send <session> "<prompt text>"
codex-team -b $TOKEN message send <session> --file prompt.txt
codex-team -b $TOKEN message send <session> --stdin
codex-team -b $TOKEN message send <session> --attach image.png "explain this screenshot"
```

- `--attach` currently accepts local image files only (`png/jpg/jpeg/gif/webp/bmp/svg`).
- Returns immediately with `turn_id` (if started) or `started:false` + `queue_id` + `queued_depth` if a turn was already running.
- Queue is per-session. Daemon dispatches queued prompts in order on each `turn.completed`.

### `message peer` — soft interject

```bash
codex-team -b $TOKEN message peer <session> "actually, focus on auth first"
```

Only valid when a turn is active. Does NOT kill in-flight tool calls (those finish naturally); the new prompt is prepended to the model's next thinking step. Use this to redirect without losing work.

### `message interrupt` — hard cancel

```bash
codex-team -b $TOKEN message interrupt <session>
```

Kills the current turn immediately. In-flight shell commands are SIGTERM'd. Use only when the worker is clearly off-track.

Note: during a review or compact turn, codex rejects interrupt/steer with `codex_error_info: active_turn_not_steerable`. Wait for that turn to finish.

## The event stream

Arm once:

```bash
codex-team -b $TOKEN cursor save ops-tail
```

Then either:

```text
/codex-team:events -b $TOKEN --stream --summary --cursor ops-tail
```

Or raw Monitor invocation (see quickstart).

### Default filter

`*.delta` events (token-level streaming) are filtered out by default. Add `--include-delta` if you need them (rarely useful — the agent-message delta fires many times per turn).

### What you'll see

See `events.md` in this skill for the full type catalogue. The common ones are:

- `turn.completed` — a turn finished. Fetch content with `message tail` or `message history`.
- `session.crashed` — the live session lost its app-server. Run `session health`, then `session heal`.
- `session.closed` — the live binding was torn down (detach, shutdown, idle unload, destroy, etc.).
- `approval.<kind>` — codex is waiting for your answer. Respond via `message approval`.
- `user_input.request` — codex wants an ask-user-question / user-input answer. Respond via `message answer`.
- `approval.request_cancelled` / `user_input.request_cancelled` — the pending request was dropped during teardown or crash handling.
- `turn.queued_failed` — daemon tried to auto-drain a queued prompt after `turn.completed`, but dispatch failed. Treat it as a retry/triage point, not a completion signal.

`monitor events --stream` is safe to leave open during high-rate sessions. The cli now applies stdout back-pressure so a noisy worker does not blow up the stream reader's memory.

Use `--summary` for high-fanout orchestration and `--cursor <name>` when the stream needs to resume cleanly across Claude restarts. In 0.5.2, `turn.completed` is compact metadata only; it no longer embeds turn items.

### Blocking on one turn

```bash
codex-team -b $TOKEN message wait <session> [--for <turn_id>] [--timeout <s>]
```

- Exit `0` on a completed turn
- Exit `1` on errored/cancelled/crashed paths
- Exit `124` on timeout

### Fetching content on demand

```bash
# Latest N turns rendered as markdown
codex-team -b $TOKEN message tail <session> -n 3 --format markdown --truncate 2048

# Follow mode — streams new snapshots as turns complete
codex-team -b $TOKEN message tail <session> --follow --truncate 2048

# Longer history with pagination or relative offsets
codex-team -b $TOKEN message history <session> --limit 20 --since <turn-or--3> --truncate 2048
```

## Responding to approvals

See `approvals.md` in this skill for the full decision matrix. Short version:

```bash
# Shortcuts
codex-team -b $TOKEN message approval <s> <request_id> accept           # decision:"accept"
codex-team -b $TOKEN message approval <s> <request_id> accept-session   # decision:"acceptForSession"
codex-team -b $TOKEN message approval <s> <request_id> decline
codex-team -b $TOKEN message approval <s> <request_id> cancel

# Complex / structured
codex-team -b $TOKEN message approval <s> <request_id> \
  --json '{"decision":"acceptWithExecpolicyAmendment","execpolicyAmendment":{...}}'
```

Shortcut validity depends on the approval kind. In particular: `approval.permissions` rejects `cancel`; `approval.mcp_elicitation` rejects `accept-session`; form-mode `approval.mcp_elicitation` requires `--json`.

askUserQuestion:

```bash
# Single-question shorthand
codex-team -b $TOKEN message answer <s> <request_id> "Postgres"

# Multi-question — always JSON
codex-team -b $TOKEN message answer <s> <request_id> --json \
  '{"answers":{"q1":{"answers":["Postgres"]},"q2":{"answers":["Drizzle"]}}}'
```

## Reading state

Default output on these read-only commands is already concise (post-0.5.3). Pass `--short` for plain-text dashboard lines, or `--full` when you need a field the default omits.

| Command | Purpose |
|---|---|
| `codex-team -b <TOK> status` | Your user's summary: live sessions, retained events, pending requests |
| `codex-team -b <TOK> session list` | Live sessions in your registry |
| `codex-team -b <TOK> session list --all` | Every thread on disk (including other users) |
| `codex-team -b <TOK> session info <s>` | Session metadata: state, model, busy, turn id, items |
| `codex-team -b <TOK> session health <s>` | Live runtime snapshot: busy, current turn, pending approvals, app-server liveness |
| `codex-team -b <TOK> session heal <s> [--force]` | Re-attach a crashed/dead live session to a fresh app-server |
| `codex-team -b <TOK> session context <s>` | Latest detailed JSON thread snapshot from codex |
| `codex-team -b <TOK> message history <s>` | Last N turns (ids, status, duration, item counts) |

All are read-only. `session health` is the first check when you receive `session.crashed` — if it shows `state=crashed` or `app_server_alive=false`, follow up with `session heal`.

## Ending work

```bash
# Graceful: do not interrupt; wait for the active turn to finish before detaching
codex-team -b $TOKEN session detach <name> --graceful

# Default: hard detach (interrupt current turn, drop queue)
codex-team -b $TOKEN session detach <name>
```

Detach does not delete the thread — you can re-attach the same UUID later.

## Common patterns

### Fire-and-forget batch

```bash
for src in src/*.ts; do
  codex-team -b $TOKEN message send refactor "Refactor: $(basename "$src")"
done
# sends all synchronously from cli's POV; daemon queues them and processes in order
```

### Early correction

```bash
codex-team -b $TOKEN message send demo "Refactor auth.ts"
# ... 5s later, watching events, you realise the worker is going off-direction
codex-team -b $TOKEN message peer demo "stay within the existing API shape"
```

### Parallel workers

Spin up two sessions in the same user, give each different work, arm one events Monitor (events carry `session` field to disambiguate).

If one worker emits `turn.queued_failed`, inspect the error, fix the blocking condition (often a transient app-server/session issue), then re-send or manually resume that queued unit of work.

See `codex-team-playbooks/` for canonical multi-session topologies.

## Anti-patterns

- Polling `session info` / `message history` as a substitute for the event stream or `message wait` (wastes RPCs; doesn't see turn.started in time).
- Holding multiple pending approvals across sessions without tracking which `request_id` belongs to which. Record them as you receive events.
- Using `interrupt` as a way to queue: it destroys the in-flight turn's work. Use `send` (queues automatically) or `peer` (soft interject).
- Passing raw JSON to `message approval` when a shortcut would do — more verbose, more error-prone.
