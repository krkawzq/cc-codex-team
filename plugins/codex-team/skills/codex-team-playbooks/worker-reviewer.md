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
codex-team -b $TOK cursor save wr-tail

cd /repo
mkdir -p .codex-team
echo "$BRIEF" > .codex-team/brief.md

# fixer + reviewer profiles (see configure-codex-team/profiles-library.md)
codex-team -b $TOK session new worker --cwd "$(pwd)" \
  --model gpt-5.4 --sandbox workspace-write --approval on-request --effort high \
  --auto-approve 'git*,npm test,vitest*'
codex-team -b $TOK session new reviewer --cwd "$(pwd)" \
  --model gpt-5.4 --sandbox read-only --approval never --effort xhigh

# Arm events Monitor
codex-team -b $TOK monitor events --stream --summary --cursor wr-tail
```

### Main loop

```
Claude:
  1. message send worker "Read .codex-team/brief.md; write your plan to .codex-team/worker.md; then execute it. Update worker.md with what you did."
  2. `codex-team -b $TOK message wait worker --timeout 0`
  3. message send reviewer "Read .codex-team/brief.md and .codex-team/worker.md. Produce .codex-team/review.md with:
     - Verdict: accept / reject
     - If reject: numbered list of concrete issues
     - Any suggestions"
  4. `codex-team -b $TOK message wait reviewer --timeout 0`
  5. Read .codex-team/review.md yourself.
     - accept → detach both sessions; done.
     - reject → message send worker "Address the issues in .codex-team/review.md. Update worker.md."
     - back to step 2.
```

Bounded: stop after 3 accept-loops. If still rejecting, escalate (human intervention or fork-and-restart).

`turn.completed` is compact in 0.5.2, so the worker's diff/log still comes from `worker.md` or `message tail`, not the event payload.

## Message-only variant

Use this when the worker is producing prose, analysis, or a rewrite plan and there are no files worth diffing.

Claude waits for the worker turn to finish, runs `codex-team -b $TOK message tail worker -n 1 --format markdown`, and pipes that output verbatim into the reviewer session as the review target.

Ask the critic to answer with one of these verdicts: `approved`, `needs-rewrite: <reason>`, or `reject: <reason>`.

Keep the same default iteration cap of 3 rounds. If the critic still has not said `approved` at the cap, stop the loop and escalate to a human or restart with a narrower brief.

## Variants

- **Parallel review**: spin up a second reviewer with a different angle (e.g. one checks correctness, one checks performance). Claude merges reviews before sending to worker.
- **Quiet reviewer**: instead of a dedicated session, use `codex:codex-rescue` subagent for ad-hoc review. Cheaper; no persistent context.
- For several worker/reviewer pairs at once, keep one `monitor events --summary --cursor wr-tail` rather than separate verbose streams.

## Anti-patterns

- Reviewer in workspace-write mode. The reviewer shouldn't touch the code — it creates murky ownership and the worker stops trusting the review.
- Letting the worker see the reviewer's verdict BEFORE the worker has written its own justification. Risks sycophantic fixes that miss the root cause.
- Infinite review loops. Cap at 3.
