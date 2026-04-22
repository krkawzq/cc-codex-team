# Plan – execute – verify

## Adoption signal

- Task is complex enough to benefit from an explicit upfront plan
- Execution is non-trivial (multi-step, multi-file)
- A verification step has clear, checkable criteria (tests pass, lints clean, diff reviewed)

Not the same as a pipeline — here the three stages have named roles with strict separation of concerns.

## Team

| Session | Role | Profile |
|---|---|---|
| `planner` | Produces the plan | `planner` (read-only, xhigh) |
| `executor` | Executes the plan step-by-step | `fixer` (workspace-write, on-request) |
| `verifier` | Runs checks, produces pass/fail | `reviewer` (read-only, xhigh) |

## Shared artefacts

- `<cwd>/.codex-team/brief.md` — Claude writes
- `<cwd>/.codex-team/plan.md` — planner writes (ordered list of steps, each with acceptance criterion)
- `<cwd>/.codex-team/execution.md` — executor writes (log of what was done per step)
- `<cwd>/.codex-team/verification.md` — verifier writes (step-by-step verdict + overall)

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null

cd /repo
mkdir -p .codex-team
echo "$BRIEF" > .codex-team/brief.md

codex-team -b $TOK session new planner  --profile planner  --cwd "$(pwd)"
codex-team -b $TOK session new executor --profile fixer    --cwd "$(pwd)"
codex-team -b $TOK session new verifier --profile reviewer --cwd "$(pwd)"
```

### Phase 1 — Plan

```
message send planner "Read .codex-team/brief.md. Produce .codex-team/plan.md:
  - Ordered list of steps (no more than 10)
  - Each step: what to do, what files it touches, acceptance criterion
  - End with overall acceptance criterion

Do not execute. Do not modify any files outside .codex-team/."
```

Wait for turn.completed. Claude reads plan.md. If obviously wrong, message send planner with targeted feedback. Otherwise proceed.

### Phase 2 — Execute

```
message send executor "Read .codex-team/brief.md and .codex-team/plan.md.
Execute every step. Log each step's outcome in .codex-team/execution.md with headings.
Stop at the first step you can't complete; explain why."
```

Executor may fire `approval.command_execution` / `approval.file_change` events. Claude responds per `manage-codex-team/approvals.md`, using brief.md as the reference for what's in scope.

If executor stops mid-plan: Claude reads execution.md, decides whether to adjust plan (message planner again) or retry the failing step.

### Phase 3 — Verify

```
message send verifier "Read .codex-team/plan.md and .codex-team/execution.md.
For each step in the plan:
  - Did it get done? (check execution.md)
  - Does the acceptance criterion hold? (check the actual files / run tests)
Write .codex-team/verification.md: per-step verdict + overall accept / reject.
If reject, list concrete follow-ups."
```

Claude reads verification.md. If accept: detach all; done. If reject: decide — do we message executor to address the gaps, or restart planning?

## When to short-circuit

- Trivial task: skip planner; solo-worker is fine.
- Plan obviously incomplete: send planner again with feedback — don't execute a half-plan.
- Verification keeps rejecting: the plan is probably wrong. Go back to planner, not executor.

## Parallel variants

- **Parallel planning**: two planners with different approaches, then pick. Expensive but useful for novel problems.
- **Parallel execution**: if plan steps are independent, spawn N `executor-<i>` sessions, each assigned a subset. Reduce to single verifier.

## Termination

```bash
for s in planner executor verifier; do codex-team -b $TOK session detach "$s"; done
```

## Anti-patterns

- Letting planner write code. Planner describes; executor does.
- Letting executor skip the plan. If executor decides "I'll just do it my way," abort — it's not following the protocol, and verifier has nothing to verify against.
- Verifier in workspace-write mode. Must be read-only so it doesn't paper over problems.
