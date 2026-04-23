<history> {"session":"audit","thread_id":"th-7","count":1,"next_cursor":"cursor-2"}
<turn> {"id":"turn-7","status":"completed","duration_ms":2310}
<message> {"role":"user"}
Show me the latest markdown output.
<\message>

<tool.search-docs> {"server":"docs","tool":"searchDocs"}
Found markdown.ts, html-md-format.md, and markdown-snapshot.test.ts with
…[16 bytes truncated; use --truncate 0 to disable]
<\tool.search-docs>

<shell> {"cmd":"npm test","exit":0,"duration_ms":1200}
PASS markdown-snapshot.test.ts
PASS status-and-format.test.ts
PASS cli-r
…[10 bytes truncated; use --truncate 0 to disable]
<\shell>

<auto-approval-review>{"id":"review-1","kind":"approval.command_execution","matched_pattern":"npm test","command_preview":"npm test","decision":"approved"}<\auto-approval-review>

<message> {"role":"assistant"}
Snapshot output refreshed.
<\message>
<\turn>
<\history>
