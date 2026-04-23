# Known quirks

These aren't bugs in codex-team — they're characteristics of the underlying codex app-server protocol. Learn them once, don't debug them again.

## 1. Zero-turn threads aren't persistent

If you `session new` and immediately `session detach` without sending any turn, codex does not write a rollout file. The thread_id is effectively gone — `session attach <that-uuid>` will fail with `codex_error`: `no rollout found for thread id …`.

**Mitigation**: send at least one turn before detaching, or don't detach a brand-new session you plan to reuse.

## 2. `thread/turns/list` still returns turns with empty `items`

The protocol still defines `Turn.items` as empty in `thread/turns/list` responses. Raw JSON `message history` therefore remains metadata-first.

In 0.5.5, though, `message history --format markdown` and `message tail --format markdown` are no longer metadata-only. codex-team now hydrates readable turn content from thread snapshots when available and renders a rich tagged transcript.

**Mitigation**: prefer `message history --format markdown` / `message tail --format markdown` for post-hoc reading, or parse `item.completed` events live when you need every step as it happens.

## 3. `thread/read` is metadata-first, not a guaranteed full transcript API

`thread/read` returns the `Thread` object (`{ thread: Thread }`). Depending on what the app-server includes, that may or may not contain past turn items. codex-team treats it as a best-effort hydration source for markdown rendering, not as a protocol guarantee that every historical item will always be present.

**Mitigation**: use the event stream for live progress, and use `message history` / `message tail --format markdown` for the best readable retrospective view. If you need codex's raw persisted artefacts, inspect the rollout files directly under `~/.codex/sessions/...`.

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

## 6. Terminal turn notifications are summaries, not transcript payloads

The wire-level `turn.completed` notification is not the place to recover rich turn content. codex-team 0.5.5 intentionally normalizes the terminal event to a compact summary: `{turn_id, status, duration_ms, items_count, token_usage, ended_at, turn_items_included: false}`.

That event shape is separate from the markdown read path: `message history` / `message tail --format markdown` can still render rich readable content by hydrating from thread snapshots when available.

**Mitigation**: treat `turn.completed` as the boundary marker, not the content source. Fetch readable content with `message tail` / `message history`, or follow `item.completed` live if you need every step.

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

## 15. Persisted state is schema-versioned and newer versions are rejected

`users/*/sessions.json` and the per-user `events.log` carry `schema_version`. If a file was written by a newer codex-team build, this build refuses to load it rather than guessing.

**Mitigation**: do not downgrade the daemon onto a newer data dir. If you must inspect or recover data, use the newer binary or move the old data dir aside and start with a fresh one.

## 16. Daemon log follow is rotation-safe

`daemon logs --follow` now tails by byte offset, debounces bursts, and keeps working across rename-based log rotation. If a log file disappears briefly during rotation, the follower resets its offset and resumes when the file reappears.

**Mitigation**: if a follow stream looks quiet during rotation, wait for the next write before assuming logging stopped.

## 17. Windows shutdown is cooperative first, shell wrappers are exercised

On Windows, child-process shutdown now tries `stdin.end()` before `kill()` so app-server and monitor children get a chance to exit cleanly under back-pressure. The `.cmd` wrapper path is also covered and expected to chain through `call`, so nested launcher scripts should return control to the parent shell correctly.

**Mitigation**: if you still see a stuck Windows child, treat it as a real process issue rather than an expected wrapper limitation.

## 18. Orphan reap and pidfile ownership are identity-based, not pid-only

`codex-pids.json` tracks `pid + start_time + nonce`, and daemon startup also checks whether a pidfile owner still looks like a `codex-team` daemon before refusing to start. This avoids killing or blocking on an unrelated process that inherited the same PID later.

If startup still refuses with "another daemon pidfile is live", verify the pid in `daemon.pid` really belongs to codex-team before deleting anything:

1. Inspect the pid from the error or pidfile.
2. Check its command line / process details.
3. Only remove the pidfile manually if that process is gone or is not a codex-team daemon.
