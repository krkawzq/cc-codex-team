# Docs update report

## Files changed
- `plugins/codex-team/docs/设计文档.md`: bumped the documented version to `0.5.1`; added `turn.queued_failed` and `monitor.overflow`; documented reply-durability warning kinds, per-subcommand help parsing, approval shortcut restrictions, `--since` validation, pidfile/orphan identity checks, detach semantics, and corrected the stale idle-unload note.
- `plugins/codex-team/skills/manage-codex-team/SKILL.md`: added guidance for `turn.queued_failed`, stream back-pressure, approval shortcut caveats, and corrected `session detach --graceful`.
- `plugins/codex-team/skills/manage-codex-team/events.md`: added `turn.queued_failed`, `monitor.overflow`, and the four warning payload kinds; clarified that some warning/monitor events can retain session context.
- `plugins/codex-team/skills/manage-codex-team/approvals.md`: documented per-kind shortcut validity in detail and noted the stdin-ack durability delay/back-pressure caveat.
- `plugins/codex-team/skills/configure-codex-team/cli-reference.md`: documented per-command `--help`, help termination, `daemon user destroy --force`, approval shortcut restrictions, `--since` invalid-id behavior, and corrected `session detach --graceful`.
- `plugins/codex-team/skills/configure-codex-team/config-keys.md`: documented `~` expansion for daemon path keys and Windows home-directory resolution order.
- `plugins/codex-team/skills/configure-codex-team/env-vars.md`: documented `~` expansion for env-backed paths and Windows home-directory resolution order.
- `plugins/codex-team/skills/recover-codex-team/SKILL.md`: updated daemon ownership, app-server auto-recovery, orphan identity tracking, and `daemon user destroy --force`.
- `plugins/codex-team/skills/recover-codex-team/known-quirks.md`: added notes for schema-version enforcement, rotation-safe log following, Windows cooperative shutdown / `.cmd` wrapper behavior, and identity-based orphan/pidfile handling.
- `plugins/codex-team/skills/using-codex-team/SKILL.md`: clarified idle-shutdown semantics for invariant #10.
- `plugins/codex-team/skills/using-codex-team/mental-model.md`: updated crash recovery and event-flow notes to include `thread/resume`, durable append, microtask fan-out, and `turn.queued_failed`.

## Deltas captured
- Per-subcommand `--help` now renders distinct help screens, and `--help` stops parsing at the current command path.
- `message approval` now documents per-kind shortcut validity: `approval.permissions` rejects `cancel`; `approval.mcp_elicitation` rejects `accept-session`; form-mode MCP elicitation requires `--json`.
- `daemon user destroy --force` behavior is documented consistently, along with the actual detach/pending-request failure semantics.
- New event surface is documented: `turn.queued_failed`, `monitor.overflow`, and warning payload kinds for approval/user-input reply durability.
- Config/env path handling now documents `~` expansion and Windows home lookup via `os.homedir()` first, then `USERPROFILE`.
- Recovery docs now reflect pidfile ownership checks, identity-based orphan reaping, schema-version rejection on persisted state, app-server crash recovery via `thread/resume`, and improved `daemon logs --follow`.

## Open follow-ups
- Repo root does not contain a `package.json`, so `npm run build` cannot run from `/home/wzq/Code/Projects/cc-codex-team`; verification was performed from `plugins/codex-team/`.

## Commit
`5821946c1bf0824fd6469dd11b53d68f26106198`
