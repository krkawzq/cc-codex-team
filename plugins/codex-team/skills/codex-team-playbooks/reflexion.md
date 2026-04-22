# Reflexion

## Adoption signal

- Task where a first attempt often fails but the failure mode is learnable
- Need explicit self-critique between attempts, not just "try again"
- Iterations are bounded (2–3 total)

Classic use: "Fix a flaky test" — first attempt often misunderstands the flakiness; second attempt informed by a critique does better.

## Team

Two sessions:

| Session | Role | Profile |
|---|---|---|
| `worker` | Attempts the task | `fixer` |
| `critic` | Reviews the worker's failure and produces a lesson for the next attempt | `reviewer` |

The worker is the same session across iterations (keeps context). The critic is a separate session because it needs adversarial distance.

## Shared artefacts

- `<cwd>/.codex-team/brief.md` — task
- `<cwd>/.codex-team/attempt-<n>.md` — worker's attempt log, one per iteration
- `<cwd>/.codex-team/lesson-<n>.md` — critic's lesson, one per iteration

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null
codex-team -b $TOK cursor save reflexion-tail

cd /repo
mkdir -p .codex-team
echo "$BRIEF" > .codex-team/brief.md

codex-team -b $TOK session new worker --profile fixer    --cwd "$(pwd)" \
  --auto-approve 'git*,npm test,vitest*'
codex-team -b $TOK session new critic --profile reviewer --cwd "$(pwd)"

N=3  # max iterations
```

In a separate terminal or Monitor tool:

```bash
codex-team -b $TOK monitor events --stream --summary --cursor reflexion-tail
```

### Main loop

```
for n in 1..N:
  # Attempt
  if n == 1:
    message send worker "Read .codex-team/brief.md and attempt the task. Log your work in .codex-team/attempt-1.md."
  else:
    message send worker "Read .codex-team/lesson-$((n-1)).md. Attempt again with that lesson in mind. Log this attempt in .codex-team/attempt-$n.md."

  codex-team -b $TOK message wait worker --timeout 0

  # Run verification (tests, lint, etc.) externally
  if verification passes:
    detach both sessions; done.

  # Critique
  message send critic "Read .codex-team/brief.md and .codex-team/attempt-$n.md. Diagnose:
    - What did the worker assume that turned out false?
    - What's the root cause of the failure?
    - One concrete lesson to apply in the next attempt.
  Write to .codex-team/lesson-$n.md."

  codex-team -b $TOK message wait critic --timeout 0

# Ran out of iterations
escalate.
```

`turn.completed` is only the completion signal now; it does not embed the attempt or lesson items. Read the files or `message tail` when you need the content.

## Why two sessions

A worker's own reflection tends to reinforce its errors. A dedicated critic session, with no context from the worker's reasoning, spots assumptions the worker can't see.

## Variants

- **Persistent critic**: keep the critic across tasks (it builds expertise about your project)
- **Critic targets**: force the critic to look at one specific thing (e.g. "diagnose timing issues only")
- For trusted fix loops, the worker can inherit a daemon default `session.auto_approve_command_patterns` instead of repeating `--auto-approve` on every run.

## Termination

```bash
codex-team -b $TOK session detach worker
codex-team -b $TOK session detach critic
```

## Anti-patterns

- Letting the worker read its previous attempt directly. It should only see the lesson. Direct access to the old attempt reinforces the same reasoning.
- Skipping the critic between iterations. That's just retrying — different from reflexion.
- Unbounded iterations. Cap at 3. If still failing, the problem isn't iteration — it's diagnosis (switch to `plan-execute-verify`).
