# Playbook: Plan-Execute-Verify

**Team size:** 3 · **Pattern:** Planner proposes, Executor implements, Verifier audits — each its own session.

## Adoption signal

- One concrete deliverable (a feature, a migration, a non-trivial bug fix).
- Correctness is high-stakes; you want each phase scrutinised by a different session.
- Brief already specifies *what* but not *how* — the planner fills in the *how*.

This is a stricter cousin of `pipeline.md`. Pipeline has 2-4 arbitrary stages; plan-execute-verify is always exactly three and carries a specific semantics: planning → execution → verification against the plan.

Not this playbook when:

- The *what* and *how* are both already fixed in the brief → `solo-worker.md`.
- Stages are design/implement/test/docs (4-stage SDLC) → `pipeline.md`.
- Iteration dominates (many rounds of critique → `reflexion.md`).

## Team composition

| Session | Role | Profile |
|---|---|---|
| `planner` | Reads brief + repo; produces an explicit plan (steps + expected outcomes + tests to run). Does not execute. | `worker` with high effort |
| `executor` | Reads plan; executes it step by step; updates work doc. Does not plan or verify. | `worker` |
| `verifier` | Reads plan + what executor actually did; checks each step for conformance; writes a pass/fail verdict per step. | `reviewer` |

## Shared artefacts

- **Brief**: `/<repo>/docs/briefs/<task>-brief.md` — shared, Claude-owned. Specifies *what* to accomplish and success criteria.
- **Plan doc**: `/<repo>/docs/pev/<task>-plan.md` — the planner's output. Read-only for executor and verifier.
- **Execution log**: `/<repo>/docs/pev/<task>-exec.md` — the executor's step-by-step record. Read by verifier.
- **Verification report**: `/<repo>/docs/pev/<task>-verify.md` — the verifier's pass/fail matrix. Read by Claude.
- **Per-session work doc**: `/<repo>/docs/worker/<session-name>-work.md`. Internal progress log per session.

## Plan doc shape

```markdown
# Plan for <task>

## Objective
<restatement from brief>

## Approach
<the design call the planner made>

## Steps
1. <step> — expected outcome: <outcome>; verification: <how to check>
2. <step> — …
N. <step> — …

## Risks / uncertainty
- <risk 1> — mitigation: <mitigation>
- ...

## Success criteria (from brief)
- <criterion 1> — verified by: <step N in this plan>
```

The **verification column** is what makes this playbook stricter than a pipeline. Every step has a named way to confirm it worked.

## Execution log shape

```markdown
# Execution of <task>

## Step 1
- Action taken: <exact commands / files changed>
- Result: <what actually happened>
- Deviation from plan: <yes/no; details if yes>

## Step 2
...
```

## Verification report shape

```markdown
# Verification of <task>

## Per-step

| # | Plan step | Expected | Actual | Verdict |
|---|---|---|---|---|
| 1 | <step> | <expected> | <actual> | pass / fail / partial |
| 2 | ... | ... | ... | ... |

## Overall
- Brief success criteria 1: pass/fail
- Brief success criteria 2: pass/fail

## Blockers to merge
- <issue 1> — severity: low/med/high
```

## Iteration loop

```
Phase 1 (Plan):
  1. Send planner: produce plan doc.
  2. Wait for turn-done.
  3. Claude reviews the plan. If weak/wrong: re-dispatch planner with specifics. If okay: proceed.

Phase 2 (Execute):
  4. Create executor session. Dispatch with plan doc as input.
  5. Executor works through steps; updates execution log + own work doc.
  6. Wait for turn-done. If executor asks questions (via turn-attn), answer.
  7. When executor reports done, proceed.

Phase 3 (Verify):
  8. Create verifier session. Dispatch with plan + execution log as inputs.
  9. Wait for turn-done. Verifier produces verification report.
  10. Claude reads the report.
      - All pass → merge (Claude-owned), close sessions.
      - Any fail → either (a) re-dispatch executor to fix that step, and re-verify;
                   or (b) re-dispatch planner if the step was under-specified.
```

Phase 3 may loop back into Phase 2 (or Phase 1) if the verdict is fail.

## Send templates

**Planner — first send:**

```
codex-team send planner "plan-only: read <brief-path>; read the relevant files listed in the brief's Reference section; produce a plan doc at <plan-path> using the template with Objective / Approach / Steps (each with expected outcome + verification) / Risks / Success criteria mapping. Do not modify code. Create the work doc at <planner-work-path>. Reply 'plan done' with a one-line summary of your approach."
```

**Planner — rework:**

```
codex-team send planner "rework plan: the current plan at <plan-path> is insufficient because <specific reason>. Update it; keep the same template. Reply 'plan done' when the gap is closed."
```

**Executor — first send:**

```
codex-team send executor "execute: read <brief-path> for context, read <plan-path> for the plan; execute each step in order; record actual results + any deviations in <exec-path> using the template; create the work doc at <executor-work-path>; do not run git commit|merge|push; reply 'execution done' with a one-line summary"
```

**Executor — fix a failed step:**

```
codex-team send executor "step <N> failed verification because <reason>. Read verifier's note in <verify-path> under the row for step <N>; re-execute that step with the correction; update <exec-path>'s step <N> section; reply 'step <N> reworked'"
```

**Verifier — first send:**

```
codex-team send verifier "verify: read <brief-path> for success criteria, read <plan-path>, read <exec-path>; produce <verify-path> using the template — per-step pass/fail with actual-vs-expected + brief success criteria pass/fail; do not modify code; create the work doc at <verifier-work-path>; reply 'verification done' with overall verdict"
```

**Verifier — re-verify a single step:**

```
codex-team send verifier "re-verify step <N>: the executor reworked it. Read <exec-path>'s step <N> again; update only step <N>'s row in <verify-path>; reply 're-verified' with the new verdict"
```

## Exit criteria

- Verification report shows all plan steps `pass` and all brief success criteria `pass`.
- No `fail` / `partial` verdicts in the report (or Claude has explicitly accepted them as out-of-scope).

## Failure modes

| Smell | Fix |
|---|---|
| Planner produces a plan that looks like the brief restated | Plan needs *concrete steps with verification method* per step. Re-dispatch with "each step must name the file touched and how to verify". |
| Executor deviates from plan without flagging it | Executor's prompt must require explicit deviation notes per step. See template. |
| Verifier rubber-stamps everything | Verifier prompt must demand actual-vs-expected comparison per step with evidence. Raise reasoning_effort if needed. |
| Verifier modifies code to "fix" issues it found | Forbidden. Verifier writes findings; re-dispatch executor to fix. Enforce in verifier profile's `developer_instructions`. |
| Plan gets obsolete after partial execution | Re-dispatch planner with updated context — treat it as a plan revision. Don't let executor improvise in a changed world. |
| Session management: you keep all three sessions open the whole time | Fine if resources allow; otherwise close planner after Phase 1, close executor after Phase 2. Threads preserved, can be resumed if rework needed. |

## Variants

- **Plan-Execute only** (2 sessions, no verifier). Drop if correctness risk is low. Effectively a `pipeline.md` with 2 stages.
- **Plan-Execute-Verify-Refine** (add Refiner session for polish). Rare — if refinement is needed, it usually means verification found failures; use the normal rework loop.
- **Nested plan**: Executor's step N internally spawns a sub-session using `solo-worker.md`. Outer playbook doesn't care; executor is responsible for the sub-session.

## Related

- For continuous design → implement → test → doc pipeline without strict verify phase → `pipeline.md`.
- For iterative critique on a single deliverable → `reflexion.md`.
- For adversarial design review with multiple plan proposals → `debate.md` first to pick the plan, then `plan-execute-verify.md` to execute it.
