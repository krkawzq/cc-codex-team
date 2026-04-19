# Work doc

Reference for `manage-codex-team`. **The single source of truth** for work-doc discipline. `philosophy.md` §7 sets the principle; this file is the operational template. No other skill restates either.

Every session owns **one durable Markdown work doc** — a real file in the repo, at a path the user picks at session creation. You stick with that path for the session's lifetime.

---

## Template

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

Adapt section names to the session's nature — e.g. a reviewer's work doc might replace `Next up` with `Issues raised`, a porter's with `Modules remaining`. Keep the spirit: current + history + findings + blockers + forward list.

## Rules

- **One path per session, stable for the session's lifetime.** The user picks at creation. Don't move it mid-work.
- **Every send references it.** "Continue: read `<path>`, tackle `Next up`, update `Progress / Findings / Next up` when done." You do not re-describe the task.
- **The worker updates it every turn.** `Current task` and `Next up` get rewritten; `Progress`, `Findings`, `Open questions` are append-only.
- **You read it before merging.** `Progress` + `Findings` tell you what happened without reading every turn.
- **One doc per session.** If you need cross-session shared state, that's a separate **brief** file (see `send-patterns.md` §2.3), not the work doc.

## Creating the doc

If the work doc doesn't exist at session creation, your opening send should instruct the worker to create it at the agreed path, seeded with the template above:

```
codex-team send W "create <path> with sections Current task / Progress / Findings & decisions / Open questions / Next up, all empty except Current task which is '<one-line-summary>'. Reply 'created' with the absolute path."
```

## Why it's load-bearing

- It's the worker's **memory across turns** — your every send points at it instead of re-describing the task.
- It's your **status dashboard** — you read it to audit what the worker has been doing, without parsing raw `history.md`.
- It's the **anchor for compaction** — when the thread is compacted, the internal codex summary is approximate; the work doc is canonical. See `recover-codex-team/compaction-ritual.md`.

## Work doc vs history vs brief

| File | Written by | Purpose |
|---|---|---|
| **Work doc** | The worker, every turn | Current state + history + findings + forward list. One per session. **Canonical.** |
| **Brief** | You (or the user) before dispatch | Task specification — objective, scope, approach, criteria, references. One per logical task; can be shared across workers. |
| `history.md` | The daemon (automatic) | Raw turn-by-turn digest. Long, not distilled. Read for gaps only. |
| `turns.jsonl` | The daemon (automatic) | Machine-readable turn records. For programmatic queries. |

When you need to understand a session's state, read in this order:

1. **Work doc** — what the worker thinks has happened.
2. `history <name> --format md --last-n 3` — what actually happened in recent turns.
3. `tail <name> --stderr` — what broke, if anything.

## Failure modes (anti-patterns)

| Smell | What to do |
|---|---|
| Work doc hasn't been updated in N turns | Re-anchor the send: "before continuing, append a Progress entry for what you did last turn". |
| Work doc grows to thousands of lines without distillation | The worker is appending raw notes. Re-anchor: keep Current/Next up tight; prune Progress to the last week. Compact if needed. |
| Two sessions writing to the same work doc | Forbidden. One doc per session. If the sessions are collaborating, they each write to their own doc and a shared **brief** coordinates them. |
| Send doesn't reference the work doc | You're re-describing the task in the send. That defeats the whole mechanism. Point at the doc and let the worker read it. |
| You merged without reading the work doc | Your audit surface is the doc. Always read Progress + Findings before merging. |

## Recovery interaction

When `recover-codex-team/compaction-ritual.md` runs Step 1, the worker writes a dense dump into this work doc. That's why it must exist and be current at all times. If it hasn't been maintained, Step 1 produces weaker output.
