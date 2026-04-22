# AUDIT_D

## Renderer Inventory

- `userMessage` renders as `<user-input>` inline for short prompts and block form for long prompts.
- `agentMessage` renders as `<agent-message>` with markdown body.
- `commandExecution` renders as `<shell>` with command metadata and merged output body.
- `fileChange` renders as `<file-patch>` with diff body.
- `mcpToolCall` renders as `<tool.<name>>` with `{server, tool, status, duration_ms}` metadata plus nested `<mcp-args>` and `<mcp-result>`.
- `hook.*` renders as `<hook.pre-command>` / `<hook.post-command>` style tags; small payloads stay inline, stdout/stderr payloads move into nested `<hook-output>`.
- `autoApprovalReview` renders inline as `<auto-approval-review>`.
- `reasoning` renders inline when short and block form when the body exceeds the inline byte limit.
- Unknown item types still fall back to `<item>`.

## INLINE_MAX_BYTES Rationale

- `INLINE_MAX_BYTES` is `2048`.
- The threshold is large enough to keep normal prompts, short reasoning blurbs, command previews, and review summaries on one line.
- The threshold is small enough to stop 10KB to 50KB text payloads from collapsing into unreadable inline JSON.
- `--truncate <N>` overrides the renderer byte budget for `message history` and `message tail`.
- `--truncate 0` disables body clipping but still lets long inline-capable content switch to block form for readability.
- Inline-only tags fall back to a marker of the form `…[N bytes truncated; use --truncate 0 to disable]`.

## Snapshot Regeneration

- Fixtures live in `plugins/codex-team/tests/fixtures/markdown/`.
- Each `*.json` fixture pairs with a `*.expected.md` file rendered by `tests/markdown-snapshot.test.ts`.
- Regenerate expected markdown with `npm test -- -u`.
- The snapshot harness uses `expect(actual).toBe(expected)` so mismatches print a normal vitest diff.
- The long-message regression check in `tests/markdown-snapshot.test.ts` verifies that a 10KB `userMessage` becomes block form plus a truncation marker when truncation is enabled.
