# Known quirks

These aren't bugs in codex-team — they're characteristics of the underlying codex app-server protocol. Learn them once, don't debug them again.

## 1. Zero-turn threads aren't persistent

If you `session new` and immediately `session detach` without sending any turn, codex does not write a rollout file. The thread_id is effectively gone — `session attach <that-uuid>` will fail with `codex_error`: `no rollout found for thread id …`.

**Mitigation**: send at least one turn before detaching, or don't detach a brand-new session you plan to reuse.

## 2. `thread/turns/list` returns turns with empty `items`

The protocol explicitly defines `Turn.items` as populated only on `thread/resume` or `thread/fork` responses. `message history` and `message tail` use `thread/turns/list` under the hood, so they return turn metadata (id, status, timings) but no item content.

**Mitigation**: use `session context` (`thread/read`) for a thread-level snapshot, or parse `item.completed` events as they arrive for live progress.

## 3. `thread/read` doesn't return items either

Thread/read returns the `Thread` object only (`{ thread: Thread }`). There's no protocol method that returns past turn items for a session. Items come from the event stream (`item.completed`) while the turn is running.

**Mitigation**: listen to events in real time. After a turn completes, the items are only recoverable via codex's on-disk rollout files (`~/.codex/sessions/<date>/rollout-*.json`) — codex-team does not parse those.

## 4. Long-context reply mismatch (first occurrence is usually spurious)

Under high context load, codex occasionally returns a reply that doesn't seem to match the prompt — e.g. you asked about `auth.ts` and it describes `http.ts`. First occurrence: ignore, re-send the prompt. Second occurrence: the thread context is probably misaligned; fork from an earlier turn and replay.

**Not** a protocol bug — it's a model quirk under pressure.

## 5. `turn/interrupt` and `turn/steer` during review/compact turns

Codex runs internal review and compact turns between user turns (part of the approvals-reviewer mechanism). During these, both `turn/interrupt` and `turn/steer` return:

```
codex_error_info: active_turn_not_steerable
```

with `turnKind: "Review"` or `"Compact"`.

**Mitigation**: wait for the internal turn to finish (usually 5–30s). The daemon does NOT retry these — it's not an overload error.

## 6. Turn completed notifications arrive with `turn.items = []`

The wire-level `turn.completed` notification does include a `Turn` object, but its `items` field is always empty (per protocol spec). Turn content arrives through separate `item.completed` notifications during the turn. codex-team normalizes `turn.completed`'s payload to a summary (`turn_id`, `status`, `started_at`, `completed_at`, `duration_ms`, `item_count`, and the raw `turn`) and drops the empty `items`.

**Mitigation**: collect items via `item.completed` events during the turn; `turn.completed` is a boundary marker, not a content source.

## 7. Token case: camelCase on the wire, snake_case in codex-team events

Codex app-server uses `camelCase` (`threadId`, `turnId`, `codexErrorInfo`). codex-team events normalize to `snake_case` (`thread_id`, `turn_id`, `codex_error_info`). Within `payload.raw` (unnormalised passthrough on server requests), casing is still camelCase.

## 8. `thread/name/set` (not `thread/setName`)

A historical slash-based method name. codex-team-team got this wrong in early drafts; now correct. If you call the codex app-server directly, use `thread/name/set`.

Similarly: `thread/turns/list` not `thread/turnsList`; `thread/compact/start` not `thread/compactStart`.

## 9. `sortDirection` is `"asc"` / `"desc"`

Not `"ascending"` / `"descending"`. API rejected the longer forms in testing.

## 10. app-server stdout/stderr go through separate channels

The JSON-RPC messages come on stdout; free-form log output goes to stderr. The AppServerClient keeps the last ~400 stderr lines as a diagnostic tail — accessible via `client.stderrTailText()` if you're debugging protocol issues.

## 11. Non-standard `<\tag>` close in markdown output

The markdown format uses `<\tag>` (backslash) as the close marker. This is deliberate non-HTML so markdown viewers don't try to interpret it as an element. Don't "fix" this to `</tag>` — tag-text visibility is the design goal.

## 12. orphan reap is best-effort on startup

`codex-pids.json` tracks spawned codex PIDs so that on next daemon start, `reapOrphans()` can SIGTERM leftovers. The daemon now sanity-checks that a live pid still looks like `codex app-server` before killing it, but on some platforms process-command inspection is best-effort. Worst case, an old orphan survives until manual cleanup; the daemon itself still starts.

## 13. `app_server.max_sessions_per_process` mainly affects reusable adhoc clients

Live sessions are isolated onto dedicated app-server clients by default, so changing `app_server.max_sessions_per_process` mostly affects reusable adhoc/read-only clients (`thread/list`, `thread/read`, etc.). The setting is still hot-but-sticky for already-spawned reusable clients; `daemon restart` forces a clean slate.

## 14. Takeover cancels pending requests

When user A has a pending `approval.command_execution` and user B runs `session attach --takeover`, codex-team cancels the pending request on user A's side by responding to codex with `-32000 session seized`. User A will see their pending event vanish but NOT receive a `server_request_resolved` (they receive `session.seized` instead). Codex treats the cancelled approval as declined.
