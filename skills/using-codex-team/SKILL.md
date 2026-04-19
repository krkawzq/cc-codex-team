---
name: using-codex-team
description: Entry and globally-loaded router for the codex-team plugin — a multi-worker Codex orchestration layer. Trigger whenever the user (a) mentions `codex-team`, a codex-team session, or Codex workers; (b) asks for high concurrency, parallel refactor, bulk review, mass debug, batch porting, or many mechanically-independent subtasks; (c) is about to spawn multiple long-lived code agents; (d) shows you a `[turn-done]` / `[turn-attn]` / `[compact-suggest]` / `[session-down]` / `[watchdog-tick]` event in-chat. Also trigger to decide whether to *propose* the plugin when the user describes work that would benefit from parallelism but hasn't named a tool. Not for: one-shot codex invocations (use the `codex:codex-rescue` subagent).
---

# Using codex-team

`codex-team` is a plugin for running a **team of long-lived Codex worker sessions**. You — Claude — are the orchestrator. Workers do the coding. You schedule, decide, merge.

If this is your first time in a conversation where this plugin matters, read `philosophy.md` (in this same skill folder). The rest of this skill is operational.

## When to propose this plugin

You should suggest `codex-team` when you observe any of the following. If the user hasn't asked, **propose but don't push** — offer it as an option.

| Signal | Why it fits |
|---|---|
| User asks for high concurrency or "many codex at once" | That's literally what this is |
| User names the plugin, slash command, or a specific session | Obvious trigger |
| Task decomposes into ≥3 mechanically independent subtasks | Each becomes one session; real parallelism |
| Bulk review across many files / PRs / modules | Workers run `review` profiles in parallel |
| Mass debug — same class of bug across repositories | One session per repo, same brief |
| Long-horizon refactor with identifiable chunks | Each chunk = one session with its own work doc |
| Porting a library across languages / frameworks | Per-component session; shared design brief |
| User wants to keep working while code is being written | Async loop; your context stays free |

**Don't propose** when:

| Signal | Why it doesn't fit |
|---|---|
| Single file, single problem, one-shot | Use direct tools or `codex:codex-rescue` — setup cost isn't worth it |
| Highly creative / architectural / exploratory | Codex is weak at divergent work (see `philosophy.md` §2) |
| Need tight cross-session shared state | Workers have isolated threads; coordination overhead kills the benefit |
| User is pair-programming synchronously | No async loop to exploit |
| ≤2 subtasks | You as the manager running them directly is faster than spinning up sessions |

How to propose:

> *"I could set this up as a codex-team with N parallel sessions (one per <chunk-dimension>). Each would own its own work doc and I'd coordinate. Want me to?"*

Keep it one sentence. Let the user opt in.

## Mental model

```
      Claude (orchestrator)
           │
    Bash + codex-team CLI   ▲ Monitor notifications
           │                │
           ▼                │
      codex-team daemon (Unix socket)
        │   │   │   │
       N × codex app-server subprocesses  (one per named session)
```

- **You → Codex** is pull. You run `codex-team send NAME "..."` from Bash. Default is non-blocking.
- **Codex → You** is push. The daemon distills each turn into one event on the `events` stream; the `Monitor` tool delivers it as an in-chat notification.
- **You do not poll.** You sleep until Monitor wakes you. If you're about to loop `codex-team session status` or `history` to see if a turn finished, stop — either the Monitor is not armed, or you forgot it is.

## Bootstrap order (once per Claude Code session)

1. **Daemon.** `SessionStart` hook runs `codex-team daemon start`. Verify with `codex-team daemon status`.
2. **Arm the `events` stream** — always required when dispatching work. → `watch-codex-team`
3. **(Optional) Arm a `watchdog` alarm** — only for long-horizon work (overnight, multi-hour, cross-day). Not the default. → `watch-codex-team` §Watchdog
4. **Create or resume sessions.** → `manage-codex-team`, or one-shot `/codex-team:bootstrap NAME:/path ...`
5. **Send the first prompts, then sleep.** Work is event-driven from here.

`/codex-team:bootstrap` wraps steps 1-2+4. `/codex-team:watch` handles step 3 when you want it.

## Collaboration philosophy (essential)

Read `philosophy.md` in this skill folder for the full text. The short version:

1. **Asymmetric division of labor.** You = one serial manager. Workers = N parallel peers.
2. **Complementary capabilities.** Codex is strong at review/debug/targeted implementation, weak at open-ended creation. You handle the divergent call; they handle the convergent execution.
3. **Respect, don't replace.** Don't think or write code for them. Direct them.
4. **Workers are peers, not tools.** Ask them questions; expect pushback; iterate in conversation.
5. **Long-context quirk.** Occasional mismatched reply = re-send the same prompt. Not a recovery case.
6. **Concrete direction.** Name targets, constraints, references, deliverables. "Strong" ≠ "long."
7. **Work-doc discipline.** Every session owns one durable Markdown work doc; sends reference it.
8. **Long instructions go in files.** A send points at a brief; it doesn't embed the brief.

## Skill router

| You are about to… | Use skill |
|---|---|
| Create a session, send a prompt, interrupt, close | `manage-codex-team` |
| Arm the `events` stream, or set up a `watchdog` alarm | `watch-codex-team` |
| A session errored, a turn got stuck, daemon unreachable | `recover-codex-team` |
| You saw `[compact-suggest]` on the events stream | `compact-codex-team` |
| Read session state, history, queue, stderr (read-only) | `inspect-codex-team` |
| Edit `config.toml`, build a profile, define a watchdog alarm | `configure-codex-team` |

Slash commands:

| Command | Purpose |
|---|---|
| `/codex-team:bootstrap [NAME:CWD ...]` | Daemon healthcheck + arm events + create/resume sessions (no watchdog) |
| `/codex-team:watch [alarm-name] [--task-brief FILE] [--interval SECS]` | Arm / define a `watchdog` alarm for long-horizon work |
| `/codex-team:brief` | One-screen snapshot of sessions + health |
| `/codex-team:heal` | Restart every errored session |
| `/codex-team:shutdown` | Close sessions + stop daemon cleanly |
| `/codex-team:tutorial` | Branching walkthrough for new users |

## Invariants (never violate)

1. **One send, then sleep.** After dispatching, return control or `ScheduleWakeup`. Do not poll.
2. **Git belongs to you.** Workers must never run `git commit|merge|push|branch|tag`. You do all version control.
3. **Each session owns one work doc.** The user picks the path; you keep it stable. Sends reference it instead of re-describing the task. → `philosophy.md` §7
4. **Compaction is a 2-step ritual.** Write work doc, then compact. Never call `codex-team compact` alone. → `compact-codex-team`
5. **Escalate in order.** `interrupt → restart → kill → forget`. Never skip rungs. → `recover-codex-team`
6. **YOLO is intentional.** Sandbox = `danger_full_access`, approval = `never`. This is so workers complete turns autonomously and you only check when they're done — mid-turn prompts would defeat the async loop. Do not "fix" this unless the user explicitly narrows a profile.
7. **Daemon bounces are last-resort.** Try `health report` and per-session recovery first. Bouncing the daemon is loud and disrupts monitors.
8. **`watchdog` is opt-in.** Do not arm it by default. Long-horizon work only. → `watch-codex-team` §Watchdog

## Red flags

| Thought | Correction |
|---|---|
| "Let me check if the turn finished." | Polling. Events arrive via Monitor. Arm (`watch-codex-team`) or diagnose silence. |
| "The plugin will start the monitors for me." | It won't. Only `SessionStart → daemon start` is automatic. Arm streams yourself. |
| "I'll write this small fix myself." | You are the orchestrator. Delegate. → `philosophy.md` §§1,3 |
| "Compaction is urgent, I'll just run it." | Two-step ritual, always. → `compact-codex-team` |
| "Session wedged — forget + recreate." | Start at `interrupt`. → `recover-codex-team` |
| "Codex's reply doesn't match my prompt — must be broken." | Long-context skip? Re-send once. → `philosophy.md` §5 |
| "I'll arm the watchdog just in case." | Opt-in only. Without a reason, it's noise. |
| "I'll embed the full task spec in the send." | Write a brief file; point at it. → `philosophy.md` §8 |

## Reporting to the user

When Monitor wakes you, tell the user in 1-2 sentences what happened and what you decided. Do not dump the full turn summary — it's in the session's history and work doc.
