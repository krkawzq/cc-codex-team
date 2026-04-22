---
name: using-codex-team
description: >-
  Entry router and mental model for codex-team — a multi-session Codex orchestration layer. Trigger when (a) the user mentions codex-team, Codex workers, or long-lived Codex sessions; (b) the task needs parallel coding, bulk refactor, multi-agent review, or any work that decomposes into multiple mechanically independent Codex runs; (c) you see a `turn.completed` / `turn.error` / `approval.*` / `user_input.request` event in the task panel and need to know what to do; (d) you're picking whether codex-team is the right tool. Not for: one-shot codex invocations — use the `codex:codex-rescue` subagent.
---

# Using codex-team

> **You are reading this because a skill auto-loader matched a trigger in the description.** If the task below isn't what you're actually doing, close this and return to your work.

`codex-team` runs a **team of long-lived Codex worker sessions** behind one daemon. You (Claude) are the orchestrator — schedule, decide, merge. Workers do the coding.

## Mental model

```
┌────────────────────────────────────────────────────────────────┐
│  agent (Claude)  ──┐                                           │
│                    │ codex-team -b <token> ...  (stateless cli)│
│                    ▼                                           │
│               codex-team-daemon (singleton per OS user)        │
│                    │  JSON-RPC 2.0 over stdio                  │
│                    ▼                                           │
│               codex app-server process(es)                     │
│                    │  isolated live sessions + reusable adhoc  │
│                    ▼                                           │
│               sessions (threads inside app-server)             │
└────────────────────────────────────────────────────────────────┘
```

Five concepts:

| Concept | Meaning |
|---|---|
| **bearer token** | Your identity — any string you pick. Isolates your sessions from other agents sharing the daemon. |
| **user** | Namespace keyed by token. Create once with `daemon user create`. |
| **session** | A codex thread (UUID on the wire). You give it a human name. Persistent on disk by codex. |
| **live session** | A session currently attached to an app-server process. Only live sessions accept `send` / `peer` / `interrupt`. |
| **event** | A NDJSON summary line pushed by the daemon when something happens on a session you own. |

## When to use codex-team

- Task decomposes into ≥2 mechanically independent coding subtasks → parallel workers
- Long-running refactor / bulk migration / large multi-file change → long-lived session
- Review-then-fix / plan-then-execute / debate patterns → multi-session with shared artefacts
- You want to fire off work AND keep your own context free while it runs

## When NOT to use codex-team

- One-shot code fixes where `codex` cli or `codex:codex-rescue` subagent is enough
- Interactive line-by-line editing — codex-team is for autonomous turns
- Anything where you'd micromanage every step; codex-team presumes worker autonomy within a session

## First run (canonical flow)

```bash
# Pick a bearer token — any string you'll reuse for this agent conversation
TOKEN=claude-$(date +%s)

# 1. Register the user (one-time; idempotent for re-register → user_already_exists)
codex-team daemon user create $TOKEN

# 2. Start a session in the repo you're working in
codex-team -b $TOKEN session new refactor --cwd /path/to/repo \
  --model gpt-5.4 --sandbox workspace-write --approval on-request

# 3. Arm the events Monitor (convenience slash command)
#    /codex-team:events -b <TOKEN>
#    — OR equivalent raw Monitor({ command: "... monitor events --stream" })

# 4. Send work. Non-blocking — the turn runs async in the worker.
codex-team -b $TOKEN message send refactor "Refactor the auth module..."

# 5. When an event says turn.completed, fetch the full turn
codex-team -b $TOKEN message tail refactor -n 1 --format markdown
```

The daemon auto-spawned on step 1. No explicit bootstrap. No workspaces. No hooks.

## Core loop

1. **Send or peer** — push a prompt to a live session
2. **Watch events** — `monitor events` tells you when turns finish, errors fire, approvals are needed
3. **Fetch detail on demand** — events are summaries only; use `message tail` for content
4. **Respond to asks** — `approval.*` and `user_input.request` events need your reply via `message approval` / `message answer`
5. **Detach when done** — `session detach` releases app-server resources; the thread persists in codex for later resume

## Skill map

| You need to … | Read |
|---|---|
| Understand the architecture more deeply | `mental-model.md` (this skill) |
| See a full first-run walkthrough | `quickstart.md` (this skill) |
| Look up any CLI command / flag / config key | `skills/configure-codex-team/` |
| Drive sessions day-to-day: send patterns, events, approvals | `skills/manage-codex-team/` |
| Pick a multi-agent topology | `skills/codex-team-playbooks/` |
| Handle errors / crashes / protocol quirks | `skills/recover-codex-team/` |

## Ten invariants

Do not violate these, even under duress:

1. **One bearer token per agent conversation.** Don't rotate mid-session.
2. **Every `-b` call implicitly spawns the daemon.** You never `daemon start` manually.
3. **Sessions are not deletable** by codex-team. `detach` removes from the live set; codex keeps the thread file.
4. **`send` is non-blocking.** It starts a turn and returns. Don't poll for completion — listen on events.
5. **`peer` needs an active turn.** Without one, use `send`.
6. **`interrupt` is hard.** It kills in-flight tool calls. Prefer `peer` if you want to redirect without destroying state.
7. **Events are summaries.** Always. Never expect full turn content in the event stream.
8. **Approvals block the turn.** A session waiting on `approval.*` or `user_input.request` cannot make progress until you reply.
9. **Multiple agents can share a session via `--takeover`**, but the original holder gets a `session.seized` event and loses pending requests. Cross-user attach by name must be unique; otherwise use the `thread_id`.
10. **Daemon auto-shuts down after 6h idle.** Idle is only evaluated when there are 0 live sessions; live sessions and the codex activity associated with them keep the daemon from being idled out. Don't rely on the daemon being there forever if you walk away.

## Output rendering

`session context` / `message history` / `message tail` all accept `--format markdown` and return a tag-structured markdown blob (`<turn>`, `<shell>`, `<file-patch>`, …). Tag names + attributes follow `plugins/codex-team/docs/html-md-format.md`.
