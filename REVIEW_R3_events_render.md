# REVIEW R3 — events + render

Validation note: this audit is from source inspection. I could not run `npm run typecheck` or `npm test` in `plugins/codex-team` because the worktree does not currently have the required Node dev dependencies installed (`tsc` cannot find `@types/node`, and `vitest` is not on `PATH`).

## Blockers

- `plugins/codex-team/src/format/markdown.ts:187-192,221-229,337-345,529-535`  
  Confidence: high  
  Finding: `createRenderContext()` lets `--truncate <N>` raise `inlineMaxBytes` above `INLINE_MAX_BYTES`. As a result, any inline-capable payload between `2049` bytes and `N` bytes stays inline when `N > 2048` (for example `userMessage`, `reasoning`, and inline `mcp-args`), which contradicts the renderer contract from D: `--truncate` is supposed to change body clipping, not relax the inline/block boundary.  
  Suggested fix: keep `inlineMaxBytes` pinned to `INLINE_MAX_BYTES` and use the caller's `--truncate` value only for `truncateBytes`. Add a regression test that renders a ~3 KB `userMessage` with `truncate: 4096` and asserts block form.

- `plugins/codex-team/src/daemon/cursors.ts:126-136`  
  Confidence: high  
  Finding: `CursorStore.persistAsync()` always writes through the fixed path `cursors.json.tmp` and then renames it into place, but there is no inter-process lock or unique temp name. Two CLIs updating the same user's cursor file can trample each other's temp file: one writer can rename the other writer's payload into place, and the loser can fail with `ENOENT` after its temp file has already been moved away. That makes concurrent `cursor save` / `monitor events --cursor` updates non-atomic across processes.  
  Suggested fix: use a unique temp file per write (`cursors.json.<pid>.<random>.tmp`) plus an advisory lock or compare-and-swap strategy around `cursors.json`, or centralize cursor mutation behind the daemon so only one process writes the file.

## Majors

- `plugins/codex-team/src/daemon/cursors.ts:114-123`  
  Confidence: high  
  Finding: persistence failures are always downgraded to `logger.warn(...)` inside `enqueuePersist()`. `save()` / `delete()` still resolve successfully and return the in-memory cursor even when the rename or write failed. That turns the race above, `ENOSPC`, permission failures, or any other filesystem error into silent data loss from the caller's perspective.  
  Suggested fix: let `enqueuePersist()` reject back to the handler so `cursor save`, `cursor delete`, and `monitor events --cursor` can return an error when persistence fails. If best-effort behavior is desired for background refreshes, make that an explicit opt-in path rather than the default for all writes.

## Nits

- `plugins/codex-team/src/daemon/events.ts:292-295,482-485`  
  Confidence: low  
  Finding: event ids are backed by a plain JS number (`evt-<n>`) with no `MAX_SAFE_INTEGER` guard. This is fine for 0.5.2 scale, but rollover behavior is undefined once the counter stops being exactly representable.  
  Suggested fix: add a sanity check long before `Number.MAX_SAFE_INTEGER`, or move the persisted counter to a bigint/string representation if the log is expected to live indefinitely.

## Non-findings

- `turn.completed` compact payload consumption looks consistent in the places that mattered for this phase: `messageWait` now forwards the compact fields, `wire.ts` only needs `turn_id`, and I did not find another consumer still requiring embedded `turn.items`.
- `EventLog.listSince()` correctly returns `id_rotated` for rotated checkpoints, and `monitor events --since/--cursor` surfaces that error instead of silently skipping.
- `monitor events --summary` emits `key` as either a string or `null`; I did not find a path that produces `key=undefined` or invalid JSON from unexpected payload shapes.
- Snapshot inputs are stable: `tests/markdown-snapshot.test.ts` freezes time before rendering, and the checked-in fixture ids/timestamps are static.
- `auto_approved`, `session.closed`, and `session.crashed` fields are aligned with the current R3 summary/render expectations (`matched_pattern`, `decision`, and `reason` are present where expected).
- Experimental tool alias resolution is case-insensitive; `ask-user-question` and its documented aliases all normalize onto the same feature-flag wiring.
