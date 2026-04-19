# CLI cheatsheet

Reference for `configure-codex-team`. Quick lookup. Run `codex-team <subcommand> --help` for the authoritative flags.

---

## Daemon

```bash
codex-team daemon status             # IPC ready? PID? workspace counts?
codex-team daemon start              # start if not running
codex-team daemon stop [--force]     # refuses if other workspaces have sessions
codex-team daemon doctor             # one-shot diagnostic snapshot
codex-team daemon logs [--follow]    # daemon-level log tail
codex-team daemon reload-config      # re-apply config.toml without restart
```

## Workspace

```bash
codex-team workspace list                # every workspace + session/client counts
codex-team workspace show [<name>]       # details for one workspace (default: current)
```

## Session lifecycle

```bash
codex-team session create <name> \
    --cwd <abs-path> \
    [--profile <name>] \
    [--ephemeral]

codex-team session list [--all-workspaces]
codex-team session status <name>
codex-team session dump <name>                # registry + queue + stderr + transport
codex-team session close <name>               # preserves thread
codex-team session resume <name>              # re-attach fresh subprocess
codex-team session restart <name>             # close + resume
codex-team session kill <name>                # hard-reset subprocess
codex-team session forget <name>              # destructive — removes registry entry
codex-team session read <name>                # thread exists? (probe)
```

## Send / interrupt / compact

```bash
codex-team send <name> "<prompt>"                            # non-blocking
codex-team send <name> --prompt-file <path>                  # for multi-line / metachar-heavy prompts
codex-team send <name> "<prompt>" --wait                     # blocks until turn/completed — avoid
codex-team send <name> "<prompt>" --model <X> --effort <Y>   # per-turn override
codex-team interrupt <name>                                  # cancel current turn
codex-team compact <name>                                    # compaction Step 2 (see ritual)
```

## Queue

```bash
codex-team queue show <name>
codex-team queue retry-last <name>
codex-team queue clear <name>
```

## History / inspection

```bash
codex-team history <name> --format md [--last-n N]
codex-team history <name> --format md --since-turn-id <id>
codex-team history <name> --format jsonl [--last-n N]
codex-team history <name> --format jsonl --since-turn-id <id> --follow
codex-team tail <name> --stderr
```

## Health

```bash
codex-team health report [--all-workspaces]
codex-team health repair                         # best-effort local fix
```

## Watchdog alarms

```bash
codex-team watch alarm create <name> \
    [--interval-seconds N] \
    [--task-brief-file PATH] \
    [--template-file PATH | --template "text"] \
    [--emit-idle] \
    [--disabled]

codex-team watch alarm list [--all-workspaces]
codex-team watch alarm delete <name>
```

## Monitor subscriptions (normally driven by the `Monitor` tool)

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/main.js" monitor events
node "${CLAUDE_PLUGIN_ROOT}/dist/main.js" monitor watchdog
```

## Clients

```bash
codex-team client list                           # every live Claude Code attached
codex-team client detach <client-id>             # force-detach a stale client
```

## Hooks (normally run automatically by Claude Code lifecycle)

```bash
codex-team hook session-start                    # resolves workspace, registers client
codex-team hook session-end                      # detaches client
```

## Cross-workspace flags

| Flag | Behaviour |
|---|---|
| `--workspace <name>` | Act in a specific workspace (override resolution). |
| `--all-workspaces` | Read-only subcommands only. Destructive calls reject it. |

## Help

```bash
codex-team --help
codex-team <subcommand> --help
```
