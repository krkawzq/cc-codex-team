# cc-codex-team

[简体中文](./README_zh.md)

> **Give Claude Code a Codex team.** A Claude Code plugin that lets Claude orchestrate a team of long-lived OpenAI Codex workers in parallel.

## What this is

Claude Code is great at conversation, context, planning, and code review. OpenAI Codex is great at long-running autonomous code execution. But each is single-track by default: one Claude session, one Codex thread.

This plugin turns Claude Code into the **orchestrator** of a **team** of Codex worker sessions:

- You describe work to Claude; Claude decomposes it into independent subtasks.
- Claude spawns one Codex worker per subtask (each a real `codex app-server` subprocess).
- Workers run in **parallel, asynchronously**. Claude stays free to schedule, audit, merge.
- Claude is notified through an event stream when a worker finishes a turn, needs attention, errors, or crosses a token threshold.

In short: **Claude decides. Codex executes. In parallel.**

## When this is worth setting up

- Refactor / port / review across many files, modules, or repositories (≥3 independent subtasks).
- Bulk review or mass debug of the same class of problem.
- Long-horizon coding work you want to leave running.
- Any situation where a single Claude or a single Codex is the bottleneck and the work naturally parallelizes.

Single-file one-shot fixes don't need this — the setup cost isn't worth it.

## Architecture

```
      Claude Code  (the orchestrator — you talk to it)
             │
             │   codex-team CLI (Bash)            Monitor events ▲
             │                                                    │
             ▼                                                    │
      codex-team daemon (Unix socket, multi-tenant)
       │   │   │   │
      N × codex app-server subprocesses  (workers, run in parallel)
```

- **Daemon** — one local Node process per `CLAUDE_PLUGIN_DATA`, partitioned into **workspaces** so different projects / Claude Code windows don't see each other.
- **Workers** — each a real `codex app-server` subprocess with its own thread, history, queue, and work doc.
- **Events** — Claude subscribes to a workspace-scoped event stream; each worker turn produces one structured notification.

The orchestration discipline and collaboration norms are documented in `plugins/codex-team/skills/using-codex-team/philosophy.md`.

## Install

Inside a Claude Code session:

```text
/plugin marketplace add krkawzq/cc-codex-team
/plugin install codex-team
/reload-plugins
```

Then verify dependencies:

```bash
node --version       # 18+
codex --version
codex login
```

After install, Claude can drive the plugin through the `codex-team` CLI (via the Bash tool) and the bundled slash commands.

## Your first task, end to end

In a Claude Code chat:

```
/codex-team:bootstrap reviewer:/abs/path/to/repo fixer:/abs/path/to/repo
```

This starts the daemon, arms the event stream, and creates two workers in the current workspace. Then tell Claude what you want:

> "Have `reviewer` audit the auth module for risk. Have `fixer` pick the highest-risk issue and fix it. I'll review the PRs."

Claude dispatches the work, sleeps, wakes when events arrive, and reports back.

When the task is finished:

```
/codex-team:shutdown
```

## Learn more

The plugin ships a full set of skills Claude loads on demand — you don't normally need to read them yourself. If you want to:

- Browse the mental model → `plugins/codex-team/skills/using-codex-team/SKILL.md`
- Read the collaboration philosophy → `plugins/codex-team/skills/using-codex-team/philosophy.md`
- Run a guided walkthrough → `/codex-team:tutorial`
- Configure profiles / watchdog alarms → `plugins/codex-team/skills/configure-codex-team/SKILL.md`

The CLI itself is self-documenting via `codex-team --help` and each slash command's frontmatter.

## Requirements

- Claude Code with plugin support
- Node.js 18+
- Codex CLI installed and authenticated

## Local development

```bash
cd plugins/codex-team
npm install
npm run typecheck
npm run build
npm test
```

Install from this checkout:

```bash
claude plugin marketplace add /abs/path/to/cc-codex-team
claude plugin install codex-team@cc-codex-team
```

Or run Claude Code with the plugin directory directly:

```bash
claude --plugin-dir /abs/path/to/cc-codex-team/plugins/codex-team
```

Rebuild and `/reload-plugins` after editing TypeScript.

## Repository

https://github.com/krkawzq/cc-codex-team

## License

MIT — see [LICENSE](LICENSE)
