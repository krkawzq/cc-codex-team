<div align="center">

# cc-codex-team

**Give Claude Code a Codex team.**
A Claude Code plugin that lets Claude orchestrate long-lived OpenAI Codex workers in parallel.

[English](./README.md) · [简体中文](./README_zh.md)

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-18%2B-brightgreen.svg)](#requirements)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-8A4FFF.svg)](https://code.claude.com/docs/en/plugins)

</div>

---

## At a glance

|  |  |
| --- | --- |
| **What** | Turns Claude Code into the orchestrator of a team of Codex workers |
| **Workers** | One `codex app-server` subprocess per session, each with its own thread, queue, and work doc |
| **Parallelism** | N workers run asynchronously; Claude stays free to schedule, audit, merge |
| **Isolation** | One daemon per user / plugin, partitioned into workspaces so projects and Claude Code windows don't cross-talk |
| **Status updates** | Per-turn events pushed back to Claude through Monitor subscriptions |

---

## Why

Claude Code is great at conversation, context, planning, and code review. Codex is great at long-running autonomous code execution. But each is single-track by default — one Claude session, one Codex thread.

This plugin bridges them:

- You describe work to Claude; Claude decomposes it into independent subtasks.
- Claude spawns one Codex worker per subtask.
- Workers run in parallel, asynchronously.
- Claude is notified through an event stream when a worker needs attention, finishes a turn, errors, or approaches a token threshold.

**Claude decides. Codex executes. In parallel.**

---

## When it's worth setting up

- Refactor, port, or review across many files, modules, or repositories (≥3 independent subtasks).
- Bulk review or mass debug of the same class of problem.
- Long-horizon coding work you want to leave running.
- Any situation where a single Claude or a single Codex is the bottleneck and the work naturally parallelizes.

> Single-file one-shot fixes don't need this — the setup cost isn't worth it.

---

## Architecture

```text
     Claude Code  (the orchestrator — you talk to it)
            │
            │   codex-team CLI                Monitor events ▲
            │                                                 │
            ▼                                                 │
     codex-team daemon  (local IPC, multi-tenant)
      │   │   │   │
      N × codex app-server subprocesses  (workers, run in parallel)
```

- **Daemon** — one local Node process per `CLAUDE_PLUGIN_DATA`, partitioned into **workspaces** so different projects / Claude Code windows stay isolated.
- **Workers** — each a real `codex app-server` subprocess with its own thread, history, queue, and work doc.
- **Events** — Claude subscribes to a workspace-scoped stream; each worker turn produces one structured notification.

Orchestration discipline and collaboration norms: [`skills/using-codex-team/philosophy.md`](plugins/codex-team/skills/using-codex-team/philosophy.md).

---

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

After install, Claude can drive the plugin through the `codex-team` CLI and the bundled slash commands.

---

## Your first task, end to end

In a Claude Code chat:

```text
/codex-team:bootstrap reviewer:/abs/path/to/repo fixer:/abs/path/to/repo
```

This starts the daemon, arms the event stream, and creates two workers in the current workspace. Then tell Claude what you want:

> *"Have `reviewer` audit the auth module for risk. Have `fixer` pick the highest-risk issue and fix it. I'll review the PRs."*

Claude dispatches the work, sleeps, wakes on events, and reports back.

When the task is finished:

```text
/codex-team:shutdown
```

---

## Learn more

The plugin ships a full set of skills Claude loads on demand — you don't normally need to read them yourself. If you want to:

| To… | Go to |
| --- | --- |
| Browse the mental model | [`skills/using-codex-team/SKILL.md`](plugins/codex-team/skills/using-codex-team/SKILL.md) |
| Read the collaboration philosophy | [`skills/using-codex-team/philosophy.md`](plugins/codex-team/skills/using-codex-team/philosophy.md) |
| Walk through the plugin interactively | `/codex-team:tutorial` |
| Configure profiles or watchdog alarms | [`skills/configure-codex-team/SKILL.md`](plugins/codex-team/skills/configure-codex-team/SKILL.md) |

The CLI is self-documenting via `codex-team --help` and each slash command's frontmatter.

---

## Requirements

- Claude Code with plugin support
- Node.js 18+
- Codex CLI installed and authenticated
- Windows 10+, macOS 12+, or Linux

---

## Local development

<details>
<summary>Build and run from this checkout</summary>

```bash
cd plugins/codex-team
npm install
npm run typecheck
npm run build
npm test
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

Rebuild and `/reload-plugins` after editing TypeScript.

</details>

---

## Repository

[github.com/krkawzq/cc-codex-team](https://github.com/krkawzq/cc-codex-team)

## License

MIT — see [LICENSE](LICENSE)
