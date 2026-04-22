# Hierarchical (manager + sub-workers)

## Adoption signal

- Task has nested structure — an outer goal that decomposes into subgoals that further decompose
- You want codex itself to do the decomposition and assignment, not Claude
- Long-horizon work where a single manager-session holds the plan and issues delegations over time

Not for flat problems (use `map-reduce`) or fixed-stage problems (use `pipeline`).

## Team

| Session | Role | Profile | Notes |
|---|---|---|---|
| `manager` | Holds the master plan, decides what to delegate | `planner` (read-only, xhigh) | Persistent across delegations |
| `worker-<name>` | Executes a delegated subtask | `fixer` / `explorer` / role-specific | Spawned on demand, detached after subtask |

Claude sits as the **network hub**: manager and workers never talk directly. Every message crosses Claude.

## Shared artefacts

- `.codex-team/brief.md` — overall goal
- `.codex-team/plan.md` — manager's living plan (manager writes, Claude reads)
- `.codex-team/delegations.jsonl` — append-only log of delegations (Claude writes)
- `.codex-team/worker-<name>.md` — each worker's output (worker writes)

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null

cd /repo
mkdir -p .codex-team
echo "$BRIEF" > .codex-team/brief.md

codex-team -b $TOK session new manager --profile planner --cwd "$(pwd)"

# Kick off the manager
codex-team -b $TOK message send manager "Read .codex-team/brief.md.
Write .codex-team/plan.md as a numbered checklist of subtasks.
For each subtask, include:
  - A short id (1-3 words, kebab-case)
  - A one-sentence description
  - Acceptance criterion
  - Any file paths relevant
Do NOT execute. When you want to delegate a subtask, output a block like:

  DELEGATE <subtask-id>
  ROLE: fixer | explorer | tester | reviewer
  BRIEF: <one paragraph brief for the worker>

at the bottom of your reply.

Stop after proposing the first 1–3 delegations; I'll act on them and come back."
```

### Main loop

Claude cycles between reading manager output and materialising delegations:

```
while task not complete:
  # Get the manager's next decision
  wait for manager turn.completed
  fetch latest manager reply via `message tail manager -n 1 --format markdown`
  parse DELEGATE blocks from the reply

  for each DELEGATE block:
    id = delegation.id
    role = delegation.role    # maps to a profile
    brief = delegation.brief

    # Record the delegation
    append {ts, id, role, brief} to .codex-team/delegations.jsonl

    # Spawn a worker
    codex-team -b $TOK session new worker-$id --profile $role --cwd $PWD

    # Issue the subtask
    codex-team -b $TOK message send worker-$id \
      "$brief\n\nWrite your output to .codex-team/worker-$id.md.\nReport progress and completion in that file."

    # Wait for the worker to finish
    wait for worker-$id turn.completed
    fetch worker-$id output

    # Detach the worker once done
    codex-team -b $TOK session detach worker-$id

    # Feed the result back to the manager
    codex-team -b $TOK message send manager \
      "worker-$id completed. Summary: $(head -c 2000 .codex-team/worker-$id.md).
      Update .codex-team/plan.md (mark the subtask done, revise remaining).
      Emit the next DELEGATE block(s), or say ALL_DONE."

  if manager said ALL_DONE:
    break

# Cleanup
codex-team -b $TOK session detach manager
```

## Feeding back bounded state

Don't forward the worker's full output to the manager — it bloats context fast. Rules:

- Always summarise worker output to ≤500 words when feeding to manager
- Put the full output in `.codex-team/worker-<id>.md` so it's available on disk
- Include a path reference in the summary: "Full log at `.codex-team/worker-refactor-auth.md`"

## Variants

- **Checkpoint manager**: after every K delegations, Claude asks the manager to re-read the full plan and decide whether to pivot. Prevents drift.
- **Multi-manager**: for enormous tasks, split into two managers each owning a sub-tree. Use a meta-layer (Claude alone) to arbitrate between them. Rarely worth it.
- **Parallel workers**: issue ≥2 DELEGATE blocks at once; Claude fires them in parallel, collects results, then reports back to the manager as a batch.

## When the manager gets confused

Symptoms: emits DELEGATE blocks for subtasks already marked done; proposes work outside the brief; ALL_DONE too early.

Mitigations:

- Shorter summaries back to manager (reduces noise)
- Explicit "current plan state" reminder with each feedback message
- Start a fresh manager session, hand it the plan.md and recent delegations.jsonl to recover

## Termination

```bash
# Workers are detached as they finish; manager at the end
codex-team -b $TOK session detach manager
```

Any delegations in-flight: `session detach --graceful` each to let them complete.

## Anti-patterns

- **Letting manager touch code.** Manager is read-only by profile. If it tries to write, the sandbox stops it and you get confused state. Delegations are the only way work gets done.
- **Manager delegating without clear acceptance criteria.** "Look into auth" is not a delegation — it's wishful thinking. Every delegation needs a way to judge done.
- **Workers seeing the plan.md file.** They should see only their own brief — the plan is manager's scratchpad. Decoupling keeps workers focused.
- **No decay rule.** After 10+ delegations, manager context is saturated. Either checkpoint and roll a fresh manager, or stop.
- **Using hierarchical for 2–3 subtasks.** Overhead dwarfs benefit. Flat `solo-worker` or `pipeline` is almost always better at this scale.
