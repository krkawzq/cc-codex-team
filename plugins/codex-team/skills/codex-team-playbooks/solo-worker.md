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

# fixer profile (see configure-codex-team/profiles-library.md)
codex-team -b $TOK session new worker --cwd /repo \
  --model gpt-5.4 --sandbox workspace-write --approval on-request --effort high \
  --auto-approve 'git*,npm test,vitest*'
codex-team -b $TOK cursor save solo-tail

codex-team -b $TOK message send worker "<brief>"
```

If you want resumable async monitoring, keep this open in a separate terminal or Monitor tool:

```bash
codex-team -b $TOK monitor events --stream --summary --cursor solo-tail
```

If you are just blocked waiting on the worker, skip the monitor and use:

```bash
codex-team -b $TOK message wait worker --timeout 0
```

Claude:

1. Watches events for `turn.completed` / `approval.*` / `user_input.request`
2. Responds to approvals per `manage-codex-team/approvals.md`
3. On `turn.completed`, fetches via `message tail worker -n 1 --format markdown`
4. Decides: send follow-up, detach, or leave running

Notes:

- If you are actively blocked on the worker, `message wait` is simpler and more reliable than a polling loop.
- `turn.completed` is still just the terminal boundary signal. In 0.5.5, fetch substance with `message tail ... --format markdown`, which now renders rich tagged content for reasoning, shell output, file patches, tool calls, and messages.
- If you do not want unattended approvals, pass `--auto-approve ""` or omit the flag and rely on the daemon default being empty.

## Termination

```bash
codex-team -b $TOK session detach worker --graceful
```

## When to escalate

If the worker produces clearly wrong output twice in a row, don't try again — switch to `plan-execute-verify` or `worker-reviewer`. More work upfront, less thrash.
