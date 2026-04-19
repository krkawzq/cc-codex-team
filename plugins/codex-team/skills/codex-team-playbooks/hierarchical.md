# Playbook: Hierarchical (Tech-Lead)

**Team size:** 2 + N (tech-lead + N sub-workers) · **Pattern:** Tech-lead worker coordinates sub-workers; Claude coordinates the tech-lead.

## Adoption signal

- Task is large enough that it has **internal decomposition** — not 3 independent chunks, but a *structured* breakdown that needs a middle manager.
- Breakdown itself is a judgment call the worker can make (you shouldn't micromanage every sub-task).
- You want a single integration point (the tech-lead) rather than managing N sub-workers yourself.

Examples:

- Refactor a subsystem into 5-8 related files — tech-lead sequences the edits, sub-workers execute chunks.
- Port a package where one module depends on another — tech-lead orders the porting, sub-workers port each module.
- Land a feature across backend + frontend + migration — tech-lead coordinates the interface, sub-workers own each layer.

Not this playbook when:

- Sub-tasks are genuinely independent → `map-reduce.md`. Don't add a tech-lead tax you don't need.
- Task has natural linear stages → `pipeline.md`.
- You want to do the tech-lead work yourself → just be the manager; `solo-worker.md` or `map-reduce.md` without the lead.

## Team composition

| Session | Role | Profile |
|---|---|---|
| `tech-lead` | Reads task brief; decomposes into sub-tasks; writes sub-briefs; coordinates sub-workers via sub-brief files; reports to Claude. | `worker` with high effort + detailed summary |
| `sub-worker-<id>` × N | Each handles one sub-brief. Reads that sub-brief only. Reports back to tech-lead via their own work doc. | `worker` |

**Key distinction from `map-reduce.md`**: in map-reduce, Claude writes the N briefs and dispatches the N workers. In hierarchical, Claude writes *one* brief to the tech-lead; the tech-lead writes the sub-briefs and dispatches nothing (the tech-lead can't dispatch — only Claude can). So Claude reads the tech-lead's sub-briefs and issues the actual `codex-team send` commands.

## Shared artefacts

- **Master brief**: `/<repo>/docs/briefs/<task>-master.md` — Claude → tech-lead.
- **Sub-briefs** (tech-lead writes): `/<repo>/docs/briefs/<task>-sub-<id>.md`. One per sub-worker.
- **Tech-lead's plan doc**: `/<repo>/docs/hierarchical/<task>-lead.md` — decomposition, sub-brief index, status, open decisions.
- **Per-session work doc**: `/<repo>/docs/worker/<session-name>-work.md`. One per session (tech-lead + each sub-worker).

## Communication flow

```
                 master brief
                      │
                      ▼
                 [tech-lead]
                 writes plan + sub-briefs
                      │
       ┌──────────────┼──────────────┐
       │ (Claude dispatches)          │
       ▼              ▼               ▼
  [sub-1]        [sub-2]         [sub-N]
     │              │               │
  reads          reads           reads
  sub-brief-1    sub-brief-2     sub-brief-N
     │              │               │
     ▼              ▼               ▼
  work-sub-1  work-sub-2     work-sub-N
     │              │               │
     └──────────────┴───────────────┘
                      │
                      ▼  (Claude relays)
                 [tech-lead]
                 reads sub-work-docs
                 updates plan
                      │
                      ▼
                    Claude
```

**Critical asymmetry**: tech-lead **plans and audits**, but does not execute sub-tasks and does not have dispatch authority. Only Claude can `codex-team send`. So the tech-lead writes sub-briefs to paths, and Claude uses those paths as the input to sub-worker sends.

**Why this asymmetry**: if workers could dispatch workers, you'd have a proliferating tree that loses traceability. Keeping Claude at the root of all sends keeps the trace tight.

## Tech-lead's plan doc shape

```markdown
# <task> — tech-lead plan

## Decomposition
- Sub-task 1 (sub-brief: <path-1>) — <one-line summary> — status: not-started | in-progress | done
- Sub-task 2 (sub-brief: <path-2>) — ... — status: ...
- ...

## Dependencies
- Sub-task 2 depends on sub-task 1 completing
- Sub-task 3 can run in parallel with sub-task 2

## Integration points
- <point 1: what has to line up across sub-tasks>

## Open decisions (need Claude input)
- <question 1>

## Next dispatch recommendation
- Claude should send sub-worker-<X> next, pointing at <sub-brief-path>
```

## Iteration loop

```
Phase 0 (Plan):
  1. Send tech-lead: read master brief, write plan doc + sub-briefs. Do not execute.
  2. Wait for turn-done.
  3. Claude reads plan doc.
     - Missing pieces? Re-dispatch tech-lead.
     - Otherwise: dispatch the recommended sub-worker(s).

Phase 1+ (Execute):
  4. Claude dispatches sub-worker(s) per tech-lead's recommendation, using sub-brief paths.
  5. Sub-workers execute. Each turn-done arrives.
  6. Claude periodically (or on every sub-worker done) sends tech-lead an "audit" send: "read sub-worker-<X>'s work doc; update plan doc's status and next dispatch".
  7. Tech-lead updates plan.
  8. Claude dispatches the next sub-worker(s) per the updated plan.
  9. Loop until plan shows all sub-tasks done.

Phase N (Integrate):
  10. Tech-lead does the integration step if it's a coding task (merge the work, run full tests).
  11. Claude audits and merges.
```

## Send templates

**Tech-lead — planning send:**

```
codex-team send tech-lead "plan only: read <master-brief-path>; produce a plan doc at <plan-path> with Decomposition / Dependencies / Integration points / Open decisions / Next dispatch recommendation; write sub-brief files to <sub-briefs-dir>/<task>-sub-<id>.md for each sub-task (using the Brief template from send-patterns.md). Do not modify code yet. Create the work doc at <lead-work-path>. Reply 'plan ready' with the count of sub-tasks"
```

**Tech-lead — audit send (after sub-worker finishes):**

```
codex-team send tech-lead "audit: sub-worker-<X> has reported done on sub-task <id>. Read <sub-worker-work-path>'s latest Progress + Findings; update <plan-path>'s status for sub-task <id>; re-evaluate Next dispatch recommendation; update Open decisions if sub-worker raised new questions. Reply 'audit done' with next recommendation"
```

**Tech-lead — integration send:**

```
codex-team send tech-lead "integrate: all sub-tasks are reported done per <plan-path>. Verify the integration points listed in the plan; run the repo's test suite; update <plan-path>'s status to final. If anything fails, list specifics in Open decisions. Reply 'integration done' with pass/fail"
```

**Sub-worker — first send** (Claude uses the path tech-lead wrote):

```
codex-team send sub-worker-<id> "execute the tasks in <sub-brief-path-id> (the tech-lead at tech-lead session wrote this brief). Create the work doc at <sub-worker-work-path>; update Progress/Findings/Next up; do not run git commit|merge|push; reply 'done' with a one-line summary when complete"
```

**Sub-worker — continue:**

```
codex-team send sub-worker-<id> "continue: read <sub-worker-work-path>, tackle the top Next up item, update the work doc; reply 'done' when complete"
```

**Answering tech-lead's Open decision:**

```
codex-team send tech-lead "decision: <the question the tech-lead raised> — answer: <your call>. Update <plan-path>'s Open decisions accordingly; re-evaluate Next dispatch recommendation"
```

## Exit criteria

- Tech-lead's plan doc shows all sub-tasks status=done.
- Integration send reports pass.
- Claude has read the plan doc + integration report.

## Failure modes

| Smell | Fix |
|---|---|
| Tech-lead produces vague sub-briefs | Plan-send prompt must require sub-briefs to follow the Brief template with Scope, Approach, Success criteria, Reference. Re-dispatch if missing. |
| Claude forgets to audit after each sub-worker finishes | Make it a habit: every `turn-done` from a sub-worker triggers the audit send to tech-lead. The plan doc is your dashboard. |
| Tech-lead tries to dispatch sub-workers itself | Workers can't dispatch — sends will fail or go nowhere. But tech-lead may *phrase* its plan as if it can. Re-anchor: "do not dispatch; only Claude sends. Write sub-briefs and the Next dispatch recommendation only." |
| Two sub-workers modify the same file | Dependencies were missed in tech-lead's plan. Claude must re-dispatch tech-lead for a revised plan before resuming. |
| Tech-lead accumulates context that should live in work docs | Tech-lead's own work doc exists; use it. Tech-lead isn't a special case. |
| Integration fails and tech-lead can't diagnose | Bring in a `worker-reviewer.md` inner loop for the integration step, or dispatch a dedicated `debug` sub-worker. |
| You're talking to sub-workers directly without going through tech-lead | If you're bypassing the tech-lead repeatedly, you probably don't need the playbook. Collapse to `map-reduce.md`. |

## Variants

- **Hierarchical + reflexion**: each sub-worker runs an inner `reflexion.md` on its sub-artefact. Outer hierarchical doesn't care.
- **Hierarchical with critic**: add a critic session that reviews the tech-lead's plan before sub-workers dispatch. Tech-lead writes plan → critic reviews → Claude arbitrates → dispatch.

## Related

- If sub-tasks are genuinely independent → `map-reduce.md` (no tech-lead).
- If the structure is fully linear → `pipeline.md` (no tech-lead, just stages).
- If you need multi-round critique on the tech-lead's plan → `debate.md` on the plan first, then hierarchical.
