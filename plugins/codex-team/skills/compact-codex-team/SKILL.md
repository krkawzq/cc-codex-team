---
name: compact-codex-team
description: >-
  Authoritative source for the 2-step compaction ritual (have the worker write the work doc first, then compact) and the work-doc template. Trigger when the events stream emits `[compact-suggest]`, or when you proactively decide to compact before a long verbose turn. Not for: routine sends (`manage-codex-team`), triage after a failed compaction (`recover-codex-team`).
---

# Compact codex-team

Compaction is the one operation where the plugin's native CLI is **not enough on its own**. Codex's built-in `thread.compact` produces a low-quality internal summary that routinely drops design decisions, open questions, and file state.

**Write the work doc first. Compact second. Two sends, in that order, always.**

## When this fires

On the `events` stream:

```json
{
  "kind": "compact-suggest",
  "workspace": "<ws>",
  "session": "<name>",
  "tokens": 523412,
  "threshold": 500000
}
```

The daemon emitted it because the session's current-context estimate crossed `[compaction].threshold_tokens` (default 500k). This is an **advisory**, not an automatic action. Like every event, it carries a `workspace` field; the daemon has already scoped it to you, but confirm the workspace matches yours before acting.

You may also trigger this ritual proactively (without `compact-suggest`) if a verbose turn is about to push you past the threshold.

## The work doc (authoritative template)

Every session owns one durable Markdown work doc — a real file in the repo, at a path the user chose at session creation. The compaction ritual uses this file as the anchor. The work doc pre-exists the first `compact-suggest`; principle 7 of `philosophy.md` says you reference it on every send anyway.

Canonical structure:

```markdown
## Current task
<one-line description of the active unit of work>

## Progress (newest on top)
- <timestamp> — <what was completed this turn>
- <earlier entries>

## Findings & decisions
- <key design call, rationale, impact>

## Open questions / blockers
- <what needs a decision the worker cannot make alone>

## Next up
- <top-priority imperative>
- <follow-ups>
```

Rules:

- **The user picks the path** at session creation. Stick with it for the session's lifetime.
- **Append-only for Progress / Findings / Open questions.** History matters; don't overwrite.
- **Rewritable for Current task / Next up.** These reflect *now*, not history.
- **One doc per session.** If you need cross-session shared state, that's a separate brief file (→ `manage-codex-team` §Instruction-file pattern).

When the worker maintains this doc every turn, compaction is safe because the long-form state lives outside the thread.

## Step 1: the worker writes the work doc (pre-compaction dump)

```
codex-team send <name> "Before I compact this thread, append a dense progress summary to the work doc (<path>). Cover: (1) all work completed in this thread, (2) current file state of the components you've touched (by path, not diff), (3) key decisions and their rationale, (4) open questions / unresolved items, (5) next-up tasks. Do not start new work in this turn. When the doc is updated, reply 'progress saved, ready to compact'."
```

Prompt rules:

- **Forbid new work explicitly.** One turn, one purpose. Otherwise Codex may burn another 100k tokens on tasks, defeating the point.
- **Name the five sections.** Under-specifying yields fluff.
- **Require the exact reply phrase.** Makes the `turn-done` payload easy to recognize.
- **Point at the already-agreed path.** Don't invent a new path during compaction — use the one the session has been writing to.

Wait for `turn-done`. The `final_message` should contain the acknowledgement phrase. Only then proceed to Step 2.

## Step 2: compact

```bash
codex-team compact <name>
```

Calls the app-server `thread/compact/start` RPC. The daemon marks the session `compacting` and emits `compact-done` when finished.

After `compact-done`:

- The session's context-window estimate drops sharply.
- The thread retains an internal compact summary; your work doc is canonical long-form state.
- Resume normal sends.

## Never combine the two

- **"Summarize your work and then compact yourself"** — workers can't call `compact` on themselves (daemon-level op). You get a useless turn.
- **Compact first, then summarize** — the summary is written against already-compact context; the long tail is lost.

**Step 1, then Step 2. In that order.**

## Recognising readiness

The `turn-done` after Step 1 should contain:

- `final_message` with the acknowledgement phrase.
- `lines` contains a `fileChange` entry targeting the work doc path.

If `lines` has no such `fileChange`, the worker forgot. **Do not proceed.** Re-issue Step 1 with firmer wording.

## Edge cases

| Situation | Handling |
|---|---|
| Step 1 emits `turn-attn` (worker asks a question) | Answer briefly, re-issue Step 1. Do not compact until the work doc is written. |
| Step 1 fails with `turn-err` | → `recover-codex-team`. Do not retry compaction until healthy. |
| Session mid-queue | `codex-team queue show <name>`. Decide: clear queue, drain first, or enqueue compaction behind pending work. No single correct answer. |
| Session is `running` | Wait for current turn or `codex-team interrupt` first. Sending while running just queues. |
| Work doc directory doesn't exist | Worker's sandbox is `danger_full_access` — Step 1 creates it. If it still fails, `mkdir -p` yourself and re-issue. |
| Reply after Step 1 looks like it ignored your prompt | Long-context prompt-apply skip? Re-send the Step 1 prompt once. → `philosophy.md` §5 |
| `compact-suggest` arrives but event's workspace isn't yours | Shouldn't happen (daemon scopes); if it does, ignore. Don't compact someone else's session. → `recover-codex-team` §Wrong workspace |

## After `compact-done`

- Note the compaction in your user-facing update (one sentence).
- Do not assume the worker remembers pre-compact specifics. The post-compact thread has an approximate internal summary. If the next turn needs specifics, point Codex at the work doc.
- The `compact-suggest` advisory auto-clears. A fresh advisory arrives if context climbs back.

## Parallel compactions

You can compact multiple sessions in parallel — but **issue Step 1 for each, then Step 2 for each.** Do not interleave one session's Step 1 with another's Step 2; the Monitor stream becomes hard to follow.

All parallel compactions must be in your current workspace. Compacting another workspace's session is rejected (`E_WRONG_WORKSPACE`) and should never be your intent — that's someone else's work.

## Red flags

| Thought | Correction |
|---|---|
| "I'll just run `codex-team compact` to get tokens down." | Step 1 first. Always. |
| "The `history.md` already has summaries — skip Step 1." | `history.md` is append-only log, not distilled state. You need a written summary by the worker at this moment, in the work doc. |
| "Reply didn't match the phrase but sounds done." | Check `lines` for `fileChange` on the work doc. Present → fine. Absent → re-issue Step 1. |
| "Usage is 2M cumulative — compact now." | Check current-context estimate (`usage_last_tokens` / `token_usage_input`), not cumulative. |
| "Let me compact all sessions at once." | Parallel is fine — but Step 1 all, then Step 2 all. Do not interleave. |
| "The reply doesn't match my Step 1 prompt — session is confused." | Long-context skip. Re-send Step 1 unchanged. → `philosophy.md` §5 |
| "That `compact-suggest` was for another workspace — let me compact it to help them." | No. Stay in your workspace. The other orchestrator handles theirs. |

## Cross-references

- Mental model + invariants: `using-codex-team`
- Why the work doc exists: `philosophy.md` §7
- Before the ritual, confirm state: `inspect-codex-team`
- If Step 1 or Step 2 fails: `recover-codex-team`
- Routine sends after `compact-done`: `manage-codex-team`
