# Compaction ritual

Reference for `recover-codex-team`. The **2-step ritual** for reducing a session's context without losing long-form state.

Compaction is the one operation where the plugin's native CLI is **not enough on its own**. Codex's built-in `thread.compact` produces a low-quality internal summary that routinely drops design decisions, open questions, and file state.

**Write the work doc first. Compact second. Two sends, in that order, always.**

---

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

The daemon emitted this because the session's current-context estimate crossed `[compaction].threshold_tokens` (default 500k). This is an **advisory**, not an automatic action. Confirm the workspace matches yours before acting.

You can also trigger the ritual proactively, without waiting for `compact-suggest`, if a verbose turn is about to push you past the threshold.

## Step 1 — worker writes a pre-compaction dump into the work doc

The work doc is already the session's canonical long-form state (see `manage-codex-team/work-doc.md`). Step 1 forces the worker to densify and refresh it *right now*, before the context is lost.

```bash
codex-team send <name> "Before I compact this thread, append a dense progress summary to the work doc (<path>). Cover: (1) all work completed in this thread, (2) current file state of the components you've touched (by path, not diff), (3) key decisions and their rationale, (4) open questions / unresolved items, (5) next-up tasks. Do not start new work in this turn. When the doc is updated, reply 'progress saved, ready to compact'."
```

Prompt rules:

- **Forbid new work explicitly.** One turn, one purpose. Otherwise Codex may burn another 100k tokens on tasks, defeating the point.
- **Name the five sections.** Under-specifying yields fluff.
- **Require the exact reply phrase.** Makes the `turn-done` payload easy to recognize.
- **Point at the already-agreed path.** Don't invent a new path during compaction — use the one the session has been writing to.

Wait for `turn-done`. The `final_message` should contain the acknowledgement phrase. Only then proceed to Step 2.

### Recognising readiness

The `turn-done` after Step 1 should carry:

- `final_message` with the acknowledgement phrase.
- `lines` contains a `file_change` entry targeting the work doc path.

If `lines` has no such `file_change`, the worker forgot. **Do not proceed.** Re-issue Step 1 with firmer wording.

## Step 2 — compact

```bash
codex-team compact <name>
```

Calls the app-server `thread/compact/start` RPC. The daemon marks the session `compacting` and emits `compact-done` when finished.

After `compact-done`:

- The session's context-window estimate drops sharply.
- The thread retains an internal compact summary; **your work doc is the canonical long-form state.**
- Resume normal sends.

## Never combine the two

- ❌ *"Summarize your work and then compact yourself"* — workers can't call `compact` on themselves (daemon-level op). You get a useless turn.
- ❌ *Compact first, then summarize* — the summary is written against already-compact context; the long tail is lost.

**Step 1, then Step 2. In that order.**

## Edge cases

| Situation | Handling |
|---|---|
| Step 1 emits `turn-attn` (worker asks a question) | Answer briefly, re-issue Step 1. Do not compact until the work doc is written. |
| Step 1 fails with `turn-err` | → `recover-codex-team` main skill. Do not retry compaction until healthy. |
| Session mid-queue | `codex-team queue show <name>`. Decide: clear queue, drain first, or enqueue compaction behind pending work. No single correct answer. |
| Session is `running` | Wait for current turn or `codex-team interrupt` first. Sending while running just queues. |
| Work doc directory doesn't exist | Worker's sandbox is `danger_full_access` — Step 1 creates it. If it still fails, `mkdir -p` yourself and re-issue. |
| Reply after Step 1 looks like it ignored your prompt | Long-context prompt-apply skip? Re-send Step 1 once. → `known-quirks.md`. |
| `compact-suggest` arrives but event's workspace isn't yours | Shouldn't happen (daemon scopes); if it does, ignore. Don't compact another workspace's session. |

## After `compact-done`

- Note the compaction in your user-facing update (one sentence).
- Do not assume the worker remembers pre-compact specifics. The post-compact thread has an approximate internal summary. If the next turn needs specifics, point Codex at the work doc.
- The `compact-suggest` advisory auto-clears. A fresh advisory arrives if context climbs back above the threshold.

## Parallel compactions

You can compact multiple sessions in parallel — but **issue Step 1 for each, then Step 2 for each.** Do not interleave one session's Step 1 with another's Step 2; the Monitor stream becomes hard to follow.

All parallel compactions must be in your current workspace. Compacting another workspace's session is rejected (`E_WRONG_WORKSPACE`) and should never be your intent — that's someone else's work.

## Red flags

| Thought | Correction |
|---|---|
| "I'll just run `codex-team compact` to get tokens down." | Step 1 first. Always. |
| "The `history.md` already has summaries — skip Step 1." | `history.md` is append-only log, not distilled state. You need a fresh summary by the worker at this moment, in the work doc. |
| "Reply didn't match the phrase but sounds done." | Check `lines` for `file_change` on the work doc. Present → fine. Absent → re-issue Step 1. |
| "Usage is 2M cumulative — compact now." | Check current-context estimate (`usage_last_tokens` / `token_usage_input`), not cumulative. |
| "Let me compact all sessions at once." | Parallel is fine — but Step 1 all, then Step 2 all. Do not interleave. |
| "The reply doesn't match my Step 1 prompt — session is confused." | Long-context skip. Re-send Step 1 unchanged. → `known-quirks.md`. |
| "That `compact-suggest` was for another workspace — let me compact it to help them." | Stay in your workspace. The other orchestrator handles theirs. |
