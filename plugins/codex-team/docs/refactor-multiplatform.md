# Refactor design: multi-platform support (v0.3.0)

Status: implementation in progress.

Scope: make `codex-team` run natively on Linux, macOS, and Windows by moving OS-specific behavior behind a platform layer and removing shell scripts from the hook/Monitor hot path.

## Goals

- Keep Linux/macOS behavior compatible with v0.2.x.
- Support Windows without WSL/MSYS assumptions.
- Use Unix domain sockets on Linux/macOS and Windows named pipes on Windows.
- Run hooks and Monitor commands through the Node entrypoint, not `.sh` scripts.
- Keep one daemon per plugin data directory, partitioned by workspace.
- Keep registry, event, history, and workspace wire behavior unchanged.

## Implemented Shape

- `src/platform/`
  - `paths.ts`: config/data/runtime path resolution, including `%APPDATA%` and `%LOCALAPPDATA%`.
  - `ipc.ts`: Unix socket / named pipe abstraction.
  - `process.ts`: spawn and process-tree termination.
  - `which.ts`: PATH lookup with Windows `PATHEXT`.
  - `env.ts`: hook env export and `.codex-team/client.env` fallback.
  - `signals.ts`: shutdown signal registration.
- `src/hooks/`
  - `codex-team hook session-start`
  - `codex-team hook session-end`
- Hot path commands:
  - hooks run `node "${CLAUDE_PLUGIN_ROOT}/dist/main.js" hook ...`
  - Monitor commands run `node "${CLAUDE_PLUGIN_ROOT}/dist/main.js" monitor ...`
- Developer aliases:
  - existing `.sh` scripts stay as aliases.
  - Windows `.cmd` helpers are added.

## Important Decisions

- Direct Node entrypoints still honor `CLAUDE_PLUGIN_DATA` by resolving the daemon data dir to `${CLAUDE_PLUGIN_DATA}/data` when invoked inside the plugin.
- Hook client records use `pid: null` because wrapper parent processes can be short-lived; stale clients are cleaned by `SessionEnd` or seven-day age sweep.
- Session names are path-safe across platforms and reject traversal, Windows reserved names, trailing spaces/dots, and path separators.
- `daemon.doctor` reports IPC semantics with `ipc_kind`, `ipc_endpoint`, and `ipc_ready`; `socket_exists` remains for Unix socket file compatibility.

## Remaining External Validation

- Run the GitHub Actions matrix on `ubuntu-latest`, `macos-latest`, and `windows-latest`.
- On a real Windows Claude Code install, verify:
  - plugin hook substitution for `${CLAUDE_PLUGIN_ROOT}`
  - `node ".../dist/main.js" hook session-start`
  - `node ".../dist/main.js" monitor events`
  - daemon named pipe start/status/stop
  - `codex.cmd app-server --listen stdio://` via `spawnManaged`
