---
name: using-codex-team
description: Start here for any task involving the codex-team plugin. Establishes the orchestrator mental model, the event-driven Monitor loop, and routes you to the right focused skill. Use on first contact with the plugin, when a user mentions codex sessions / codex-team / Codex team orchestration, or when you are unsure which codex-team skill applies.
---

# Using codex-team

`codex-team` is a plugin that lets you — Claude — act as the manager of
a team of long-lived Codex worker sessions. Each session is a real
`codex app-server` subprocess owned by the plugin's daemon; you command
them through the `codex-team` CLI and receive their per-turn results
asynchronously through the `Monitor` tool.

You are the **orchestrator**, not a worker. You schedule, audit, and
merge. Codex does the coding.

## Mental model

```
                    Claude (manager)
                         │
         Bash + codex-team CLI   ▲ Monitor notifications
                         │       │
                         ▼       │
                  ┌──────────────────┐
                  │  codex-team      │
                  │  daemon (UDS)    │
                  └──────────────────┘
                   │    │    │    │
                  N codex app-server subprocesses
                   (one per named session)
```

Two flows, asymmetric:

- **You → Codex** is pull: you run `codex-team send <name> "..."` from
  Bash. Send is non-blocking by default — it returns once the turn has
  been queued/started.
- **Codex → You** is push: the daemon watches each session's JSON-RPC
  event stream, renders a per-turn summary, and emits one line on the
  `events` channel when that turn completes. That line reaches you via
  the `Monitor` tool as a notification.

**You do not poll codex. You sleep until Monitor wakes you.** If you
find yourself about to run `codex-team session status` or
`codex-team history` in a loop "to see if the turn is done," stop —
that means the Monitor is not armed, or you forgot it is armed.

## The bootstrap order (once per Claude session)

1. Confirm the daemon is up. The plugin's `SessionStart` hook runs
   `codex-team daemon start` when the plugin activates, and the two
   plugin monitor scripts also pre-start the daemon. Verify with
   `codex-team daemon status`.
2. Confirm the two plugin monitors are live. Claude Code auto-spawns
   them from `monitors/monitors.json` when the plugin is enabled, so
   they should appear in the task panel as `codex-team-events` and
   `codex-team-watchdog`. **You do not call `Monitor({...})`
   yourself** — these are plugin-owned monitors, not user-armed ones.
   If either is missing, run `/reload-plugins`; see `watch-codex-team`
   for deeper diagnosis.
3. Create whatever sessions you need (`manage-codex-team`).
4. Send the first prompts and go to sleep. Subsequent work is
   event-driven.

If the user has provided an overall task brief (e.g. a refactor
instruction doc), record its path — the watchdog reminds you of it
every 20 minutes so you cannot drift off-course.

## Skill router

| You are about to… | Use skill |
|---|---|
| Create / send-to / close a session, write a send prompt | `manage-codex-team` |
| Read session state, history, queue, or a stderr tail | `inspect-codex-team` |
| A session is errored, stuck, down, or the daemon is dead | `recover-codex-team` |
| You saw `[compact-suggest]` on the events stream | `compact-codex-team` |
| Understand the auto-started monitors, or diagnose silent streams | `watch-codex-team` |
| Edit `config.toml`, build a profile, or tune a threshold | `configure-codex-team` |

Commands (user-triggered shortcuts):

| Command | What it does |
|---|---|
| `/codex-team:tutorial` | interactive branching walkthrough for users new to the plugin |
| `/codex-team:bootstrap` | daemon healthcheck + create/resume N sessions (monitors auto-started by the plugin already) |
| `/codex-team:brief` | one-screen snapshot of all sessions + latest events |
| `/codex-team:heal` | try-restart every errored session, report outcome |
| `/codex-team:shutdown` | close all sessions, stop daemon cleanly |

## Invariants (do not break)

1. **One send, then sleep.** After dispatching work, return control to
   the user or sleep. Do not poll. Events will arrive.
2. **Git belongs to you, not codex.** Codex sessions must never run
   `git commit`, `merge`, `push`, `branch`, or `tag`. You handle all
   version control.
3. **Per-session progress file.** Each session maintains
   `docs/refactor/<session>/progress.md` (or equivalent, per the
   user's project layout). Your send prompts reference it instead of
   re-describing the task.
4. **Compaction is manual.** When you see `[compact-suggest]`, follow
   the two-step ritual in `compact-codex-team`. Do not call
   `codex-team compact` directly — codex's built-in compaction loses
   context.
5. **Do not bounce the daemon casually.** Use `health report` and
   per-session recovery first. `daemon stop` / `daemon start` is only
   for when the daemon itself is unresponsive or stale — see
   `recover-codex-team`.

## Red flags — thoughts that mean STOP

| Thought | Correction |
|---|---|
| "Let me just check if the turn finished." | Events come via the plugin's auto-started monitors. Trust them; if silent, see `watch-codex-team`. |
| "Let me call `Monitor({...})` to arm the stream." | Plugin monitors auto-start. Calling Monitor manually creates a duplicate. |
| "I'll write the code fix myself, it's small." | You are the manager. Delegate via `codex-team send`. |
| "Compaction is urgent, I'll just run it." | Follow the two-step ritual in `compact-codex-team`. |
| "The session looks wedged — let me forget + recreate." | Escalation order is `interrupt` → `restart` → `kill` → `forget`. Start at the top. |
| "I'll commit what codex produced." | Yes, *you* commit. Read what codex changed first (`inspect-codex-team`) before staging. |
| "No events for a while, maybe the plugin broke." | Watchdog emits every ~20m. If nothing arrives for >25m, check the task panel (monitors listed?) — see `watch-codex-team`. |

## Response style when reporting to the user

When a Monitor notification wakes you, briefly tell the user what
happened (one or two sentences) and what you decided to do next. Do
not dump the full turn summary unless asked; it is already in
`history.md` for that session.

## When this skill does not apply

- You are writing code *yourself* in this Claude session — this plugin
  is for orchestration, not inline work.
- You need a generic `codex` subagent — that is the `codex:codex-rescue`
  agent from the other plugin; it is one-shot, not long-lived.
