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
codex-team -b $TOK cursor save pipeline-tail

cd /repo
mkdir -p .codex-team
echo "$BRIEF" > .codex-team/brief.md

# Each stage uses its own profile bundle (see configure-codex-team/profiles-library.md).
# We spell them out here because the same flag pattern shows up verbatim in every playbook.

codex-team -b $TOK session new explorer    --cwd "$(pwd)" \
  --model gpt-5.4-mini --sandbox read-only --approval never --effort medium
codex-team -b $TOK session new designer    --cwd "$(pwd)" \
  --model gpt-5.4 --sandbox read-only --approval never --effort xhigh
codex-team -b $TOK session new implementer --cwd "$(pwd)" \
  --model gpt-5.4 --sandbox workspace-write --approval on-request --effort high \
  --auto-approve 'git*,npm test,vitest*'
codex-team -b $TOK session new tester      --cwd "$(pwd)" \
  --model gpt-5.4-mini --sandbox workspace-write --approval never --effort medium \
  --auto-approve 'npm test,vitest*,pytest*'
codex-team -b $TOK session new reviewer    --cwd "$(pwd)" \
  --model gpt-5.4 --sandbox read-only --approval never --effort xhigh
codex-team -b $TOK monitor events --stream --summary --cursor pipeline-tail
```

### Run the stages

Claude runs each sequentially, waiting for `turn.completed` before starting the next:

```
stage explorer:
  message send explorer "Read brief.md. Survey the codebase. Write findings to .codex-team/explorer.md."
  codex-team -b $TOK message wait explorer --timeout 0

stage designer:
  message send designer "Read brief.md and .codex-team/explorer.md. Propose a design in .codex-team/designer.md."
  codex-team -b $TOK message wait designer --timeout 0

stage implementer:
  message send implementer "Read brief.md and .codex-team/designer.md. Implement the design. Log your progress in .codex-team/implementer.md."
  codex-team -b $TOK message wait implementer --timeout 0

stage tester:
  message send tester "Run the test suite. Log results in .codex-team/tester.md."
  codex-team -b $TOK message wait tester --timeout 0

stage reviewer:
  message send reviewer "Read everything in .codex-team/*.md. Write .codex-team/reviewer.md with verdict + any concerns."
  codex-team -b $TOK message wait reviewer --timeout 0

Claude reads reviewer.md, decides to ship or loop back.
```

`turn.completed` only tells you that the stage reached a terminal boundary. Read the stage file or `message tail` for actual content.

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
codex-team -b $TOK message wait explorer --timeout 0
codex-team -b $TOK message wait prior-art --timeout 0
```

If the implement stage is intentionally trusted, give that session `--auto-approve "<patterns>"` or use the daemon default `session.auto_approve_command_patterns`; do not emulate approval handling with shell polling.

## Termination

```bash
for s in "${stages[@]}"; do codex-team -b $TOK session detach "$s"; done
```

## Anti-patterns

- Using a pipeline for work that's actually one stage. Adds 5× context without quality gain.
- Skipping stages because "this task is easy". If you decide you don't need a stage, remove it from the playbook — don't just stop calling it.
- Stages writing to each other's files. One file per stage, owned by that stage.
