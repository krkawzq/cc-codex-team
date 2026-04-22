# Merge report — integration branch

## Branches integrated

| branch | commits | sha range |
|---|---|---|
| audit-help | 5 (R1 + R4) | 0227166 … a38d477 |
| audit-multi | 5 | 28548c6 … eae81de |
| audit-edge | 9 | 474a5ed … 186c2b1 |
| audit-async | 1 (bulk) | 37176e3 |
| fix-monitor | 1 | 098adc1 |

Merge commits on `integration`:
- `2acdb45` merge(audit-help)
- `5177ce1` merge(audit-multi)
- `5c24bfb` merge(audit-edge)
- `8e7c407` merge(audit-async) — conflicts manually resolved by orchestrator after resolver-session ran out of context at 5.8M tokens
- `9ca9d4e` merge(fix-monitor)
- `769d408` fix(tests): prime events log before testing appendFile retry — one post-merge test fix for header-line incompatibility

Final integration sha: `769d408`.

## How merging proceeded

`merge-resolver` codex session successfully handled the first 3 merges (help, multi, edge) with ~20 commits-worth of conflict resolution. During merge #4 (audit-async, the largest — 21 files, +1292/-413), the session hit ~5.8M total tokens over 26 minutes without committing; files had all been edited to remove conflict markers (verified `<<<<<<` / `>>>>>>` gone) but stayed UU because git-add hadn't been run. Claude (orchestrator) interrupted the session, verified marker-free state, staged and committed manually, then did a clean `git merge fix-monitor` for the final branch.

## Conflict resolution outcomes (per review guidance)

### `src/daemon/handlers/monitor.ts`

Combined:
- **multi's M5**: cooperative Windows shutdown (stdin.end first, then kill) with `stdio: ["pipe", "pipe", "pipe"]` (not `"ignore"` stdin)
- **edge's M5**: `stream.onClose(...)` registered BEFORE the first `await runOnce()`; hard-kill timer lifecycle preserved across both cancel and timeout
- **async's M3**: bounded interval-mode queue with overflow handling
- **fix-monitor**: stream stays open when `--filter` yields empty backlog

### `src/daemon/orphans.ts` + `src/daemon/processes.ts`

Combined:
- **edge's M3**: pidfile uses `{pid, start_time, nonce}` identity records
- **multi's N2**: `tasklist` fallback classifier for Windows + retain-unresolved-pids

Resolver's integration of these was clean (git's 3-way merge handled most; semantic combine was already the way both diffs converged).

### `src/paths.ts` + `src/daemon/run.ts`

- **multi**'s home resolution + `~` expansion wins path-side
- **edge**'s pidfile identity check operates on the new resolved path
- Legacy-path probing (edge's O3 suggestion for Windows HOME migration) NOT applied — deferred for follow-up

### `src/cli/run.ts`

Clean non-overlapping merge:
- Help's early `--help` short-circuit path at top of `runCli`
- Async's `runStream` stdout back-pressure (sock.pause / resume on drain)

### `src/daemon/pending.ts` + `src/daemon/handlers/message.ts`

Combined:
- **edge's M2**: atomic `claim(requestId)` as linearization point
- **async's N2**: `respondAck()` with pending retained until write-callback

Known caveat (from help R3 review D1): `message approval` / `message answer` now awaits stdin drain + warning-event `events.append` before resolving — caller sees slightly higher latency under back-pressure. Post-merge follow-up captured.

### `src/daemon/wire.ts`

Rewritten ~79% by async (microtask subscribe fan-out, B1 requeue, queued_failed event). Edge's B2/B3 (crash respawn + teardown state machine, late-server_request filtering) layered on top of async's new skeleton. Handled by merge-resolver before interrupt.

### `src/daemon/queues.ts`

Combined async's B1 requeue + edge's B3 teardown state-machine with disposed/generation bit. Handled by merge-resolver.

### `src/daemon/events.ts`

- async's async cold-load + microtask fan-out + M5 back-pressure as skeleton
- edge's `SCHEMA_VERSION` validation + `listSince` "rotated vs never existed" distinction layered on top
- Header-line format added for schema tagging (new — came from edge's work)
- One test (retry-on-failed-appendFile) was written against pre-header behavior and failed post-merge because first-write now uses `writeFile` with header instead of `appendFile`. Fixed by priming the test with a warmup append before the retry assertion.

### `src/daemon/handlers/daemon.ts`

- `daemonLogsStream`: async's byte-offset tail + debounce + rename-safe version
- `daemonUserDestroy`: help's `--force` gate
- Other handlers unchanged

## Tests

- Build: PASS (`dist/main.js` 225 KB)
- Tests: **139 / 139 passed**
- Fixed one test breakage post-merge: `tests/events.test.ts > retries failed appendFile batches` — primed the log file so the retry assertion hits the `appendFile` path instead of the new first-write `writeFile` path.

## Known follow-ups (post-merge)

1. **async D1 — `message approval`/`answer` latency regression**: stdin-ack + events.append on critical path adds round-trip delay. Consider async warning-event emission. Captured in `BUG_*` docs elsewhere.
2. **edge O3 — Windows `$HOME` → native-home migration**: no legacy-root probing added; users on legacy HOME install paths will see their old daemon orphaned across version upgrade. Document as one-time cleanup.
3. **merge-resolver context efficiency**: resolver burned 5.8M tokens without final commit. Future dogfood runs should either (a) scope per-file conflicts rather than all-at-once merge, or (b) hand-roll the final staging in orchestrator. See separate BUG doc.
4. **Monitor tool issues discovered during dogfood** (already captured in BUG_* docs):
   - `BUG_MONITOR_FILTER.md` — fixed by fix-monitor branch (was stale dist)
   - `BUG_FORMAT_MARKDOWN_ENVELOPE.md` — `--format markdown` wraps in JSON envelope + item body is raw JSON
   - `BUG_ASKUSERQUESTION_NO_TOGGLE.md` — no way to enable askUserQuestion from session new
   - `BUG_SANDBOX_WORKTREE_GIT.md` — sandbox denials for git worktree meta-writes

## Final integration sha

`769d408` on branch `integration`, parent chain: 5 merge commits + 1 post-merge test fix on top of dogfood-base.
