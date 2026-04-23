<context> {"session":"sess-ctx","thread_id":"th-ctx","generated_at":"2026-01-01T00:00:00.000Z","model_provider":"openai","preview":"Repository status review","cwd":"/repo/project","status":"running","created_at":1735689000,"updated_at":1735689600}

<turn> {"id":"turn-1","status":"completed","duration_ms":1500}

<user-input>{"id":"item-user-1","text":"Summarize the repository status."}<\user-input>

<agent-message> {"id":"item-agent-1","phase":"analysis"}

Repository has 2 pending changes.

<\agent-message>

<\turn>

<turn> {"id":"turn-2","status":"running","started_at":1735689720}

<shell> {"id":"item-cmd-1","cmd":"git status --short","cwd":"/repo/project","exit":0,"duration_ms":45}

M src/app.ts

<\shell>

<\turn>

<\context>