# Environment variables

codex-team honours a small number of env vars, mostly for routing persistent state under non-default locations. Set them in the shell that invokes the cli; the daemon inherits via the spawn env.

## `CODEX_TEAM_DATA_DIR`

Overrides the root for all persistent state. Default `~/.codex-team`.

`~`, `~/...`, and `~\\...` are expanded before use.

Use cases:

- Pinning a test run: `CODEX_TEAM_DATA_DIR=/tmp/ct-test pytest tests/…`
- Shared team directory under a mount point
- Claude Code plugin routing (auto-set by the `bin/codex-team` launcher to `$CLAUDE_PLUGIN_DATA/data` when invoked by CC)

On Unix, all daemon state files live under this dir: `daemon.sock`, `daemon.log`, `config.json`, `users/…`, etc. On Windows, the daemon IPC endpoint is a named pipe derived from this location rather than a literal `daemon.sock` file. Change it ⇒ completely separate daemon.
On Windows, home resolution prefers `os.homedir()`, then `USERPROFILE`, then `HOMEDRIVE` + `HOMEPATH`, and finally `HOME`.

## `CODEX_TEAM_SOCK`

Overrides just the sock path (leaves other files at `$CODEX_TEAM_DATA_DIR`). Useful when you want one daemon but need to isolate test sockets:

```bash
CODEX_TEAM_SOCK=/tmp/alt.sock codex-team daemon status
```

Equivalent to the `--daemon-sock` flag on the cli, but propagates to spawn env. On Windows this value is normalized into a named-pipe endpoint, not used as a filesystem socket path verbatim.
`~`, `~/...`, and `~\\...` are expanded here too.

## `CODEX_TEAM_DAEMON_SOCK`

Client-only attach mode. When set, the CLI connects to an already-running daemon at this socket path and does not probe-bind, auto-spawn, or require `$CODEX_TEAM_DATA_DIR` to be writable.

Use this for sandboxed child sessions that can reach the host daemon socket but cannot create sockets or write under `~/.codex-team`:

```bash
CODEX_TEAM_DAEMON_SOCK=$HOME/.codex-team/daemon.sock codex-team -b "$TOKEN" session list
```

`--daemon-sock <path>` triggers the same client-only behavior for a single invocation. `~`, `~/...`, and `~\\...` are expanded here too.

## `CLAUDE_PLUGIN_DATA` + `CLAUDE_PLUGIN_ROOT`

Set by Claude Code when the plugin is invoked. The `bin/codex-team` launcher uses them to route `CODEX_TEAM_DATA_DIR` to `$CLAUDE_PLUGIN_DATA/data`, so each plugin install has isolated state. Do not set these manually outside CC — the launcher is cautious about trusting them when `CLAUDE_PLUGIN_ROOT` is absent.

## PATH / `codex` binary

codex-team spawns `codex` by looking it up on `PATH`. If codex isn't there or you need a specific build, either:

- Symlink into PATH, or
- Set a shell alias that exports `PATH=/path/to/codex/bin:$PATH` before invoking

codex-team does NOT accept a custom binary path yet — if you need it, set it via an ancestor wrapper script.

## Node

codex-team targets Node ≥ 18. If your default `node` is older, invoke via:

```bash
PATH=/path/to/node18+/bin:$PATH codex-team ...
```

The bin launcher respects whatever `node` is on PATH.

## Not env vars

These are `daemon config` keys, not env vars. Setting them in the environment does nothing:

- `daemon.idle_shutdown_hours`
- `codex.default_model`
- `retry.*`
- etc.

Use `codex-team daemon config set <key> <value>` instead.
