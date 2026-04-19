# cc-codex-team

A Claude Code plugin for running a team of long-lived Codex workers.
Each worker is a named `codex app-server` session with its own thread
state, queue, health checks, monitor events, and local history.

This is the Node/TypeScript rewrite. It does **not** depend on the
official Python SDK. The daemon talks to `codex app-server` directly
over JSON-RPC.

## Install

Inside a Claude Code instance, run:

**Step 1: Add the marketplace**

```text
/plugin marketplace add krkawzq/cc-codex-team
```

**Step 2: Install the plugin**

```text
/plugin install codex-team
```

**Step 3: Reload plugins**

```text
/reload-plugins
```

After install, `codex-team` is available to Claude Code's Bash tool.

## Requirements

- Claude Code with plugin support
- Node.js 18+
- Codex CLI installed and authenticated

```bash
node --version
codex --version
codex login
```

## Quickstart

Start the daemon:

```bash
codex-team daemon start
```

Create named workers:

```bash
codex-team session create reviewer --cwd /path/to/project --profile reviewer
codex-team session create fixer --cwd /path/to/project --profile fixer
```

Sessions are scoped to the current workspace. By default the workspace is derived
from `CLAUDE_PROJECT_DIR`; override with `CODEX_TEAM_WORKSPACE=<name>` or
`--workspace <name>`. Use `--all-workspaces` only for admin inspection.

Restore a saved Codex thread when the codex-team registry is missing:

```bash
codex-team session attach restored --thread-id <codex-thread-id> --cwd /path/to/project --profile reviewer
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

The `events` stream now emits a `turn-start` record that maps the
CLI-returned `pending-*` id to the real Codex `turn_id`.
Recovery events are also more explicit: idle child recycling shows up
as `subprocess-recycled`, while turn-time transport failure recovery
shows up as `auto-heal-after-crash`.

## Common Commands

```bash
codex-team session list
codex-team session status fixer
codex-team session read fixer --include-turns
codex-team session resume fixer
codex-team session attach restored --thread-id <codex-thread-id> --cwd /path/to/project
codex-team session dump fixer
codex-team health report
codex-team health issues
codex-team daemon reload-config
codex-team history fixer --format md
codex-team history fixer --format jsonl --since-turn-id tr_123
codex-team history fixer --format jsonl --since-turn-id tr_123 --follow
codex-team tail fixer --stderr --lines 200
codex-team queue show fixer
codex-team daemon doctor
codex-team daemon stop --force   # admin reset only; prefer /codex-team:shutdown
```

## Local Development

Build the plugin before loading it:

```bash
cd plugins/codex-team
npm install
npm run typecheck
npm run build
npm test
```

Run it as a local plugin:

```bash
claude --plugin-dir /path/to/cc-codex-team/plugins/codex-team
```

Or install through the local marketplace manifest:

```bash
claude plugin marketplace add /path/to/cc-codex-team
claude plugin install codex-team@cc-codex-team
```

If you edit TypeScript sources, rebuild before reloading the plugin:

```bash
cd plugins/codex-team
npm run build
/reload-plugins
```

## Notes

- The plugin auto-starts only the daemon on Claude Code `SessionStart`.
- Monitor streams are explicit: arm both before dispatching async work.
- Plugin monitors are not started automatically. Arm `events` via
  `/codex-team:bootstrap`, and arm `watchdog` only via `/codex-team:watch`.
- Persistent sessions can auto-resume after daemon restart.
- `--ephemeral` sessions are intentionally not durable across daemon
  shutdown.
- `session create`, `session resume`, and `session restart` refresh
  `config.toml` from disk before acting, so new profiles and defaults
  do not require a daemon restart.
- `daemon reload-config` reapplies watchdog / heartbeat intervals
  immediately.
- `history` supports incremental reads via `--since-turn-id` for both
  `md` and `jsonl` output, and `--follow` for a simple tail-style
  stream after the initial snapshot.
- Text-content commands (`history`, `tail --stderr`, `daemon logs`)
  print their text body directly on stdout. The daemon socket API still
  returns `{ content }` for callers that need structured JSON.
- compact operations retry automatically on transient failure; see
  `[compaction].retry_attempts` and `retry_delay_ms` in `config.toml`.
- `health report` includes an `issues` block so it can be used as a
  triage surface rather than a second copy of `session list`.
- When a task is finished, run `/codex-team:shutdown` or
  close the workspace sessions and then run `codex-team daemon stop` only after
  confirming no non-closed sessions remain in any workspace. SessionEnd only
  detaches the current client; it does not close work that another Claude Code
  session may be using.
- Watchdog emits an initial snapshot on daemon start, then suppresses
  idle periodic ticks by default. Set `monitor.watchdog_emit_idle =
  true` if you want heartbeat noise even when nothing needs attention.
- Watchdog reminder messages include send time by default:
  `sent_at` (ISO) and `local_time` (terminal locale). Custom templates
  can use `{{sentAt}}` and `{{localTime}}`.
- Watchdog supports multiple named alarms with different intervals and
  prompts. Runtime alarms are easiest for task-specific reminders:
  ```bash
  codex-team watch alarm create fast --interval-seconds 300 --template "Fast check {{sentAt}}\n{{sessionsText}}"
  ```
  Persistent config alarms are workspace-keyed:
  ```toml
  [monitor.watchdog_alarms.proj-example.fast]
  interval_seconds = 300
  template = "Fast check {{sentAt}}\n{{sessionsText}}"

  [monitor.watchdog_alarms.proj-example.deep]
  interval_seconds = 1800
  task_brief_file = "docs/team/current.md"
  template_file = "docs/team/deep-watchdog-template.md"
  ```

## Repository

https://github.com/krkawzq/cc-codex-team

## License

MIT — see [LICENSE](LICENSE)
