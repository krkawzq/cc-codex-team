# Playbook: Reflexion

**Team size:** 2 · **Pattern:** Worker produces; Critic critiques; Worker revises. Iterate until good.

## Adoption signal

- A **single artefact** that must be refined until good (not a diff, an artefact).
- Iterating same artefact with fresh eyes each round improves quality.
- The deliverable shape is narrow enough that "keep improving" is meaningful.

Examples:

- Writing a benchmark result document.
- Producing a tight design doc.
- Crafting a high-quality test suite for a module.
- Writing a blog post or RFC.
- Generating a concise architecture proposal.

Not this playbook when:

- Work is code-shaped and correctness is the axis, not quality → `worker-reviewer.md`.
- Artefact has no convergent "good" — this loop will spin forever → switch to `debate.md` if multiple options are emerging.
- Task has independent chunks → `map-reduce.md`.

## Team composition

| Session | Role | Profile |
|---|---|---|
| `worker` | Produces and revises the artefact. | `worker` |
| `critic` | Reads the artefact at each round; points out the top-3 weaknesses with specific suggestions. Does **not** rewrite. | `critic` (gpt-5.4, high effort, concise) |

## Shared artefacts

- **Brief**: `/<repo>/docs/briefs/<task>-brief.md` — defines the artefact's goals, constraints, quality bar.
- **The artefact** (the whole point): `/<repo>/docs/<task>.md` (or wherever the deliverable lives). Worker owns; critic reads.
- **Critic notes**: `/<repo>/docs/reflexion/<task>-critic.md`. Per-round findings, append-only.
- **Per-session work doc**: `/<repo>/docs/worker/<session-name>-work.md`. Internal progress per session.

## Communication flow

```
            brief (shared, read-only)
               │
               ▼
           artefact.md ◄─┐
               ▲         │ (reads artefact, writes critic notes)
               │         │
               │    [ critic ]
               │         │
            [ worker ]   ▼
               │     critic.md ──┐
               ▼                 │
          (next round reads      │
           critic.md above)      │
                                 │
               Claude arbitrates (round cap, scope, exit)
```

**Critic never edits the artefact.** That distinction is what makes this different from solo-worker-with-self-critique.

## Critic notes shape (per round)

```markdown
## Round <N> — <timestamp>

### Top issues
1. <issue> — <file:line or section ref> — suggestion: <specific fix>
2. <issue> — ref — suggestion: <specific fix>
3. <issue> — ref — suggestion: <specific fix>

### Quality bar progress
- <dimension>: <better/same/worse since last round>

### Verdict
- <converged / still improving / stuck>
```

Capping critic at top-3 issues per round keeps the loop productive. Unbounded critique tends to nitpick.

## Iteration loop

```
1. Worker round 1: produce initial artefact from the brief.
2. Wait for worker turn-done.
3. Critic round 1: read artefact; write round 1 critic notes.
4. Wait for critic turn-done.
5. Claude reads critic notes.
   - If verdict=converged: exit.
   - If "stuck" or no measurable progress for 2 rounds: exit + accept imperfect.
   - Else: worker round (N+1), pointing at critic notes.
6. Round cap (set upfront): stop at round N-max regardless. Good artefacts usually plateau at 3-5 rounds.
```

## Send templates

**Worker — round 1:**

```
codex-team send worker "round 1: read <brief-path>; produce the artefact at <artefact-path>; create the work doc at <worker-work-path>; reply 'round 1 artefact ready' with a one-line summary of your approach"
```

**Critic — round 1:**

```
codex-team send critic "round 1 critique: read <brief-path> for quality bar and <artefact-path> for the artefact; write round 1 critic notes to <critic-path> — top-3 issues only, each with file:line or section ref + specific suggestion; include a verdict (converged / still improving / stuck); create the work doc at <critic-work-path>; reply 'round 1 critique done' with the verdict"
```

**Worker — round N:**

```
codex-team send worker "round <N>: read round <N-1> critic notes at <critic-path>; revise <artefact-path> to address the top-3 issues; update <worker-work-path>; reply 'round <N> artefact ready' with a one-line summary of what you changed and anything you pushed back on"
```

**Critic — round N:**

```
codex-team send critic "round <N> critique: read <artefact-path>'s current state; write round <N> critic notes appended to <critic-path> — top-3 issues only (skip issues worker already fixed; skip issues flagged in earlier rounds unless they regressed); update verdict; reply 'round <N> critique done' with the verdict"
```

**Converge nudge** (when the critic keeps raising new issues without convergence):

```
codex-team send critic "tighten standard: only flag issues that are above the quality bar for this artefact's purpose. If the artefact meets the bar for <target audience>, verdict=converged. Re-evaluate and emit round <N> accordingly."
```

## Exit criteria (any one triggers exit)

- Critic's latest verdict = `converged`.
- Round cap reached (configured per task; 3-5 typical).
- Two consecutive rounds with verdict = `stuck` — means further iteration won't help; accept current artefact or pivot.

Then:

```bash
codex-team session close worker
codex-team session close critic
```

## Failure modes

| Smell | Fix |
|---|---|
| Critic flags 10+ issues per round | Re-anchor: "top-3 only per round". Critics without a cap ruin the loop. |
| Critic edits the artefact | Forbidden. Profile's `developer_instructions` for critic must say "do not modify the artefact; write findings only". |
| Worker ignores critic notes | Worker's round-N send must reference `<critic-path>` explicitly. Add "address the top-3 issues from round <N-1>" verbatim. |
| Convergence never happens | After 2 stuck rounds, exit. Perfectionism is not the goal; good-enough-for-purpose is. |
| Round 2's critique duplicates round 1's | Critic prompt must say "skip issues already fixed or flagged in earlier rounds unless regressed". |
| Worker pushes back on every issue | Read the pushbacks seriously (`philosophy.md` §4). If they're good, agree + re-anchor the critic's quality bar. If they're excuses, re-send worker with "address the issue without rationalising". |
| Artefact regresses between rounds | Usually worker is rewriting too much. Re-send with "make only the minimum edits needed to address the top-3". |
| Round cap reached with "still improving" | You under-capped. Either add more rounds, or accept diminishing returns. |

## Variants

- **Worker-only reflexion** (no critic): worker self-critiques within a single turn. Degrades quickly; the second session is what makes this playbook work. Don't use this variant except for trivial refinements.
- **Multi-critic reflexion** (2 critics + worker): two critics with different focuses (e.g. "technical" and "editorial"). Worker reads both. Usually overkill — pick one critic with a broader brief unless the audiences are genuinely distinct.
- **Reflexion on code**: possible but often `worker-reviewer.md` is better. Reflexion works when the deliverable itself is refined in place; worker-reviewer works when the deliverable is a series of changes.

## Related

- For code-change-centric iteration → `worker-reviewer.md`.
- For pick-one-of-several at round 0 → `debate.md` first, then reflexion on the winner.
- If the artefact itself reveals sub-tasks that parallelise → inner `map-reduce.md`, outer reflexion keeps the whole in check.
