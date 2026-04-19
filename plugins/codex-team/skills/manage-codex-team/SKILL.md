---
name: manage-codex-team
description: >-
  Authoritative source for codex-team session lifecycle (create / send / interrupt / close), event-stream arming, `turn-done` / `turn-attn` response decisions, and read-only inspection. Trigger when you are about to create/send/inspect a session, arm the `events` stream, respond to an event Monitor just delivered, or audit session state before a decision. Not for: failure triage (`recover-codex-team`), compaction ritual (`recover-codex-team/compaction-ritual.md`), picking a collaboration pattern (`codex-team-playbooks`), config/tuning (`configure-codex-team`).
---

# Manage codex-team

> **You are reading this because you are about to dispatch work, read state, or respond to an event.** If the event is an error/failure/quirk, close this and open `recover-codex-team` instead. If you need to pick *how many workers and with what roles*, close this and open `codex-team-playbooks` first.

**Prerequisites:**

- You have internalized the 8 principles in `using-codex-team/philosophy.md`.
- You know which workspace you're in (`using-codex-team` §Workspaces; verify with `codex-team workspace show`).
- The `events` Monitor stream is armed — see §Arming events below.

**Every CLI call in this skill operates in your current workspace** unless you pass `--workspace <name>`. Cross-workspace destructive operations are rejected with `E_WRONG_WORKSPACE`.

**Reference files in this skill** (read on demand, not upfront):

- `send-patterns.md` — how to deliver a prompt (inline / temp file / repo brief), style rules, quoting traps.
- `event-table.md` — every event kind, its payload, and the decision you should take.
- `work-doc.md` — the durable session state file every session owns.

## Session lifecycle

```
  (nothing)
     │
     │  codex-team session create <name> --cwd <path> [--profile X]
     ▼
   idle ◄────────────────── turn/completed
     │                          ▲
     │  codex-team send ...     │
     ▼                          │
   running ────────────── codex finishes
     │                          │
     │  codex-team interrupt    │
     └──────────────────────────┘
     │
     │  codex-team session close <name>
     ▼
   closed  (thread preserved; can `session resume <name>`)
```

Recovery states `errored` / `compacting` are handled by `recover-codex-team`.

### Create

```bash
codex-team session create <name> \
    --cwd <absolute-path> \
    --profile <profile-name>
```

- **Name format**: 1–64 chars, first char `[a-zA-Z0-9_]`, rest `[a-zA-Z0-9_.-]`. No Windows reserved names (`CON`, `PRN`, …). No `/\:*?"<>|`. Invalid → `E_INVALID_NAME`.
- Names are **unique within a workspace**, not globally. Two workspaces can both have `reviewer`.
- Pick names that describe the worker's scope (role, module, chunk dimension).
- Each session is a real `codex app-server` subprocess — intentional.
- `--cwd` is typically a git worktree you created beforehand.
- `--profile <name>` pulls defaults from `[profiles.<name>]`. Prefer profiles over long flag lists.
- Sandbox defaults to `danger_full_access`, approval to `never`. Intentional (`using-codex-team` §Invariants #6).

### Send

```bash
codex-team send <name> "<prompt>"
```

Default is **non-blocking** — returns once the turn is queued. Outcome arrives on the `events` stream, not stdout.

**Send-prompt style and delivery mechanics → `send-patterns.md`.** In 2 sentences: a send should be short and point at a work doc or brief; any prompt longer than a paragraph, or containing `"` / `` ` `` / `$` / `!` / newline, must be delivered via `--prompt-file` or a repo brief file. Do not escape; switch to a file.

### Queue behaviour

Sends while a session is `running` **queue** — they do not reject. Per-session queue, max 5 by default.

- Pipeline: `send A "step 1"`, then `send A "step 2"` — they run sequentially.
- Inspect: `codex-team queue show <name>`.
- On overflow: default policy `warn` still enqueues + emits `queue-overflow`. Change in config for `reject` or `drop_oldest`.

### Interrupt

```bash
codex-team interrupt <name>
```

Cancels the current turn at the next safe point. Turn emits `turn-done` with partial state or `errored`. Queue continues. Use when the worker is looping on non-productive reasoning, when you need to redirect after partial results, or when a long turn has produced the valuable output and is now polishing.

### Close

```bash
codex-team session close <name>
```

Stops the subprocess, marks session `closed`, preserves the thread. `codex-team session resume <name>` re-attaches a fresh subprocess.

For permanent removal: `codex-team session forget <name>` — see `recover-codex-team` for when to escalate this far.

## Arming events (always required when dispatching)

This is the stream that makes the async loop work. Arm **once per Claude Code session.**

```
Monitor({
  description: "codex-team events: turn completions, errors, compact suggestions",
  command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/main.js\" monitor events",
  persistent: true,
  timeout_ms: 3600000
})
```

`/codex-team:bootstrap` does this for you (idempotent via task-panel check). Re-arm after a daemon restart — persistent Monitor children don't reconnect. Do not re-arm on every turn.

**Every event kind, its payload, and the decision → `event-table.md`.**

## Watchdog (opt-in only)

The `watchdog` stream is a **periodic reminder + self-check** channel for you (the orchestrator). Separate from `events`. **Opt-in per workspace.** Arm only when the work is long-horizon (>1h wall-clock with mostly-idle orchestrator, overnight, cross-day). For short iterations / interactive sessions, watchdog is pure noise.

Quick path:

```
/codex-team:watch <alarm-name> [--task-brief FILE] [--interval-seconds N] [--emit-idle]
```

Manual equivalent + template variables: see `configure-codex-team/config-schema.md` §Watchdog alarms.

On every watchdog tick you receive:

1. Read `message`. Let it re-anchor you.
2. If `summary.errored > 0` → `/codex-team:heal` or `recover-codex-team`.
3. If any advisory includes `crossed compaction threshold` → `recover-codex-team/compaction-ritual.md`.
4. If `taskBrief` is present, compare it with what sessions are actually working on. Drift? Nudge the off-course session with a re-anchoring send.
5. Sleep.

## Decision on every Monitor wake (summary)

| Event | Decide |
|---|---|
| `turn-done` (normal) | Read summary → next prompt → one `send` → sleep. |
| `turn-attn` with question | Answer verbatim in next `send` → sleep. |
| `turn-attn` with failure | Fix the input (name target, adjust constraint) → re-dispatch. |
| `turn-done` but reply doesn't match the prompt | **Known quirk** — re-send same prompt. → `philosophy.md` §5. |
| `compact-suggest` | → `recover-codex-team/compaction-ritual.md`. |
| `session-down` / `turn-err` / `auto-heal` | → `recover-codex-team`. |
| `queue-overflow` | You're over-dispatching. Throttle. |

Full payload schemas + subtler decisions → `event-table.md`.

## Read-only inspection

Each call is cheap. Use **one or two per wake**, always in service of a decision you're about to make. If you're not about to decide, do not inspect.

| Question | Command |
|---|---|
| Which sessions exist? | `codex-team session list` |
| One session's full record | `codex-team session status <name>` |
| Status + queue + stderr + transport (for triage) | `codex-team session dump <name>` |
| Aggregate health | `codex-team health report` |
| Markdown history of a session | `codex-team history <name> [--last-n N] [--format md]` |
| Raw turn records | `codex-team history <name> --format jsonl [--last-n N]` |
| Queue contents | `codex-team queue show <name>` |
| Per-session stderr tail | `codex-team tail <name> --stderr` |
| Daemon log | `codex-team daemon logs [--follow]` |
| One-shot daemon diagnostic | `codex-team daemon doctor` |
| Workspace map | `codex-team workspace list` |
| Live clients | `codex-team client list` |
| Runtime watchdog alarms | `codex-team watch alarm list` |

Cross-workspace audits: add `--all-workspaces` (read-only only).

Polling `session status` in a loop "to check if the turn finished" is not inspection — it's a symptom that `events` isn't armed. Close this skill, go arm it.

Prefer the **work doc** over `history.md` for understanding what the worker did. The work doc is distilled; history is raw. See `work-doc.md`.

## Red flags

| Thought | Correction |
|---|---|
| "I'll use `--wait` to keep things simple." | Default async; keep the Monitor loop. |
| "Let me stuff the full task description into the send." | → `send-patterns.md` §Instruction-file pattern. |
| "Let me escape these quotes and backticks in the inline send." | Stop. Switch to `--prompt-file`. → `send-patterns.md`. |
| "I'll figure out the approach myself, then tell Codex what to type." | Over-specified. Name target + constraint + reference; let the worker execute. → `philosophy.md` §3. |
| "I'll just write this small fix inline — faster than sending." | You're the orchestrator. Delegate. → `philosophy.md` §1. |
| "5 minutes running — something must be wrong." | Turns can take minutes. Wait for `turn-done` or `turn-stuck`. |
| "Worker's reply doesn't match my prompt — must be broken." | Long-context skip? Re-send once. → `philosophy.md` §5. |
| "I'll send a new prompt to cancel the current turn." | Sends queue. Use `codex-team interrupt`. |
| "Worker is disagreeing — let me override and force the plan." | Read the pushback seriously. → `philosophy.md` §4. |
| "Let me run `session status` every 10 seconds." | Polling. Arm the `events` stream. |
| "I'll read the full `history.md` just in case." | Work doc first (`work-doc.md`). `history.md` is for gaps. |

## Cross-references

- Collaboration principles: `using-codex-team/philosophy.md`
- Picking a collaboration pattern: `codex-team-playbooks`
- Failure triage / escalation ladder: `recover-codex-team`
- Compaction ritual: `recover-codex-team/compaction-ritual.md`
- Config knobs, profiles, codex tricks: `configure-codex-team`
