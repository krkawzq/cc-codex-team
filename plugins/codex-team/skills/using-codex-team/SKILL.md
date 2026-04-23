---
name: using-codex-team
description: >-
  Entry router and mental model for codex-team — a multi-session Codex orchestration layer Claude uses to spawn long-lived worker sessions in parallel. **Proactively load this skill whenever a coding task decomposes into ≥2 mechanically independent subtasks, OR matches any of: parallel/concurrent work, bulk refactor, multi-file migration, audit+fix, map-reduce, fan-out, swarm, spawn workers, worker+reviewer, plan→execute→verify, debate, long-horizon / autonomous / unattended coding, 并行 / 并发 / 批量 / 同时 / 多个 agent — even without an explicit "codex-team" mention.** Also load on (a) the user naming codex-team, Codex workers, long-lived Codex sessions, bearer token, codex-team CLI; (b) seeing a `turn.completed` / `turn.error` / `approval.*` / `user_input.request` / `session.crashed` / `session.closed` / `session.seized` / `turn.queued_*` event in the task panel; (c) picking whether codex-team is the right tool vs. direct `codex` CLI / `codex:codex-rescue` subagent. Not for: one-shot edits you'd micromanage — use `codex:codex-rescue` or the `codex` CLI directly.
---

# Using codex-team

> **You are reading this because a skill auto-loader matched a trigger in the description.** If the task below isn't what you're actually doing, close this and return to your work.

`codex-team` runs a **team of long-lived Codex worker sessions** behind one daemon. You (Claude) are the orchestrator — schedule, decide, merge. Workers do the coding in parallel.

## Recognition heuristic (run this before any complex coding task)

Before starting any non-trivial coding task, ask yourself three questions. If **any** answers "yes", codex-team is likely the right tool:

1. **Can I decompose this into ≥2 independent subtasks that could run in parallel?**
   (bulk refactor, audit across N files/modules, N similar migrations, N independent analyses)
2. **Will this take long enough that I want my context free while it runs?**
   (long-horizon work: multi-module migration, 30+ file refactor, running tests repeatedly, iterative worker+reviewer loops)
3. **Would another codex worker add real value as a second pair of eyes, a critic, or a specialist role?**
   (plan→execute→verify, worker+reviewer, debate, reflexion)

If all three are "no" → use the `codex` CLI or `codex:codex-rescue` subagent directly. codex-team's overhead (daemon + sessions + events) only pays off when you actually use the parallelism or long-running nature.

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

Six concepts — learn all of these before dispatching work:

| Concept | Meaning |
|---|---|
| **bearer token** | Your identity — any string you pick. Isolates your sessions from other agents sharing the daemon. Stick with one token per agent conversation. |
| **user** | Namespace keyed by token. Create once with `daemon user create`. Idempotent (re-register → `user_already_exists`, treat as success). |
| **session** | A codex thread (UUID on the wire). You give it a human name. Persistent on disk by codex. Not deletable by codex-team — `detach` only removes the live binding. |
| **live session** | A session currently attached to an app-server process. Only live sessions accept `send` / `peer` / `interrupt`. A `detached` session still exists on disk and can be re-attached by name or `thread_id`. |
| **event** | A NDJSON summary line pushed by the daemon when something happens on a session you own. Events are **summaries only** — fetch turn content with `message tail` / `message history`. |
| **cursor** | A named resume point in your event log. `cursor save <name>` freezes the tail id, then `monitor events --cursor <name>` resumes from there and auto-advances as events are consumed. Survives daemon restarts. |

## Fit matrix — when to use codex-team

| Task shape | Fit |
|---|---|
| Task decomposes into ≥2 mechanically independent coding subtasks | ✅ Parallel workers (map-reduce, swarm) |
| Long refactor / bulk migration / large multi-file change | ✅ Long-lived session, optionally with reviewer loop |
| Review-then-fix / plan-then-execute / debate | ✅ Multi-session with shared `.codex-team/` artefacts |
| Want to fire off work and keep Claude context free | ✅ Send → sleep → wake on event |
| One-shot edit (add one function, fix one line, rename one symbol) | ❌ Use `codex:codex-rescue` subagent |
| Interactive line-by-line editing | ❌ codex-team presumes worker autonomy within a turn |
| Task you'd micromanage every step | ❌ Use the `codex` CLI directly |

## First run (canonical flow)

```bash
# Pick a bearer token — any string you'll reuse for this agent conversation
TOKEN=claude-$(date +%s)

# 1. Register the user (one-time; idempotent for re-register → user_already_exists)
codex-team daemon user create $TOKEN

# 2. Start a session in the repo you're working in
codex-team -b $TOKEN session new refactor --cwd /path/to/repo \
  --model gpt-5.4 --sandbox workspace-write --approval on-request
codex-team -b $TOKEN cursor save refactor-tail

# 3. Arm the events Monitor (convenience slash command)
#    /codex-team:events -b <TOKEN>
#    — OR equivalent raw Monitor({ command: "... monitor events --stream --summary --cursor refactor-tail" })

# 4. Send work. Non-blocking — the turn runs async in the worker.
codex-team -b $TOKEN message send refactor "Refactor the auth module..."

# 5. If you're blocked on just this turn, wait directly
codex-team -b $TOKEN message wait refactor --timeout 0

# 6. When an event says turn.completed, fetch the full turn
codex-team -b $TOKEN message tail refactor -n 1 --format markdown
```

The daemon auto-spawned on step 1. No explicit bootstrap. No workspaces. No hooks.

## Core loop

1. **Send or peer** — push a prompt to a live session
2. **Watch events** — `monitor events` tells you when turns finish, errors fire, sessions crash/close, approvals arrive
3. **Fetch detail on demand** — events are summaries; use `message tail` for content
4. **Respond to asks** — `approval.*` and `user_input.request` events need your reply via `message approval` / `message answer`
5. **Detach when done** — `session detach` releases app-server resources; the thread persists in codex for later resume

If you see `session.crashed`, inspect the live snapshot with `session health` and repair with `session heal`. `session.closed` means the live binding was torn down intentionally; if the underlying thread still exists, re-attach it.

## Fan-out tip — survey once, fork N times

When you're about to spawn ≥3 workers on the **same codebase**, don't let each one re-ingest it. Run a single **surveyor** session first (read-only, `explorer` or `planner` profile), have it survey the repo and file findings to `.codex-team/survey.md`, then `codex-team session fork surveyor worker-<i>` for each worker. Each fork inherits the surveyor's full context turn-for-turn, so you pay the research cost once and every worker starts with complete understanding.

```bash
codex-team -b $TOK session new surveyor --cwd /repo --sandbox read-only --approval never
codex-team -b $TOK message send surveyor "Survey this repo. Architecture, conventions, risky areas. Write to .codex-team/survey.md."
codex-team -b $TOK message wait surveyor --timeout 0

for i in 0 1 2 3; do
  codex-team -b $TOK session fork surveyor "worker-$i"      # inherits survey context
  codex-team -b $TOK message send "worker-$i" "Your task: <subtask-$i>."
done
codex-team -b $TOK session detach surveyor                    # thread persists for re-forking later
```

Break-even is ~N≥3. For detailed rules (reconfiguring fork sandbox, composition with map-reduce / worker-reviewer, anti-patterns) see `codex-team-playbooks/survey-and-fork.md`.

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
3. **Sessions are not deletable** by codex-team. `detach` removes from the live set; codex keeps the thread file. **But a session with zero turns is not persisted by codex** — always send at least one turn before detaching a session you want to resume.
4. **`send` is non-blocking.** It starts a turn and returns. Don't poll for completion — listen on events or block explicitly with `message wait`.
5. **`peer` needs an active turn.** Without one, use `send`.
6. **`interrupt` is hard.** It kills in-flight tool calls. Prefer `peer` if you want to redirect without destroying state.
7. **Events are summaries.** Always. In 0.5.2, `turn.completed` is compact metadata only (`turn_id`, `status`, `duration_ms`, `items_count`, `token_usage`, `ended_at`, `turn_items_included: false`). Never expect full turn content in the event stream.
8. **Approvals block the turn.** A session waiting on `approval.*` or `user_input.request` cannot make progress until you reply.
9. **Multiple agents can share a session via `--takeover`**, but the original holder gets a `session.seized` event and loses pending requests. Cross-user attach by name must be unique; otherwise use the `thread_id`.
10. **Daemon auto-shuts down after 6h idle.** Idle is only evaluated when there are 0 live sessions; live sessions keep the daemon alive. Don't rely on the daemon being there forever if you walk away.

## Output rendering

`session context` / `message history` / `message tail` all accept `--format markdown` and return a tag-structured markdown blob (`<turn>`, `<shell>`, `<file-patch>`, …). Tag names + attributes follow `plugins/codex-team/docs/html-md-format.md`.

## Output modes: concise default, `--full` for the rest

**From 0.5.3 the default JSON output is concise** — only the fields Claude needs to decide what to do next (correlation ids, flow-control flags, outcome). This eliminates a large class of wasted-token problems. You don't pass any flag to get it — it's just the default.

Three output modes:

| Mode | When to use |
|---|---|
| **default** (no flag) | Almost always. Single-line JSONL with only essential fields. E.g. `message send` returns `{"status":"started","turn_id":"..."}` or `{"status":"queued","queue_id":"...","queued_depth":N}`; `session new` returns `{name, thread_id}`; `message approval` returns `{}`; `session info` returns a compact session/thread summary. |
| **`--full`** | Only when you need a field the concise form omits (full config echo, timestamps, token usage breakdown, git info, etc.). Prints the complete response body as multi-line JSON. |
| **`--short`** | Dashboard / grep / log scraping. Plain-text `key=value` single line — even more compact than default, but not JSON. Available on state-heavy commands (`status`, `session list`, `session info`, `session health`, `daemon status`, `daemon user list`, `message history`, …). |

Rule: **never pass `--full` preemptively.** If the default is missing a field you need, re-query with `--full`.

| Need | Command (default output is enough) |
|---|---|
| Send a prompt and track it | `message send <s> "..."` → `{"status":"started","turn_id":"..."}` or `{"status":"queued","queue_id":"...","queued_depth":N}` |
| Steer active turn | `message peer <s> "..."` |
| Kill a turn | `message interrupt <s>` |
| Reply to approval / input | `message approval <s> <req> <action>` / `message answer <s> <req> "..."` |
| Block on a turn | `message wait <s>` |
| Create / attach / detach / heal | `session new`, `session attach`, `session detach`, `session heal` |
| Save cursor | `cursor save <name>` |
| Fleet health | `session list`, `status` |
| One session's state | `session health <s>`, `session info <s>` |
| Daemon / users / config | `daemon status`, `daemon user list`, `daemon config list` |
| Recent turns summary | `message history <s>` |
| **Agent output you plan to reason about** | `message tail <s> -n 1 --format markdown --truncate 2048` (markdown, not JSON) |
| **Thread snapshot** | `session context <s>` |

Combine with Monitor filters for the event stream:

```bash
# Compact fan-out event stream: only decision-worthy events, one line each
monitor events --stream --summary --cursor review-tail \
  --filter turn.completed,turn.error,approval.command_execution,approval.file_change,user_input.request,session.crashed
```

## Slash commands

## Slash commands

Three convenience commands ship with the plugin — use them in preference to hand-rolling equivalents:

| Command | What it does |
|---|---|
| `/codex-team:events` | Arms a persistent Monitor subscribed to `codex-team monitor events` for your bearer token. Prompts for the token via AskUserQuestion if you don't pass `-b`. Use this instead of manually spawning a Monitor every time. |
| `/codex-team:logs` | Follows the daemon log file. For daemon-level debugging (app-server spawn failures, sock issues). Not for per-session events — use `/codex-team:events` for those. |
| `/codex-team:tutorial` | Interactive branching walkthrough. Read-only; useful when the user wants to learn, not for actual work. |
