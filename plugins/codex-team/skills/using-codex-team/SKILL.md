---
name: using-codex-team
description: >-
  Entry router and skill map for the codex-team plugin — a multi-worker, multi-workspace Codex orchestration layer. Trigger whenever the user (a) mentions `codex-team`, a codex-team session, or Codex workers; (b) asks for high concurrency, parallel refactor, bulk review, mass debug, batch porting, or many mechanically-independent subtasks; (c) is about to spawn multiple long-lived code agents; (d) shows you a `[turn-done]` / `[turn-attn]` / `[compact-suggest]` / `[session-down]` / `[watchdog-tick]` event in-chat; (e) asks whether codex-team is right for some work. Not for: one-shot codex invocations (use the `codex:codex-rescue` subagent).
---

# Using codex-team

> **You are reading this because a skill auto-loader matched one of the triggers in the `description` above.** Skills in this plugin are loaded on demand, not all at once — `using-codex-team` is the entry router, not a container for every detail. If the task below is not what you are actually doing, close this file and return to your work.

`codex-team` runs a **team of long-lived Codex worker sessions**. You — Claude — are the orchestrator. Workers do the coding; you schedule, decide, merge.

## Before anything else

If you have not read `philosophy.md` (in this same folder) during this conversation, read it now. Every other skill in this plugin assumes its 8 principles are internalized. It is the **single source of truth** for them.

`philosophy.md` is the only place you will find:

- §1 asymmetric division of labour
- §2 convergent vs divergent capability split
- §3 respect the worker; don't replace their thinking
- §4 workers are peers, not tools
- §5 the long-context prompt-apply skip (re-send, not recovery)
- §6 concrete direction beats open-ended tasking
- §7 work-doc discipline
- §8 long instructions go in Markdown files

Other skills link to these section numbers. Do not restate them.

## When to propose this plugin

Suggest `codex-team` when any of the following. If the user hasn't asked, **propose but don't push** — offer it as an option.

| Signal | Why it fits |
|---|---|
| User asks for high concurrency or "many codex at once" | That's literally what this is. |
| User names the plugin, a slash command, or a specific session | Obvious trigger. |
| Task decomposes into ≥3 mechanically-independent subtasks | Each becomes one session; real parallelism. |
| Bulk review across many files / PRs / modules | → `codex-team-playbooks/map-reduce.md` or `worker-reviewer.md`. |
| Mass debug — same class of bug across repositories | One session per repo, same brief. |
| Long-horizon refactor with identifiable chunks | Each chunk = one session with its own work doc. |
| Porting a library across languages / frameworks | Per-component session; shared design brief. |
| User wants to keep working while code is being written | Async loop; your context stays free. |

**Don't propose** when:

| Signal | Why it doesn't fit |
|---|---|
| Single file, single problem, one-shot | Use direct tools or `codex:codex-rescue`. |
| Highly creative / architectural / exploratory | Codex is weak at divergent work (`philosophy.md` §2). |
| Need tight cross-session shared state | Workers have isolated threads; coordination overhead kills the benefit. |
| User is pair-programming synchronously | No async loop to exploit. |
| ≤2 subtasks | You running them directly is faster than spinning up sessions. |

How to propose (one sentence):

> *"I could set this up as a codex-team with N parallel sessions (one per <chunk-dimension>). Each would own its own work doc and I'd coordinate. Want me to?"*

## Mental model

```
      Claude (orchestrator)
           │
    codex-team CLI           ▲ Monitor notifications
           │                 │
           ▼                 │
      codex-team daemon (local IPC, multi-tenant)
        │   │   │   │
       N × codex app-server subprocesses  (one per named session)
```

- **You → Codex** is pull. `codex-team send <name> "..."`. Default is non-blocking.
- **Codex → You** is push. The daemon distils each turn into one event on the `events` stream; the `Monitor` tool delivers it as an in-chat notification.
- **You do not poll.** You sleep until Monitor wakes you. If you're about to loop `codex-team session status` or `history`, stop — either the Monitor isn't armed, or you forgot it is.

## Workspaces (the tenancy unit)

One daemon, many workspaces. Every session, subscription, and watchdog alarm belongs to exactly one workspace. **You see only your current workspace by default.**

Resolution order (first non-empty wins):

1. `--workspace <name>` flag on the CLI call
2. `CODEX_TEAM_WORKSPACE` environment variable
3. `${CLAUDE_PROJECT_DIR}/.codex-team/workspace.env` (pin file)
4. Derived from `CLAUDE_PROJECT_DIR` as `proj-<sha1(abs-path)[:8]>`
5. Literal `default`

The plugin's `SessionStart` hook computes the workspace, registers this Claude Code instance as a client, and exports the resolved workspace into env. **You almost never need to set it yourself.** To inspect: `/codex-team:workspaces` or `codex-team workspace show`.

## Bootstrap order (once per Claude Code session)

1. **Daemon.** `SessionStart` hook starts it. Verify with `codex-team daemon status`.
2. **Arm the `events` stream** — always required when dispatching work. → `manage-codex-team/event-table.md`.
3. **(Optional) Arm a `watchdog` alarm** — only for long-horizon work. → `manage-codex-team` §Watchdog or `/codex-team:watch`.
4. **Create or resume sessions.** → `manage-codex-team` §Session lifecycle, or `/codex-team:bootstrap`.
5. **Send the first prompts, then sleep.** Work is event-driven from here.

`/codex-team:bootstrap` wraps steps 1-2+4.

## Skill router

Load the skill whose trigger matches what you are about to do:

| You are about to… | Use skill |
|---|---|
| Pick a multi-agent collaboration pattern (worker+reviewer, map-reduce, debate, pipeline, …) | `codex-team-playbooks` |
| Create / send / interrupt / close a session, arm events, inspect status | `manage-codex-team` |
| Respond to a `turn-done` / `turn-attn` / `session-down` event | `manage-codex-team` §Decision on every Monitor wake |
| Escalate a failure, a stuck turn, `E_WRONG_WORKSPACE`, or daemon issue | `recover-codex-team` |
| Run the compaction ritual after a `compact-suggest` advisory | `recover-codex-team/compaction-ritual.md` |
| Edit `config.toml`, build a profile, or consult a codex tricks/tuning question | `configure-codex-team` |

## Slash commands (thin, mostly idempotent)

| Command | Purpose |
|---|---|
| `/codex-team:bootstrap [NAME:CWD ...]` | Daemon healthcheck + events armed + sessions created/resumed. |
| `/codex-team:watch [alarm-name] [...]` | Register a runtime watchdog alarm in current workspace. |
| `/codex-team:brief` | One-screen snapshot of sessions + health. |
| `/codex-team:heal` | Restart every errored session in current workspace. |
| `/codex-team:workspaces` | List all workspaces on the daemon. |
| `/codex-team:shutdown` | Close sessions + conditionally stop daemon. |
| `/codex-team:tutorial` | Branching walkthrough for new users. |

Add `--all-workspaces` to inspection commands for audit; destructive commands reject it.

## Invariants (never violate)

1. **One send, then sleep.** After dispatching, return control or `ScheduleWakeup`. Do not poll.
2. **Git belongs to you.** Workers must never run `git commit|merge|push|branch|tag`. You do all version control.
3. **Each session owns one work doc.** → `philosophy.md` §7.
4. **Compaction is a 2-step ritual.** Work doc first, then `compact`. Never call `codex-team compact` alone. → `recover-codex-team/compaction-ritual.md`.
5. **Escalate in order.** `interrupt → restart → kill → forget`. Never skip rungs. → `recover-codex-team`.
6. **YOLO is intentional.** Sandbox `danger_full_access`, approval `never`. Workers complete turns autonomously. Do not narrow unless the user asks via a profile.
7. **Daemon bounces are last-resort.** Try per-session recovery first; bouncing disrupts other workspaces.
8. **`watchdog` is opt-in.** Only for long-horizon work.
9. **Workspace isolation is the default; crossing it is deliberate.** Destructive commands cannot cross workspaces; read-only audit can via `--all-workspaces`.
10. **End the task cleanly.** When orchestration is truly done, run `/codex-team:shutdown`. `SessionEnd` only detaches your client.

## Reporting to the user

When Monitor wakes you, tell the user in 1-2 sentences what happened and what you decided. Do not dump the full turn summary — it's in the session's history and work doc.
