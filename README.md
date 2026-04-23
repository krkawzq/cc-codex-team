<div align="center">

# cc-codex-team

**A team of long-lived Codex workers, orchestrated by Claude Code.**

[English](./README.md) · [简体中文](./README_zh.md)

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-18%2B-brightgreen.svg)](#requirements)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-8A4FFF.svg)](https://code.claude.com/docs/en/plugins)
[![Release](https://img.shields.io/badge/Release-0.5.4-success.svg)](plugins/codex-team/docs/releases/0.5.4.md)

</div>

---

Claude Code and Codex have **complementary strengths.** Claude Code is at its best planning work, decomposing problems creatively, prototyping MVPs, orchestrating tasks, and running long-horizon autonomous loops. Codex is more careful in the small — stronger at detailed code implementation and rigorous review.

**cc-codex-team combines the two.** Claude Code stays at the top of the stack as the orchestrator — decomposing work, assigning subtasks, making judgment calls, reviewing output — while a fleet of long-lived Codex workers handles the fine-grained coding in parallel. If you pay for both subscriptions, usage balances naturally across them instead of one sitting idle.

- Claude decomposes work, spawns workers, and waits on events.
- Workers run as real `codex app-server` processes with their own threads, queues, and logs.
- Approvals, user-input prompts, crashes, turn completions — everything is a line on the event stream.

## Mental model

```
   Claude (orchestrator)
      │   codex-team -b <token> ...   (stateless CLI)
      ▼
   codex-team daemon   (one per OS user, multi-tenant by bearer token)
      │   JSON-RPC 2.0 over stdio
      ▼
   N × codex app-server processes   (workers, parallel)
      │
      └── sessions (persistent codex threads, one live binding each)
```

Four concepts:

| | |
| --- | --- |
| **bearer token** | Any string you pick. Namespaces your sessions from other agents sharing the daemon. |
| **session** | A codex thread with a human name. Persistent on disk by codex; codex-team owns the **live binding** to an app-server. |
| **event** | A NDJSON summary line pushed by the daemon when something happens (turn started/completed/errored, approval request, session crashed, …). |
| **named cursor** | Daemon-maintained resume point in the event stream. Survives restarts. |

Daemon-per-OS-user. Isolation-per-token. No per-project workspaces — just token scoping.

## When to reach for it

- **Parallel coding** — a task decomposes into ≥2 mechanically independent subtasks
- **Long-horizon work** — bulk refactors, multi-module migrations, audit + fix across a repo
- **Multi-agent patterns** — worker+reviewer, map-reduce, plan→execute→verify, debate, swarm
- **Autonomy with checkpoints** — fire off work, let Claude's context stay free, wake on events

Not the right tool for one-shot edits (use `codex` CLI directly or the `codex:codex-rescue` subagent), or anything you want to micromanage step-by-step.

## Install

Inside a Claude Code session:

```text
/plugin marketplace add krkawzq/cc-codex-team
/plugin install codex-team
/reload-plugins
```

Verify dependencies:

```bash
node --version   # 18+
codex --version
codex login
```

Claude can now drive the plugin through the `codex-team` CLI and the bundled slash commands.

**If `codex-team` is not on your `PATH`** (happens in some sandboxes), invoke it through the bundled launcher: `$CLAUDE_PLUGIN_ROOT/plugins/codex-team/bin/codex-team ...`. When in doubt, run `codex-team doctor` (or `<launcher> doctor`) first — it checks `PATH`, `codex` binary, socket-bind permissions, stale pidfile, and dist freshness, and exits non-zero with a specific diagnostic message on failure.

## First run

Pick a bearer token, spawn a worker, arm the event stream, send work:

```bash
TOKEN=claude-$(date +%s)

# Register once (idempotent; daemon auto-spawns on first -b call)
codex-team daemon user create $TOKEN

# Spawn a long-lived worker session in your repo
codex-team -b $TOKEN session new refactor --cwd /abs/path/to/repo \
  --model gpt-5.4 --sandbox workspace-write --approval on-request

# Named cursor for resumable tailing
codex-team -b $TOKEN cursor save refactor-tail

# Arm the events Monitor — or from Claude Code: /codex-team:events -b $TOKEN
codex-team -b $TOKEN monitor events --stream --cursor refactor-tail
```

Now tell Claude what you want:

> *"Have `refactor` audit the auth module for risk, then rewrite the token-validation path. I'll review the diff."*

Claude sends the prompt via `message send`, sleeps, wakes on `turn.completed`, and fetches detail with `message tail`. When you're done: `codex-team -b $TOKEN session detach refactor` — the thread persists in codex for future resume.

## Day-to-day operations

**Session lifecycle**

```bash
codex-team -b $TOK session new NAME --cwd PATH [--auto-approve "git*,npm"] ...
codex-team -b $TOK session health NAME            # live snapshot: state, busy, current_turn_id when active, pending when non-zero
codex-team -b $TOK session heal NAME [--force]    # re-attach crashed / dead session
codex-team -b $TOK session detach NAME            # release app-server; thread persists
codex-team -b $TOK session list [--short]         # one line per session
```

**Messaging**

```bash
codex-team -b $TOK message send NAME "prompt"      # non-blocking; starts a turn
codex-team -b $TOK message peer NAME "..."         # inject into the active turn (soft redirect)
codex-team -b $TOK message wait NAME [--timeout S] # block until turn.completed / turn.error / timeout
codex-team -b $TOK message tail NAME -n 1 --format markdown   # fetch the last turn
codex-team -b $TOK message approval NAME REQ_ID accept         # respond to approval.request
codex-team -b $TOK message answer NAME REQ_ID "..."            # respond to user_input.request
```

**Event stream**

```bash
codex-team -b $TOK monitor events --stream --cursor NAME             # concise summary JSONL by default, auto-advance cursor
codex-team -b $TOK cursor list                                       # named cursors
codex-team -b $TOK cursor get NAME                                   # {"event_id":"evt-..."}
```

**Output & status**

Successful non-streaming commands emit concise single-line JSONL by default. Pass `--full` to print the complete response body as multi-line JSON. All status-returning commands also accept `--short` for compact plain-text output (friendly for grep and dashboards). `message history` and `message tail` accept `--truncate <bytes>` to clip long bodies. Tagged-markdown output (`--format markdown`) follows [`docs/html-md-format.md`](plugins/codex-team/docs/html-md-format.md) with per-type renderers for user messages, agent messages, shell, file patches, MCP tool calls, hooks, reasoning, and auto-approval reviews.

## Playbooks

Nine multi-session topologies ship as skills Claude loads on demand. You rarely need to read them yourself — Claude picks based on task shape.

| Playbook | Best for |
| --- | --- |
| `solo-worker` | One session, one goal, no review loop |
| `worker-reviewer` | Generator + critic, iterate until approval |
| `map-reduce` | N independent similar subtasks + aggregator |
| `pipeline` | Stage 1 → Stage 2 → Stage 3, each a specialist |
| `plan-execute-verify` | Planner + executor + verifier sessions |
| `reflexion` | Failure → self-critique → retry with lesson |
| `debate` | Advocate vs. opposing, judge synthesises |
| `hierarchical` | Manager delegates to sub-sessions it spawns |
| `swarm` | Loosely-related workers, handoff by mutual agreement |

See [`skills/codex-team-playbooks/`](plugins/codex-team/skills/codex-team-playbooks/) and [`anti-patterns.md`](plugins/codex-team/skills/codex-team-playbooks/anti-patterns.md).

## Documentation

The CLI is self-documenting (`codex-team --help`, `<cmd> --help`). For deeper material:

| To… | Go to |
| --- | --- |
| Grok the mental model | [`skills/using-codex-team/`](plugins/codex-team/skills/using-codex-team/) |
| Drive sessions day-to-day | [`skills/manage-codex-team/`](plugins/codex-team/skills/manage-codex-team/) |
| Pick a collaboration pattern | [`skills/codex-team-playbooks/`](plugins/codex-team/skills/codex-team-playbooks/) |
| Tune models, profiles, tricks | [`skills/configure-codex-team/`](plugins/codex-team/skills/configure-codex-team/) |
| Handle errors, crashes, recovery | [`skills/recover-codex-team/`](plugins/codex-team/skills/recover-codex-team/) |
| Interactive walkthrough | `/codex-team:tutorial` |
| Latest changes | [`docs/releases/0.5.4.md`](plugins/codex-team/docs/releases/0.5.4.md) |
| Output format spec | [`docs/html-md-format.md`](plugins/codex-team/docs/html-md-format.md) |

## Requirements

- Claude Code with plugin support
- Node.js 18+
- Codex CLI installed and authenticated (`codex login`)
- Windows 10+, macOS 12+, or Linux

## Local development

<details>
<summary>Build and run from this checkout</summary>

```bash
cd plugins/codex-team
npm install
npm run typecheck
npm test
npm run build
```

Install from the local marketplace manifest:

```bash
claude plugin marketplace add /abs/path/to/cc-codex-team
claude plugin install codex-team@cc-codex-team
```

Or point Claude Code at the plugin directory directly:

```bash
claude --plugin-dir /abs/path/to/cc-codex-team/plugins/codex-team
```

Bump version (updates `package.json` + `.claude-plugin/plugin.json` + rebuilds dist):

```bash
npm run bump-version 0.5.5
```

Rebuild and `/reload-plugins` after editing TypeScript.

</details>

## Repository

[github.com/krkawzq/cc-codex-team](https://github.com/krkawzq/cc-codex-team)

## License

MIT — see [LICENSE](LICENSE)
