# Known Codex quirks (look like failures, aren't)

Reference for `recover-codex-team`. Behaviour that looks broken on first encounter but does **not** warrant the escalation ladder. Read before climbing.

---

## The long-context prompt-apply skip

**Symptom.** After many turns in a single thread, Codex occasionally returns a reply that does **not** match the prompt you just sent — as though it applied an earlier turn's context instead of the current one.

You can spot it because the reply:

- Talks about the wrong file (a file you didn't reference).
- Answers a question you didn't ask.
- Continues old work verbatim instead of acting on the new send.

**Response.** **Re-send the exact same prompt, unchanged.**

Do not:

- Treat it as a recovery case (don't `interrupt` / `restart` / `kill`).
- Rephrase the prompt — that introduces new ambiguity.
- Assume the session is confused and needs a reset.

One re-send typically resolves it. **Two consecutive re-sends with the same bad behaviour** = genuine problem → escalate via the ladder.

**Why it happens.** Long-thread state drift. You can't prevent it; you can only recognise it. The one-time re-send is effectively free — the worker applies the current prompt on the retry.

→ `philosophy.md` §5 for the cultural framing.

---

## Turns legitimately take minutes

A turn that has been running 2–5 minutes is **not stuck**. Codex turns can legitimately take that long when:

- Running a long test suite.
- Compiling / type-checking a large project.
- Walking a deep code path in `reasoning_effort=high`.
- Downloading dependencies.

**Don't intervene** until:

- The `turn-stuck` event fires (heartbeat sees `currentTurnAgeMs > heartbeat.turn_stuck_seconds`, default 600s).
- OR you have strong evidence (`session dump` shows `transport_alive=false` or `stderr_tail` with an actual fault).

The most expensive mistake is interrupting a turn that was about to finish. Waiting is free; interrupting drops the queue (if any) and wastes the turn's progress.

---

## Reasoning-effort effort reality

**Symptom.** `reasoning_effort=high` worker spends 10× longer and burns 2–3× the tokens compared to `medium`.

**Not a bug.** `high` is for ambiguous or deep problems. For a well-specified task with a tight brief, `medium` (or even `low` / `minimal`) is often strictly better. See `configure-codex-team/codex-tricks.md`.

---

## Final-answer phase

**Symptom.** A single turn emits multiple agent messages; only the last one is the "final answer".

**Not a bug.** Codex workers narrate as they execute. The digest captures every `agentMessage` item in order; the one with `item.phase === "final_answer"` is marked as such in the turn history (see `docs/refactor-history-display.md`). When you want the bottom line, read `final_message` on the `turn-done` payload.

---

## `auto-heal` when `was_during_turn=false`

**Symptom.** `session-down` fires, then `auto-heal` fires, but the worker wasn't in a turn.

**Not a bug.** The `codex app-server` child was recycled (idle timeout or minor OOM). The thread is intact; nothing was lost. Continue without re-dispatching.

`was_during_turn=true`, on the other hand, means the in-flight turn died. The `auto-heal` restored the session but not the turn — re-send that prompt.

---

## Cumulative vs context-window tokens

**Symptom.** `usage_total_tokens=2,400,000` looks terrifying. The worker is nowhere near compaction.

**Not a bug.** `usage_total_tokens` is cumulative across the entire thread (all turns, all inputs, all outputs). Compaction is decided on `usage_last_tokens` (the current context-window snapshot). Only `usage_last_tokens >= threshold_tokens` (default 500k) triggers `compact-suggest`.

---

## Queue behaviour during recovery

**Symptom.** After `session kill`, queued sends are gone.

**Not a bug.** Destructive recovery drops queued waiters with an error, by design — there's no silent hang. Before killing, inspect:

```bash
codex-team queue show <name>
```

Decide what to preserve, then kill.

---

## Red flag: treating any quirk as a failure

The ladder is for real failures. Every entry above has a specific, non-destructive response. If you find yourself running `interrupt` / `restart` / `kill` as the *first* action for any of the symptoms on this page, stop and re-read.
