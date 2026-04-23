# cc-codex-team 0.5.5 dogfood round-2 findings

> Round-2 run after the 6-WS fix cycle landed. Sandbox: `danger-full-access`. Daemon: 0.5.5 dist live.
>
> Purpose: verify round-1 fixes actually stick + hunt regressions.

---

## Headline verdict

**The fixes landed and the product works** — all 4 dogfood shapes completed their tasks. Round-1's P0 blocker (sandbox wall) is gone. BUT round-2 surfaced **1 new P0** (bearer-token isolation break) and extended the scope of **WS3's attach-by-name fix** (only `session attach` was patched; 5-6 other commands still have the old behavior).

### Round-1 fixes validated (all 4 dogfooders)

| Fix | Evidence |
|---|---|
| OB-1 `turn.error` dropped; terminal via `turn.completed{status}` | No `turn.error` spam in 4 dogfood runs. Events.md + commands/events.md updated. `message wait` returned `{"outcome":"completed"...}` cleanly. |
| DF-1 self-hosting (nested codex-team usage) | All 4 dogfooders completed `daemon user create` + `session new` + full workflow with no `socket_bind_denied`. `danger-full-access` sandbox let them operate; `CODEX_TEAM_DAEMON_SOCK` available but not exercised (that's a `workspace-write` + client-only test — see 0.5.6 todo). |
| RV-fmt-2 real markdown transcript | All 4 dogfooders confirmed `message tail --format markdown` renders real `<message>` items. Parallel also validated `message history --format markdown`. |
| RV-codex-1 attach-by-name for detached threads | longhorizon + review + parallel ALL confirmed `session attach <name>` works after `session detach <name>` — same thread_id preserved, worker memory intact. |
| WS3 worker-reviewer message-only variant (DF-4) | review ran a 3-round critic loop against the documented pattern; the new §Message-only variant covered it. |

### New round-2 blockers found

**🔴 P0 must-fix before shipping 0.5.5**:
- R2-L3 — `session list --all` leaks detached threads **across bearer tokens** (isolation break, potential privacy concern)

**🟡 P1 should-fix before shipping** (same-day trivial extensions of existing fixes):
- R2-L1 + R2-R1 — WS3's detached-name resolution is only in `sessionAttach`; extend to `session info`, `session context`, `session heal`, `session fork`, `message history`, `message tail`
- R2-L2 — post-attach metadata `turn_count`/`last_turn_id`/`created_at` reflect fresh binding, not full thread
- R2-R2 — `--truncate 0` clips user prompts (truncate-path edge case)

**🟠 P2 / polish / docs** — defer to 0.5.6 unless trivial (see list below).

---

## Round-2 findings (to consider for 0.5.5 final polish or defer to 0.5.6)

### R2-1 — README.md release badge + `message wait` prose still reference 0.5.4/`turn.error`
- Source: dogfood-solo.
- Evidence:
  > "`README.md` still advertises release `0.5.4` and says `message wait` blocks until `turn.completed / turn.error / timeout`, which conflicts with `skills/manage-codex-team/events.md`."
- Root cause: WS6 bumped the bump-version *example* but didn't sweep the Release badge URL or the `message wait` prose in the README.
- Fix: sweep `README.md` + `README_zh.md` — update badge to 0.5.5 + remove `turn.error` from the message-wait description.
- **Severity: P2** (docs drift, 15-min fix)

### R2-2 — `message wait --help` still says "turn.completed, errors, or times out"
- Source: dogfood-solo.
- Evidence:
  > "`message wait` worked cleanly, but the help text still says `Block until a turn completes, errors, or times out.` while the round-2 note says terminal failure is now represented as `turn.completed` with `status="failed"`."
- Root cause: WS1 cleaned up event docs and filter recipes but didn't sweep CLI help strings in `src/cli/help.ts` (or wherever leaf help bodies live).
- Fix: grep `src/cli/` for "errors" / "turn.error" in help strings and update.
- **Severity: P2** (docs drift, runtime behavior correct)

### R2-3 — `doctor` exits non-zero on PATH-warning-only
- Source: dogfood-solo.
- Evidence: `doctor` reports `[WARN] codex-team not on PATH` + all `[OK]` elsewhere → `=== DEGRADED ===` → exit code 1.
- Impact: awkward to use `doctor` as a binary health gate in CI. This was visible to us throughout the dogfood cycles too.
- Fix: distinguish severity in exit code — `FAIL` → 1, `WARN` → 0 with verbose output; OR add a `doctor --strict` for the binary-gate use case (matches FR-4 from round 1).
- **Severity: P2** (the check logic is right; only the exit mapping is off)

### R2-4 — `--format markdown` produces tagged-markdown envelope, not plain markdown
- Source: dogfood-solo.
- Evidence: output starts with `<tail>`, contains `<turn>` / `<message>` / `<\turn>` etc. around the body.
- User mental-model mismatch: flag name `markdown` suggests "plain markdown body"; reality is "tagged markdown interchange format". Dogfooder explicitly flagged this as a semantics issue.
- Fix options:
  - (A) Rename to `--format md-envelope` / keep current behavior, add new `--format markdown-body` for bare markdown.
  - (B) Two flags: `--format markdown` (plain) + `--format markdown-tagged` (current).
  - (C) Keep name, document explicitly in flag help that it's a tagged interchange format (not pure markdown).
- **Severity: P2** (naming / docs; code is fine) — but may be worth fixing now since we touched this area.

### R2-5 — No user-facing round-2 changelog foregrounds the attach-by-name fix
- Source: dogfood-solo.
- Evidence:
  > "The round-2 note mentions `session attach <name>` now working for detached threads, but none of the docs I read foregrounds that as a recently fixed behavior."
- Fix: add a `plugins/codex-team/docs/releases/0.5.5.md` changelog entry listing the round-2 fixes (turn.error drop, attach-by-name, markdown transcript, CODEX_TEAM_DAEMON_SOCK, CLI hardening, listLive + events tolerance).
- **Severity: P2** (release-hygiene; standard for a dot release)

### R2-6 — `solo-worker.md` playbook has stale 0.5.2 notes
- Source: dogfood-solo.
- Evidence: still says "`turn.completed` is compact metadata only in 0.5.2" without the 0.5.5 update that `message tail --format markdown` now hydrates items.
- Fix: add a line to solo-worker.md that the markdown tail is now content-rich.
- **Severity: P2** (docs drift)

### R2-FR1 — Single-command spawn-and-prompt path
- Source: dogfood-solo (also matches round-1 FR-3).
- Request: `codex-team session new <name> --cwd ... --prompt-file foo.md` that spawns + sends in one call.
- **Severity: feature request, high convenience** — defer to 0.5.6 unless trivial to add.

---

## Remaining sessions (round-2)

- dogfood-parallel (3-worker fan-out — tests survey-and-fork implicitly, map-reduce playbook)
- dogfood-review (writer+critic loop)
- ✅ dogfood-longhorizon (landed — findings below)

_appended as they land_

---

## dogfood-longhorizon (landed) — detach/resume confirmation + deeper findings

### ✅ Confirmed fixes
- `session attach resume-test` on a **detached** thread worked — returned same `thread_id`.
- Worker remembered P1 content when asked in P2 (true conversation continuity across detach).
- `message tail` / `message history --format markdown` rendered full turn content.

### 🔴 NEW P0 — bearer-token isolation is broken for detached-thread enumeration

**R2-L3** — `session list --all` under a **fresh bearer token** `dogfood-longhorizon-1776929110` returned detached threads belonging to **other tokens** (e.g., `worker` from `/tmp/ct-dogfood-r2/solo/pg`, a session my solo dogfooder created under a different token):
```json
{"sessions":[
  {"name":"resume-test","cwd":"/tmp/ct-dogfood-r2/longhorizon/pg","state":"closed"},
  {"name":"worker","cwd":"/tmp/ct-dogfood-r2/solo/pg","state":"closed"}
]}
```
- Root cause: detached-thread enumeration goes against the global codex store without bearer-token filtering.
- **Security impact**: token A can enumerate session names + cwds (which may reveal paths / project layouts) from token B. Bearer token isolation was the CORE promise of the daemon.
- Fix: `session list --all` must filter by caller's user; detached threads are still owned by the token that created them.
- **Severity: P0** (isolation/privacy failure)

### 🟡 NEW P1 — WS3's attach-by-name fix was under-scoped

**R2-L1** — `session info <name>` right after `session detach <name>` fails with wrong error class:
```json
{"ok":false,"error":{"code":"session_not_found","message":"session 'resume-test' not found: JSON-RPC error -32600: invalid thread id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `r` at 1"}}
```
- Root cause: WS3 fixed `session attach` to resolve detached threads by name, but `session info` (and likely `session context`, `session heal`, `session fork`) still hit the raw thread-id parser when the name doesn't match a live session.
- Fix: factor out the detached-name-resolution helper WS3 wired into `sessionAttach` and apply it to every `<name|thread_id>`-accepting command that touches detached threads.
- Commands likely affected (to audit): `session info`, `session context`, `session heal`, `session fork`.
- **Severity: P1** (core day-2 flow: "tell me about my detached session" fails).

### 🟡 NEW P1 — post-attach metadata under-reports turn history

**R2-L2** — After `session attach resume-test`, `session info` returns:
```json
{"name":"resume-test","thread_id":"019db93b-288d-7ad2-bf4f-3d9a04240895","state":"live",
 "created_at":"2026-04-23T07:28:07.528Z","turn_count":0,"last_turn_id":null}
```
Even though `message history` clearly contains both turns. After P2, `turn_count` only reaches `1` (not 2).
- Root cause guess: live-session projection counts turns executed since the latest attach, not total thread turns.
- Impact: users can't verify continuity from metadata alone — must prompt the worker to recall prior content.
- Fix: populate `turn_count` / `last_turn_id` / `created_at` from the underlying thread record, not the fresh live binding.
- **Severity: P1** (contradicts claim that thread continuity is preserved; misleads every introspection tool).

### 🟠 NEW P2 — `session attach <uuid>` loses the human-readable name

**R2-L4** — `session attach 019db93b-...` succeeds and rehydrates the right thread, but gives it a generated live name `s-019db93b`:
```json
{"session":{"name":"s-019db93b","thread_id":"019db93b-288d-7ad2-bf4f-3d9a04240895"}}
```
Even though `session list --all` before this call had `name:"resume-test"` for the same thread.
- Fix: if the detached thread has a stored human name, prefer it over a generated one on UUID-based attach.
- **Severity: P2** (surprising but workable).

### 🟠 NEW P2 — `message wait` has no heartbeat during long silent gaps

**R2-L5** — During the 2-minute P1 turn, `message wait` blocked with no intermediate signal. Dogfooder had to cross-query `session events` and `session health` to distinguish "slow" from "stuck".
- Fix: `message wait` could emit a heartbeat line every N seconds with `items_done_in_turn` + `current_item_type` (already available in `session health`).
- **Severity: P2** (UX polish)

### 🟠 NEW — Quickstart Day-2 block doesn't show continuity verification

**R2-L6** — `quickstart.md` has the Day-2 resume example (from WS3) but doesn't show how to **verify** continuity — user has to trust the returned name. Dogfooder had to compare thread_id + prompt-recall manually.
- Fix: extend the Day-2 block with "verify: `message history resume-test --short` should include yesterday's turns".
- **Severity: P2** (docs polish)

---

## dogfood-review (landed) — writer+critic message-only loop

### ✅ Confirmed fixes
- Worker-reviewer **message-only variant** (the new §from DF-4 / WS3) covered the flow accurately.
- `session attach writer` on detached thread worked — cross-validates RV-codex-1 again.
- `message tail --format markdown` rendered real `<message>` items with assistant paragraph.

### 🟡 NEW P1 — `message history` / `message tail` scope-gap (symmetric to R2-L1)

**R2-R1** — after `session detach writer`, both fail:
```
$ message history writer --limit 5 --format markdown --truncate 0
{"ok":false,"error":{"code":"session_not_found","message":"session 'writer' not live in this user"}}
$ message history 019db93b-2648-73d0-9865-50610428c5a6 ...
# same error
```
- Root cause: `message history` + `message tail` are hard-coded "live-session-only". WS3's detached-name resolution was only wired into `sessionAttach`. Same class as R2-L1.
- **Combined fix needed**: extract the detached-thread resolution helper and wire it into ALL commands accepting `<name|thread_id>`: `message history`, `message tail`, `session info`, `session context`, `session heal`, `session fork`. Scope of WS3's fix was under-counted.
- **Severity: P1** (symmetric to R2-L1; this is actually worse because transcript read is the #1 reason to re-attach).

### 🟠 NEW P2 — `--truncate 0` still clips the user prompt

**R2-R2** — with `--truncate 0` (documented as "no truncate" implicit), the user prompt was visibly clipped mid-sentence:
```
Write exactly one markdown paragraph, 120 words or fewer, for a first-time user explaining what the codex-team event stream is. Constraints: - Plain English, no
```
- Root cause guess: `--truncate 0` may hit a path that interprets 0 as "use default" rather than "no truncate" — or an inline/block threshold is still applying somewhere WS2 missed.
- Fix: audit truncation path for 0 handling; add explicit test for `truncate === 0`.
- **Severity: P2** (may be P1 if it affects machine consumers).

### 🟠 NEW P2 — `cli-reference.md` still says "for detached threads, use the thread_id"

**R2-R3** — WS6's docs sweep missed this one-line claim:
> "For detached threads, use the `thread_id`."
- Now factually wrong for `session attach` (name works); still accidentally correct for `message history` / `message tail` / `session info` (because those commands don't have the fix — see R2-R1, R2-L1).
- Fix: after the R2-R1/L1 scope fix, remove the claim entirely. Until then, rewrite as "name works for `session attach`, other commands require `thread_id`".
- **Severity: P2** (docs).

### 🟠 NEW P2 — Shell-safe verbatim handoff between sessions

**R2-R4** — the worker-reviewer message-only variant says "pipe tail output verbatim into the reviewer" but the playbook doesn't show a shell-safe pattern. Dogfooder hit `zsh:2: command not found: message` / `parse error near \`>'` on a naive here-doc approach before switching to `printf %s ... | message send critic --stdin`.
- Fix: update `codex-team-playbooks/worker-reviewer.md` §Message-only variant to include a safe-forwarding one-liner (`codex-team ... message tail X ... | codex-team ... message send Y --stdin`).
- **Severity: P2** (docs / pattern guidance).

### FR echoes (already in R2 from solo)
- `message send --file -` / `--stdin-literal` as documented patterns.
- `session new <name> --prompt-file <file>` single-call spawn-and-prompt.

---

## dogfood-parallel (landed) — 3-worker map-reduce fan-out

### ✅ Confirmed fixes
- `monitor events --stream --cursor parallel-tail` terminal-event wake-up works for fan-out.
- Detached `session attach worker-a` by name works (validation #3 for RV-codex-1).
- `message tail/history --format markdown` renders real items on a LIVE session (validation #3 for WS2).
- Total LOC task completed: worker-a 3878 + worker-b 1113 + worker-c 9011 = 14002. (Actual LOC numbers not the point; the pattern completed.)

### 🟠 NEW P2 — stale `recover-codex-team/known-quirks.md`

**R2-P1** — still says `message history`/`message tail` return metadata-only because `thread/turns/list` has empty items. WS2 fixed this but WS2 didn't edit `recover-codex-team/`. Fix: remove or rewrite that caveat (mention it as pre-0.5.5 behavior).

### 🟠 NEW P2 — map-reduce playbook doesn't handle cwd vs target-path mismatch

**R2-P2** — dogfooder had to create symlinks because required session `--cwd` was the playground while target inspection was `/home/.../plugins/codex-team/src/*`. The playbook assumes target tree lives under cwd. Under `workspace-write` sandbox, this ambiguity leads to symlink workarounds.
- Fix: map-reduce.md + worker-reviewer.md + generally using-codex-team/SKILL.md should explicitly note: "workers can READ anywhere even under workspace-write; only writes are restricted to cwd". This single line would unblock the confusion.

### 🟠 NEW P2 — `--summary` on `monitor events` is conceptually fuzzy

**R2-P3** — help text says it's the same as default concise output unless `--full`. Dogfooder couldn't tell when `--summary` materially changes behavior.
- Fix: help text should say explicitly "`--summary` forces daemon-side summarization even when `--full` is requested; otherwise no-op." Or remove the flag if it's always no-op.

### FR echoes + additions
- **R2-FR-P1** — manifest-driven fan-out: `codex-team session fanout workers.json` (new).
- **R2-FR-P2** — `monitor events --wait-terminal NAME,NAME,NAME` blocks until all named sessions hit terminal (new).
- **R2-FR-P3** — `message send --prompt-file` / `session new --prompt-file` (3rd echo — strong signal).

### Other
- Dogfooder ran `doctor` and was again surprised by DEGRADED / exit 1 on PATH-only warning → cross-reference with R2-3.

---

## Updated 0.5.5 ship decision

**Hard P0 to fix before shipping**:
- **R2-L3** — bearer-token isolation break for `session list --all` on detached threads.

**Strongly recommend before shipping** (reopening the WS3 scope gap + WS2 truncate edge case):
- **R2-L1 + R2-R1** — apply detached-name resolution to `session info`, `session context`, `session heal`, `session fork`, `message history`, `message tail`. The fix pattern already exists in `sessionAttach` (WS3 commit 79340f6) — extract + extend. Related cleanup: **R2-R3** cli-reference.md claim.
- **R2-L2** — post-attach metadata `turn_count`/`last_turn_id`/`created_at` reflect full thread, not fresh binding.
- **R2-R2** — audit truncation path for `--truncate 0` clipping.

**Defer to 0.5.6 (polish / UX)**:
- R2-L4 attach-by-UUID name preservation
- R2-L5 `message wait` heartbeat
- R2-L6 quickstart continuity-verification example
- R2-R4 worker-reviewer shell-safe handoff pattern
- R2-1..R2-6 (from solo report): README badge/prose sweep, `message wait --help` text, doctor exit-code, `--format markdown` envelope naming, 0.5.5 changelog, solo-worker.md update
- R2-FR1 `session new --prompt-file`

Will re-confirm with dogfood-parallel findings when they land.
