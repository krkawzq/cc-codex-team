# codex-team 0.5.1 dogfood pain points

Collected by Claude orchestrator during the 2026-04-22 dogfood run that took the project from 0.5.0 rewrite → 0.5.1 release via 10 parallel codex sessions doing audit/fix/review/merge/docs. This document is a consolidated, honest list of UX frictions, missing affordances, and surprise behaviors encountered in the field — meant to drive the next optimization cycle.

## Summary of what the dogfood run did

- Spawned 10 codex sessions across 7 git worktrees (4 audit/fix + 1 help implementer + 1 monitor bug fixer + 2 post-merge bug fixers + 1 merge-resolver + 1 docs-updater).
- Produced ~40 commits on an `integration` branch; merged to `main` at `9f34b1e` as 0.5.1.
- Resolved ~5 blockers, ~16 majors, ~5 nits across code + tests.
- 5 separate bug documents authored mid-run (now superseded by this consolidated doc).

## A. CLI output / format

### A.1 `--format markdown` was wrapped in JSON envelope (fixed in this release)

`message tail --format markdown` used to return `{ok, data: {markdown: "..."}}` on stdout, forcing callers to `jq -r '.data.markdown'`. Fixed in fix-format-markdown: stdout now emits raw tagged markdown per `docs/html-md-format.md`. Error path still returns JSON envelope (exit 1). Still room for:

- Streaming variant (`message tail --follow --format markdown`) — sanity check the new chunk emission behaves well under fast turn sequences.
- `session list --format markdown` (future) — currently only json/table.
- Consider a short cli doc line under `--format` explaining the stdout contract (raw markdown vs JSON envelope) — rediscovery cost is real.

### A.2 Item body was raw JSON instead of rendered markdown (fixed)

`renderItem` used to pretty-print the item's JSON into the tag body, which was fact-of-life unreadable. Fixed in fix-format-markdown with per-type renderers (userMessage inline, agentMessage block, commandExecution → nested `<shell>`, fileChange → `<file-patch>`). Worth auditing going forward:

- Add renderer for `mcpToolCall` / `hook.*` / `autoApprovalReview` item types. Currently fallback to inline.
- Length-bound the inline `text` attr — a 50KB user message should NOT inline.
- `<reasoning>` rendering: currently inline; consider block for long chains.

### A.3 Event stream is extremely verbose

Every codex item generates ~4 events: `item.started` (reasoning) / `item.completed` / `item.started` (agentMessage) / `item.completed`, plus `turn.token_usage_updated`, `account.rate_limits_updated`, `turn.diff.updated` (for file ops), etc. A single 10-minute codex turn can emit 100+ events.

- Monitor tool (external) hit rate limits on verbose streams; I had to switch to `--since cursor` polling as a workaround.
- Need a daemon-side "digest mode" subscription: one event per item (not per phase), and suppress the token_usage / rate_limits for most callers.
- `--filter` works but takes a CSV of every type you want; inverted match (`--exclude item.*`) is not enough — want semantic flags like `--summary` (= `turn.{started,completed,error} + approval.* + user_input.request + thread.closed + session.seized`).
- `turn.completed` payload includes the entire `turn` object with items — bloating the event to multi-KB when the only new info is `{turn_id, status, duration_ms}`. Consider a "lite" projection by default; the detailed view is available via `message tail`.

### A.4 JSON output is deeply nested

Default `{ok:true, data:{session:{...},...}}` is fine for scripts but rough for human spotting. Useful additions:

- `--quiet` or `--short`: print only the primary id/value. E.g. `session new --short` prints just the session name on stdout.
- `--yaml` or `--indent=2` option.
- Status command that prints a compact one-line summary: `user=X live=3 pending=1 retained=10000/10000 app_servers=2`.

### A.5 Tag markdown doesn't scale to nested content well

`<turn>` containing many `<item>` tags, each possibly containing `<shell>` or `<file-patch>`, quickly becomes huge. Dogfood output hit ~35KB for a single turn. Mitigations worth exploring:

- Default `message tail -n N` to emit `turn.summary` inline form for older turns, full-expand only the newest turn.
- `--truncate <bytes>` flag per item body.
- Section header delimiters so agents parsing the text can chunk safely.

## B. Session lifecycle & health

### B.1 No per-session health / progress endpoint

When 4 codex sessions ran in parallel, I had no single call to ask "where are they all at". I resorted to:

```
status                      # user-wide
session info <name>         # per-session metadata, no live state
monitor events --since evt  # parse by hand
git log worktree branch     # external evidence
```

Desired:

- `session health <name>` returning `{current_turn_id, elapsed_ms, current_item_type, items_done_in_turn, total_tokens, busy: bool, pending_requests: N}`.
- `session watch <name>` (blocking) — print status line once per second until turn.completed.
- Sessions list with a `busy|idle` indicator.

### B.2 No "wait for this turn to finish" helper

After `message send`, I had to poll `message history` or watch `monitor events --filter turn.completed --session X`. A blocking helper:

```
codex-team -b $TOK message wait <session> [--for <turn_id>] [--timeout <s>]
# exits 0 on completion, 1 on turn.error, 124 on timeout
```

Would collapse ~5 lines of polling glue per test script.

### B.3 Session recovery after app-server crash was unclear

During this run my daemon process died (root cause unknown — possibly a startup-conflict between running daemon and a throwaway daemon I spawned for smoke testing) and all 9 live sessions simultaneously got `turn.error: app-server process exited unexpectedly`. The threads still exist on codex (persistent), but:

- No `session heal <name>` to force-re-attach after a crash. I had to start my troubleshooting from scratch.
- Dead sessions stayed in the registry with `state: live` even though their app-servers were gone — misleading.
- Pending approvals tied to dead sessions were orphaned (can't reply, can't cancel).

Desired lifecycle fix:
- On `client_close`, if session is registered: automatic detach + emit `session.crashed` event + offer `session attach` suggestion.
- `session attach <thread_id> --force-resume` flag for broken sessions.

### B.4 No "read-only session" mode for inspection

All my test sessions had to be real codex sessions (consuming tokens + bandwidth) even when I just wanted to ping the plumbing. A "fake session" / "null backend" mode for integration tests would help.

## C. Approvals / YOLO

### C.1 `acceptForSession` is not as session-wide as the name suggests

Name implies "approve this command pattern for the rest of the session". Reality: approvals seem scoped to the exact command string. I had to approve `git commit -m "msg1"` then `git commit -m "msg2"` as separate prompts.

- Fix: document exact scope. Likely fix is codex-side, but expose a codex-team-side `session auto-approve <cmd-pattern>` knob.

### C.2 No middle ground between `on-request` and `never`

- `--approval never` = YOLO (dangerous — no safety net)
- `--approval on-request` = every codex exec needs my decision

I wrote an auto-approver script `/tmp/cct-auto-approve.sh` that polled every 3s and accepted everything. This should be first-class:

- `codex-team daemon config set session.auto_approve_command_patterns "git,npm,node,sh -c cat"` — daemon auto-responds internally without bothering the caller.
- Or per-session: `session new X --auto-approve git,npm`.
- Audit log: every auto-approval writes a compact `auto_approved` event to the log so it's not silent.

### C.3 `message approval` shortcut validity per-kind is now documented but initially surprising

Shortcuts don't all apply to all kinds:
- `approval.permissions` rejects `cancel` — must use `decline`
- `approval.mcp_elicitation` rejects `accept-session`, form mode needs `--json`

R4 help fix added warnings in `message approval --help`. Good. Still worth:
- Consider rejecting unknown-kind shortcut at CLI before round-tripping to daemon (lower latency on user-error).

### C.4 Sandbox denied git-worktree metadata writes for one session

audit-async could not `git commit` because worktree's `.git` file points to shared metadata outside the cwd sandbox. Workaround: manual commit by orchestrator. Root cause is codex's sandbox, not codex-team's. Options:

- Document in skills: "if committing fails with sandbox denial, use `danger-full-access` or fall back to manual commit".
- codex-team could detect the worktree pattern and pre-expand sandbox write-list for `.git/worktrees/<name>/` paths — but that's intrusive.

## D. Monitor / event streaming

### D.1 `monitor events --stream --filter X` premature exit (fixed)

When source was newer than dist/main.js, the stale compiled bundle still had the old "stream.end after handler" behavior. Fixed by fix-monitor rebuild + regression test. But:

- Should there be a build-timestamp sanity check on daemon startup? "dist was built from commit X; source is now at Y; rebuild?"
- Add a CI gate that fails if dist/main.js is older than its source.

### D.2 Monitor tool (external) auto-kills on high event rate

Hit by Claude's Monitor tool — large events per line exceeded its throttle. Hard to debug (silent "stream ended"). Mitigations from codex-team side:

- Default event payloads should be compact (see A.3).
- Add an explicit `monitor events --summary` mode that emits one short line per event `<id> <type> <session> <key_field>` — specifically optimized for toolchains with line-rate caps.

### D.3 No graceful back-pressure signal for streaming subscribers

If the daemon's stream queue overflows (>1 MiB / 1024 frames), it closes the stream with an `internal` error. Subscriber sees a JSON error line and exits 1. Desired:

- Graceful backpressure: `stream_pause` / `stream_resume` signals so subscribers can breathe.
- Or a dedicated overflow event: `monitor.overflow` (already added in async M3).

## E. Approval / askUserQuestion

### E.1 askUserQuestion was silently unavailable (fixed in 0.5.1)

codex gates the experimental `askUserQuestion` tool behind feature flag `default_mode_request_user_input`. codex-team 0.5.0 had no knob to enable it. 0.5.1 adds `session new --experimental-tools ask-user-question` (plus aliases). Follow-up:

- Verify end-to-end: create a session with the flag, prompt for askUserQuestion, observe `user_input.request` event, respond via `message answer`.
- Document the known experimental tool IDs in `configure-codex-team/cli-reference.md` (currently only lists the flag, not the IDs it accepts).
- Daemon-level default: `codex-team daemon config set experimental.default_tools ask-user-question` so new sessions auto-include it.

## F. Orchestration / multi-session patterns

### F.1 Git worktree + codex session setup is manual

Each spawn:
```bash
git worktree add -b <branch> /path <base>
codex-team session new NAME --cwd /path --model --sandbox --approval --effort
```

In practice: 4 sessions × 2 commands = 8 invocations, each parameterized similarly. Desired:

- `codex-team workspace spawn <role> --base <branch>` that runs both steps.
- Or playbook runner: `codex-team playbook run map-reduce --inputs a,b,c` spins up the N workers per the playbook template.
- Profile-based defaults: `codex-team session new X --profile fixer` pulls sandbox+approval+effort from `~/.codex-team/profiles.toml`.

### F.2 Peer review loop (R3) was manual

For each pair of workers I had to:
1. Generate `peer's-branch.patch` file in reviewer's worktree
2. Copy peer's AUDIT_*.md over
3. Write a review prompt with embedded context
4. Send to reviewer
5. Parse review verdict, decide iterate or not
6. Author R4 prompt if iterating

Desired: a playbook runner that takes a Graph (who reviews whom) and handles this transparently.

### F.3 Merge conflicts across N branches are unavoidable with overlapping scope

audit-multi + audit-edge both edited `monitor.ts`, `orphans.ts`, `run.ts`. audit-async rewrote `wire.ts` 79% while audit-edge added B2/B3 hooks to the same file. The merge-resolver codex session burned 5.8M tokens over 26 minutes without actually committing — it edited out the conflict markers but stopped short of `git add`.

Desired:
- Prevent: a workspace-lock manager that assigns "primary owner" per file at spawn time, so conflicts only happen on intended shared files.
- Resolve: codex-team could ship a structured merge helper that uses per-finding diffs (lift out hunks by commit message tag) instead of raw 3-way merge.
- Fallback: orchestrator takes over more aggressively — when session exceeds N tokens/M minutes on the same turn, interrupt + hand-resume.

### F.4 Session death cascade is destructive

One daemon death killed 9 active sessions. That includes:
- In-flight turns (some mid-reasoning, some mid-edit)
- Pending approvals
- Uncommitted worktree state (fix-askq's 14-file work was NOT lost because it was on disk, but any cognition state in codex was)

Mitigations:
- Persistent "pending request" recovery on daemon restart: read `pending.json`, reconnect or emit cancellation.
- Periodic commit nag: codex-team could suggest "it's been N minutes since last commit; consider saving state".
- Out-of-band: run daemon under a supervisor (systemd, pm2) so it restarts automatically.

### F.5 No session.shutdown_reason event

When daemon auto-shut-downs or a session's app-server dies, the CLI just sees a `turn.error` with `app-server process exited unexpectedly`. No distinction between:
- OS killed the process (OOM)
- Parent daemon shut down
- Session was explicitly destroyed
- codex itself crashed

Useful: emit `session.closed` with a `reason` field (`"daemon_shutdown"`, `"app_server_crashed"`, `"idle_unload"`, `"user_destroyed"`, ...).

## G. Build / release / dist

### G.1 dist/main.js was stale (fixed in 0.5.1)

Discovered by fix-monitor: the committed `dist/main.js` on `dogfood-base` didn't match the current source. Rebuilding made the monitor filter bug go away. Prevention:

- Pre-commit hook: `npm run build` if source under `plugins/codex-team/src/` changed but dist didn't get refreshed.
- CI gate.
- `daemon status` could include a `dist_age_seconds` field derived from file mtime.

### G.2 Version string in 3 places

`package.json`, `.claude-plugin/plugin.json`, `src/codex/appServerClient.ts` (clientInfo default). Easy to forget one.

- Script: `scripts/bump-version.sh <new-version>` that updates all three + rebuilds dist.
- Or SSOT: read version from package.json at runtime.

### G.3 Daemon startup can be silent

`--daemon-internal` spawn is detached with `stdio: "ignore"`. If startup fails (e.g., pidfile conflict, sock permission error), CLI only sees `daemon_unreachable`. Stderr goes nowhere.

- Add `--daemon-internal --stderr-to <path>` for debug-spawn.
- CLI's `ensureDaemon` could do a short `daemon status` probe after spawn + report the daemon log path if still unreachable.

### G.4 `daemon restart` restarts but doesn't hot-reload

If I update `src/` + `npm run build`, existing daemon still runs old code. `daemon restart` spawns new daemon but kills all sessions (via app-server shutdown). No graceful handoff.

- Daemon could be built to persist session state (partially done), drain to new process on SIGHUP.

## H. Documentation mismatches

### H.1 `html-md-format.md` existed but renderer didn't match the spec (fixed)

Classic "spec-drift-from-impl". The spec is explicit about inline vs block form, per-type body semantics. Renderer predates this detail. Fixed in fix-format-markdown. Future-proofing:

- Snapshot tests: render a canonical set of item fixtures and compare against `.expected.md` files.
- Doc cross-check during code review: any PR changing renderer MUST reference `docs/html-md-format.md` in commit message.

### H.2 Skills had stale invariants

docs-updater had to sync skills/ with code. Several items had drifted:
- "Daemon auto-shuts down after 6h idle" — actually "live session counts as activity"
- Missing `turn.queued_failed` / `monitor.overflow` / warning kinds
- `session detach --graceful` semantics docs were wrong (not actually waiting for turn completion before teardown in original code)

Dealing with drift:
- Generate parts of the docs from code: events list from normalize.ts map, config keys from config.ts spec, flag list from cli/args.ts + help schema.
- Or: regular `npm run docs:check` that flags known-diverging patterns.

## I. Orchestrator ergonomics (Claude-side)

These are about driving codex-team as an outer agent, not codex-team bugs per se — but documenting them here because they shape what codex-team should expose.

### I.1 Auto-approve required a custom shell script

I had to write `/tmp/cct-auto-approve.sh` — a polling loop that read `monitor events`, parsed approval request_ids, and called `message approval`. This should be first-class.

### I.2 Event polling via `--since <cursor>` is fiddly

Cursor management across loop iterations is error-prone (my Monitor tool version lost cursor state on restart). Cursor semantics should be publishable:

- `codex-team cursor save <name>` / `codex-team cursor restore <name>` — daemon-maintained cursors.
- Or: `monitor events --cursor-file /tmp/cursor.log --update-cursor` auto-updates a persistent cursor.

### I.3 Cannot easily test multi-session scenarios programmatically

No spy/mock framework for "codex responds this" scenarios from the orchestrator side. I had to use real codex, real tokens, real latency to validate anything.

- Fake codex backend: `codex-team daemon --mock-codex` returns canned responses for testing integration.
- Record-and-replay: capture real codex I/O from a session, replay for regression.

## J. Run-level observations

### J.1 Total token spend was substantial

Rough estimate: 10 sessions × 5–30 min × gpt-5.4 xhigh. The merge-resolver alone used ~5.8M tokens. A single audit round used ~50K tokens. Multi-session fanout is powerful but expensive — tooling should help decide whether to fan out or serialize.

- Cost-estimator command: `codex-team estimate <playbook> <inputs>` returns a ballpark.
- Per-session budget: `session new X --token-budget 500000` → daemon interrupts at budget exhaustion.

### J.2 Failure modes cascade invisibly

When my 17:36 daemon died, I didn't realize until minutes later via a grep match. A "the sky is falling" event would help:

- `daemon.health.degraded` event when N in-flight turns suddenly all error
- Auto-detect mass failure + stop auto-approver from accepting anything new until orchestrator confirms

### J.3 No dry-run for mutating commands

- `session new --dry-run` could print the `thread/start` params it'd send without actually creating anything.
- `session detach --dry-run` could list what will be torn down.

## K. Ranked shortlist for 0.6.x roadmap

If I had to pick 10 items, ordered by orchestrator-pain-relief:

1. **`session health <name>` + `message wait <name>`** (B.1, B.2) — remove the polling glue
2. **`--summary` mode for `monitor events`** (A.3, D.2) — one line per event, compact
3. **Built-in auto-approve config** (C.2, I.1) — kills the biggest orchestration chore
4. **Semantic `turn.completed` payload** (A.3) — strip the embedded turn object
5. **Session.crashed event + `session heal`** (B.3, F.4) — recover gracefully from daemon/app-server death
6. **Playbook runner** (F.1, F.2) — make multi-session orchestration declarative
7. **`--format markdown` snapshot tests** (H.1) — prevent renderer regressions
8. **Single-source version + dist-staleness check** (G.1, G.2) — remove release footguns
9. **Persistent cursor for event streams** (I.2) — orchestrator-friendly tailing
10. **Mock codex backend** (I.3) — enable meaningful integration tests

## Appendix: bugs already fixed in 0.5.1

- `BUG_MONITOR_FILTER.md` — fix-monitor commit `098adc1`
- `BUG_FORMAT_MARKDOWN_ENVELOPE.md` — fix-format commits `7acb276` `d798cec` `f782255`
- `BUG_ASKUSERQUESTION_NO_TOGGLE.md` — fix-experimental-tools commit `921f3da`
- `BUG_SANDBOX_WORKTREE_GIT.md` — documented, deferred (codex-side limitation)
- `BUG_DAEMON_PREMATURE_EXIT.md` — superseded; was actually timeout-too-short, not a real bug

## Appendix: known follow-ups flagged during peer review

- audit-async D1 (reviewed by audit-help): `message approval` / `message answer` now await stdin drain + warning-event persistence → slight latency regression for callers. Consider emitting warning events asynchronously.
- audit-edge O3 (reviewed by audit-multi): Windows `$HOME`-rooted daemons from legacy installs won't be seen by the new `os.homedir()` path after 0.5.1 upgrade. One-time migration probe or release-note mention recommended.
- `17:36 daemon death post-mortem` — my running daemon died during isolated smoke-test of a throwaway daemon in a separate data_dir. Still unexplained; orphan reaper or PID conflict suspect. Worth investigating.
