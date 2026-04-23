# cc-codex-team 0.5.5 bug collection

> Compiled during the 0.5.4 → 0.5.5 dogfood/review cycle (2026-04-23).
>
> Sources: 5 reviewer sessions (cli/codex/daemon/format/profile-util, static audit) + 4 dogfood sessions (solo/parallel/review/longhorizon, live use) + orchestrator (Claude) direct observation.
>
> IDs: `OB-*` orchestrator, `DF-*` dogfood, `RV-<mod>-*` reviewer, `FR-*` feature request.
>
> Severity: **P0** = blocker / data-loss / protocol break. **P1** = wrong behavior in normal use. **P2** = polish / docs / smell.

---

## Executive summary

| Bucket | Count |
|---|---:|
| P0 | 3 (OB-1, DF-1, DF-2) |
| P1 | 24 (3 cli + 5 codex + 6 daemon + 2 format + 3 profile-util + 5 dogfood) |
| P2 | 12 |
| Contract drift (docs lie) | 23 items across 8 skill/docs files |
| Test gaps | 23 |
| Feature requests | 4 |

### Hot spots (multiple reviewers converge)

1. **Event contract is partial fiction** — `turn.error` non-terminal (OB-1), `turn.completed.status` enum mismatch (RV-codex drift #4), `token_usage` field names wrong (same), `message send` concise shape mismatch (RV-fmt drift #6). **Every orchestrator parsing the event stream is acting on wrong assumptions.**
2. **Markdown transcript is hollow** — `message tail --format markdown` and `message history --format markdown` render metadata-only wrappers (RV-fmt-2). `session context --format markdown` is rejected outright but docs promise it (6 drift items in format/). The "agent output you plan to reason about" path in the skill invariants is effectively broken in production.
3. **Detach → resume path is broken** — `session attach <name>` doesn't resolve **detached** threads by name (RV-codex-1); only UUID works. Dogfood-longhorizon hit this (DF-5). Quickstart never shows the attach command (DF-5 docs gap). Combined, the "threads persist for future resume" promise is unreachable in the normal happy path.
4. **Crash recovery doesn't match docs** — `listLive()` includes crashed sessions (RV-dm-1) → idle shutdown wedge + status lies; one bad line in `events.log` wipes retention (RV-dm-3); `daemon user destroy` leaks cursors (RV-dm-4); queued sends orphan after crash (RV-codex-5); `mental-model.md` promises auto-resume that requires explicit heal (4 drift items).
5. **Sandbox / isolation** — `acquireForAdhoc()` reuses live-session app-servers (RV-codex-3) breaking the isolation claim; nested codex sessions can't bootstrap codex-team at all under `workspace-write` (DF-1, DF-2), blocking self-hosted multi-agent patterns and the yolo dogfood flow we tried today.
6. **Help / CLI contract drift** — `--full` advertised as global but only 4 flags are global (RV-cli drift #2); `--short` claimed on `daemon config` but rejected (drift #1); `doctor --json` undocumented (drift #4); error codes drift between CLI and daemon (drift #3). 5 drift items in `cli-reference.md` alone.

### Recommended 0.5.5 must-fix shortlist (my proposed scope)

Pick from this list for 0.5.5; push the rest to 0.5.6.

**Protocol / data (P0/P1, must)**
- [ ] **OB-1** — decide `turn.error` semantics (rename / add terminal bit / drop) and fix emission + skill filter recipes.
- [ ] **RV-dm-3** — tolerate torn final line in `events.log`; never wipe retention on a single parse error.
- [ ] **RV-codex-1** — make `session attach <name>` resolve detached threads by name (documented day-2 flow).
- [ ] **RV-dm-1** — split `listLive()` strict vs `listAll()`; fix every callsite. Unblocks idle auto-shutdown.
- [ ] **Event-shape alignment** — reconcile `turn.completed.status` enum and `token_usage` field names between `normalize.ts` and `manage-codex-team/events.md`; same for `message send` concise output (`{status}` vs `{started,...}`).

**Markdown contract (P1, high user impact)**
- [ ] **RV-fmt-2** — either implement real content pulling for `message history/tail --format markdown`, or explicitly retract the contract in skill docs + surface a "metadata-only" notice inside rendered output. Current state lies to consumers.
- [ ] **RV-fmt-1** — decouple `inlineMaxBytes` from `--truncate` so truncation only clips, doesn't reshape.

**Crash recovery & races (P1, infra)**
- [ ] **RV-codex-2** — make `--takeover` two-phase (don't tear down old owner until new taker resumed).
- [ ] **RV-codex-4** — `message interrupt` keeps turn active until terminal event; return "interrupt requested".
- [ ] **RV-codex-5** — `session heal` drains/drops surviving queue.
- [ ] **RV-dm-2** — clean malformed `daemon.pid` from stale-pidfile recovery path.
- [ ] **RV-dm-5** — session new/attach lifecycle gates re-check after awaits; IPC rejects once shutdown begins.
- [ ] **RV-dm-6** — IPC frame validation rejects batch/malformed deterministically.

**Self-hosting (P0 if we want nested codex-team usage to work)**
- [ ] **FR-1** (covers DF-1 + DF-2) — `CODEX_TEAM_DAEMON_SOCK=...` client-only mode + tolerate RO data_dir for pure client calls.
- [ ] **DF-3** — cache "daemon unreachable" verdict in CLI process; short-circuit subsequent `-b` calls with a one-line error.

**Docs / drift cleanup (mostly P1 docs fixes)**
- [ ] Reconcile every `mental-model.md` auto-resume claim with explicit-heal reality.
- [ ] `quickstart.md` gets a "Day 2 — resume" 3-line block with `session detach` → `session attach` → `message send`.
- [ ] `worker-reviewer.md` message-only variant section (DF-4).
- [ ] `cli-reference.md` — fix 5 drift items from RV-cli.
- [ ] `profiles-library.md` parity check with `src/profiles/builtin.ts`; fix `tester` auto_approve (RV-pu-4); fix shell-unsafe `<placeholder>` rendering (RV-pu-1).
- [ ] README.md:213 bump example from `0.5.3` to current.

**Polish (pick a few)**
- [ ] RV-cli-1/2/3 — arg parser edge cases + error code stability + plugin-mode detection (affects every doctor run, we saw it).
- [ ] RV-pu-2/3 — `--cwd` canonicalization + logger stream error handling.

### Decisions needed from you

1. **Event protocol — pick one for OB-1**:
   - (A) rename non-terminal to `turn.retry` / `turn.transient_error`, keep `turn.error` terminal-only
   - (B) add `terminal:bool` field to `turn.error`
   - (C) drop `turn.error` entirely; terminal failure = `turn.completed` with `status="failed"`
2. **Scope cut**: is the recommended shortlist the right size for 0.5.5, or cut further (e.g., ship event/transcript fixes only, push recovery to 0.5.6)?
3. **Re-run dogfood with `--sandbox danger-full-access`?** Today's 4 dogfooders all crashed on the sandbox wall before exercising real flows. If FR-1 lands, we can re-dogfood properly. Otherwise we re-run with danger-full-access and get real flow feedback now (cost: ~same as today).
4. **Will Codex fix these**? Assigning the bug list to Codex for parallel fixing, I suggest: one PR per hot-spot (event, transcript, detach, recovery, self-hosting, CLI/docs). Want me to draft the PR-sized work items?

---

---

## P0 — blockers

### OB-1 — `turn.error` is non-terminal and floods the event stream
- **Observed**: during the 0.5.5 dogfood run, every session emitted `turn.error` 5–20 times within ~90 s while the turn was still `inProgress` (`busy=y, items_done>0, app_server alive`). No corresponding `turn.completed` was emitted for those "errors"; the turns continued and eventually succeeded normally.
- **Event sample**: evt-1960/1961 (dogfood-solo), evt-2030/2031/2035 (review-codex), evt-2032/2034/2037/2082 (review-daemon), evt-2078/2083/2099/2103 (review-cli), evt-2081/2084/2100/2105 (review-format), evt-2058/2080/2085/2101 (review-profile-util) — same event repeating across a short window.
- **Volume**: event_id advanced from ~evt-32 to evt-3000+ in ~90 s across 9 sessions; tight filter (`turn.completed,turn.error,...`) still produced dozens of events per minute.
- **Doc claim broken**: `using-codex-team/SKILL.md` §Core loop and invariant #7 imply `turn.error` is terminal. The event filter recipes in both the skill and the `/codex-team:events` slash command use `turn.error` as a completion signal.
- **Impact**: any orchestrator polling for terminal state on `turn.error` will **healfalse-positive / re-dispatch / cancel** live work.
- **Root-cause guess**: daemon forwards non-terminal app-server error frames (model retry, streaming hiccup, tool partial failure) as `turn.error` without a terminal bit.
- **Fix options** (pick one):
  - A) Rename non-terminal variant to `turn.retry` / `turn.transient_error`, keep `turn.error` terminal.
  - B) Add `terminal: bool` field to `turn.error`; terminal ones also set the turn's final `status=failed`.
  - C) Drop `turn.error` entirely; emit terminal failure via `turn.completed` with `status="failed"`.
- **Skill update required**: every filter recipe currently listing `turn.error` needs revisiting.

### DF-1 — Nested codex sessions cannot bootstrap codex-team (sandbox `socket_bind_denied`)
- **Hit by**: every dogfood session (solo / parallel / review / longhorizon).
- **Evidence** (all 4 reports match):
  ```json
  {"ok":false,"error":{"code":"socket_bind_denied","message":"local socket bind denied by environment (EPERM)","data":{"suggested_action":"codex-team cannot bind a local IPC socket here — run `codex-team doctor` for details","errno":"EPERM","probed_path":"/tmp/codex-team-1000/daemon-probe-22-...sock"}}}
  ```
- **Sequence the dogfooders walked**:
  1. `doctor` reports `data_dir=/home/wzq/.codex-team not writable` AND `socket_bind EPERM`
  2. Override with `CODEX_TEAM_DATA_DIR=/tmp/codex-team-1000` — data_dir resolves, but socket bind still EPERM.
  3. Every subsequent `-b ... daemon user create` / `session new` / `session attach` triggers daemon bootstrap probe → same EPERM.
- **Impact**: codex-team **cannot be used from inside a codex app-server running with `--sandbox workspace-write`** (which is the recommended sandbox!). This blocks self-hosted multi-agent patterns (e.g., a worker using codex-team to spawn its own sub-workers). It also means the supplied **yolo** dogfooding workflow is broken unless the user picks `danger-full-access`.
- **Fix options** (pick ≥1, compose if useful):
  - A) **Client-only mode**: if `~/.codex-team/daemon.sock` exists and is reachable, don't try to bind; just connect. Expose `CODEX_TEAM_DAEMON_SOCK=/path/to/existing.sock` as a first-class override and have CLI skip the bootstrap probe entirely when set.
  - B) **Tolerate read-only `data_dir`**: the CLI currently seems to write client state under data_dir; make it optional (in-memory cursor fallback) for one-shot calls.
  - C) **Document sandbox requirement**: if nested usage requires `danger-full-access`, say so loudly in `using-codex-team/SKILL.md` and in doctor output.
  - D) **`doctor` should detect "sandboxed child" case** and suggest `CODEX_TEAM_DAEMON_SOCK=$HOME/.codex-team/daemon.sock codex-team ...` when a daemon is already running on the host.

### DF-2 — `data_dir_not_writable` triggered even for client-side commands
- **Observed by**: all 4 dogfooders on `doctor` / `daemon user create` / `session new` / `-b` calls.
- **Error**: `{"ok":false,"error":{"code":"data_dir_not_writable","message":"daemon data_dir is not writable: /home/wzq/.codex-team (EROFS)"}}`
- **Why P0**: couples with DF-1. Even if we relaxed DF-1, this one would still block any `-b` call whose cwd is sandboxed away from `$HOME`.
- **Fix**: split "daemon-side data_dir" (writes, needs RW) from "client-side cache" (optional, writable-if-possible). Let the client run with RO data_dir when it's just proxying to an existing daemon.

---

## P1 — wrong behavior / bad UX in hot path

### DF-3 — No fail-fast preflight; every `-b` call re-probes and re-fails identically
- **Observed by**: all 4 dogfood runs. Each burned multiple commands on identical `socket_bind_denied` errors before realizing the whole flow was dead.
- **Fix**: once daemon bootstrap fails with `socket_bind_denied`, cache the verdict for the process-lifetime and subsequent `-b` calls return a shorter "daemon-unreachable" error with the fix hint, instead of re-running the probe.

### DF-4 — `worker-reviewer.md` playbook assumes file-driven flow, omits message-only variant
- **Observed by**: dogfood-review.
- **Quote**: "The playbook never says what the critic should emit if the workflow is prose-only rather than diff/file based. I had to infer my own `approved` vs rewrite-demand contract."
- **Fix**: add a §"Message-only variant" to `worker-reviewer.md` covering (a) how Claude pipes `message tail` output verbatim into the critic, (b) suggested critic verdict vocabulary (`approved` / `needs-rewrite: <reason>`), (c) iteration cap and fallback.

### DF-5 — `quickstart.md` claims "you can attach later" but never shows the attach command
- **Observed by**: dogfood-longhorizon.
- **Quote**: "I could not tell from the quickstart alone whether 'resume later' meant `session attach <name>`, `session attach <thread_id>`, or some other restore flow. The answer exists in `manage-codex-team/SKILL.md`, but not where I first looked."
- **Fix**: add a 3-line "Day 2" block to `quickstart.md` showing `session detach refactor` → later → `session attach refactor` → `message send refactor ...`.

### DF-6 — `CODEX_TEAM_DATA_DIR` not surfaced in quickstart / doctor happy-path
- **Observed by**: dogfood-review, dogfood-longhorizon, dogfood-parallel.
- **Current state**: documented in `configure-codex-team/env-vars.md` only. `doctor` mentions it as a hint on the failure line, but the quickstart assumes the default works.
- **Fix**: quickstart calls out "if `~/.codex-team` isn't writable (sandbox / multi-user hosts), `export CODEX_TEAM_DATA_DIR=/tmp/ct-$USER`".

### OB-2 — Monitor filter recipes ship with the known-broken `turn.error` signal
- Both `using-codex-team/SKILL.md` and `commands/events.md` include `turn.error` in their example `--filter` lists. Until OB-1 is fixed, these recipes are **actively misleading**.
- **Fix**: once OB-1 resolved, revise filter recipes; meanwhile add a note that `turn.error` is non-terminal in 0.5.4 and will change in 0.5.5.

---

## P2 — polish / docs

### DF-7 — `version` reports 0.5.4 while dogfood task framing said 0.5.5
- **Note**: expected — we're developing 0.5.5. But dogfooders flagged it as uncertainty about what build they were testing. Pre-release builds should expose `--pre` / `-dev` in the version string (e.g., `0.5.5-dev`).

### DF-8 — `commands/events.md` references `${CLAUDE_PLUGIN_ROOT}/dist/main.js` but tasks require raw launcher
- **Observed by**: dogfood-solo.
- **Quote**: "that split makes the docs feel like they target Claude plugin runtime first and raw CLI second."
- **Fix**: parameterize or offer both invocation forms.

### DF-9 — Dogfood log template had sections that stayed empty
- **Observed**: dogfood-parallel's log had headers but no body content in "CLI bugs / Missing features / Skill-docs gaps / Confusion points / Overall UX verdict / ONE thing I'd ask for".
- **Note**: this is a dogfooder-prompt issue (too-demanding template) more than a codex-team bug, but flagged for the next dogfood cycle — simplify the deliverable template so agents backfill reliably.

---

## Proposed feature requests (from dogfood)

### FR-1 — Client-only / remote-daemon mode (covers DF-1, DF-2 root cause)
- `CODEX_TEAM_DAEMON_SOCK=/path` skips bootstrap, connects to existing socket.
- `codex-team --client-only <...>` explicit opt-in; errors immediately if daemon absent.

### FR-2 — Daemonless dry-run for formatters / rendering
- `codex-team message tail --dry-run --file fixture.json --format markdown` to inspect envelope rendering without a running daemon.
- Unblocks CI tests and sandboxed dogfooding.

### FR-3 — `session new --prompt "..."` / `session new --prompt-file foo.md` (spawn + send in one call)
- Reduces the 2-step {create, send} fan-out boilerplate by 50 % and removes a race window where you've created a session but can't yet send.

### FR-4 — `doctor --strict` that exits non-zero and refuses to run setup in a sandboxed child
- Preflight gate suitable for CI + prompt front-matter. Matches DF-3 fix intent.

---

## Reviewer findings (updated as reviewers land)

### review-daemon (landed — REVIEW_daemon.md)
**P0**: none (reviewer), but OB-1 turn.error event-spam belongs here in spirit.

**P1**:
- RV-dm-1 — `src/daemon/sessions.ts:126` — `listLive()` returns all tracked sessions including crashed records. Callers (`run.ts:191`, `handlers/daemon.ts:114`, `handlers/status.ts:24`) treat them as live → **idle auto-shutdown never fires** (crashed sessions count as live forever), `status` lies, `daemon user destroy` spuriously demands `--force`. Fix: split into `listLive()` strict vs `listAll()`.
- RV-dm-2 — `src/daemon/run.ts:224+266` — stale-pidfile recovery never cleans up malformed/empty `daemon.pid` because `readPidFile()` returning null skips the unlink branch. Torn pidfile after crash/disk-full → 3s retry loop + hard failure until manual delete.
- RV-dm-3 — `src/daemon/events.ts:355+369-371+761` — **one malformed line in `events.log` erases the entire retained event window on next start** (parse throws, async loader resets to empty). Breaks `--since` / `--cursor` resume even when most of the file is valid. Fix: preserve the valid prefix, tolerate torn final line, trim bad suffix only.
- RV-dm-4 — `src/daemon/handlers/daemon.ts:151` — `daemon:user:destroy` clears sessions + events but never calls `CursorStore.clearUser()`. Destroy→recreate same token in same daemon surfaces stale cursors from memory; pending debounced flushes can recreate `cursors.json` after deletion.
- RV-dm-5 — `src/daemon/handlers/session.ts:56` + `handlers/daemon.ts:108` + `shutdown.ts:11` + `server.ts:59` — `session new` / `session attach` validate user ownership **before** awaited RPCs but concurrent `daemon user destroy` / shutdown can race → resurrected live state under deleted/exiting daemon. Fix: lifecycle gates, recheck after awaits, reject IPC once shutdown begins.
- RV-dm-6 — `src/ipc/sock.ts:24` + `server.ts:28-32` — malformed JSON / batched arrays / wrong-shape frames silently ignored → "hung request" on the client. Fix: validate top-level frame, reject arrays/unknown kinds deterministically with structured error.

**P2**:
- RV-dm-7 — `src/ipc/protocol.ts:22` — `stream_start` declared in IPC surface but `server.ts:63-80` never emits it → dead protocol surface.
- RV-dm-8 — `src/daemon/cursors.ts:343+401-421` — malformed `.lock` file unreclaimable: `readCursorLock()` returns null; `reclaimStaleCursorLock()` only unlinks syntactically valid stale locks → cursor saves hit repeated 2s timeouts.

**Contract drift** (crash-recovery claims vs. reality):
- `using-codex-team/mental-model.md:34` says app-server death auto `thread/resume` → `wire.ts:241-279` marks crashed, cancels pending, requires explicit `session heal`.
- `using-codex-team/mental-model.md:50` says live bindings are "lazy re-spawn on next interactive command" → `handlers/message.ts:646-652` rejects unhealthy sessions; `handlers/session.ts:517-573` demands explicit `session heal`.
- `recover-codex-team/SKILL.md:19` says restart synthesizes `session.pending_dropped` when pending requests existed → `sessions.ts:14-23` + `run.ts:138-151` no longer persist counters needed to synthesize after full restart.
- `recover-codex-team/SKILL.md:21` + `recover-codex-team/known-quirks.md:101` say orphan reaping verifies `pid + start_time + nonce` → `orphans.ts:191-200` never consults nonce.

**Test gaps**:
- `daemon-run-platform.test.ts`: no malformed/empty `daemon.pid` recovery.
- `daemon-user-destroy.test.ts` + `monitor-cursor.test.ts`: no cursor-cleanup / pending-flush / re-create-after-destroy coverage.
- `events.test.ts` + `monitor-cursor.test.ts`: no restart/load coverage for truncated `events.log` / malformed `cursors.json.lock`.
- `server.test.ts` + `ipc-sock.test.ts`: no explicit invalid/batch frame rejection; no duplicate streaming request-id reuse; no wrong-shaped id handling.
- `session-handlers.test.ts` + `shutdown.test.ts`: no concurrent session-new/attach vs user-destroy / daemon-shutdown race.

### review-cli (landed — REVIEW_cli.md)
**P0**: none.

**P1**:
- RV-cli-1 — `src/cli/args.ts:139` — global-flag value parsing accepts the next flag token as the value. `codex-team -b --help status` silently changes routing instead of `invalid_params`. Fix: reject flag-like follow-ons for required-value globals.
- RV-cli-2 — `src/cli/run.ts:115` — invalid approval shortcut emits `invalid_params`+exit 2, but skill docs and daemon handler contract say `invalid_decision`. Machine callers can't depend on a stable code.
- RV-cli-3 — `src/cli/doctor.ts:462` — plugin-mode launcher detection assumes `${CLAUDE_PLUGIN_ROOT}/plugins/codex-team/...` but shipped launcher resolves `${CLAUDE_PLUGIN_ROOT}` as plugin root directly → `doctor` falsely reports "not on PATH" / DEGRADED. (This is what we saw in the preflight today!)

**P2**:
- RV-cli-4 — `src/cli/run.ts:149` — `version --full` is advertised by help but `runVersion()` ignores the flag.
- RV-cli-5 — `src/cli/doctor.ts:340` — `doctor --json` wraps success as `{ok:true, data:{...}}` while rest of CLI returns body directly → inconsistent parser target.
- RV-cli-6 — `bin/codex-team:14` — launcher only checks `dist/main.js` exists; doesn't preflight node version or stale dist (doctor does, launcher doesn't).

**Contract drift** (docs claim → code does):
- `cli-reference.md:13` claims `--short` on `daemon config list/get` → code rejects it (`args.ts:270`, `run.ts:71`).
- `cli-reference.md:29` calls `--full` a global flag → only `bearer/verbose/help/daemonSock` are global (`args.ts:82`); `doctor` rejects `--full`.
- `cli-reference.md:298` promises `invalid_decision` for bad approval shortcut → code emits `invalid_params`.
- `cli-reference.md:42` lists `doctor [--short]` only → code also accepts undocumented `--json` with different envelope.
- `quickstart.md:74` uses `node "${CLAUDE_PLUGIN_ROOT}/dist/main.js"` for raw invocation → `doctor.ts:462` only recognises plugin mode via the `plugins/codex-team/bin/` layout.

**Test gaps**:
- `paths-and-args.test.ts`: no case for `-b`/`--daemon-sock` followed by another flag token.
- `cli-run.test.ts`: invalid-approval-shortcut test checks message/exit but not error code → drift invisible.
- `cli-run.test.ts` / `paths-and-args.test.ts`: no coverage for `daemon nope` / `session nope`-style unknown subcommands.
- `doctor.test.ts`: plugin-mode only tests parent-directory layout, not direct-plugin-root layout.
- `help.test.ts`: doesn't enumerate every leaf for USAGE/EXAMPLES presence or validate advertised `--full` honoring.
- No suite exercises `bin/codex-team` for missing node / old node / stale dist.

### review-codex (landed — REVIEW_codex.md)
**P0**: none.

**P1**:
- RV-codex-1 — `src/daemon/handlers/session.ts:145` — `session attach <name>` never resolves **detached** threads by name; only live or UUID paths work. Breaks day-to-day detach/resume (returns `session_not_found`). **Fix**: before failing, resolve detached by name via existing `findDetachedThreadByName`/`threadRead` helpers. **This matches DF-5 dogfood finding from a different angle** — the skill is correct, the code is wrong.
- RV-codex-2 — `src/daemon/handlers/session.ts:142` — `--takeover` tears down original owner **before** new taker has successfully resumed. A transient `threadResume` failure = nobody attached, approvals already cancelled, old owner already saw `session.seized`. **Fix**: two-phase — only cancel old binding after new resume confirmed, else restore.
- RV-codex-3 — `src/codex/pool.ts:166` — `acquireForAdhoc()` reuses app-servers that already host live sessions → adhoc reads (`thread/list`, `thread/read`, detached-name discovery) contend with running worker turns. **Directly contradicts the "live sessions are isolated" claim in using-codex-team/mental-model.md.** Fix: exclude bound-session clients from adhoc pool, or split into two pools.
- RV-codex-4 — `src/daemon/handlers/message.ts:103` — `message interrupt` clears `currentTurnId` and returns `interrupted:true` **before** the terminal event arrives. Subsequent `message send` races with the winding-down turn → `turn/start` failures and false operator feedback. **Fix**: keep turn active until `turn/completed` observed; return "interrupt requested" until confirmed.
- RV-codex-5 — `src/daemon/wire.ts:276` — queued sends survive an app-server crash but `session heal` doesn't drain/drop them → prompts stuck forever. **Fix**: emit/drop queued items on crash, or have `sessionHeal` kick a drain when resumed session has no active turn.

**P2**:
- RV-codex-6 — `src/daemon/wire.ts:146` — `thread.closed` surfaces as `session.closed reason=user_detach` → operators can't distinguish permanent thread close from explicit detach. Fix: add `reason="thread_closed"`.
- RV-codex-7 — `src/daemon/handlers/message.ts:601` — `message wait` still treats `turn.interrupted` as terminal, but `normalize.ts` only emits `turn/completed` as terminal → dead branches + confused interrupt semantics.

**Contract drift**:
- `using-codex-team/SKILL.md:50` + `manage-codex-team/SKILL.md:89` say attach takes `name|thread_id` → code only resolves detached by `thread_id` (RV-codex-1 above).
- `using-codex-team/mental-model.md:34` says app-server death auto-resumes → code marks `crashed` and requires explicit `session heal` (`wire.ts:241` vs `handlers/session.ts:517`).
- `using-codex-team/mental-model.md:18` + `recover-codex-team/known-quirks.md:73` + `configure-codex-team/config-keys.md:30` claim live sessions isolated and `max_sessions_per_process` only affects adhoc → but `pool.ts:166` reuses live-session clients (RV-codex-3).
- `manage-codex-team/events.md:29` claims `turn.completed.status` ∈ {`failed|interrupted|cancelled`} and `token_usage={input,cached_input,output,reasoning_output,total}` → `normalize.ts:130` emits {`completed|errored|cancelled`} and {`prompt,completion,total`}. **Event-shape drift — orchestrators parsing status/usage fields break.**

**Test gaps**:
- `session-handlers.test.ts`: no regression for `session attach <detached-name>` via thread discovery.
- `session-handlers.test.ts`: no rollback case where `--takeover` fails after old owner seized.
- `pool.test.ts`: no case proving `acquireForAdhoc()` doesn't reuse live-session clients.
- `message-handlers.test.ts` + `wire.test.ts`: no interrupt-race case (send after interrupt ACK but before terminal event).
- `wire.test.ts` + `session-heal.test.ts`: no crash+heal coverage for queued prompts.

### review-format (landed — REVIEW_format.md)
**P0**: none (but RV-fmt-2 below is arguably user-visible-P0).

**P1**:
- RV-fmt-1 — `src/format/markdown.ts:345` — `createRenderContext()` shrinks `inlineMaxBytes` to match `--truncate`. So `--truncate 80` flips `<user-input>`, `<reasoning>`, JSON sub-tags between inline and block forms — truncation is supposed to *clip content*, not restructure. Fix: pin `inlineMaxBytes` to `INLINE_MAX_BYTES`; use the flag only for `truncateBytes`.
- RV-fmt-2 — `src/daemon/handlers/message.ts:214` — **`message history --format markdown` and `message tail --format markdown` render `thread/turns/list` output as if it had turn items, but that RPC only returns metadata**. Production markdown transcript = mostly empty `<turn>` wrappers, no user/assistant text, no shell output, no file patches, no tool summaries. **This is the main "read-back a turn" path and it's hollowed out.** Fix: either reconstruct items from a real source, or downgrade the markdown contract to metadata-only and say so inline.

**P2**:
- RV-fmt-3 — `src/format/markdown.ts:71` — `renderContext()` + the `context` snapshot fixtures model a `session context` markdown view that no CLI path can emit → dead renderer giving false confidence that `session context --format markdown` works.

**Contract drift** (significant — the markdown contract is substantially fiction):
- `cli-reference.md:19,133-134` says `session context` accepts `--format markdown` → `handlers/session.ts:357-360` only accepts json.
- `using-codex-team/SKILL.md:134` claims all three (`session context` / `message history` / `message tail`) return tag-structured markdown → rejected on `session context`, and history/tail only have metadata.
- `docs/html-md-format.md:17-19,70-76,125-190` describes transcript-style history/tail with context-only tags (`<system>`, `<developer>`, `<compacted>`) → `recover-codex-team/known-quirks.md:11-21` already admits those RPCs don't return past items, AND the renderer at `markdown.ts:71` is unused.
- `docs/html-md-format.md:92-110` says `tool.*` carries `args` in attrs and doesn't list `auto-approval-review`, `mcp-args`, `mcp-result`, `hook-output` → `markdown.ts:420-492` emits those tags and the fixtures snapshot them.
- `quickstart.md:113` claims CLI response has a `markdown` field → `cli/run.ts:219-221,371-375` strips wrapper and prints raw markdown.
- `cli-reference.md:176` + `manage-codex-team/SKILL.md:116` say concise `message send` is `{started, turn_id, queue_id, queued_depth}` → `format/compact.ts:335-347` emits `{status:"started"|"queued", ...}`. **We saw this exact shape today when firing prompts.**

**Test gaps**:
- `status-and-format.test.ts`: no case where `truncate < INLINE_MAX_BYTES` must not change inline/block rendering.
- `message-handlers.test.ts` / `cli-run.test.ts`: no production-shaped markdown history/tail case where `threadTurnsList()` returns turns without `items` → current transcript failure is invisible.
- `markdown-snapshot.test.ts`: snapshots unreachable `context` renderer instead of asserting the real `session context --format markdown` rejection path.

**Notes**: focused suites pass — failures are contract/coverage gaps, not red tests. No JSON/NDJSON emitter issue found in this scope.

### review-profile-util (landed — REVIEW_profile-util.md)
**P0**: none.

**P1**:
- RV-pu-1 — `src/profiles/builtin.ts:74` — `profiles show` advertises a "copy-ready" command but renders literal `<name>` / `<repo>` placeholders → **shells treat `<` as redirection**. Copying verbatim fails. Fix: use shell-safe placeholders (`SESSION_NAME`, quoted `"/abs/path/to/repo"`) and add a shell-parse test.
- RV-pu-2 — `src/daemon/handlers/session.ts:680` + `src/cli/run.ts:804` — relative `--cwd` resolved against **daemon process cwd**, not caller's cwd. CLI preflight validates raw relative path caller-side. When daemon runs from a different dir, `session new --cwd ../repo` validates but resolves wrong. Fix: canonicalize to absolute in CLI before dispatch.
- RV-pu-3 — `src/logger.ts:19` — long-lived append stream has **no `'error'` handler and no reopen strategy**. Bad log destination can crash daemon; rename-based rotation strands writes on old inode. Fix: attach stream error handler with stderr fallback + reopen on rotation.

**P2**:
- RV-pu-4 — `src/profiles/builtin.ts:53` — bundled `tester` profile's `auto_approve` omits `npm run test*` even though skill lib documents it.

**Contract drift**:
- `configure-codex-team/profiles.md:23` says `--profile` works on `session attach` → code ignores it (`handlers/session.ts:115`) and help doesn't advertise it.
- `profiles-library.md:5` promises ready-to-copy command → shell-active `<...>` placeholders break paste.
- `profiles-library.md:70` lists `npm run test*` in `tester` → builtin omits it.
- `recover-codex-team/known-quirks.md:89` claims `daemon logs --follow` survives rename-based rotation → `logger.ts:19` keeps writing to old fd, never reopens.

**Test gaps**:
- `profiles.test.ts`: no shell-safety/executability check for rendered `profiles show --short` command; no parity assertion between builtin profiles and `profiles-library.md`.
- `cli-cwd-preflight.test.ts` + `session-cwd-preflight.test.ts`: no case where daemon cwd differs from caller cwd; no symlink / space-containing `--cwd` cases.
- `logger.test.ts` + `daemon-handlers-more.test.ts`: no `WriteStream` error-event + rename-rotation coverage.
- No suite exercises `session attach --profile ...` → documented silent no-op easy to miss.

**Notes**:
- 134 focused tests passed locally during audit.
- `src/version.ts` is a good SSOT wrapper (no issues).
- README.md:213 bump example still says `0.5.3` (out of date).
