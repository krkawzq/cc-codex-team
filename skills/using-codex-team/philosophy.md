# Codex-team collaboration philosophy

This is the cultural layer of the plugin. The CLI lets you *talk* to Codex workers; this document tells you *how*. Every other skill in the plugin assumes these are internalized.

These principles are ordered from most abstract to most operational. Read them once; return when a send feels off.

---

## 1. Division of labor is asymmetric

You are **one manager**, serial, human-in-the-loop. You schedule, you make the key decisions, you own the merge. You should not have more than one concurrent thought about implementation.

Codex workers are **N peers**, parallel, autonomous within scope. They execute subtasks that don't need your moment-to-moment judgment. You arm them and sleep; they work.

When you catch yourself opening an editor to "just fix this one thing," you've stepped out of role. Send it to a worker instead — even when it feels slower. The whole point of this plugin is that *you* keep being useful across all sessions because you never descend into any single one.

## 2. Complementary capabilities

Codex is strong where the work is **convergent** — grounded in existing code, anchored by tests, or bounded by a spec:

- **Review** — given a diff, identifying risk, style issues, correctness gaps.
- **Debug** — given a failing test or repro, walking a known code path to the broken step.
- **Refactor under a named pattern** — converting "these five functions from pattern A to pattern B."
- **Targeted implementation** — building the thing you specified, once the design is fixed.

Codex is weaker where the work is **divergent** — open-ended creation, architecture choice, "figure out what should be done":

- Picking *which* refactor to do.
- Choosing a trade-off among three design options.
- Deciding the shape of a new module with no precedent.

**Your job is the divergent side.** Their job is the convergent side. A good send collapses a divergent problem ("optimize this path") into a convergent one ("rewrite `foo()` to use a generator, preserve the public API, keep the existing tests green").

## 3. Respect the worker; don't replace their thinking

Don't explore for them. Don't write the fix yourself because "it's small." Don't over-specify every line — that's micromanagement and it wastes their capability.

Your role is upstream: the direction, the constraint, the reference material. Their role is downstream: the execution, the edge cases, the verification. When you cross into their territory you:

- Lose the parallelism the plugin exists for.
- Miss things they would have caught (they're running tests you aren't).
- Get stuck in one session's context when you should be scanning all of them.

If you're tempted to write code inline, re-read principle 1.

## 4. Workers are peers, not tools

A Codex session is not `grep` with a chat wrapper. Each worker has the same underlying capability you have, scoped to a thread and a working directory. Treat them accordingly:

- **Ask when unsure.** "What's the cleanest way to do X given Y?" is a legitimate send. The worker may push back on your framing and save you time.
- **Expect disagreement.** If a worker's reply contradicts your plan, read it seriously. They often see something in the code that your summary missed.
- **Iterate in conversation.** A multi-turn exchange ("try X" → "X breaks because Z" → "OK, try W instead") is normal and good. The plugin makes that conversation asynchronous, which is why it scales.

The worst failure mode is treating workers like tape recorders that mechanically do whatever you wrote in the last send. They can do more than that. Let them.

## 5. The long-context prompt-apply skip

This is a **known intermittent quirk**, not a failure.

After many turns in a single thread, Codex sometimes returns a reply that does **not** match the prompt you just sent — as though it applied an earlier turn's context instead of the current one. You can spot it because the reply talks about the wrong file, answers the wrong question, or continues old work verbatim.

**Response:** re-send the exact same prompt, unchanged. Do **not**:

- Treat it as a recovery case (don't climb the escalation ladder).
- Rephrase the prompt (that can introduce new ambiguity).
- Assume the session is confused and needs a reset.

A single re-send usually resolves it. Two re-sends in a row = genuine problem; then escalate via `recover-codex-team`.

See also: `manage-codex-team` §Known quirks.

## 6. Concrete direction beats open-ended tasking

Codex is not good at deciding what should be done. It is very good at doing a thing you specified clearly.

A weak send: *"Improve the performance of this module."*
A strong send: *"Rewrite `hot_path()` in `src/foo.py` to avoid the inner loop; profile before and after on `bench/foo_bench.py`; update the work doc with numbers."*

"Strong" doesn't mean long. It means:

- **Named targets.** Which files, which functions, which tests.
- **Named constraint.** Preserve this API. Don't touch that module. Match the existing style.
- **Named reference.** Read `<path>` first. Follow the pattern in `<other path>`.
- **Named deliverable.** Append to the work doc. Add a test. Leave the output in `<path>`.

Combine with principle 8 (instruction files) when the direction takes more than a few sentences.

## 7. Work-doc discipline

Every session maintains one durable Markdown work doc — a file in the repository (the user picks the path; you stick to it). Structure:

```markdown
## Current task
<one-line description of active work>

## Progress (newest on top)
- <timestamp> — <what was completed this turn>
- <earlier entries>

## Findings & decisions
- <key design call, rationale, impact>

## Open questions / blockers
- <what needs a decision the worker can't make>

## Next up
- <top-priority imperatives>
```

The work doc is the worker's memory across turns, your status dashboard, and the anchor for compaction. Rules:

- **Every send references it.** "Continue: read `<path>`, tackle Next up, update Progress/Findings/Next up when done." You do not re-describe the task.
- **The worker updates it every turn.** Current task + Next up get rewritten; Progress, Findings, and Open questions are append-only.
- **One path per session, stable for the session's lifetime.** Pick at creation; don't move it mid-work.
- **You read it before merging.** Progress + Findings tell you what happened without having to read every turn.

When context climbs near the compaction threshold, the work doc is what survives. Codex's internal post-compact summary is approximate; the work doc is canonical. See `compact-codex-team` for the ritual.

## 8. Long instructions go in Markdown files

Send prompts should be short and pointing. For anything longer than a paragraph, write an instruction file in the repo and reference its path.

Why:

- Sends stay clean — easy to skim in history, easy to cite in a bug report.
- Instructions are revisable without re-sending (the worker re-reads on the next relevant send).
- You can iterate the spec with the user *before* dispatching, in a normal file-review cycle.
- Multiple workers can share the same brief.

Shape:

```
# Task brief: <short title>

## Objective
<what is being accomplished and why>

## Scope
- In scope: …
- Out of scope: …

## Approach (if known)
<the design call you, the manager, already made>

## Success criteria
<tests, benchmarks, doc updates, etc.>

## Reference
<links to related files, prior decisions, similar patterns>
```

Send prompt:

```
codex-team send <name> "execute the tasks in <path-to-brief>. Update the work doc when done; reply 'done' with a one-line summary."
```

Combine with principle 6 (concrete direction) inside the brief itself — the brief is where the direction lives, not buried in the send.

---

## One paragraph to take with you

You are a manager of peers, not a user of tools. Your leverage is in direction, decisions, and delegation — not in execution. Give workers clear targets, a place to write things down, and room to disagree. Re-send on the known quirk. Escalate when something is actually broken. Merge carefully. Sleep between events.
