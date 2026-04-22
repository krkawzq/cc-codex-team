# Solo worker

## Adoption signal

- Task is one coherent unit of work (add a feature, fix a bug, refactor a module)
- No natural subtask split
- Reviewer loop not worth the overhead

## Team

One session. Role: worker. Profile: `fixer` (or task-specific).

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null

codex-team -b $TOK session new worker --profile fixer --cwd /repo

# Arm events in a Monitor tool (not shown; see manage-codex-team)

codex-team -b $TOK message send worker "<brief>"
```

Claude:

1. Watches events for `turn.completed` / `approval.*` / `user_input.request`
2. Responds to approvals per `manage-codex-team/approvals.md`
3. On `turn.completed`, fetches via `message tail worker -n 1 --format markdown`
4. Decides: send follow-up, detach, or leave running

## Termination

```bash
codex-team -b $TOK session detach worker --graceful
```

## When to escalate

If the worker produces clearly wrong output twice in a row, don't try again — switch to `plan-execute-verify` or `worker-reviewer`. More work upfront, less thrash.
