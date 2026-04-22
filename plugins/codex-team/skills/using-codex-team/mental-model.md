# codex-team Mental Model

The architecture in one page. Read this if the behaviour surprises you.

## Layers

```
CLI (stateless) ──► Daemon (stateful, per-OS-user singleton)
                       │
                       ├── config store       (~/.codex-team/config.json)
                       ├── user registry      (~/.codex-team/users/<base64>/metadata.json)
                       ├── session registry   (per-user sessions.json)
                       ├── event log          (per-user events.log, ring buffer)
                       ├── pending registry   (in-memory: pending approvals)
                       ├── turn queues        (in-memory: per-session send queue)
                       └── app-server pool
                             └── AppServerClient(s) — each owns one `codex app-server` subprocess
                                   ├── live sessions — isolated 1:1 by default
                                   └── adhoc/read-only clients — may be reused up to `app_server.max_sessions_per_process`
```

## Process model

- **cli** is a short-lived Node process per invocation. Reads argv, talks to daemon over a local IPC endpoint (Unix socket on Unix, named pipe on Windows), prints JSON, exits.
- **daemon** is one long-lived Node process per OS user. Binds a local IPC endpoint + `daemon.pid`. Survives across cli calls. Auto-shuts down on idle.
- **codex app-server** subprocesses are spawned by the daemon on demand. Live sessions get isolated clients by default; reusable adhoc clients may host up to `app_server.max_sessions_per_process` (default 16) thread bindings.

## Lifecycle invariants

| Event | Daemon response |
|---|---|
| First `codex-team` cli call | Spawn daemon (detached child) if sock isn't live |
| cli disconnect mid-stream | Drop subscription / alarm timer / stream cleanup |
| app-server process death | Emit `turn.error` for affected sessions, re-acquire a client, and attempt `thread/resume` for each still-live session |
| `thread.closed` notification from codex | Auto-detach the session, cancel pending approvals |
| 6h no activity AND 0 live sessions | `shutdownDaemon("idle timeout")` |
| SIGTERM / SIGINT | `shutdownDaemon` — pool.shutdown → flush event log → unlink sock + pid |

## Data persistence

| What | Where | Survives daemon restart? |
|---|---|---|
| User registry (token → User) | `users/<enc>/metadata.json` | ✓ |
| Session registry (name → record) | `users/<enc>/sessions.json` | ✓ |
| Event log | `users/<enc>/events.log` (JSONL) | ✓ (truncated to retention) |
| Config (explicit overrides) | `config.json` | ✓ |
| codex-pids.json | `codex-pids.json` | used only to reap orphans on next start |
| Pending approval requests | in-memory | ✗ |
| Turn queues | in-memory | ✗ |
| Live session ↔ app-server binding | in-memory | ✗ (lazy re-spawn on next interactive command) |

## Event flow

```
codex app-server notification  ──►  pool emits "notification"
                                      │
                                      ▼
                            normalizeNotification
                                      │
                                      ▼
         EventLog.append (durable append)  ──►  subscriber fan-out (queued via microtask)
                                      │
                                      ▼ (side effects)
                       turn.completed  ──►  TurnQueues.onTurnCompleted → next queued turn
                                            └── emits local `turn.queued_started`
                                            └── or `turn.queued_failed` if auto-drain dispatch fails
                       thread.closed   ──►  auto-detach
                       server_request_resolved  ──►  prune pending registry
```

Server-initiated approval requests from codex take a separate path: they're registered in `PendingRegistry`, get a daemon-assigned `request_id`, and an `approval.*` / `user_input.request` event is emitted so you can respond.

## Isolation

- **Across OS users**: each user has their own daemon (separate `~/.codex-team` home). No crosstalk.
- **Across bearer tokens on one daemon**: hard. Different tokens can't see each other's sessions, events, or pending requests.
- **Across app-server processes**: each app-server is tied to one user's session pool. One user's sessions never cross into another user's app-server.

## What codex-team does NOT do

- **Does not manage codex auth.** The codex binary on your PATH authenticates itself. codex-team just spawns it.
- **Does not persist conversation items.** Item content lives only in codex's own session files (`~/.codex/sessions/...`). codex-team reads turn metadata via `thread/turns/list` and thread snapshots via `thread/read`.
- **Does not sandbox codex further.** The `--sandbox` flag you pass at `session new` is forwarded to codex app-server, which implements it.
- **Does not rate-limit your turns.** Codex app-server handles that; codex-team only wraps certain transient failures with retry/backoff and applies request timeouts.

## Relationship to codex app-server protocol

codex-team is a **layer above** `codex app-server`'s JSON-RPC 2.0 protocol. For every codex-team command there is a corresponding RPC (`thread/start`, `turn/start`, `thread/name/set`, etc). See `docs/codex-app-server-protocol.md` for the full mapping. When in doubt about what codex can do, check the codex crate (`forks/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`) — codex-team does not expose anything codex can't natively do.
