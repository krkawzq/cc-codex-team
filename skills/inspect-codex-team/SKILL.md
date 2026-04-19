---
name: inspect-codex-team
description: Read-only reference for querying codex-team state — registry, per-session status, history, queue, stderr, aggregate health. Trigger when a Monitor event pointed you at a session needing deeper review, when diagnosing drift during a watchdog tick, or when auditing a session's work before a merge. Not for: dispatching work (`manage-codex-team`), recovery actions (`recover-codex-team`), or arming monitors (`watch-codex-team`).
---

# Inspect codex-team

Read-only queries. Nothing here starts, cancels, or compacts anything. The `events` stream already tells you what you need for routine `turn-done` handling — inspection is for the **unusual** case: drift, failed turn, pre-merge audit, watchdog follow-up.

## Query table

| Question | Command |
|---|---|
| Which sessions exist and in what state? | `codex-team session list` |
| Full registry record for one session? | `codex-team session status <name>` |
| Combined registry + queue + stderr + transport liveness? | `codex-team session dump <name>` |
| Aggregate health of all sessions? | `codex-team health report` |
| Codex's Markdown history for a session? | `codex-team history <name> [--last-n N] [--format md]` |
| Raw turn records? | `codex-team history <name> --format jsonl [--last-n N]` |
| Incremental log from a known turn id? | `codex-team history <name> --format jsonl --since-turn-id <turn_id>` |
| Tail new turns after an initial filtered snapshot? | `codex-team history <name> --format jsonl --since-turn-id <id> --follow` |
| Tail of Codex's stderr for a session? | `codex-team tail <name> --stderr` |
| Queue contents? | `codex-team queue show <name>` |
| Daemon's own log? | `codex-team daemon logs [--follow]` |

## When to reach for each

- `session list` — first call on any watchdog tick; first call after `auto-heal`.
- `session status` — one session you care about right now. Gives `last_turn_id`, `last_turn_ended_at`, `token_usage_input`, `queue_length`.
- `session dump` — erroring session where you need registry + queue + stderr in one call. First step of `recover-codex-team` triage.
- `health report` — aggregate, non-destructive. Every watchdog wake, confirm nothing drifted to `errored`.
- `history <name> --format md --last-n 1` — after a `turn-attn` when the summary wasn't enough.
- `history --format jsonl --since-turn-id X` — incremental; don't re-read processed turns.
- `history ... --follow` — tail style, for future appended turns after initial filter.
- `tail <name> --stderr` — `session-down` fired; you need to know *why* (OOM, auth expiry, crash).
- `daemon logs` — the *daemon* is misbehaving (sessions won't resume, UDS errors).

## Decision: "Why am I looking?"

| Reason | Command |
|---|---|
| `turn-attn` — details of one turn | `history <name> --format md --last-n 1` |
| `session-down` — figure out why | `session dump <name>` + `tail <name> --stderr` |
| Watchdog tick — periodic audit | `session list` + `health report` |
| Pre-merge audit of a session's changes | `history <name> --format md` + `git diff` on the worktree + read the work doc |
| Daemon misbehavior | `daemon doctor` + `daemon logs` |

## Budgeting inspection

Each call is cheap. Calling `session status` in a loop "to see if the turn is done" is **polling** — re-read `using-codex-team` and arm the `events` stream.

**Heuristic:** at most one or two inspection calls per wake, always in service of a decision you are about to make. If you are not about to decide, do not inspect.

## Reading `history` efficiently

| Pattern | Use |
|---|---|
| `--last-n 1 --format md` | Most recent turn, human-readable. After `turn-attn`. |
| `--last-n 3 --format md` | Multi-turn context when a worker keeps asking questions. |
| `--format jsonl --last-n 10` | Programmatic: count file changes, diff, extract commands. |
| Full `history.md` | Only for merge audits. |

## `daemon logs` vs session logs

| Log | Content |
|---|---|
| `codex-team daemon logs` | Daemon lifecycle, auto-resume attempts, background-loop failures, UDS errors |
| `codex-team tail <name> --stderr` | Per-session Codex subprocess stderr |

Daemon-level problems → `daemon logs`. Session-level problems → `tail --stderr`.

## The work doc as an inspection target

The session's **work doc** (a Markdown file in the repo at a path the user chose) is often a faster read than raw `history.md`. Progress / Findings / Next up summarize what the worker has been doing without you parsing per-turn diffs.

Use in order:
1. Work doc — what the worker thinks has happened.
2. `history <name> --format md --last-n 3` — what actually happened in recent turns.
3. `tail <name> --stderr` — what broke, if anything.

## Red flags

| Thought | Correction |
|---|---|
| "Let me run `session status` every 10 seconds." | Polling. Arm the events stream (`watch-codex-team`). |
| "I'll read the full `history.md` just in case." | Target with `--last-n`. Full history is merge audits only. |
| "Nothing is wrong but I want to see the queue." | Fine — one call, then stop. Do not loop. |
| "stderr is empty, session must be healthy." | Healthy sessions have empty stderr. Not a reason to keep looking. |
| "Let me dump every session just to see." | `health report` gives you all in one call. |
| "I'll skip the work doc and read raw history." | Work doc first; it's what the worker distilled. History is for the gaps. |

## Cross-references

- After reading, to act: `manage-codex-team` (send) or `recover-codex-team` (triage)
- Reading a `compact-suggest` threshold: `compact-codex-team`
- If inspecting because events stopped: `watch-codex-team` first — diagnosing a silent monitor is cheaper than inspection-polling
