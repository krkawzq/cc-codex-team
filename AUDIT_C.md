# Worker C Audit

## New session/runtime controls

- Added `session new --auto-approve <patterns>` to persist per-session auto-approval rules on `SessionRecord.autoApprovePatterns`.
- `session info` now returns `autoApprovePatterns` inside the existing `session` payload.
- Session attach/fork paths preserve the field so live runtime settings stay consistent.

## Daemon default config

- Added daemon config key `session.auto_approve_command_patterns`.
- Value format is a comma-separated string such as `git,npm,node *,/sh -c cat.*/i`.
- If `session new` omits `--auto-approve`, the daemon default is inherited.
- If `session new --auto-approve ""` is passed, the session opts out and stores `[]`.
- If `session new --auto-approve ...` is passed, that explicit list replaces the daemon default.

## Matcher semantics

- Plain patterns are exact matches unless they contain `*`.
- `*` is the only glob wildcard and matches any substring.
- Patterns starting with `/` are treated as JavaScript regex literals `/.../flags`; invalid regex values are rejected by config validation.
- Matching targets:
  - `approval.command_execution`: `command`
  - `approval.permissions`: `command` first, then `reason`
  - `approval.file_change`: `reason` first, then `grant_root`
  - `approval.mcp_elicitation`: `url`, then `message`, then `server_name`

## Auto-approve behavior

- Matching approvals are accepted inside the daemon before a pending approval is created.
- For kinds that support session scope, the daemon sends the session-wide accept shortcut:
  - `approval.command_execution`
  - `approval.file_change`
  - `approval.permissions`
- `approval.mcp_elicitation` uses plain `accept`.
- Successful matches emit `auto_approved` with `request_id`, `kind`, `matched_pattern`, and `command_preview`.
- Non-matching approvals keep the existing pending-request flow unchanged.

## CLI validation

- Added optional `message approval --kind <kind>` hint.
- When `--kind` and a shortcut are both present, the CLI validates the action locally and exits `2` on invalid combinations.
- Without `--kind`, behavior is unchanged and the daemon remains the final validator.

## Backward compatibility

- Existing sessions loaded from disk without `autoApprovePatterns` are normalized to `[]`.
- The new daemon config key defaults to an empty string, so auto-approval stays disabled unless configured.
- No daemon/CLI payload outer shapes changed; `session info` only adds a new nested field on the existing `session` object.
