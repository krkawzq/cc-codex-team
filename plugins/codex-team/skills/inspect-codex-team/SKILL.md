---
name: inspect-codex-team
description: >-
  Read-only reference for querying codex-team state — registry, per-session status, history, queue, stderr, aggregate health, workspaces, clients, and runtime alarms. Trigger when a Monitor event pointed you at a session needing deeper review, when diagnosing drift during a watchdog tick, when auditing a session's work before a merge, or when debugging "which other workspace is using this daemon." Not for: dispatching work (`manage-codex-team`), recovery actions (`recover-codex-team`), or arming monitors (`watch-codex-team`).
---

# Inspect codex-team

Read-only queries. Nothing here starts, cancels, or compacts anything. The `events` stream already tells you what you need for routine `turn-done` handling — inspection is for the **unusual** case: drift, failed turn, pre-merge audit, watchdog follow-up, cross-workspace debugging.

**Scope rule:** every read command is workspace-scoped by default. Pass `--all-workspaces` for audit.

## Query table

| Question | Command |
|---|---|
| Which sessions exist in my workspace? | `codex-team session list` |
| All sessions on the daemon (audit)? | `codex-team session list --all-workspaces` |
| Full registry record for one session? | `codex-team session status <name>` |
| Combined registry + queue + stderr + transport liveness? | `codex-team session dump <name>` |
| Aggregate health of my workspace? | `codex-team health report` |
| Aggregate health across all workspaces? | `codex-team health report --all-workspaces` |
| Codex's Markdown history for a session? | `codex-team history <name> [--last-n N] [--format md]` |
| Raw turn records? | `codex-team history <name> --format jsonl [--last-n N]` |
| Incremental log from a known turn id? | `codex-team history <name> --format jsonl --since-turn-id <turn_id>` |
| Tail new turns after an initial filtered snapshot? | `codex-team history <name> --format jsonl --since-turn-id <id> --follow` |
| Tail of Codex's stderr for a session? | `codex-team tail <name> --stderr` |
| Queue contents? | `codex-team queue show <name>` |
| Daemon's own log? | `codex-team daemon logs [--follow]` |
| Daemon + IPC + workspace diagnostic snapshot? | `codex-team daemon doctor` |
| Workspace summary (all workspaces + session/client counts)? | `codex-team workspace list` |
| Details for one workspace? | `codex-team workspace show [<name>]` |
| Who is connected right now (live clients)? | `codex-team client list` |
| Runtime watchdog alarms in my workspace? | `codex-team watch alarm list` |
| All runtime alarms on the daemon? | `codex-team watch alarm list --all-workspaces` |

## When to reach for each

- `session list` — first call on any watchdog tick; first call after `auto-heal`.
- `session list --all-workspaces` — when you see a session in the daemon log that you don't recognize, or when diagnosing an `E_WRONG_WORKSPACE` error.
- `session status <name>` — one session you care about right now. Gives `last_turn_id`, `last_turn_ended_at`, `token_usage_input`, `queue_length`, `workspace`.
- `session dump <name>` — erroring session where you need registry + queue + stderr in one call. First step of `recover-codex-team` triage.
- `health report` — aggregate for your workspace, non-destructive. Every watchdog wake.
- `history <name> --format md --last-n 1` — after a `turn-attn` when the summary wasn't enough.
- `history --format jsonl --since-turn-id X` — incremental; don't re-read processed turns.
- `tail <name> --stderr` — `session-down` fired; you need to know *why* (OOM, auth expiry, crash).
- `daemon logs` — the *daemon* is misbehaving (sessions won't resume, UDS errors).
- `daemon doctor` — one-shot "everything at a glance" of the daemon: `ipc_kind` (`uds` on Linux/macOS, `pipe` on Windows), `ipc_endpoint`, `ipc_ready`, `socket_exists` (UDS only), `pid`, workspace/session summary, client list. Start here when triage needs facts.
- `workspace list` — you want to know if you're alone on this daemon or there's cross-window sharing.
- `client list` — diagnose "is a zombie subscriber holding my monitor from draining," or count active Claude Code sessions.
- `watch alarm list` — audit which watchdog alarms are scheduled in your workspace.

## Decision: "Why am I looking?"

| Reason | Command |
|---|---|
| `turn-attn` — details of one turn | `history <name> --format md --last-n 1` |
| `session-down` — figure out why | `session dump <name>` + `tail <name> --stderr` |
| Watchdog tick — periodic audit | `session list` + `health report` |
| Pre-merge audit of a session's changes | `history <name> --format md` + `git diff` on the worktree + read the work doc |
| Daemon misbehavior | `daemon doctor` + `daemon logs` |
| `E_WRONG_WORKSPACE` | `workspace list` + `session list --all-workspaces` |
| "Is another CC window on this daemon?" | `workspace list` + `client list` |
| "Why is my watchdog silent?" | `watch alarm list` + check `emit_idle` on the alarm you expected |

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
| `codex-team daemon logs` | Daemon lifecycle, auto-resume attempts, background-loop failures, UDS errors, client-sweep events |
| `codex-team tail <name> --stderr` | Per-session Codex subprocess stderr |

Daemon-level problems → `daemon logs`. Session-level problems → `tail --stderr`.

## The work doc as an inspection target

The session's **work doc** (a Markdown file in the repo at a path the user chose) is often a faster read than raw `history.md`. Progress / Findings / Next up summarize what the worker has been doing without you parsing per-turn diffs.

Use in order:
1. Work doc — what the worker thinks has happened.
2. `history <name> --format md --last-n 3` — what actually happened in recent turns.
3. `tail <name> --stderr` — what broke, if anything.

## Cross-workspace audit

When you need to inspect across tenants — typically because `E_WRONG_WORKSPACE` fired or the user asks "who else is on this daemon":

```bash
codex-team workspace list
codex-team session list --all-workspaces
codex-team client list
codex-team watch alarm list --all-workspaces
```

Use read-only flags only. Destructive commands reject `--all-workspaces` on purpose — they must stay in the caller's workspace.

## Red flags

| Thought | Correction |
|---|---|
| "Let me run `session status` every 10 seconds." | Polling. Arm the events stream (`watch-codex-team`). |
| "I'll read the full `history.md` just in case." | Target with `--last-n`. Full history is merge audits only. |
| "Nothing is wrong but I want to see the queue." | Fine — one call, then stop. Do not loop. |
| "stderr is empty, session must be healthy." | Healthy sessions have empty stderr. Not a reason to keep looking. |
| "Let me dump every session just to see." | `health report` gives all in your workspace in one call. |
| "I'll skip the work doc and read raw history." | Work doc first; it's what the worker distilled. History is for gaps. |
| "I'll `session list --all-workspaces` as my normal check." | Stay scoped by default. `--all-workspaces` is for audits of specific questions, not routine scans. |

## Cross-references

- After reading, to act: `manage-codex-team` (send) or `recover-codex-team` (triage)
- Reading a `compact-suggest` threshold: `compact-codex-team`
- If inspecting because events stopped: `watch-codex-team` first — diagnosing a silent monitor is cheaper than inspection-polling
- Daemon-level / cross-workspace overview: `/codex-team:workspaces`
