# Worker + reviewer

## Adoption signal

- One coherent unit of work where quality matters more than speed
- Worker produces code / diff; a second opinion is valuable
- The reviewer has a well-defined acceptance criterion (passes tests? matches brief? no new lints?)

## Team

| Session | Role | Profile |
|---|---|---|
| `worker` | Writes/edits code | `fixer` (workspace-write, on-request) |
| `reviewer` | Reads diff, returns verdict + critique | `reviewer` (read-only, never-approval, xhigh effort) |

## Shared artefacts

- `<cwd>/.codex-team/brief.md` — task statement; Claude writes
- `<cwd>/.codex-team/worker.md` — worker's progress log; worker writes
- `<cwd>/.codex-team/review.md` — reviewer's verdict + comments; reviewer writes

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null

cd /repo
mkdir -p .codex-team
echo "$BRIEF" > .codex-team/brief.md

codex-team -b $TOK session new worker   --profile fixer    --cwd "$(pwd)"
codex-team -b $TOK session new reviewer --profile reviewer --cwd "$(pwd)"

# Arm events Monitor
```

### Main loop

```
Claude:
  1. message send worker "Read .codex-team/brief.md; write your plan to .codex-team/worker.md; then execute it. Update worker.md with what you did."
  2. Wait for worker turn.completed.
  3. message send reviewer "Read .codex-team/brief.md and .codex-team/worker.md. Produce .codex-team/review.md with:
     - Verdict: accept / reject
     - If reject: numbered list of concrete issues
     - Any suggestions"
  4. Wait for reviewer turn.completed.
  5. Read .codex-team/review.md yourself.
     - accept → detach both sessions; done.
     - reject → message send worker "Address the issues in .codex-team/review.md. Update worker.md."
     - back to step 2.
```

Bounded: stop after 3 accept-loops. If still rejecting, escalate (human intervention or fork-and-restart).

## Variants

- **Parallel review**: spin up a second reviewer with a different angle (e.g. one checks correctness, one checks performance). Claude merges reviews before sending to worker.
- **Quiet reviewer**: instead of a dedicated session, use `codex:codex-rescue` subagent for ad-hoc review. Cheaper; no persistent context.

## Anti-patterns

- Reviewer in workspace-write mode. The reviewer shouldn't touch the code — it creates murky ownership and the worker stops trusting the review.
- Letting the worker see the reviewer's verdict BEFORE the worker has written its own justification. Risks sycophantic fixes that miss the root cause.
- Infinite review loops. Cap at 3.
