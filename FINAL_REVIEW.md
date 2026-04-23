# codex-team 0.5.2 — Final review summary (Phase 2d)

Base: `0.5.2-integration` head (post Phase 2c). 251 tests + typecheck green. dist rebuilt.

## Round-1 findings — verdict

Aggregated across R1 (daemon), R2 (CLI), R3 (events+render), R4 (config+build):

| ID | Description | FX handler | Phase 2c verdict |
|---|---|---|---|
| R1 B1 + R4 B | session `--auto-approve` regex not validated | FX1 | **resolved** (src+dist after rebuild) |
| R1 B2 | `message wait` ignores turn.completed status | FX1 | **resolved** (src+dist after rebuild) |
| R1 B3 | daemon restart leaves dead sessions marked live | FX1 | **resolved** (src+dist after rebuild) |
| R1 M1 | `server_request_resolved` cross-client fallback | FX1 | **resolved** |
| R1 M2 | persisted sessions not backfilled | FX1 | **resolved** |
| R2 B1 | `--short` drops pagination | FX2 | **resolved** (footer) |
| R2 B2 | `monitor --cursor` advances on abort | FX2 | **resolved** (ack-driven) |
| R2 M1 | `--flag=value` global parsing | FX2 | **resolved** |
| R2 N1 | error envelope duplicated | FX2 | **resolved** (`forwardDaemonError`) |
| R2 N2 | `-n` in `long` field | FX2 | **resolved** |
| R3 B1 | `--truncate` raised inline threshold | FX2 | **resolved** (pinned to INLINE_MAX_BYTES) |
| R3 B2 | CursorStore non-atomic cross-process | FX2 | **resolved** for original race (see NM2 below) |
| R3 M1 | cursor persist failures silent | FX2 | **resolved** (+ explicit best-effort variant) |
| R3 N1 | event id overflow guard | FX3 | **resolved** |
| R4 M1 | `daemon status` missing `session_count` | FX3 | **resolved** |
| R4 M2 | bump-version.sh bash-only | FX3 | **resolved** (mjs cross-platform) |
| R4 M3 | 设计文档 config table stale | FX3 | **resolved** (23/23 keys) |
| R4 M4 | no post-build SSOT test | FX3 | **resolved** (+ graceful skip) |
| R4 N1 | renderContext coverage | FX3 | **resolved** |

**17/17 Round-1 findings resolved.**

## New findings from Phase 2c — for Phase 3

Residual cross-boundary issues discovered by round-2 reviewers:

### PH3-1 (R1 NB2) — pending requests lost across daemon restart (Major)
- **Files**: `src/daemon/context.ts:49-75`, `src/daemon/run.ts:76-169` (`reconcileLoadedSessionsAfterRestart`), `src/daemon/pending.ts`
- **Issue**: FX1 reconciliation emits `approval.request_cancelled` / `user_input.request_cancelled` from `cancelRestartPendingRequests`, but `buildContext()` starts with a FRESH empty `PendingRegistry`. Pending request ids aren't persisted anywhere, so a real daemon restart has no pending entries to cancel — the emission path only fires in test harnesses that inject a pre-populated registry.
- **Fix options**:
  - (a) Persist minimal pending metadata (`request_id, kind, session, thread_id, turn_id`) to `~/.codex-team/users/<t>/pending.json`; load on startup; use that to emit real cancellations.
  - (b) Downgrade contract: emit one session-scoped `session.crashed_pending_dropped` synthetic event per dead session (no per-request detail), document the best-effort semantics.
  - Recommend (b) for 0.5.2 scope, (a) as a 0.6 candidate.

### PH3-2 (R3 NM1) — cancellation events only fire on restart, not on live teardown (Major)
- **Files**: `src/daemon/run.ts:114-126`, `src/daemon/wire.ts:265-288`, `src/daemon/handlers/session.ts:213-216, 462-469, 692-700`, `src/daemon/handlers/daemon.ts:80-83`
- **Issue**: Live teardown paths (`session detach`, `session.crashed` on live app-server exit, `session seize`, `session heal --force`, `daemon user destroy`) abort/remove pending requests + send JSON-RPC errors to the waiting client, but do NOT append `approval.request_cancelled` / `user_input.request_cancelled` events. So monitor/event-log consumers see cancellation events after restart but not during normal runtime — asymmetric contract.
- **Fix**: centralize pending-request cancellation in a helper that (a) aborts/removes the pending entry, (b) sends the JSON-RPC error, (c) appends the cancellation event. Replace all 5+ call sites.

### PH3-3 (R3 NM2) — cursor lock has no stale-lock recovery (Medium)
- **Files**: `src/daemon/cursors.ts:162-204` (`acquireCursorLock`)
- **Issue**: Lock acquired via `open(lockPath, "wx")`. On crash the `.lock` file persists and every subsequent write times out at 2s indefinitely until manual deletion.
- **Fix**: either (a) write `{pid, started_at}` into the lockfile, validate on retry (PID alive? timestamp > N min old?), reclaim stale; or (b) use OS advisory lock (`fs.flock` via `proper-lockfile` — but adding dep), auto-release on process exit. Prefer (a), hand-rolled.

### PH3-4 (R4 NM1) — SSOT test doesn't cover plugin.json (Medium)
- **Files**: `tests/version-ssot.test.ts:15-48`, `.claude-plugin/plugin.json`
- **Issue**: Current test verifies `package.json.version === VERSION === dist(main.js).cli_version`, but doesn't assert `.claude-plugin/plugin.json.version === package.json.version`. Manual edits / partial cherry-picks can drift.
- **Fix**: extend `version-ssot.test.ts` to read both manifests and assert equality.

## Test + typecheck status

- 251 tests passing
- typecheck clean
- dist rebuilt post Phase 2b merge (commit `4c2022d`)

## Recommended Phase 3 scope

Single cross-boundary fixer session (`xfix-2`) addresses PH3-1 through PH3-4. Estimated effort: ~15-25 min codex turn (similar to xfix-1). After xfix-2 merges, no further audits — proceed directly to Phase 4 docs + release.

Appended Phase 2a + 2c reports (at repo root): `REVIEW_R{1..4}_*.md`, `REVIEW_R{1..4}_*_r2.md`.
