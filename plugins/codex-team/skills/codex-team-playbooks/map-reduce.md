# Playbook: Map-Reduce

**Team size:** N (3-6 typical) · **Pattern:** Each worker handles one independent chunk; Claude aggregates.

## Adoption signal

- Task decomposes into ≥3 **mechanically independent** subtasks (no cross-chunk dependencies).
- Each subtask has the same shape — same brief applies, only the target differs.
- You need actual parallelism, not just concurrency.

Examples:

- Bulk review across N PRs.
- Porting N modules of the same library.
- Running the same refactor on N files/services.
- Auditing N repos for the same class of issue.

Not this playbook when:

- Chunks depend on each other → `pipeline.md`.
- Chunks produce conflicting changes to the same file → merge-conflict hell; decompose differently.
- The task is really one big thing, not N small ones → `solo-worker.md` or `plan-execute-verify.md`.

## Team composition

| Session | Role | Profile |
|---|---|---|
| `worker-<chunk-id>` × N | Each handles one chunk independently. Same profile across all. | `worker` or `quickfix` (depending on chunk size) |

Name each worker by chunk dimension — `reviewer-pr-123`, `port-mod-auth`, `port-mod-users`, etc.

## Shared artefacts

- **Brief** (shared across all workers): `/<repo>/docs/briefs/<task>-brief.md`. Defines the per-chunk procedure; chunks are passed as parameters.
- **Chunk list**: embedded in brief or a separate `/<repo>/docs/briefs/<task>-chunks.md` — explicit enumeration of what each worker should target.
- **Work doc per worker**: `/<repo>/docs/worker/<session-name>-work.md`. One per session, never shared.
- **Aggregate report** (Claude writes, workers don't touch): `/<repo>/docs/aggregates/<task>-summary.md`.

## Communication flow

```
                    brief (shared)
                    chunk list
                        │
      ┌───────────┬─────┴─────┬───────────┐
      ▼           ▼           ▼           ▼
  [worker-1] [worker-2]  [worker-3]  [worker-N]
      │           │           │           │
   work-1      work-2      work-3      work-N
      │           │           │           │
      └───────────┴───────────┴───────────┘
                        │
                        ▼
              Claude reads all, writes
              aggregate summary
```

**No cross-worker communication.** If worker-1 and worker-2 need to share info, the playbook is wrong — decompose differently or use `pipeline.md`.

## Iteration loop

```
1. Prepare brief + explicit chunk list.
2. Create one session per chunk, same profile.
3. Dispatch all N workers in parallel (N sends, one per worker, then sleep).
4. Events arrive as workers finish; each turn-done is a chunk outcome.
5. On each turn-done:
   - Mark chunk done in your local tracking.
   - Read worker's work doc's Findings (light read; don't descend).
6. When all workers done OR all stragglers hit a planned deadline:
   - Read each work doc's Progress + Findings.
   - Write aggregate summary: cross-chunk patterns, outliers, per-chunk status.
7. Close sessions.
```

Claude doesn't serialise worker turns — each worker runs its entire task at its own pace. You wake on `turn-done`, tally, then go back to sleep.

## Send templates

**First send — each worker:**

```
codex-team send worker-<chunk-id> "execute the brief at <brief-path> for chunk <chunk-id>. Chunk-specific parameters: <params>. Create the work doc at <work-path>; update Progress/Findings/Next up; reply 'done' with a one-line summary and any outlier flag"
```

**Re-dispatch a stuck chunk:**

```
codex-team send worker-<chunk-id> "your chunk <chunk-id> turn returned <reason>. Read <work-path>, continue from Next up; reply 'done' when complete"
```

**Ask a worker to cross-verify** (only if its neighbour flagged something relevant):

```
codex-team send worker-<chunk-id> "a neighbouring chunk flagged <issue>. Check whether your chunk is affected by the same pattern; append findings to <work-path>'s Findings section; reply 'checked' with yes/no"
```

(This is the only sanctioned cross-worker communication — mediated by Claude, never direct.)

## Aggregate summary shape

Write to `/<repo>/docs/aggregates/<task>-summary.md`:

```markdown
# <task> summary

## Per-chunk status

| Chunk | Session | Status | Key finding | Work doc |
|---|---|---|---|---|
| pr-123 | reviewer-pr-123 | ok | No critical issues | <path> |
| pr-124 | reviewer-pr-124 | attn | Race condition in <file:line> | <path> |
| ... |

## Cross-chunk patterns
- <pattern 1>
- <pattern 2>

## Outliers (needs attention)
- <chunk>: <issue>

## Next steps
- ...
```

## Exit criteria

All of:

- Every worker's `turn-done` received.
- Aggregate summary written and reviewed.
- Any outlier chunks addressed (either re-dispatched, re-assigned, or explicitly accepted).

Then close all sessions.

## Failure modes

| Smell | Fix |
|---|---|
| Workers step on each other's files | Chunks aren't independent. Re-decompose. |
| One worker is much slower than the rest | Inspect that one's `work.md`; may be stuck on something the brief didn't cover. Either answer the blocker or accept the partial result. |
| "Chunks have lots of shared context" | That's pipeline-shaped work, not map-reduce. Pick `pipeline.md`. |
| Aggregate summary is just a list of work doc contents | You haven't cross-read. The value of map-reduce's aggregate step is Claude spotting cross-chunk patterns. |
| Workers keep asking Claude about the brief | Brief is ambiguous. Edit it, then re-dispatch any workers that had the question. |
| `queue-overflow` event | You're dispatching faster than workers complete. For map-reduce that means one worker is queue-bound — probably the map is wrong shape. |
| You keep `grep`-ing across worker work docs | You're treating the aggregate as a search problem. Write a summary instead; future reads of this task will be lighter. |

## Scaling guidance

- 3 workers: minimum for the playbook to be worth it over serial dispatch.
- 6 workers: upper end for a single human-in-the-loop Claude orchestration.
- 10+ workers: consider splitting into batches of 6, or automating with a script — interactive orchestration stops helping past ~6 concurrent.

Each worker is a `codex app-server` subprocess. Remember the global rate limit.

## Related

- If each chunk itself deserves a reviewer → each worker session becomes a `worker-reviewer.md` pair; you manage N pairs.
- If the chunks feed each other → not map-reduce; pick `pipeline.md`.
- If chunks share a critic → `reflexion.md` nested inside each chunk.
