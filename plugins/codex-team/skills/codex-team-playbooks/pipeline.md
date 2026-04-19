# Playbook: Pipeline / Relay

**Team size:** N (2-4 typical) · **Pattern:** Sequential stages. Each stage's output feeds the next via a stage doc.

## Adoption signal

- Task has natural sequential stages: **design → implement → test → document** (or a subset).
- Each stage is substantive enough to deserve its own session (otherwise fold into `solo-worker.md`).
- Stage-k depends on stage-(k-1) — work doesn't parallelise.

Examples:

- New feature: architect designs it, implementer builds it, tester writes tests, docs-writer documents.
- Data migration: planner drafts migration, executor runs it, validator checks data integrity.
- API refactor: designer produces spec, implementer lands the change, doc-writer updates public docs.

Not this playbook when:

- Stages can run concurrently → `map-reduce.md`.
- Work iterates between two roles → `worker-reviewer.md` or `reflexion.md`.
- You're just chaining two sends in the same session → don't use sessions per step.

## Team composition

| Session | Role | Profile |
|---|---|---|
| `stage-1-<name>` (e.g. `architect`) | Owns stage 1's artefact. | `worker` (or role-specific profile) |
| `stage-2-<name>` (e.g. `implementer`) | Consumes stage 1's output; produces stage 2. | `worker` |
| `stage-3-<name>` (e.g. `tester`) | Consumes stage 2; produces stage 3. | `worker` |
| `stage-N-<name>` (e.g. `doc-writer`) | Final stage. | `worker` |

Each stage is its own session; don't reuse one session across stages even if it would technically work — you lose the role-specific profile + focused work doc.

## Shared artefacts

- **Master brief**: `/<repo>/docs/briefs/<task>-brief.md`. Describes overall goal, all stages, stage contracts (what each stage must produce for the next).
- **Stage docs**: one per stage. The *output* of stage k — `/<repo>/docs/pipeline/<task>-stage-1-design.md`, `<task>-stage-2-impl-notes.md`, etc.
- **Per-session work doc**: `/<repo>/docs/worker/<session-name>-work.md`. Progress / Findings / Next up for that stage only.

**Stage docs are the baton.** Stage k writes its stage doc; stage (k+1) reads it.

## Communication flow

```
                     master brief
                         │
                         ▼
  [stage-1] ── writes ── stage-1.md
                         │
                         ▼ (baton)
  [stage-2] ── reads ── stage-1.md
             ── writes ── stage-2.md
                         │
                         ▼ (baton)
  [stage-3] ── reads ── stage-2.md
             ── writes ── stage-3.md
                         │
                         ▼
                      Claude
```

Claude controls the baton pass. When stage k's session emits `turn-done` with the stage doc complete, Claude closes stage k (or leaves idle) and fires stage (k+1).

## Iteration loop

```
1. Write master brief with clearly named stages and their contracts.
2. Create all N sessions upfront? Or just stage 1 and create next stages on-demand?
   → Create stage 1 now; create next stages when baton passes.
   (Avoids resource cost for later stages that may not be reached.)
3. Dispatch stage 1.
4. On stage-1 turn-done:
   - Read stage-1.md.
   - Verify it meets stage 1's contract from the master brief.
   - If yes: create stage-2 session, dispatch. Close stage-1 (thread preserved).
   - If no: re-dispatch stage 1 with specific feedback.
5. Repeat per stage.
6. After last stage: Claude merges + final review.
```

## Send templates

**First send — stage 1:**

```
codex-team send <stage-1-name> "start: read <master-brief>; your stage is <stage-1-role>; deliver <stage-1-contract> to <stage-1-doc-path>; create the work doc at <work-path>; reply 'stage 1 done' with a one-line summary"
```

**Baton-pass send — stage k:**

```
codex-team send <stage-k-name> "start: read <master-brief> for context; read <stage-(k-1)-doc-path> — that is your input from the previous stage; your stage is <stage-k-role>; deliver <stage-k-contract> to <stage-k-doc-path>; create the work doc at <work-path>; reply 'stage <k> done' with a one-line summary"
```

**Re-dispatch stage k** (after Claude rejected its first attempt):

```
codex-team send <stage-k-name> "rework: your stage <k> output at <stage-k-doc-path> is missing <specific-gap>. Read <stage-(k-1)-doc-path>'s section <relevant-section>. Update <stage-k-doc-path> to address <specific-gap>; reply 'stage <k> done' when the gap is closed"
```

## Contract example (in master brief)

Make the stage contracts explicit in the master brief so each stage knows what to deliver:

```markdown
## Stages

### Stage 1: Design (session: architect)
- Produce <task>-stage-1-design.md with sections: Architecture, Interfaces, Alternatives considered, Decision.
- Must not include implementation details beyond interface shapes.

### Stage 2: Implement (session: implementer)
- Read Stage 1 output.
- Produce the code change + <task>-stage-2-impl-notes.md with sections: Files changed, Key decisions, Open questions, Deviation from design (if any).

### Stage 3: Test (session: tester)
- Read Stage 1 + 2 outputs.
- Produce new tests + <task>-stage-3-test-notes.md with sections: Tests added, Tests updated, Coverage gaps, Failures encountered.

### Stage 4: Document (session: doc-writer)
- Read all prior stages.
- Update public docs + <task>-stage-4-doc-changes.md with section: Doc files changed.
```

The explicit contracts are what makes this playbook work. Without them, stage (k+1) doesn't know what it can rely on.

## Exit criteria

- Every stage's doc meets its contract.
- Final stage's `turn-done` received.
- Claude has reviewed all stage docs in order and approved the pipeline's output.

Close sessions in reverse order (last stage first is conventional but arbitrary).

## Failure modes

| Smell | Fix |
|---|---|
| Stage k produces an ambiguous artefact; stage (k+1) is confused | Master brief's stage contract is weak. Edit + re-dispatch stage k. |
| Stage (k+1) re-does stage k's work | You didn't close stage k's session or didn't anchor stage (k+1) at stage k's doc. Re-anchor with specific path. |
| A stage stalls waiting for a decision only you can make | Read the `Open questions` in that stage's work doc; answer in next send. |
| Stage doc and work doc end up the same file | They're different. Stage doc = output, designed to be read by the next stage. Work doc = session's internal progress log. |
| Claude skips reviewing stage k before dispatching (k+1) | Don't. Every baton-pass is a checkpoint. Spending one read per stage is the whole point. |
| You want to run stages in parallel | Then it's not a pipeline; it's map-reduce. |

## Variants

- **Pipeline with feedback loops**: stage 3 discovers a stage 1 flaw; re-open stage 1. Model this explicitly in the brief's failure-mode section. Don't silently rewind.
- **Pipeline with inner reflexion**: stage k may internally use `reflexion.md` (critic + worker) to refine its artefact before declaring done. You (outer-pipeline Claude) see it as one stage; the inner critic is stage k's concern.

## Related

- Each stage may adopt its own inner playbook — e.g. stage 3's tester session might run `reflexion.md` with a critic verifier. Outer pipeline doesn't care how a stage reaches its done state.
- For non-sequential but multi-phase work where role transitions are dynamic → `swarm.md`.
