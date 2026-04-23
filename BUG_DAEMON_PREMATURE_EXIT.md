# Bug: daemon exits immediately after startup on `integration` branch

## Symptom

```bash
# Using dist/main.js built from integration branch (or any post-merge branch)
rm -rf /tmp/ff-data; mkdir /tmp/ff-data
CODEX_TEAM_DATA_DIR=/tmp/ff-data \
  node plugins/codex-team/dist/main.js --daemon-sock /tmp/ff.sock --daemon-internal
# → exits immediately with code 0 (!)
# → no sock file created
# → no startup log written
```

Expected: daemon binds to sock, logs "daemon listening", then loops forever waiting on IPC.

Actual: process returns from `runDaemon()` and exits cleanly. No errors.

## Context

The pre-merge `dogfood-base` dist daemon (which is still running from earlier in this session, pid 311705, started 15:21:32) works fine. So the regression is in one of the 5 merged branches (help, multi, edge, async, or fix-monitor) or in a post-merge change.

Most likely suspect: **audit-async's M1/M2 changes to `daemon/events.ts` and `daemon/wire.ts`** — the subscriber microtask fan-out + async cold-load rewrites may have left the server with no `ref()`ed event loop handles, so Node's default "exit when no handles" behavior kicks in.

Other suspects:
- `setInterval(..).unref()` in `scheduleIdleShutdown` (unchanged from dogfood-base, was always `.unref()`)
- `setTimeout(..).unref()` in `scheduleFlush` (may have been added by async)
- server socket `net.Server` — if accidentally `.unref()`ed during startup, the listener doesn't hold the loop open

## Where to look

- `src/daemon/run.ts:runDaemon` — the `return await new Promise<number>(() => {})` MUST keep loop alive. Should never resolve.
- `src/daemon/server.ts:listenSock` — the returned `net.Server` must NOT be `.unref()`ed. Verify.
- `src/daemon/events.ts` — any new `.unref()` calls on timers (M1 microtask fan-out, M2 async load, M5 flush back-pressure).
- `src/daemon/wire.ts` — subscribed handlers; if any leak an unref'd interval...

## Repro (minimum)

```bash
cd /home/wzq/Code/Projects/cc-codex-team
# checkout integration and build
git checkout integration
cd plugins/codex-team
npm run build
# spawn daemon in isolation
rm -rf /tmp/repro
mkdir /tmp/repro
CODEX_TEAM_DATA_DIR=/tmp/repro node dist/main.js --daemon-sock /tmp/repro.sock --daemon-internal &
PID=$!
sleep 2
ls -la /tmp/repro.sock   # expect a sock; see nothing
ps -p $PID               # expect alive; see gone
```

## Impact

High. Any fresh deployment from `integration` branch will have a daemon that silently exits — user runs a codex-team CLI command, `ensureDaemon()` spawns the daemon in background, daemon exits, next cli call hits "daemon_unreachable". From a cold start, codex-team is non-functional on integration.

Workaround: none. The daemon must be fixed before 0.5.1 can ship.

## Related

- Integration merge: see `MERGE_REPORT.md`.
- This bug was discovered during hand-verification of `fix-format-markdown`'s Bug A fix. Unable to smoke-test against a fresh daemon, but the fix-format branch's unit tests (145/145) independently validate the code change.

## Priority

Blocker for 0.5.1 release.

## Reported by

Claude orchestrator during 2026-04-22 dogfood run.
