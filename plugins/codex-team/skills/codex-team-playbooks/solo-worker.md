# Playbook: Solo Worker

**Team size:** 1 · **Default pattern.** When no other playbook fits better, this is the baseline.

## Adoption signal

- A single, well-scoped task.
- No need for a second pair of eyes.
- Correctness is protected by the worker's own tests + brief, not by a separate reviewer.
- You (Claude) will merge the result yourself after reading the work doc.

If any of these are true → not this playbook:

- Change is large or risky → `worker-reviewer.md`.
- Task splits into independent chunks → `map-reduce.md`.
- Correctness requires independent verification → `plan-execute-verify.md`.

## Team composition

| Session | Role | Profile |
|---|---|---|
| `W` | The worker. Reads the brief, updates the work doc, produces the deliverable. | `worker` |

Session name: `W` is a placeholder. Pick a real name that describes scope — `auth-refactor`, `ingest-fix`, etc.

## Shared artefacts

- **Brief** (optional): `/<repo>/docs/briefs/<task>-brief.md` if the direction takes more than a paragraph. Otherwise the work doc is enough.
- **Work doc**: `/<repo>/docs/worker/<session-name>-work.md` — user picks path; session sticks with it.

## Communication flow

```
brief (read-only)
  │
  ▼
[ W ]  — updates → work doc
  ▲
  │ sends from Claude
  │
Claude
```

- Claude sends, pointing at work doc (or brief).
- Worker executes, updates work doc, replies.
- Claude reads work doc + `turn-done` summary, decides next move.

## Iteration loop

```
1. First send: tell W to start, point at brief/work doc.
2. Wait for turn-done.
3. Read final_message + work doc's Progress / Findings / Next up.
4. Decide:
   - Done?         → merge, close session
   - More work?    → next send, pointing at Next up
   - Blocked?      → answer the Open question in the next send
   - Off-course?   → re-anchor with a constraint
5. Loop.
```

## Send templates

**First send — if there is a brief file:**

```
codex-team send W "start: read <brief-path>; create the work doc at <work-doc-path> with sections Current task, Progress, Findings & decisions, Open questions, Next up; populate Current task and seed Next up with the ordered subtasks; reply 'ready' with the first concrete step"
```

**First send — without a brief (simple task):**

```
codex-team send W "task: <one-sentence task>. Targets: <files>. Constraints: <constraints>. Reference: <paths>. Deliverable: <what you want>. Create the work doc at <work-doc-path>; update Progress/Findings/Next up as you go. Reply 'done' with a one-line summary when finished."
```

**Continue send:**

```
codex-team send W "continue: read <work-doc-path>, tackle the top Next up item, update Progress/Findings/Next up when done; reply 'done' with a one-line summary"
```

**Answering a `turn-attn` question:**

```
codex-team send W "<direct answer, no framing>"
```

**Re-anchoring (when the worker drifts):**

```
codex-team send W "you've been touching <wrong area>; the task is bounded to <correct area>. Re-read the brief and Constraint section. Pick up the next unfinished Next up item."
```

**Long-context skip re-send** (see `recover-codex-team/known-quirks.md`): re-send the previous prompt verbatim, no changes.

## Exit criteria

- Work doc's `Next up` section is empty or marked complete.
- Final turn emitted `done` with the expected summary.
- You've read the work doc's `Progress` + `Findings` and are satisfied.

Then:

```bash
codex-team session close <session-name>
```

The thread is preserved; `session resume` brings it back if follow-up work arrives.

## Failure modes

| Smell | Fix |
|---|---|
| Worker keeps asking for direction | Brief is too thin. Write a brief file; point at it. → `manage-codex-team/send-patterns.md` §2.3. |
| Work doc isn't updating | Every send must reference the work doc *and* say "update Progress/Findings/Next up when done". |
| Worker drifts into scope you didn't ask for | Your brief's `Out of scope` list is missing. Add it and re-anchor. |
| Worker says "done" but no file changes happened | `turn-done` shows trivial tier + no file_change lines. Means worker answered without executing. Re-send with explicit deliverable. |
| You're writing code yourself because "it's faster" | Stop. → `philosophy.md` §1. |

## When to upgrade the playbook

- If you find yourself reviewing the worker's diffs rigorously on each turn → `worker-reviewer.md` (formalise the reviewer).
- If the task grows and you see independent sub-parts → split into multiple sessions under `map-reduce.md`.
- If iteration on one artefact keeps happening → `reflexion.md`.
