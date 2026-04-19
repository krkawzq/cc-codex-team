---
name: codex-team-playbooks
description: >-
  Selection guide and library of multi-agent collaboration playbooks built on codex-team. Trigger when deciding how many Codex workers to spin up and what roles they should play, when a task decomposes into multiple subtasks but the topology isn't obvious, when asked "how should I structure this with codex-team", or when picking between patterns like worker+reviewer, map-reduce, debate, pipeline, reflexion, hierarchical, swarm/handoff. Not for: session lifecycle commands (`manage-codex-team`), failure triage (`recover-codex-team`), config (`configure-codex-team`).
---

# Codex-team playbooks

> **You are reading this because you need to pick a multi-agent collaboration pattern**, not because you need to run a CLI command. Once you've picked a playbook, its reference file tells you role-by-role what to do; the mechanics come from `manage-codex-team`.

A **playbook** is a proven topology of workers + manager with a defined communication protocol. Each playbook file covers:

1. **Adoption signal** — when the task shape matches this playbook.
2. **Team composition** — how many sessions, each session's role, which profile each should use (from `configure-codex-team/profiles.md`).
3. **Shared artefacts** — which brief file, whose work doc, how they relate.
4. **Communication flow** — who writes what, who reads whose work doc.
5. **Iteration loop** — what Claude does on each `turn-done` cycle.
6. **Send templates** — per-role first send, per-role iteration send, baton-pass send. Copy-paste with placeholders.
7. **Exit criteria** — how you know the playbook is done.
8. **Failure modes** — playbook-specific anti-patterns.

---

## Decision tree

Start here. Walk down until a branch matches.

```
Q1: Is the task decomposable into truly independent subtasks (no shared state)?
  ├── Yes, and there are ≥3 of them      → map-reduce.md
  ├── Yes, but only 1                    → solo-worker.md
  └── No                                 → Q2

Q2: Does the task have natural sequential stages (plan → design → impl → test → docs)?
  ├── Yes                                → pipeline.md
  └── No                                 → Q3

Q3: Is the task a single deliverable that benefits from iterative critique?
  ├── Yes, same deliverable refined over multiple rounds    → reflexion.md
  ├── Yes, code + second-pair-of-eyes review on each change → worker-reviewer.md
  └── No                                 → Q4

Q4: Is there a clear target/spec and you want the worker to plan, execute, and verify?
  ├── Yes                                → plan-execute-verify.md
  └── No                                 → Q5

Q5: Is this a design choice with multiple defensible options?
  ├── Yes, you want multiple views       → debate.md
  └── No                                 → Q6

Q6: Is the task large enough that it needs a tech-lead layer above executors?
  ├── Yes                                → hierarchical.md
  └── No                                 → Q7

Q7: Does the work's nature change mid-way (investigate → implement → verify, with role transitions)?
  ├── Yes                                → swarm.md
  └── No                                 → Back to solo-worker.md (default)
```

If multiple branches match, pick the smaller team. Parallelism has setup cost.

## Index

| Playbook | One-line | Team size | When |
|---|---|---|---|
| `solo-worker.md` | One worker, one brief, one work doc. | 1 | Single well-scoped task. Baseline. |
| `worker-reviewer.md` | Implementer + second-pair-of-eyes reviewer, iterating on diffs. | 2 | Code changes where correctness matters more than speed. |
| `map-reduce.md` | N parallel workers, shared brief, Claude aggregates. | N (3-6) | Independent same-shape subtasks. Bulk review, mass porting. |
| `pipeline.md` | N workers, serial stages. Each stage's output feeds the next via a stage doc. | N (2-4) | Natural SDLC: design → impl → test → docs. |
| `plan-execute-verify.md` | Planner, Executor, Verifier. Three sessions, linear dependency. | 3 | One deliverable, high-stakes correctness. |
| `debate.md` | 2-3 workers propose, Claude adjudicates. | 2-3 | Architecture / design choice with multiple defensible options. |
| `reflexion.md` | Worker + Critic iterating on the same deliverable. | 2 | Refining one artefact (doc, test, benchmark) until it's right. |
| `hierarchical.md` | Tech-lead worker manages N sub-workers; Claude directs the lead. | 2 + N | Large task with clear decomposition the worker can do. |
| `swarm.md` | Workers change role/focus via explicit baton hand-off. | 2+ | Multi-phase work where roles transition (investigator → implementer). |
| `anti-patterns.md` | Things not to do. Common mistakes from each playbook. | — | Before you reach for a playbook you're unsure about. |

## Universal rules (apply across all playbooks)

1. **Each session gets exactly one work doc** (`manage-codex-team/work-doc.md`). Never two sessions writing the same file.
2. **Briefs are read-many, write-one.** Multiple workers can read the same brief; only you (or the user) edit it.
3. **Claude is serial.** You drive one decision at a time, even when workers run parallel. The work docs make that tractable.
4. **Git belongs to Claude.** No playbook asks a worker to `git commit | merge | push | branch | tag` — `using-codex-team` §Invariants #2.
5. **Events drive the loop.** No playbook polls. Every wait is on the Monitor stream.
6. **Playbooks compose.** A `hierarchical` setup with 4 sub-workers may run `reflexion` internally on a single sub-deliverable. Pick the outer shape first, then the inner where needed.

## Picking a profile per role

Use `configure-codex-team/profiles.md` as the pattern. Typical role → profile mappings used in these playbooks:

| Role | Profile |
|---|---|
| Worker / Implementer | `worker` (gpt-5.4, medium effort) |
| Reviewer / Critic | `reviewer` or `critic` (gpt-5.4, high effort, concise) |
| Planner | `worker` with detailed summary |
| Verifier | `reviewer` |
| Tech-lead (hierarchical) | `worker` with detailed summary + long brief |
| Ephemeral probe | `scratch` (gpt-5.4-mini, medium) |

These profiles don't ship by default — you define them once in `config.toml` and reuse across tasks.

## Red flags

| Thought | Correction |
|---|---|
| "I'll pick the fanciest playbook to impress the user." | Match the task. Over-structuring a one-off is pure overhead. → `anti-patterns.md`. |
| "Two workers, no defined protocol — they'll figure it out." | Workers don't share memory. Without a protocol (who writes where, who reads what), they duplicate or diverge. Pick a playbook. |
| "Let me run map-reduce on a task where sub-results depend on each other." | That's pipeline or swarm, not map-reduce. |
| "I'll put a `critic` and `worker` on the same work doc." | Never. One work doc per session. The critic writes review notes to *their* work doc; the worker reads them. |
| "Debate without a judge." | Two workers disagreeing has no resolution mechanism. Debate needs Claude as adjudicator. |
| "Reflexion with a worker that rewrites *and* critiques itself." | The critic must be a different session. Self-critique in one session is just the worker running in a loop. |
