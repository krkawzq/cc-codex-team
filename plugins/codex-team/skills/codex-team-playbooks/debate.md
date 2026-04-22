# Debate

## Adoption signal

- Question has two (or more) defensible viewpoints and the wrong choice is costly
- Typical use: architecture decisions, library selection, API shape, algorithm choice
- Decomposes poorly — it's genuinely contested, not a matter of execution

Use debate when a **reviewer + worker** can't decide for you (they'd each just say "seems ok") and you need adversarial pressure.

## Team

Three sessions:

| Session | Role | Profile |
|---|---|---|
| `advocate-a` | Argues for position A | `planner` (read-only, xhigh) |
| `advocate-b` | Argues for position B | `planner` (read-only, xhigh) |
| `judge` | Synthesises + picks | `reviewer` (read-only, xhigh) |

All three are read-only — debate is about reasoning, not code.

## Shared artefacts

- `.codex-team/brief.md` — the question + any context
- `.codex-team/position-a.md` / `.codex-team/position-b.md` — initial stances (Claude writes)
- `.codex-team/a-opening.md` / `.codex-team/b-opening.md` — round 1
- `.codex-team/a-rebuttal.md` / `.codex-team/b-rebuttal.md` — round 2 (optional)
- `.codex-team/verdict.md` — judge's decision + rationale

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null
codex-team -b $TOK cursor save debate-tail

cd /repo
mkdir -p .codex-team
cat > .codex-team/brief.md <<'EOF'
<question + relevant context>
EOF
cat > .codex-team/position-a.md <<'EOF'
<one-paragraph summary of position A>
EOF
cat > .codex-team/position-b.md <<'EOF'
<one-paragraph summary of position B>
EOF

codex-team -b $TOK session new advocate-a --profile planner  --cwd "$(pwd)"
codex-team -b $TOK session new advocate-b --profile planner  --cwd "$(pwd)"
codex-team -b $TOK session new judge      --profile reviewer --cwd "$(pwd)"

# Optional long-running monitor for resumable orchestration
codex-team -b $TOK monitor events --stream --summary --cursor debate-tail
```

### Round 1 — openings (parallel)

```
message send advocate-a "Read brief.md and position-a.md. Defend position A.
  Produce .codex-team/a-opening.md:
    - Three strongest arguments for A
    - The single strongest objection you can anticipate, with your response
  Ground every claim in the repo — cite files where relevant."

message send advocate-b "<mirror for position B>"
```

Both fire concurrently. Prefer the built-in blocker over hand-rolled polling:

```bash
codex-team -b $TOK message wait advocate-a
codex-team -b $TOK message wait advocate-b
```

`turn.completed` is compact metadata only in 0.5.2, so read the actual opening via `message tail ... --format markdown` or the generated file.

### Round 2 — rebuttals (parallel, optional)

```
message send advocate-a "Read .codex-team/b-opening.md. Produce .codex-team/a-rebuttal.md:
  - Address B's strongest argument head-on
  - Do not introduce new arguments for A"

message send advocate-b "<mirror>"
```

Cap at one rebuttal round. Debates that go longer repeat themselves.

Use the same wait pattern here:

```bash
codex-team -b $TOK message wait advocate-a
codex-team -b $TOK message wait advocate-b
```

### Round 3 — verdict

```
message send judge "Read brief.md, both openings, and (if they exist) both rebuttals.
  Produce .codex-team/verdict.md:
    - Which position wins?
    - Top 1–2 reasons (cite the advocates' arguments by name)
    - Any caveats / conditions under which the other position would win instead
    - If both positions have fatal flaws, say so — don't force a choice"
```

Then:

```bash
codex-team -b $TOK message wait judge
codex-team -b $TOK message tail judge -n 1 --format markdown
```

Claude reads verdict.md. If the judge said "both fatal," escalate (ask the user; or re-scope). Otherwise act on the verdict.

## Operational notes

- `monitor events --summary --cursor debate-tail` gives one compact line per event and resumes cleanly if Claude restarts mid-debate.
- This topology is read-only end to end (`approval=never`), so no auto-approve config is needed.

## Variants

- **Three-way debate**: positions A / B / C with three advocates. Judge has more to weigh. Diminishing returns beyond 3.
- **Silent judge**: advocates never see the judge's criteria. Useful when you worry the judge's rubric leaks into the arguments.
- **Iterated debate**: judge produces preliminary verdict → advocates get one more rebuttal targeting the judge's reasoning. Use sparingly — adds a round, easy to spiral.

## Termination

```bash
for s in advocate-a advocate-b judge; do
  codex-team -b $TOK session detach "$s"
done
```

## Anti-patterns

- **Advocates given write access.** They'll implement "their" position and create facts on the ground. Keep read-only.
- **Advocates seeing each other's writing before writing their own opening.** Contaminates the position. Openings first, rebuttals second.
- **Debating a question that's actually empirical.** If a quick prototype or benchmark answers it, run that instead — debate is for genuine value / tradeoff calls, not for measurable facts.
- **More than 2 rebuttal rounds.** If openings + one rebuttal each didn't make the answer clear, the question is under-specified. Fix the brief, not the protocol.
- **Running debate for every decision.** It's expensive — 3 sessions, 4–6 turns. Reserve for genuinely contested, hard-to-reverse calls.
