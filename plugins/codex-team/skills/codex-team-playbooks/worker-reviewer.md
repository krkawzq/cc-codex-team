# Playbook: Worker + Reviewer

**Team size:** 2 · **Pattern:** implementer produces diffs; reviewer audits on each iteration; Claude arbitrates.

## Adoption signal

- Code change where correctness / risk / style matters more than raw speed.
- You (Claude) want a structured second opinion on each change before merging.
- Task is large enough that one reviewer pass at the end is insufficient — review must interleave with implementation.

Not this playbook when:

- Change is trivial (one-liner, typo fix) — waste of a reviewer session. Use `solo-worker.md`.
- Task has no shared "current diff" state (e.g. independent chunks across files) — that's `map-reduce.md` with reviewer bolted on.
- You want iterative refinement of a single deliverable (doc, benchmark), not code diffs → `reflexion.md`.

## Team composition

| Session | Role | Profile |
|---|---|---|
| `worker` | Implementer. Reads brief + reviewer's latest notes; produces diffs; updates own work doc. | `worker` |
| `reviewer` | Auditor. Reads latest diffs + worker's work doc; writes findings to reviewer's own work doc. Does **not** modify code. | `reviewer` |

(Placeholder names. Pick real names like `impl` / `audit`, `fix` / `review`.)

## Shared artefacts

- **Brief**: `/<repo>/docs/briefs/<task>-brief.md` — shared, read-only for both sessions. Claude-owned.
- **Worker's work doc**: `/<repo>/docs/worker/<session-name>-work.md`.
- **Reviewer's work doc**: `/<repo>/docs/reviewer/<session-name>-review.md`. Contains per-iteration review findings (append-only).

The reviewer's work doc is also the **cross-session communication channel** — this is the playbook's defining asymmetry. Worker reads reviewer's doc; reviewer reads worker's doc. Neither writes to the other's.

## Communication flow

```
                brief (read-only, shared)
                   │
      ┌────────────┴───────────┐
      ▼                        ▼
  [ worker ] ── updates ── worker-work.md ◄── reads ── [ reviewer ]
      │                                                   │
      ▼                                                   ▼
  reads reviewer's                                    updates
  review.md  ◄─────────────────────────────────── review.md
                                                   (append-only)
                      │
                      ▼
                   Claude (arbitrates, merges)
```

## Iteration loop

```
Round 1:
  1a. Worker reads brief → produces first implementation. Updates own work doc.
  1b. Claude sends reviewer: "review the worker's diffs since we started; write findings to <review-path>".
  1c. Reviewer writes review.md entries.
  1d. Claude reads both work docs. Decides: accept / re-dispatch worker with specific fixes / ask reviewer for deeper pass.

Round N:
  Na. Claude sends worker: "address issues from review.md's Round N-1 findings".
  Nb. Worker updates implementation. Updates own work doc.
  Nc. Claude sends reviewer: "review the changes since Round N-1; write Round N findings".
  Nd. Claude arbitrates. Either next round, or exit.
```

**Claude is the judge.** If worker and reviewer disagree (worker says "this is correct"; reviewer says "it's not"), Claude reads both positions and decides. Do not let them argue directly.

## Send templates

**First send — worker:**

```
codex-team send worker "start: read <brief-path>; create the work doc at <worker-work-path>; implement the first chunk; do not commit; reply 'round 1 done' with a one-line summary of what changed"
```

**First send — reviewer (after worker's Round 1):**

```
codex-team send reviewer "round 1 review: read <brief-path> for context; read <worker-work-path> for what was done; read the actual changed files (paths listed in worker's Progress section); write Round 1 findings to <review-path> with sections 'Correctness', 'Risk', 'Style', 'Tests', each bullet with a file:line ref and a specific suggestion; do not modify code; reply 'round 1 review done'"
```

**Worker — subsequent round:**

```
codex-team send worker "round <N>: read <review-path>, address Round <N-1> findings in order; update <worker-work-path>; do not commit; reply 'round <N> done' with a one-line summary of what you changed and what you pushed back on"
```

**Reviewer — subsequent round:**

```
codex-team send reviewer "round <N> review: read <worker-work-path>'s Round <N> Progress entry; read the changed files; write Round <N> findings to <review-path>; skip findings already resolved in earlier rounds unless they regressed; reply 'round <N> review done'"
```

**Re-anchoring when reviewer nitpicks** (reviewer is drifting into style/nit territory when correctness issues remain):

```
codex-team send reviewer "tighten focus: skip style bullets for this round; flag only correctness and risk issues; write Round <N> findings to <review-path>"
```

**Asking reviewer a targeted question** (you're unsure whether to accept a worker's pushback):

```
codex-team send reviewer "the worker pushed back on <issue-id> from Round <N-1> with rationale '<rationale>'. Is the pushback valid? Reply with accept/reject and a one-line why."
```

## Exit criteria

All of:

- Reviewer's latest round has zero `Correctness` or `Risk` findings (or only findings Claude explicitly acknowledges as out-of-scope).
- Worker's work doc shows `Next up` empty or final.
- Brief's `Success criteria` are met.

Then:

```bash
codex-team session close worker
codex-team session close reviewer
```

You merge via `git` in your shell.

## Failure modes

| Smell | Fix |
|---|---|
| Worker never addresses reviewer findings | Your send isn't pointing at `review.md`. Every "round N" worker send must reference it. |
| Reviewer modifies code | Profile `developer_instructions` must forbid code modification for the reviewer role. See `configure-codex-team/profiles.md` §reviewer. |
| Both sessions writing to the same work doc | Forbidden. Worker and reviewer have separate work docs; review.md is append-only from the reviewer only. |
| Reviewer's findings are vague | Your reviewer send must demand file:line refs + specific suggestions. See first-reviewer-send template. |
| Rounds never converge | After 3-4 rounds with no progress, pause and read both work docs end-to-end. Usually means the brief is ambiguous; Claude edits the brief and kicks off a new round. |
| Worker silently accepts every finding | Means reviewer is either under-challenging or worker isn't reading review.md. Add a line to the worker send: "report any findings you disagree with and why". |
| You're tempted to merge without reading review.md | → `manage-codex-team/work-doc.md` §When to read. Read it. |

## Variants

- **Worker + Reviewer + Security-reviewer** (3 sessions). Two reviewers with different focuses (correctness vs security). Each reviewer writes to their own review doc. Worker reads both. Same communication rules, just more incoming channels.
- **Worker-only with end-of-session reviewer** (2 sessions, reviewer only runs once at the end). Degenerate case; if you always end up here, use `solo-worker.md` with a human review at merge time.

## Related

- For iterative refinement on a non-code artefact → `reflexion.md`.
- For parallel chunks each with their own reviewer → `map-reduce.md` with per-chunk `worker-reviewer` inside.
