---
name: codex-team-playbooks
description: >-
  Library of multi-session collaboration patterns for codex-team. Trigger when deciding how many Codex workers to spin up, what roles each plays, and the communication protocol between them. Typical task shapes: worker+reviewer, map-reduce, plan-execute-verify, pipeline, reflexion, debate, swarm/hierarchical. Not for: single-session mechanics (`manage-codex-team`), tuning (`configure-codex-team`), error triage (`recover-codex-team`).
---

# codex-team Playbooks

> You have a task that decomposes into multiple Codex subtasks. This skill helps you pick the **topology** — how many workers, what roles, how they communicate. Mechanics (how to create a session, send a prompt) come from `manage-codex-team`.

A **playbook** describes:

1. **Adoption signal** — which task shapes match this pattern
2. **Team composition** — how many sessions, each session's role + profile
3. **Shared artefacts** — briefs, work docs, how they're wired together
4. **Orchestration** — what Claude does step-by-step

## Decision tree: which playbook?

```
Is the task one unit of mechanical work?
├── Yes — solo-worker.md
└── No — is there a natural split?
    ├── Plan → execute → verify, ≥3 stages → plan-execute-verify.md
    ├── One generator, one critic, iteration-heavy → worker-reviewer.md
    ├── Many independent similar subtasks → map-reduce.md
    ├── Sequential stages each transforming the output → pipeline.md
    ├── Need self-correction after a failure → reflexion.md
    ├── Two strong opposing viewpoints → debate.md
    ├── Tree of subtasks with delegation → hierarchical.md
    └── Lots of loosely-related tasks, collaborate on demand → swarm.md
```

## Playbooks in this skill

| File | Use when |
|---|---|
| `solo-worker.md` | One session, one goal, no review loop |
| `worker-reviewer.md` | Worker writes, reviewer critiques, loop until reviewer approves |
| `map-reduce.md` | N similar subtasks fan out to N workers; aggregator merges |
| `pipeline.md` | Stage 1 → Stage 2 → Stage 3, each a different specialist |
| `plan-execute-verify.md` | Planner session + executor session + verifier session |
| `reflexion.md` | Worker fails → self-critique session → worker retries with lesson |
| `debate.md` | Advocate session vs opposing session, judge synthesises |
| `hierarchical.md` | Manager session delegates to worker sub-sessions it spawns |
| `swarm.md` | Independent workers handoff tasks by mutual agreement |
| `anti-patterns.md` | Topologies that sound right but fail in practice — read before designing your own |

## Common substrate

Every playbook assumes:

- One bearer token `$TOK` for the whole orchestration
- `daemon user create $TOK` run once
- The `events` Monitor armed for `$TOK`
- Codex profiles pre-defined in `~/.codex/config.toml` for each role (see `skills/configure-codex-team/profiles.md`)

The profile names used across playbooks:

- `reviewer` — `sandbox_mode=read-only`, `effort=xhigh`, `approval=never`
- `fixer` — `sandbox_mode=workspace-write`, `effort=high`, `approval=on-request`
- `tester` — `sandbox_mode=workspace-write`, `effort=medium`, `approval=never`
- `planner` — `sandbox_mode=read-only`, `effort=xhigh`, `approval=never`
- `explorer` — `sandbox_mode=read-only`, `effort=medium`, `approval=never`

Feel free to add your own.

## Shared artefacts convention

When playbooks share state across sessions, they do it via files in the task's cwd:

- `<cwd>/.codex-team/brief.md` — task statement, updated only by Claude (orchestrator)
- `<cwd>/.codex-team/<role>.md` — each role's work doc (worker writes progress here)
- `<cwd>/.codex-team/decisions.md` — append-only decision log if the playbook needs one

These are plain files; the workers access them via normal file ops inside their sandbox. codex-team does NOT manage them.

## Composition

Playbooks compose:

- Plan-execute-verify **containing** a worker-reviewer loop in the execute stage
- Map-reduce **using** the output of a planner stage as the partition
- Reflexion **wrapping** a worker-reviewer loop (the reviewer's reject becomes the reflexion trigger)

Compose only when the added coordination work is worth it. Every additional session = more context overhead + more approval traffic + more event noise. If the problem is small, use `solo-worker.md`.
