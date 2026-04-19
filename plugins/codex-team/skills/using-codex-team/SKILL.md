---
name: using-codex-team
description: >-
  Entry and globally-loaded router for the codex-team plugin — a multi-worker, multi-workspace Codex orchestration layer. Trigger whenever the user (a) mentions `codex-team`, a codex-team session, or Codex workers; (b) asks for high concurrency, parallel refactor, bulk review, mass debug, batch porting, or many mechanically-independent subtasks; (c) is about to spawn multiple long-lived code agents; (d) shows you a `[turn-done]` / `[turn-attn]` / `[compact-suggest]` / `[session-down]` / `[watchdog-tick]` event in-chat. Also trigger to decide whether to *propose* the plugin when the user describes work that would benefit from parallelism but hasn't named a tool. Not for: one-shot codex invocations (use the `codex:codex-rescue` subagent).
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
    codex-team CLI          ▲ Monitor notifications
           │                │
           ▼                │
      codex-team daemon (local IPC, multi-tenant)
        │   │   │   │
       N × codex app-server subprocesses  (one per named session)
```

- **You → Codex** is pull. `codex-team send <name> "..."`. Default is non-blocking.
- **Codex → You** is push. The daemon distills each turn into one event on the `events` stream; the `Monitor` tool delivers it as an in-chat notification.
- **You do not poll.** You sleep until Monitor wakes you. If you're about to loop `codex-team session status` or `history`, stop — either the Monitor isn't armed, or you forgot it is.

## Workspaces (the tenancy unit)

One daemon, many workspaces. Every session, subscription, and watchdog alarm belongs to exactly one workspace. **You see only your current workspace by default.**

**Workspace resolution order** (first non-empty wins, applied by every CLI call):

1. `--workspace <name>` flag on the CLI call
2. `CODEX_TEAM_WORKSPACE` environment variable
3. `${CLAUDE_PROJECT_DIR}/.codex-team/workspace.env` (pin file)
4. Derived from `CLAUDE_PROJECT_DIR` as `proj-<sha1(abs-path)[:8]>`
5. Literal `default`

The plugin's `SessionStart` hook runs `codex-team hook session-start`, which computes the workspace, registers this Claude Code instance as a *client* of the daemon, and exports the resolved workspace into `$CLAUDE_ENV_FILE` plus `.codex-team/client.env` so later CLI invocations in this session see the same value.

**You almost never need to set the workspace yourself.** The default derivation is good: all Claude Code sessions in the same project share a workspace automatically; different projects are isolated automatically. Use `CODEX_TEAM_WORKSPACE=<name>` (or write `.codex-team/workspace.env`) only when you want a named workspace unrelated to the project directory, or you want two windows in the same project to be isolated.

To inspect: `/codex-team:workspaces` or `codex-team workspace list`.

## Bootstrap order (once per Claude Code session)

1. **Daemon.** `SessionStart` hook starts it. Verify with `codex-team daemon status`.
2. **Arm the `events` stream** — always required when dispatching work. → `watch-codex-team`
3. **(Optional) Arm a `watchdog` alarm** — only for long-horizon work (overnight, multi-hour, cross-day). → `watch-codex-team` §Watchdog
4. **Create or resume sessions.** → `manage-codex-team`, or one-shot `/codex-team:bootstrap NAME:/path ...`
5. **Send the first prompts, then sleep.** Work is event-driven from here.

`/codex-team:bootstrap` wraps steps 1-2+4. `/codex-team:watch` handles step 3.

## Collaboration philosophy (essential)

Read `philosophy.md` in this skill folder for the full text. Short version:

1. **Asymmetric division of labor.** You = one serial manager. Workers = N parallel peers.
2. **Complementary capabilities.** Codex is strong at review/debug/targeted implementation, weak at open-ended creation. You handle divergent; they handle convergent.
3. **Respect, don't replace.** Don't think or write code for them. Direct them.
4. **Workers are peers, not tools.** Ask them questions; expect pushback; iterate.
5. **Long-context quirk.** Occasional mismatched reply = re-send the same prompt. Not a recovery case.
6. **Concrete direction.** Name targets, constraints, references, deliverables. "Strong" ≠ "long."
7. **Work-doc discipline.** Every session owns one durable Markdown work doc; sends reference it.
8. **Long instructions go in files.** A send points at a brief; it doesn't embed it.

## Skill router

| You are about to… | Use skill |
|---|---|
| Create a session, send a prompt, interrupt, close | `manage-codex-team` |
| Arm the `events` stream, or set up a `watchdog` alarm | `watch-codex-team` |
| A session errored, a turn got stuck, daemon unreachable, or a CLI call returns `E_WRONG_WORKSPACE` | `recover-codex-team` |
| You saw `[compact-suggest]` on the events stream | `compact-codex-team` |
| Read session state, history, queue, stderr (read-only) | `inspect-codex-team` |
| Edit `config.toml`, build a profile, change cadence / thresholds | `configure-codex-team` |

Slash commands:

| Command | Purpose |
|---|---|
| `/codex-team:bootstrap [NAME:CWD ...]` | Daemon healthcheck + arm events + create/resume sessions in current workspace |
| `/codex-team:watch [alarm-name] [...]` | Register a runtime watchdog alarm in current workspace |
| `/codex-team:workspaces` | List all workspaces on the daemon; spot cross-window sharing |
| `/codex-team:brief` | One-screen snapshot of sessions + health (current workspace) |
| `/codex-team:heal` | Restart every errored session in current workspace |
| `/codex-team:shutdown` | Close sessions in current workspace + conditionally stop daemon |
| `/codex-team:tutorial` | Branching walkthrough for new users |

Add `--all-workspaces` to inspection commands for audit. Do this only for read-only work; destructive commands reject `--all-workspaces`.

## Invariants (never violate)

1. **One send, then sleep.** After dispatching, return control or `ScheduleWakeup`. Do not poll.
2. **Git belongs to you.** Workers must never run `git commit|merge|push|branch|tag`. You do all version control.
3. **Each session owns one work doc.** User picks the path; you keep it stable. Sends reference it. → `philosophy.md` §7
4. **Compaction is a 2-step ritual.** Write work doc, then compact. Never call `codex-team compact` alone. → `compact-codex-team`
5. **Escalate in order.** `interrupt → restart → kill → forget`. Never skip rungs. → `recover-codex-team`
6. **YOLO is intentional.** Sandbox `danger_full_access`, approval `never`. Workers complete turns autonomously; you only check when done. Mid-turn approvals would defeat the async loop. Do not narrow unless the user asks via a profile.
7. **Daemon bounces are last-resort.** Try per-session recovery first; bouncing disrupts other workspaces that share the daemon.
8. **`watchdog` is opt-in.** Only for long-horizon work. → `watch-codex-team` §Watchdog
9. **Workspace isolation is the default; crossing it is deliberate.** Before any destructive action, confirm the session is in your workspace. `--all-workspaces` is for read-only audit only.
10. **End the task cleanly.** When your orchestration is truly done (PR merged, batch complete, user dismisses the work), run `/codex-team:shutdown`. SessionEnd only detaches your client; shutdown is what closes worker sessions and releases resources.

## Red flags

| Thought | Correction |
|---|---|
| "Let me check if the turn finished." | Polling. Events arrive via Monitor. Arm (`watch-codex-team`) or diagnose silence. |
| "I see a session I didn't create — maybe it's broken." | Another workspace may exist on the same daemon. Run `/codex-team:workspaces` before touching. |
| "I'll kill this stale-looking session." | Check its workspace first. Never `kill` or `forget` a session outside yours. |
| "I'll write this small fix myself." | You are the orchestrator. Delegate. → `philosophy.md` §§1,3 |
| "Compaction is urgent, I'll just run it." | Two-step ritual, always. → `compact-codex-team` |
| "Session wedged — forget + recreate." | Start at `interrupt`. → `recover-codex-team` |
| "Codex's reply doesn't match my prompt — must be broken." | Long-context skip? Re-send once. → `philosophy.md` §5 |
| "I'll arm the watchdog just in case." | Opt-in only. Without a long-horizon reason, it's noise. |
| "I'll embed the full task spec in the send." | Write a brief file; point at it. → `philosophy.md` §8 |
| "I'll leave the daemon running — next session can reuse it." | Fine while you're pausing the same task. Not fine when the work is truly done — run `/codex-team:shutdown`. |

## Reporting to the user

When Monitor wakes you, tell the user in 1-2 sentences what happened and what you decided. Do not dump the full turn summary — it's in the session's history and work doc.
