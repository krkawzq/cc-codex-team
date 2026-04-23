# Review: codex (0.5.5 dogfood)

## P0 — crash / data loss / security / protocol
- none

## P1 — wrong behavior
- [P1] plugins/codex-team/src/daemon/handlers/session.ts:145 — `session attach <name>` never looks up detached threads by name, so a detached session can only be re-attached by UUID even though the command advertises `<name|thread_id>`.
  Why it's P1: this breaks a documented day-to-day flow after `session detach`, returning `session_not_found` under normal use.
  Fix sketch: when the identifier is not live anywhere, resolve detached threads by name via the existing `findDetachedThreadByName`/`threadRead` helpers before failing, and lock on the resolved thread id.

- [P1] plugins/codex-team/src/daemon/handlers/session.ts:142 — takeover tears down the original owner before the taker has successfully resumed the thread.
  Why it's P1: a transient `threadResume` failure leaves neither user attached, while approvals are already cancelled and the old owner already saw `session.seized`.
  Fix sketch: make takeover two-phase; only cancel/remove the old binding after the new client has resumed successfully, or restore the old binding on failure.

- [P1] plugins/codex-team/src/codex/pool.ts:166 — `acquireForAdhoc()` reuses app-servers that already host live sessions.
  Why it's P1: read-only/adhoc RPCs (`thread/list`, `thread/read`, detached-name discovery) now contend with the same busy app-server that is running a worker turn, which is exactly the hot path the docs claim is isolated.
  Fix sketch: exclude bound-session clients from adhoc acquisition, or split reusable adhoc clients into a separate pool.

- [P1] plugins/codex-team/src/daemon/handlers/message.ts:103 — `message interrupt` clears `currentTurnId` and reports `interrupted:true` before the authoritative terminal event arrives.
  Why it's P1: follow-up `message send` calls can try `turn/start` while the interrupted turn is still winding down, producing racey start failures and false operator feedback.
  Fix sketch: leave the turn active until `turn/completed` (or a dedicated terminal interrupt notification) is observed; return “interrupt requested” unless/until termination is confirmed.

- [P1] plugins/codex-team/src/daemon/wire.ts:276 — queued sends survive an unexpected app-server exit, but `session heal` never drains or drops them explicitly.
  Why it's P1: after a crash/recover cycle, previously queued prompts can remain stuck forever, violating the documented `send` queueing contract.
  Fix sketch: either emit/drop queued items on crash, or have `sessionHeal` detect surviving queue depth and kick a drain when the resumed session has no active turn.

## P2 — polish / smell / docs drift
- [P2] plugins/codex-team/src/daemon/wire.ts:146 — `thread.closed` is surfaced as `session.closed` with `reason: "user_detach"`.
  Why it's P2: operators cannot distinguish a codex-permanent thread close from an explicit detach, so event consumers lose an important diagnostic signal.
  Fix sketch: introduce a distinct close reason such as `thread_closed` and propagate it through `session.closed` / pending-cancellation paths.

- [P2] plugins/codex-team/src/daemon/handlers/message.ts:601 — `message wait` still treats `turn.interrupted` as a first-class terminal event, but the normalization layer and protocol docs only use `turn/completed` as the terminal turn notification.
  Why it's P2: this leaves dead branches in a user-facing command and obscures the actual interrupt semantics.
  Fix sketch: either normalize a real interrupt terminal event end-to-end, or collapse wait handling onto `turn.completed` statuses only.

## Contract drift (docs vs code)
- skill:[plugins/codex-team/skills/using-codex-team/SKILL.md](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/skills/using-codex-team/SKILL.md:50) and skill:[plugins/codex-team/skills/manage-codex-team/SKILL.md](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/skills/manage-codex-team/SKILL.md:89) say detached sessions can be re-attached by `name|thread_id`, but code at [plugins/codex-team/src/daemon/handlers/session.ts](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/src/daemon/handlers/session.ts:145) only resolves detached threads by explicit `thread_id`.
- skill:[plugins/codex-team/skills/using-codex-team/mental-model.md](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/skills/using-codex-team/mental-model.md:34) says app-server death triggers automatic re-acquire + `thread/resume`, but code at [plugins/codex-team/src/daemon/wire.ts](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/src/daemon/wire.ts:241) marks the session `crashed` and requires an explicit [plugins/codex-team/src/daemon/handlers/session.ts](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/src/daemon/handlers/session.ts:517) `session heal`.
- skill:[plugins/codex-team/skills/using-codex-team/mental-model.md](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/skills/using-codex-team/mental-model.md:18), skill:[plugins/codex-team/skills/recover-codex-team/known-quirks.md](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/skills/recover-codex-team/known-quirks.md:73), and skill:[plugins/codex-team/skills/configure-codex-team/config-keys.md](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/skills/configure-codex-team/config-keys.md:30) say live sessions are isolated and `app_server.max_sessions_per_process` mainly affects reusable adhoc/read-only clients, but code at [plugins/codex-team/src/codex/pool.ts](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/src/codex/pool.ts:166) reuses live-session clients for adhoc work.
- skill:[plugins/codex-team/skills/manage-codex-team/events.md](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/skills/manage-codex-team/events.md:29) says `turn.completed.status` can be `failed|interrupted|cancelled` and `token_usage` exposes `{input,cached_input,output,reasoning_output,total}`, but code at [plugins/codex-team/src/daemon/normalize.ts](/home/wzq/Code/Projects/cc-codex-team/plugins/codex-team/src/daemon/normalize.ts:130) emits `completed|errored|cancelled` and normalizes usage to `{prompt,completion,total}`.

## Test gaps
- `plugins/codex-team/tests/session-handlers.test.ts` — missing a regression for `session attach <detached-name>` succeeding via detached thread discovery.
- `plugins/codex-team/tests/session-handlers.test.ts` — missing a rollback case where `session attach --takeover` fails after the old owner has been seized.
- `plugins/codex-team/tests/pool.test.ts` — missing a case proving `acquireForAdhoc()` does not reuse a client that is already hosting a live session.
- `plugins/codex-team/tests/message-handlers.test.ts` / `plugins/codex-team/tests/wire.test.ts` — missing an interrupt race where a new `message send` arrives after `turn/interrupt` ACK but before the terminal turn event.
- `plugins/codex-team/tests/wire.test.ts` / `plugins/codex-team/tests/session-heal.test.ts` — missing crash+heal coverage for queued prompts that were pending behind the interrupted/crashed turn.

## Notes
- Most of the leaf code under `src/codex/` is small and straightforward; the user-visible risk is concentrated in how the daemon/session layer composes those primitives.
