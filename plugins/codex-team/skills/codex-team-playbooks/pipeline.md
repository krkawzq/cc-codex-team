# Pipeline

## Adoption signal

- Task has distinct sequential stages, each transforming the output of the previous
- Each stage is a specialist role
- Stages can't be merged without losing quality (otherwise use solo-worker)

Examples:

- `explore → design → implement → test → review`
- `parse → normalize → migrate → validate`
- `spec → draft → edit → publish`

## Team

One session per stage. Roles and profiles are stage-specific:

| Stage | Profile |
|---|---|
| `explorer` | `explorer` (read-only) |
| `designer` | `planner` (read-only, xhigh effort) |
| `implementer` | `fixer` (workspace-write) |
| `tester` | `tester` (workspace-write, medium effort) |
| `reviewer` | `reviewer` (read-only, xhigh effort) |

## Shared artefacts

- `<cwd>/.codex-team/brief.md` — overall brief
- `<cwd>/.codex-team/<stage-name>.md` — each stage writes its handoff file

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null

cd /repo
mkdir -p .codex-team
echo "$BRIEF" > .codex-team/brief.md

stages=(explorer designer implementer tester reviewer)
profiles=(explorer planner fixer tester reviewer)

for i in "${!stages[@]}"; do
  codex-team -b $TOK session new "${stages[$i]}" --profile "${profiles[$i]}" --cwd "$(pwd)"
done
```

### Run the stages

Claude runs each sequentially, waiting for `turn.completed` before starting the next:

```
stage explorer:
  message send explorer "Read brief.md. Survey the codebase. Write findings to .codex-team/explorer.md."
  wait for turn.completed.

stage designer:
  message send designer "Read brief.md and .codex-team/explorer.md. Propose a design in .codex-team/designer.md."
  wait.

stage implementer:
  message send implementer "Read brief.md and .codex-team/designer.md. Implement the design. Log your progress in .codex-team/implementer.md."
  wait.

stage tester:
  message send tester "Run the test suite. Log results in .codex-team/tester.md."
  wait.

stage reviewer:
  message send reviewer "Read everything in .codex-team/*.md. Write .codex-team/reviewer.md with verdict + any concerns."
  wait.

Claude reads reviewer.md, decides to ship or loop back.
```

## Handling stage failures

Each stage's exit verdict can be: `accept`, `retry`, `back-up-N-stages`. Claude reads the stage's output file + latest `turn.completed` status:

- `turn.status == "failed"` → look at `codex_error_info`; maybe retry the stage
- Stage output empty or unusable → message the stage again with a sharpened prompt
- Stage output says "blocked by earlier stage's mistake" → go back N stages and redo from there

Cap: don't back up more than once per pipeline run; escalate to plan-execute-verify or worker-reviewer if you're thrashing.

## Parallel early stages

When two stages are independent (e.g. `explorer` and `read-prior-art`), kick them off in parallel:

```bash
codex-team -b $TOK message send explorer "..."
codex-team -b $TOK message send prior-art "..."
# wait for both turn.completed, then proceed to designer
```

## Termination

```bash
for s in "${stages[@]}"; do codex-team -b $TOK session detach "$s"; done
```

## Anti-patterns

- Using a pipeline for work that's actually one stage. Adds 5× context without quality gain.
- Skipping stages because "this task is easy". If you decide you don't need a stage, remove it from the playbook — don't just stop calling it.
- Stages writing to each other's files. One file per stage, owned by that stage.
