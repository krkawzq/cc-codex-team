---
description: Arm the codex-team event stream (Monitor tool) for your bearer token. Events flow as NDJSON summaries; call `codex-team -b <token> message tail <session>` for turn content. If no token is supplied, prompt via AskUserQuestion.
argument-hint: "[-b <token>] [--stream] [--filter <types>] [--session <name>] [--since <id>]"
allowed-tools: Bash, Monitor, AskUserQuestion
---

Attach a persistent Monitor that pipes codex-team events to the task panel. Every event is a single NDJSON line; each is a **summary** — fetch details on demand via `message tail` / `message history`.

Raw user request: $ARGUMENTS

## Decision tree

1. **Resolve bearer token.**
   - Parse `-b <token>` or `--bearer <token>` from `$ARGUMENTS` if present.
   - Else ask once with `AskUserQuestion`: "What bearer token should this Monitor subscribe under?" Suggest the token you've been using in this conversation if any.
   - Empty / cancel → stop.

2. **Ensure user exists.** `codex-team daemon user create <token>` (idempotent enough — it returns `user_already_exists` if it does, which you should treat as success).

3. **Arm the Monitor.** Skip if the task panel already has a `codex-team events:` Monitor for the same token.
   ```
   Monitor({
     description: "codex-team events: <token>",
     command: "node \"${CLAUDE_PLUGIN_ROOT}/dist/main.js\" -b <token> monitor events <extra-flags>",
     persistent: true,
     timeout_ms: 3600000
   })
   ```
   `<extra-flags>` forwards any of `--stream` / `--filter a,b,c` / `--session name` / `--since evt-id` / `--include-delta` / `--interval N` from `$ARGUMENTS`.
   If you need to suggest a default decision-focused filter, use `turn.completed,turn.queued_started,turn.queued_failed,approval.command_execution,approval.file_change,user_input.request,session.crashed`.

4. **Short report** (one line): token, mode (`stream` or `interval=N`), filter if any.

## Do not

- Dispatch / send / approve anything. This is observation only.
- Run the event stream as a foreground Bash call — it would block until interrupted.
- Arm more than one Monitor for the same token in one session (noisy duplicates).

## Related

- Event types: `skills/manage-codex-team/events.md`
- Fetch turn content: `codex-team -b <token> message tail <session>` or `message history`
