# Playbook: Debate / Panel

**Team size:** 2-3 · **Pattern:** Multiple workers each propose a position; Claude adjudicates.

## Adoption signal

- Design / architecture / strategy decision with multiple defensible options.
- You (Claude) want independent takes before committing, not one opinion you'll then second-guess.
- The question has no obviously right answer — it's a trade-off.

Examples:

- Which refactoring approach to pick for a tangled module.
- Whether to introduce a new dependency or work around with existing code.
- Which of three library APIs best fits a use case.
- How to structure a cross-cutting abstraction.

Not this playbook when:

- Question has a clear correct answer (just send to one worker → `solo-worker.md`).
- You already know the answer and want execution → `plan-execute-verify.md`.
- The task is "find the right design", i.e. no options are on the table yet → send a single worker to research options first, then debate if needed.

## Team composition

| Session | Role | Profile |
|---|---|---|
| `advocate-A` | Argues for option A. Does not consider other options. | `worker` high effort, concise |
| `advocate-B` | Argues for option B. Does not consider other options. | `worker` high effort, concise |
| `advocate-C` (optional) | Argues for option C. | `worker` high effort, concise |
| — | **Claude is the judge.** Reads all advocates' arguments and decides. | — |

Each advocate is deliberately biased toward their position. That's the playbook's design. Claude provides the neutrality.

## Shared artefacts

- **Debate brief**: `/<repo>/docs/briefs/<task>-debate.md` — describes the decision, the options on the table, the evaluation criteria.
- **Per-advocate work doc**: `/<repo>/docs/debate/<task>-advocate-<X>.md`. Each advocate writes their case here (proposal + rationale + counter-objection handling).
- **Judgment doc** (Claude writes): `/<repo>/docs/debate/<task>-decision.md` — records the decision + reasoning + which arguments were decisive.

## Debate brief shape

```markdown
# Debate: <decision>

## Context
<what has to be decided, and why this matters>

## Options
- **A:** <option A, one paragraph>
- **B:** <option B, one paragraph>
- **C:** <option C, one paragraph>

## Evaluation criteria (weighted)
1. <criterion 1> — weight: high/med/low
2. <criterion 2> — ...
3. <criterion 3> — ...

## Constraints (hard)
- <must-have 1>
- <must-have 2>

## Reference
- <files, prior PRs, related docs>
```

## Advocate work doc shape

```markdown
# Advocate for option <X>

## Proposal
<concrete shape of option X in this codebase>

## Strengths (vs criteria)
- <criterion 1>: <why option X is strong>
- ...

## Concessions / weaknesses (be honest)
- <weakness>: <mitigation>

## Answers to anticipated objections
- "But what about <objection>?" → <answer>

## Concrete next steps if adopted
- <step 1>
- ...
```

## Judgment doc shape

```markdown
# Decision: <decision>

## Chosen option
<A | B | C>

## Decisive arguments
- From advocate-<X>: <argument>
- From advocate-<Y>: <argument — yes, you can borrow from rejected options>

## Rejected arguments (and why)
- Advocate-<Y>'s "<claim>" — reason rejected

## Implementation plan
- <high-level plan; or a handoff to plan-execute-verify>
```

## Communication flow

```
          debate brief (shared, read-only)
                  │
      ┌───────────┼───────────┐
      ▼           ▼           ▼
  [advocate-A] [advocate-B] [advocate-C]
      │           │           │
   A.md         B.md         C.md
      │           │           │
      └───────────┴───────────┘
                  │
                  ▼
           Claude — judgment.md
```

**Advocates do not read each other's work docs.** That's the playbook's isolation: each case is independent. If they read each other's they'd converge, defeating the point.

## Iteration loop

```
Phase 1 (Open):
  1. Write debate brief. Iterate with user until the options and criteria are honest.
  2. Create N advocate sessions. Dispatch all in parallel.
  3. Wait for all advocates' turn-done.

Phase 2 (Read):
  4. Read each advocate's work doc end to end. Look for:
     - How each handles the weakest criterion for their option.
     - Whether their "concessions" are real or perfunctory.
     - What concrete steps they propose.

Phase 3 (Optional cross-examination):
  5. If Claude has a specific follow-up for advocate-X, dispatch one targeted send.
  6. Wait for turn-done, re-read.

Phase 4 (Judge):
  7. Write the judgment doc. State the decision + which arguments were decisive.
  8. Share with user (brief paragraph in-chat); point them at the judgment doc.
  9. Close advocate sessions.

Handoff:
  10. If implementation follows, open a new playbook (often `plan-execute-verify.md`).
```

## Send templates

**Advocate — first send:**

```
codex-team send advocate-<X> "advocate for option <X> from <debate-brief-path>. Do not consider options A/B/C/… other than your own. Write your case to <advocate-work-path-X> using the template (Proposal / Strengths / Concessions / Answers to anticipated objections / Concrete next steps). Reply 'case presented' with a one-line summary of your strongest argument."
```

**Advocate — cross-examination:**

```
codex-team send advocate-<X> "cross-examination: specifically, how does option <X> handle <specific scenario>? Update your answer in <advocate-work-path-X>'s 'Answers to anticipated objections' section; reply 'updated'"
```

(Claude does not tell advocate-X what advocate-Y said — that would let advocate-X refute positions they're not supposed to engage with. Paraphrase the scenario neutrally.)

## Exit criteria

- Every advocate has presented their case.
- Claude has written the judgment doc.
- User (if present) has reviewed the decision.

## Failure modes

| Smell | Fix |
|---|---|
| Advocates produce similar cases | Brief's options weren't actually different. Re-scope. Usually means one option is a strict dominator and there's no debate to have. |
| Advocates mention each other's options | You didn't instruct them not to. First send template must forbid it explicitly. |
| Each advocate only lists strengths | Template requires "Concessions / weaknesses" — enforce via reasoning_effort=high and explicit re-send if absent. |
| Claude can't decide | Often means the brief's criteria aren't weighted. Edit brief, ask user to confirm weights, re-read advocates' cases. |
| You ran 5+ advocates | Beyond 3 the judge-load becomes impractical. If you need 5 options, shortlist first (single worker), then debate the top 3. |
| Advocate A hedges into agreeing with B | Over-corrected concessions. Re-send with "your job is to make the strongest honest case *for* <X>, not to neutralise". |
| The judgment doc doesn't cite specific arguments | You didn't really read the cases. Re-read; cite. |

## Variants

- **Devil's advocate** (1 advocate + Claude as proposer): Claude proposes, the single advocate attacks. Useful when there's one strong hypothesis you want to stress-test.
- **Iterative debate**: After round 1, advocates are allowed to see the judge's critique (not each other's cases). Round 2 addresses the critique. Use for high-stakes decisions where round 1 left gaps.

## Related

- If debate converges on a plan → switch to `plan-execute-verify.md` to build it.
- If the "debate" is really "pick the right answer from a known set" and advocates aren't needed → single worker with the options listed.
- For recurrent refinement of a single artefact → `reflexion.md`, not debate.
