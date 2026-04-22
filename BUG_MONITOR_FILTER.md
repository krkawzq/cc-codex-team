# Bug: `monitor events --stream --filter <types>` — premature stream end

## Symptom

```bash
# WORKS (stays open, streams events until SIGTERM)
node dist/main.js -b $TOK monitor events --stream

# BROKEN (exits 0 within ~instant when no events match filter in the backlog)
node dist/main.js -b $TOK monitor events --stream --filter turn.completed
# → exit 0, zero bytes stdout; timeout SIGTERM never fires
```

## Observed behaviour

| Scenario | Expected | Observed |
|---|---|---|
| `--stream` no filter | Stream stays open | ✅ works |
| `--stream --filter X` with backlog matches | Emit matches, stay open | Emits matches, then exits 0 |
| `--stream --filter X` backlog empty | Stay open waiting for next X | Exits 0 within ms |
| `--stream --since evt-N` (no filter) | Stream from N onward | ✅ works |
| `--stream --since evt-N --filter X` | Same, filtered | ⚠️ suspect; not re-tested |

Exit code is `0`, not `130` (which would indicate SIGTERM from `timeout`) or `1` (which would indicate `daemon closed connection` from `onMessages` close path without prior finish).

## Files to inspect

- `src/daemon/handlers/monitor.ts` — the `streamMode` branch (lines 52–60): after emitting the filtered backlog and installing `subscribe`, handler returns `{streaming:true}`. The Promise resolving normally should NOT trigger stream close.
- `src/daemon/server.ts:handleRequest` — after `await handler(ctx, req, stream)` in the streaming branch, it `return;`s. Confirm no stream.end() is called implicitly.
- `src/daemon/server.ts:createStreamHandle` — `ended` flag; verify no path sets `ended=true` + emits `stream_end` with no matches.
- `src/cli/run.ts:runStream` — check the `else if (msg.kind === "response" && msg.id === reqId)` branch (lines ~187-195). If a `response` message arrives for a streaming request, CLI calls `finish(0)`. The daemon should NOT send a response for streaming requests; confirm it doesn't.

## Likely root causes (hypotheses for codex to investigate)

1. **Spurious response**: The streaming branch in `server.ts` might still write a response to the socket somewhere. Check for accidental `writeMessage(socket, resp)` calls inside the streaming path.
2. **Subscriber dispose fires early**: `stream.onClose` callback might fire spuriously during subscribe setup, releasing the subscription and collapsing the stream.
3. **Socket close-to-self**: Some code writes to a socket state that causes the cli's `onMessages` close handler to fire with `finished:false` but somehow `finish(0)` sneaks through.
4. **Timer/unref interaction**: If `--filter` path involves an `.unref()`ed timer that's the only thing keeping the event loop alive, the daemon side might exit the request handler causing socket flush → cli onclose.

## Required test to add (regression)

```ts
it("monitor events --stream --filter X stays open with empty backlog", async () => {
  const { daemon, cli } = await launchDaemonAndCli();
  await cli.userCreate("testtok");
  const proc = cli.spawn(["-b", "testtok", "monitor", "events", "--stream", "--filter", "turn.completed"]);
  await delay(500);
  expect(proc.exitCode).toBeNull();  // <-- fails today
  proc.kill("SIGTERM");
  await proc.exited;
  expect(proc.exitCode).toBe(130);
});
```

## Workaround in use

Use `--since <evt-id>` + short `timeout` + parse stdout. Works but requires polling, not push.

## Priority

Major — `--filter` is documented in `docs/设计文档.md` line ~702. Current CLI users would hit this immediately. Affects orchestration workflows that need filtered push streams.

## Reported by

Claude orchestrator during dogfood run 2026-04-22. Discovered while trying to set up event-driven monitoring for 4 parallel codex workers.
