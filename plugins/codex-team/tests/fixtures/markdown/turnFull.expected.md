<history> {"session":"audit","thread_id":"th-7","count":1,"generated_at":"2026-01-01T00:00:00.000Z","next_cursor":"cursor-2"}

<turn> {"id":"turn-7","status":"completed","duration_ms":2310,"started_at":1712345678,"completed_at":1712345680}

<user-input>{"id":"user-1","text":"Show me the latest markdown output."}<\user-input>

<reasoning> {"id":"reasoning-1"}

I should render the latest turn with the new tags, verify truncation mar
…[62 bytes truncated; use --truncate 0 to disable]

<\reasoning>

<tool.search-docs> {"id":"tool-1","status":"completed","server":"docs","tool":"searchDocs"}

<mcp-args>{"query":"snapshot renderer"}<\mcp-args>

<mcp-result> {}

Found markdown.ts, html-md-format.md, and markdown-snapshot.test.ts with
…[16 bytes truncated; use --truncate 0 to disable]

<\mcp-result>

<\tool.search-docs>

<shell> {"id":"cmd-1","cmd":"npm test","exit":0,"duration_ms":1200}

PASS markdown-snapshot.test.ts
PASS status-and-format.test.ts
PASS cli-r
…[10 bytes truncated; use --truncate 0 to disable]

<\shell>

<auto-approval-review>{"id":"review-1","kind":"approval.command_execution","matched_pattern":"npm test","command_preview":"npm test","decision":"approved"}<\auto-approval-review>

<agent-message> {"id":"agent-1"}

Snapshot output refreshed.

<\agent-message>

<\turn>

<\history>