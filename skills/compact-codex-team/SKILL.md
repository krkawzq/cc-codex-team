---
name: compact-codex-team
description: Execute the two-step compaction ritual for a codex-team session — first have Codex write a progress summary to disk, then call compact. Use when the events stream emits `compact-suggest` (or when you manually decide to compact). Never call `codex-team compact` directly; the plugin's built-in compaction loses context.
---

# Compact codex-team

Compaction is the only operation where the plugin's native CLI is
**not** enough. Codex's built-in `thread.compact` produces a
low-quality internal summary that routinely drops the design
decisions, open questions, and file state you'd actually want to
preserve. The workaround is simple and non-negotiable: **write a
progress doc first, compact second.**

## When this fires

You will see a line like this on the `events` stream:

```
{
  "kind": "compact-suggest",
  "session": "L-kernels",
  "tokens": 523412,
  "threshold": 500000
}
```

The daemon emitted it because the session's `token_usage_input`
crossed `compaction.threshold_tokens` (default 500k). It is an
*advisory*, not an automatic action — the plugin does not auto-compact
because of this quality concern.

You may also trigger the ritual proactively if you know a session is
about to cross the threshold (e.g., before a long verbose turn).

## The ritual — 2 steps, exactly 2

### Step 1: have Codex write progress to disk

```
codex-team send <name> "Before I compact this thread, append a dense progress summary to docs/refactor/<name>/progress.md covering: (1) all work completed in this thread, (2) current file state of the components you've touched (by path, not diff), (3) key decisions and their rationale, (4) open questions / unresolved items, (5) next-up tasks. Do not start new work in this turn. When the file is updated, reply 'progress saved, ready to compact'."
```

Key notes on the prompt:

- It explicitly **forbids new work** — you want this turn to do one
  thing: write the summary. Otherwise Codex may burn another 100k
  tokens doing tasks, defeating the purpose.
- It specifies the five sections. Under-specifying produces fluff.
- It asks for a specific reply phrase so the `turn-done` payload is
  easy to recognize.

Wait for the `turn-done` event. The final_message should contain the
acknowledgement phrase. Then and only then proceed to Step 2.

### Step 2: compact

```
codex-team compact <name>
```

This calls the SDK's `thread.compact()` under the hood. The daemon
marks the session `compacting` during the call and emits
`compact-done` when finished.

After `compact-done`, resume normal sends. The `token_usage_input`
will reset dramatically (typically 500k → ~15k) and Codex's thread
retains the compact summary internally. Your external
`progress.md` is the canonical long-form record.

## Never combine the two

If you write a single prompt like *"Summarize your work and then
compact yourself,"* Codex cannot call `compact` on itself — it's a
daemon-level operation — and you still need the disk write first.
You will get a meaningless turn and still have the problem.

If you run `codex-team compact` first and *then* ask Codex to
summarize, the summary is written against the already-compact context
and the long tail is lost.

**Order matters. Two sends, in this order, always.**

## Recognising the ready state

The `turn-done` after Step 1 should look like:

```
{
  "kind": "turn-done",
  "session": "L-kernels",
  "tier": "normal",
  "status": "ok",
  "final_message": "progress saved, ready to compact",
  "files_added": 0,          // irrelevant to the check
  "files_removed": 0,
  "lines": [ ... with at least one fileChange targeting progress.md ... ]
}
```

If `lines` has no `fileChange` entry pointing at
`docs/refactor/<name>/progress.md`, Codex forgot — **do not proceed**.
Re-issue Step 1 with firmer wording.

## After `compact-done`

- Register that the compaction happened in your own notes / the
  user-facing response.
- Do not assume Codex remembers the pre-compact details. The
  post-compact thread has an internal summary, which is
  approximate. If the next turn needs specifics, point Codex at
  `progress.md`.
- The `compact-suggest` advisory for this session auto-clears. If
  usage climbs again to the threshold, you'll see a fresh advisory.

## Edge cases

- **Step 1 emits `turn-attn` (Codex asks a question instead of
  writing):** answer the question briefly, then re-issue Step 1. Do
  not compact until Step 1 actually lands the file change.
- **Step 1 fails with `turn-err`:** see `recover-codex-team`. Do not
  retry the compaction until the session is healthy.
- **Session is mid-queue when you want to compact:**
  `codex-team queue show <name>` to see what's pending. Decide whether
  to clear the queue first (`queue clear`), let it drain, or just
  enqueue the compact prompts behind them. There is no correct answer;
  depends on how urgent compaction is vs. the queued work.
- **Session is `running`:** either wait for the current turn to
  finish, or `codex-team interrupt <name>` first. Compact is a
  registry-state change; sending a prompt while running just queues
  it.
- **The `progress.md` file does not exist yet:** Step 1 should create
  it (Codex's sandbox is `danger_full_access`). If it still fails,
  create the directory yourself with `mkdir -p` and re-issue.

## Red flags

| Thought | Correction |
|---|---|
| "I'll just run `codex-team compact` to get the tokens down." | Step 1 first. Always. |
| "Codex already writes summaries per turn to `history.md`, I can skip Step 1." | `history.md` is append-only log, not a distilled state. You need a written summary, by Codex, at this moment. |
| "The reply didn't match the magic phrase but it sounds done." | Check `lines` for a `fileChange` on `progress.md`. If it's there, fine. If not, re-issue. |
| "Let me compact all four sessions at once to save time." | They can run in parallel, but issue Step 1 for each, then Step 2 for each. Do not interleave Step 1 of one with Step 2 of another. |

## Cross-references

- Before the ritual: confirm session is not in a weird state —
  `inspect-codex-team`
- If Step 1 or Step 2 errors: `recover-codex-team`
- After: `manage-codex-team` for your next normal send
