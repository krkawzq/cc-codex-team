# Review R1 — daemon core (0.5.2-integration)

Base: 0.5.2-integration @ ac0b83ca6e749d04b20a0073077bef7a6229b4c4
Date: 2026-04-23T03:42:36+08:00

## Summary
The daemon-core integration is close, but I found three high-confidence flow breakers in the shipped code: one in session-scoped auto-approve validation, one in `message wait` terminal-state classification, and one in restart/recovery reconciliation. I also found two compatibility/correlation issues that are less immediate but still worth fixing in Phase 2b.

## Blockers
### B1. Invalid session auto-approve regex can black-hole approval requests
- File: `plugins/codex-team/src/daemon/handlers/session.ts`
- Lines: 568-574
- Confidence: HIGH
- Issue: `session new --auto-approve ...` only calls `parseAutoApprovePatterns()` and never validates regex-style patterns. A value like `--auto-approve '/['` is accepted and persisted. Later, `matchAutoApprovePattern()` throws on that pattern (`plugins/codex-team/src/daemon/auto-approve.ts:29-39,53-64`), and `maybeAutoApproveRequest()` calls it without a guard (`plugins/codex-team/src/daemon/wire.ts:315-319`). That exception aborts `handleServerRequest()` before `pending.add()` / event-log append (`wire.ts:226-245`), so the approval is neither auto-approved nor surfaced as a pending request.
- Suggested fix: validate session-scoped patterns on create/load/update, and treat matcher failures as a logged non-match rather than a request-handling failure.

### B2. `message wait` reports failed/cancelled `turn.completed` turns as success
- File: `plugins/codex-team/src/daemon/handlers/message.ts`
- Lines: 646-665
- Confidence: HIGH
- Issue: `terminalWaitResult()` derives `outcome` purely from the event type, so any `turn.completed` event becomes `outcome: "completed"`. But the normalizer explicitly maps failed/cancelled `turn/completed` notifications to `status: "errored"` / `"cancelled"` (`plugins/codex-team/src/daemon/normalize.ts:124-138,276-281`). Result: a failed turn can still come back as a successful wait result, and the CLI will exit `0` because it keys off `outcome`, not `status`.
- Suggested fix: derive wait success/failure from normalized terminal status for `turn.completed`, not only from the event type.

### B3. Daemon restart leaves dead sessions marked `live`, so wait/monitor can hang or lie
- File: `plugins/codex-team/src/daemon/run.ts`
- Lines: 16-35
- Confidence: HIGH
- Issue: startup builds the context and loads persisted sessions first, then calls `reapOrphans()` to kill leftover app-server processes from the previous daemon. There is no follow-up reconciliation step that marks those loaded records crashed or emits `session.crashed`. `messageWait()` only short-circuits when `rec.state !== "live"` (`plugins/codex-team/src/daemon/handlers/message.ts:245-255`), so a persisted session with `state: "live"` and a stale `current_turn_id` will wait until timeout, or forever with `--timeout 0` (`message.ts:347-358`), even though its app-server is already gone.
- Suggested fix: on startup, reconcile every loaded session against the live pool/orphan reap result, mark dead bindings crashed/degraded, and emit synthetic `session.crashed` / `turn.error` when appropriate.

## Majors
### M1. Unknown-client `serverRequest/resolved` fallback can clear the wrong pending request
- File: `plugins/codex-team/src/daemon/wire.ts`
- Lines: 164-185
- Confidence: MEDIUM
- Issue: when `ctx.pool.clientById(e.clientId)` returns null, the code falls back to scanning all pending requests for the same user and removes the first one whose `jsonrpc_id` string matches. JSON-RPC ids are only unique per client, not per user. Because the pool drops the client mapping immediately on close (`plugins/codex-team/src/codex/pool.ts:223-239`), a late `serverRequest/resolved` from an evicted client can remove another still-live client's approval/user-input with the same id.
- Suggested fix: never correlate resolved notifications by bare id across a whole user; keep dead-client correlation state briefly, or ignore unknown-client resolved notifications unless they can be matched unambiguously.

### M2. Pre-0.5.2 persisted sessions are not backfilled with the new lifecycle fields
- File: `plugins/codex-team/src/daemon/sessions.ts`
- Lines: 70-90
- Confidence: HIGH
- Issue: `loadForUser()` only normalizes `autoApprovePatterns`. It does not backfill the new required lifecycle fields (`state`, current-turn fields, pending counters, crash fields). A `sessions.json` written by the pre-lifecycle code can therefore load with `state === undefined`. `sessionHeal()` then rejects it as an unexpected state (`plugins/codex-team/src/daemon/handlers/session.ts:438-441`) instead of treating it as a recoverable live session.
- Suggested fix: normalize persisted records on load with at least `state: "live"` plus `sessionRuntimeDefaults()` for any missing runtime fields.

## Nits
### N1. `app_server_client_id` is persisted dead state
- File: `plugins/codex-team/src/daemon/sessions.ts`
- Lines: 46, 193
- Confidence: HIGH
- Issue: `SessionRecord.app_server_client_id` is part of the persisted shape and can be updated, but nothing in the runtime ever writes or reads it. Right now it only suggests a correlation strategy that the daemon does not actually implement.
- Suggested fix: remove the field, or wire it into real client-correlation logic and recovery checks.

## Non-findings (things I checked that are fine)
- `message wait --timeout 0` really means “no timeout”: `parseTimeoutSeconds()` accepts `0`, and the handler only arms a timer when `timeoutSeconds > 0`.
- `session heal --force` does clear queue/pending/runtime state before resuming: it calls `queues.dispose()`, `pending.abortForSession()`, and then rewrites the record with `sessionRuntimeDefaults()`.
- The normal pending-request registry is client-scoped, not globally id-scoped: `PendingRegistry.byJsonrpcKey` keys on `(client tag, jsonrpc_id)`, so the collision problem only appears in the unknown-client fallback path.
- `approval.mcp_elicitation` auto-approve matching does not assume a `command` field; it matches `url`, then `message`, then `server_name`.
- In-process cursor persistence is serialized through `CursorStore.writeChains`, so I did not find a same-daemon lost-update bug for concurrent CLI cursor writes.
