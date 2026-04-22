---
description: Tail the codex-team daemon log file (`daemon logs --follow`). Useful for debugging daemon-level issues — app-server spawn failures, sock issues, config set operations. Not for per-session events (use `/codex-team:events` instead).
argument-hint: "[-n <lines>] [--level <error|warn|info|debug|trace>]"
allowed-tools: Monitor
---

Stream the daemon log to the task panel. This is daemon-level debugging — it does NOT include codex-side events (those go through `monitor events`).

Raw user request: $ARGUMENTS

## Decision tree

1. Skip if the task panel already has a `codex-team daemon logs:` Monitor.

2. Arm the Monitor:
   ```
   Monitor({
     description: "codex-team daemon logs",
     command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/main.js\" daemon logs --follow <extra-flags>",
     persistent: true,
     timeout_ms: 3600000
   })
   ```
   Forward `-n <N>` and `--level <lvl>` from `$ARGUMENTS` if present.

3. One-line report: "Daemon logs streaming (follow, level=<lvl>)."

## Do not

- Run in foreground Bash — it blocks.
- Use this to monitor codex turn activity — that's `/codex-team:events`.
- Persist multiple `daemon logs` Monitors in one conversation.
