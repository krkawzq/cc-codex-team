# cc-codex-team

A Claude Code plugin for running a team of long-lived Codex workers. Each worker is a named `codex app-server` session with its own thread state, queue, health checks, and monitor events.

[![License](https://img.shields.io/github/license/krkawzq/cc-codex-team)](LICENSE)
[![Stars](https://img.shields.io/github/stars/krkawzq/cc-codex-team)](https://github.com/krkawzq/cc-codex-team/stargazers)

## Install

Inside a Claude Code instance, run:

**Step 1: Add the marketplace**

```text
/plugin marketplace add krkawzq/cc-codex-team
```

**Step 2: Install the plugin**

```text
/plugin install cc-codex-team
```

**Step 3: Reload plugins**

```text
/reload-plugins
```

After install, the `codex-team` command is available to Claude Code's Bash tool.

## Requirements

- Claude Code **v2.1.105 or later** (plugin monitors require this version; earlier versions will load skills and hooks but ignore the `monitors/monitors.json` entries)
- Python 3.10+
- Codex CLI installed and authenticated:

```bash
codex --version
codex login
```

The plugin creates its own Python environment under Claude Code's plugin data directory on first run.

## Quickstart

Start the daemon:

```bash
codex-team daemon start
```

Create named Codex workers:

```bash
codex-team session create reviewer --cwd /path/to/project --profile reviewer
codex-team session create fixer --cwd /path/to/project --profile fixer
```

Send work:

```bash
codex-team send reviewer "Review the daemon lifecycle and list risks."
codex-team send fixer "Fix the highest-risk issue and run relevant tests."
```

Watch results:

```bash
codex-team monitor events
codex-team monitor watchdog
```

## Common Commands

```bash
codex-team session list
codex-team session status fixer
codex-team session dump fixer
codex-team health report
codex-team history fixer --format md
codex-team tail fixer --stderr
codex-team session restart fixer
codex-team session ack-error fixer
codex-team daemon stop
```

## Local Development

From a local checkout:

```bash
claude --plugin-dir /path/to/cc-codex-team
```

Or install through the local marketplace manifest:

```bash
claude plugin marketplace add /path/to/cc-codex-team
claude plugin install cc-codex-team@cc-codex-team
```

Run tests:

```bash
pytest
RUN_CODEX_INTEGRATION=1 pytest
```

## Repository

https://github.com/krkawzq/cc-codex-team
