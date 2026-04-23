# Survey-and-fork

## Adoption signal

- You're about to fan out N workers on a codebase none of them know yet.
- Each worker needs the same background research (architecture, conventions, recent history, constraints) before doing its own specific subtask.
- Without a prelude, every worker would re-ingest the same files independently → wasted tokens, inconsistent understanding, drift between workers.

Pairs well with **map-reduce**, **worker-reviewer**, **pipeline** — it's a *prelude* topology that feeds any of them. It is **not** a standalone pattern on its own (the fork children still need one of the N-worker patterns after they diverge).

## Core idea

> One session reads broadly. Then fork it N times. Each fork inherits the survey turn-for-turn, so you pay the research cost **once** and each worker starts with full context.

`codex-team session fork <src> <new_name>` creates a new live session whose thread starts from the source session's state (optionally at a specified `--at-turn`). After the fork, the two sessions are independent — future turns on the child do not affect the parent, and vice versa.

## Team

| Count | Role | Profile | Purpose |
|---|---|---|---|
| 1 | `surveyor` | `explorer` or `planner` (read-only) | Ingests architecture, constraints, open PRs, conventions. Produces `.codex-team/survey.md` as a durable byproduct. |
| N | `worker-<i>` | task-appropriate (`fixer`, `reviewer`, `tester`…) | Each forked from the surveyor at the final survey turn. |

Keep the surveyor **read-only** — you don't want survey turns accidentally committing changes, and the forks inherit sandbox/approval settings on creation but can be different per fork.

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null
codex-team -b $TOK cursor save survey-tail

cd /repo
mkdir -p .codex-team
echo "$BRIEF" > .codex-team/brief.md

# 1) Spawn the surveyor — read-only, high effort
codex-team -b $TOK session new surveyor --cwd "$(pwd)" \
  --model gpt-5.4 --sandbox read-only --approval never --effort xhigh

# 2) Send the survey prompt. One turn, deep.
codex-team -b $TOK message send surveyor \
  "Read .codex-team/brief.md. Then survey this repo: architecture, module boundaries, key conventions, recent commits, open test failures, known-risky areas. Write findings to .codex-team/survey.md. Return when done."

codex-team -b $TOK message wait surveyor --timeout 0
SURVEY_TURN=$(codex-team -b $TOK message history surveyor --short | tail -1 | awk '{print $2}')

# 3) Fork N times — one per worker subtask.
#    Each fork inherits the surveyor's context. Override sandbox/approval/model as needed.
for i in 0 1 2 3; do
  codex-team -b $TOK session fork surveyor "worker-$i" --at-turn $SURVEY_TURN
  # Reconfigure the fork's sandbox if you want writers:
  #   (child sessions keep parent's config unless you heal with new flags — see below)
done

# 4) Dispatch each worker its subtask. They already know the codebase.
for i in 0 1 2 3; do
  codex-team -b $TOK message send "worker-$i" \
    "Your task: <subtask-$i>. You already surveyed this repo — reference .codex-team/survey.md if you need to recall. Write output to .codex-team/worker-$i.md."
done
```

### Reconfiguring fork sandbox/approval

Fork inherits the source session's settings. If your surveyor was `read-only` but workers need `workspace-write`, you have two options:

**Option A (clean):** `session detach worker-$i` → `session attach worker-$i --sandbox workspace-write --approval never` to re-bind with new flags. Attach reuses the thread, so survey context is preserved; only the runtime config differs.

**Option B (fast):** do the fork, then immediately tell the worker in-prompt: "for this turn you have workspace-write sandbox; apply patches freely." This works because codex respects the policy it was launched with, not what the prompt claims — so don't use this to bypass read-only. Only use it to communicate intent when the policy is already permissive.

Prefer Option A when writers fork from a read-only surveyor. **Never use Option B to lie to the child about its sandbox.**

## When to use this vs plain map-reduce

| Scenario | Pattern |
|---|---|
| Each subtask is self-contained, no shared context needed | plain `map-reduce` (no surveyor) |
| Subtasks are ALL in the same codebase and need the same background | `survey-and-fork` → then map-reduce the workers |
| Subtasks need *different* prior context each | Separate explorer sessions per worker, don't fork |
| Only 2-3 workers, <5 min each | Skip the prelude; the survey overhead won't pay off |
| ≥4 workers OR long-running (>15 min each) OR deep codebase | **Fork pays big** — the survey is amortised across all forks |

**Rule of thumb:** fork pays off when `N × (per-worker re-ingestion cost) > (survey cost) + (N × fork overhead)`. Fork overhead is small (~one RPC). Re-ingestion is expensive (thousands of tokens per worker). So fork wins from roughly N=3 onward.

## Shared artefacts

- `<cwd>/.codex-team/brief.md` — high-level task (Claude writes)
- `<cwd>/.codex-team/survey.md` — surveyor's durable findings; **every fork can read this even after detach**, because it's a file, not session state
- `<cwd>/.codex-team/worker-<i>.md` — per-worker output

The `.md` files matter when you detach + reattach workers later: their in-memory context from the fork is preserved in the thread, but files are the canonical artefact. Prefer *filing* survey findings over relying on the chat context alone.

## Anti-patterns

- **Forking after the surveyor has started touching task-specific state.** Fork immediately after the *survey* turn. If the surveyor has also done worker-0's job, then forking for worker-1 poisons worker-1 with worker-0 bias.
- **Forking into mutually-contradictory roles.** A fork inherits tone, assumptions, and intermediate decisions from the surveyor. If worker-0 is "fixer" and worker-1 is "adversarial reviewer", forking both from the same surveyor bakes the same perspective into both. Use fresh sessions for critic roles.
- **Forking for tiny tasks.** If each worker turn is <30s, the fork overhead exceeds the re-ingestion cost. Use a loop in one session instead.
- **Skipping `session detach surveyor` afterwards.** The surveyor is inert post-fork. Detach it to free the app-server slot. Its thread persists on disk — you can re-fork from it later if needed.

## Composition notes

- With **map-reduce**: surveyor + N mappers + 1 reducer. Reducer typically is NOT forked — it needs to see the mapper outputs fresh, not through the surveyor's lens.
- With **worker-reviewer**: fork the writer from the surveyor. Keep the reviewer as a fresh session — its job is an outside perspective.
- With **plan-execute-verify**: the planner itself can be the surveyor — have it produce both the plan and the survey in one turn, then fork executors + verifier from the post-plan state.

## Termination

```bash
for i in 0 1 2 3; do
  codex-team -b $TOK session detach "worker-$i"
done
codex-team -b $TOK session detach surveyor
```

All thread files persist on codex disk. You can re-fork from the preserved surveyor thread in a future conversation — that's the second order benefit: survey amortises across *sessions-over-time*, not just across *workers-in-one-run*.
