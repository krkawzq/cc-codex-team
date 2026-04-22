# codex-team 标签化 Markdown 格式

用于 `session context` / `message history` / `message tail` / `session info` 等读取类命令的 `--format markdown` 输出。

## 设计目标

面向 **agent 读取**。不是严格的机器协议，不是严格的渲染标准，就是一种**让 agent 一次看到结构和内容**的写法：

- **结构化字段** → tag 开头那行的 JSON inline（agent 一次 `JSON.parse` 拿齐）
- **自然语言 / 代码 / diff / 输出** → tag 正文的 markdown（agent 可以直接读）
- tag 边界本身已经表明"这是一段 X 类型的内容"，正文里**不再嵌套 ``` 壳**

和 `monitor events` 的 NDJSON 互补：events 是**摘要通知**（某个 turn 完成了），要拿**详细内容**（命令输出、diff、reasoning 等）就用这套 markdown。

## 语法

### 基本形式

```
<tag-name> {"id":"...","other":"..."}

tag 正文：任意 markdown，直接写，不包裹。

<\tag-name>
```

- **开始 tag 一行**：`<tag-name>` + 空格 + 单行 JSON 对象（属性）
- 空行
- **正文**：markdown；如果内容天然包含代码/diff，tag 类型会说明（`<shell>` 正文是命令输出、`<file-patch>` 正文是 diff），不用再额外加 ``` 壳
- 空行（可省）
- **结束 tag 独占一行**：`<\tag-name>`

### 内联形式

属性足以表达全部内容时，一行搞定：

```
<tag-name>{"id":"...","all":"data","here":true}<\tag-name>
```

### 什么时候在正文里写 ```` ``` ````？

只有当正文是 **prose 里穿插代码/diff 需要渲染成代码块** 时才用（自然 markdown 用法），例如 `<agent-message>` 里 assistant 贴了一段 TypeScript。结构化 tag（`<shell>` / `<file-patch>` / `<file-read>`）的正文是**纯内容**，不包一层 ``` 壳。

### 其它约定

- Tag 名：kebab-case，允许点分命名空间（`tool.<mcp-name>`）
- JSON 属性键：snake_case，和事件 payload 保持一致
- 属性值任意 JSON 类型（string / number / bool / array / nested object）
- 时间：ISO 8601 UTC；duration 统一 `duration_ms` 整数毫秒
- 关闭 tag 用 `<\name>`（反斜杠），这不是合法 HTML，markdown 渲染器不会把它当标签折叠
- Tag 之间留空行
- JSON 必须单行；值为长字符串时用 `\n` 转义
- 属性空 → `{}`；也可以写 `<tag>{}` 紧贴空 JSON

## Tag 词表

### 根容器

| Tag | 命令 | 正文 |
|---|---|---|
| `<context>` | `session context --format markdown` | 嵌套 |
| `<history>` | `message history --format markdown` | 嵌套 |
| `<tail>` | `message tail --format markdown` | 嵌套 |
| `<session-info>` | `session info --format markdown` | markdown 列表 |

根容器常见属性：`session` / `thread_id` / `model` / `cwd` / `generated_at`。

### Context 专用

| Tag | 正文 | 说明 |
|---|---|---|
| `<system>` | markdown | 系统级 instructions |
| `<developer>` | markdown | 开发者级 instructions |
| `<compacted>` | markdown 摘要 | 属性含 `from_turn` / `to_turn` / `token_saving` |

### Turn

```
<turn> {"id":"tu-5","status":"completed|interrupted|failed|in-progress",
        "model":"gpt-5.4",
        "started":"...","completed":"...","duration_ms":135000,
        "tokens_in":1234,"tokens_out":567,
        "interrupted_by":"message-interrupt"}
...
<\turn>
```

### Turn 内元素

| Tag | 正文 | 关键属性 |
|---|---|---|
| `<user-input>` | prompt 正文（markdown） | `attachments`（数组，也可独立 `<attachment>` tag） |
| `<environment>` | env 说明 | — |
| `<attachment>` | 无（内联） | `path` / `mime` / `bytes` |
| `<agent-message>` | assistant prose（里面可自然用 ```）| `id` |
| `<reasoning>` | reasoning prose | `id` |
| `<plan>` | markdown checklist | `id` |
| `<shell>` | 命令输出（stdout / 合并 stderr） | `id` / `cmd` / `exit` / `duration_ms` / `cwd` / `sandbox` / `interrupted` / `stderr`（短 stderr 单列） |
| `<file-patch>` | unified diff | `id` / `path` / `status` |
| `<file-read>` | 文件内容 | `id` / `path` / `from_line` / `to_line` / `lang` |
| `<file-write>` | 写入内容 | `id` / `path` |
| `<tool.<name>>` | tool 结果（文本 / markdown） | `id` / `server` / `status` / `duration_ms` / `args`（对象） |
| `<web-search>` | markdown 列表 | `id` / `query` / `engine` |
| `<approval-request>` | 无（全部 JSON，内联） | `id` / `kind` / `status` / `decided_by` / `decided_at` / `cmd` / `reason` / `decision`（对象） |
| `<user-input-request>` | 无（全部 JSON，内联） | `id` / `status` / `answered_by` / `answered_at` / `questions`（数组） / `answers`（对象） |
| `<error>` | 错误描述 prose | `kind` / `codex_error_info` / `will_retry` |
| `<item>` | 通用兜底 | `id` / `type` |

`<shell>` 的 `cmd` 作为 JSON 属性存（通常短）；超长多行 shell 脚本可以把 `cmd` 放进正文前面（用 ```bash 代码块），或拆成单独 tag——按 agent 可读性选。

---

## 示例

内容虚构。

### 1 — `session context`

```
<context> {"session":"auth-refactor","thread_id":"th-9f2a","model":"gpt-5.4","cwd":"/home/wzq/repo","generated_at":"2026-04-22T10:30:00Z","tokens":8500}

<system>{}

You are Codex, an AI coding assistant. Follow the user's instructions precisely.

<\system>

<developer>{}

Project conventions:

- TypeScript strict mode
- Tests live in `__tests__/`

<\developer>

<compacted> {"from_turn":"tu-1","to_turn":"tu-4","token_saving":3200}

用户让 agent 调研现有 auth 模块并提出重构方案；agent 读取 `src/auth.ts` / `src/session.ts` 和对应测试，输出方案（提取 token 校验到独立模块）。用户接受方案。

<\compacted>

<turn> {"id":"tu-5","status":"completed","duration_ms":42000}

<user-input>{}

Implement the plan we agreed on.

<\user-input>

<agent-message> {"id":"it-1"}

I'll start by creating the new `token.ts` module and then migrate callers.

<\agent-message>

<file-patch> {"id":"it-2","path":"src/token.ts","status":"applied"}

+export function validateToken(raw: string): TokenPayload | null {
+  // ...
+}

<\file-patch>

<file-patch> {"id":"it-3","path":"src/auth.ts","status":"applied"}

-function validateToken(raw) { ... }
+import { validateToken } from "./token";

<\file-patch>

<shell> {"id":"it-4","cmd":"npm test","exit":0,"duration_ms":2100}

PASS __tests__/auth.test.ts
PASS __tests__/token.test.ts
Tests: 24 passed

<\shell>

<\turn>

<\context>
```

### 2 — 标准 turn（reasoning + 命令 + 文件改动）

```
<turn> {"id":"tu-7","status":"completed","model":"gpt-5.4","started":"2026-04-22T10:25:00Z","duration_ms":78000,"tokens_in":2100,"tokens_out":890}

<user-input>{}

Run the linter and fix any warnings.

<\user-input>

<reasoning> {"id":"it-1"}

The user wants me to lint and fix. I'll run the linter first to see what comes up, then decide on a batch fix strategy.

<\reasoning>

<shell> {"id":"it-2","cmd":"npm run lint","exit":1,"duration_ms":3200}

src/auth.ts:42:5  warning  Prefer const  prefer-const
src/auth.ts:87:1  warning  Missing return type  @typescript-eslint/explicit-function-return-type
2 warnings

<\shell>

<agent-message> {"id":"it-3"}

Two warnings in `src/auth.ts`. I'll fix both.

<\agent-message>

<file-patch> {"id":"it-4","path":"src/auth.ts","status":"applied","duration_ms":450}

@@ -40,7 +40,7 @@
-let cache = new Map();
+const cache = new Map<string, Token>();
@@ -85,7 +85,7 @@
-function refresh(token) {
+function refresh(token: string): void {

<\file-patch>

<shell> {"id":"it-5","cmd":"npm run lint","exit":0,"duration_ms":2800}

Lint passed.

<\shell>

<agent-message> {"id":"it-6"}

All warnings fixed. `npm run lint` is clean.

<\agent-message>

<\turn>
```

### 3 — 含 approval（历史已决）

`<approval-request>` 用内联形式，全部结构化：

```
<turn> {"id":"tu-14","status":"completed","duration_ms":45000}

<user-input>{}

Clean up old build artifacts.

<\user-input>

<agent-message> {"id":"it-1"}

I'll remove the `build/` directory and any stale `.tsbuildinfo` files.

<\agent-message>

<approval-request>{"id":"req-1","kind":"command_execution","status":"accepted","decided_by":"agent-1","decided_at":"2026-04-22T11:00:08Z","cmd":"rm -rf build","reason":"cleanup old build artifacts","decision":{"type":"accept"}}<\approval-request>

<shell> {"id":"it-2","cmd":"rm -rf build","exit":0,"duration_ms":120}

<\shell>

<approval-request>{"id":"req-2","kind":"file_change","status":"declined","decided_by":"agent-1","decided_at":"2026-04-22T11:00:32Z","reason":"Delete all .tsbuildinfo files across the tree","decision":{"type":"decline"}}<\approval-request>

<agent-message> {"id":"it-3"}

Skipping the `.tsbuildinfo` deletion per the decision. `build/` is cleaned.

<\agent-message>

<\turn>
```

`<shell>` 的正文空（空命令无输出，例子里 `rm -rf build` 无回显）。

### 4 — 含 askUserQuestion

`<user-input-request>` 整条一次放在 JSON 里，agent 一次 parse：

```
<turn> {"id":"tu-20","status":"completed","duration_ms":61000}

<user-input>{}

Set up the database layer.

<\user-input>

<agent-message> {"id":"it-1"}

Before I scaffold the data layer, I need a couple of decisions from you.

<\agent-message>

<user-input-request>{"id":"req-7","status":"answered","answered_by":"agent-1","answered_at":"2026-04-22T12:00:18Z","questions":[{"id":"q1","header":"Database","is_other":false,"is_secret":false,"question":"Which backend should I target?","options":[{"label":"Postgres","description":"Production-grade, requires a running server"},{"label":"SQLite","description":"File-based, zero-config for dev"}]},{"id":"q2","header":"ORM","is_other":true,"is_secret":false,"question":"Preferred ORM (free-text allowed)?","options":[{"label":"Prisma"},{"label":"Drizzle"}]}],"answers":{"q1":["Postgres"],"q2":["Drizzle"]}}<\user-input-request>

<file-patch> {"id":"it-2","path":"src/db/index.ts","status":"applied"}

+import { drizzle } from "drizzle-orm";
+import { Pool } from "pg";

<\file-patch>

<\turn>
```

### 5 — MCP tool call

args 结构化进 JSON，result 当正文（通常是文本）：

```
<turn> {"id":"tu-30","status":"completed","duration_ms":8200}

<user-input>{}

Find commits that touched the auth module last month.

<\user-input>

<reasoning> {"id":"it-1"}

I have the `git-mcp` server available. `log` tool with a path filter and date range should work.

<\reasoning>

<tool.log> {"id":"it-2","server":"git-mcp","status":"ok","duration_ms":320,"args":{"repo":"/home/wzq/repo","path":"src/auth.ts","since":"2026-03-22","until":"2026-04-22"}}

3f21a8c  2026-04-10  refactor: extract token validation
8a9b2c1  2026-03-29  fix: session timeout edge case
b92d034  2026-03-25  feat: support oauth refresh

<\tool.log>

<agent-message> {"id":"it-3"}

Three commits touched `src/auth.ts` in the last month: ...

<\agent-message>

<\turn>
```

如果 tool result 本身是结构化的（JSON），直接塞进属性里 inline：

```
<tool.get_pr>{"id":"it-5","server":"github-mcp","status":"ok","args":{"pr":1234},"result":{"number":1234,"title":"...","state":"merged","author":"alice"}}<\tool.get_pr>
```

### 6 — plan 更新

```
<plan> {"id":"it-1"}

- [x] Inventory existing auth call sites
- [x] Identify breaking API changes
- [ ] Write migration guide
- [ ] Update call sites in `apps/web`
- [ ] Update call sites in `apps/mobile`
- [ ] Add deprecation warnings to old API

<\plan>
```

### 7 — turn 失败

```
<turn> {"id":"tu-50","status":"failed","duration_ms":8100}

<user-input>{}

Generate a 50-page architecture document.

<\user-input>

<agent-message> {"id":"it-1"}

Starting with an outline covering system components, data flow, and...

<\agent-message>

<error> {"kind":"turn","codex_error_info":"context_window_exceeded","will_retry":false}

Your request exceeded the model's context window. Reduce the scope or start a new session.

<\error>

<\turn>
```

### 8 — turn 被打断（含 stderr）

```
<turn> {"id":"tu-60","status":"interrupted","duration_ms":45000,"interrupted_by":"message-interrupt"}

<user-input>{}

Profile the hot path.

<\user-input>

<reasoning> {"id":"it-1"}

I'll use `clinic flame` to get a flame graph. This usually takes a few minutes.

<\reasoning>

<shell> {"id":"it-2","cmd":"npx clinic flame -- node dist/server.js","exit":-15,"duration_ms":42000,"interrupted":true,"stderr":"Interrupted by user."}

[clinic] attaching to server...
[clinic] generating flame graph...

<\shell>

<\turn>
```

### 9 — `message tail`

```
<tail> {"session":"auth-refactor","count":3,"generated_at":"2026-04-22T15:00:00Z"}

<turn> {"id":"tu-62","status":"completed","duration_ms":2100}

<user-input>{}

Commit the changes.

<\user-input>

<shell> {"id":"it-1","cmd":"git add -A && git commit -m \"refactor: extract token module\"","exit":0}

[main 3f21a8c] refactor: extract token module
 3 files changed, 87 insertions(+), 41 deletions(-)

<\shell>

<agent-message> {"id":"it-2"}

Commit `3f21a8c` created.

<\agent-message>

<\turn>

<turn> {"id":"tu-61","status":"completed","duration_ms":18000}

<user-input>{}

Add a changelog entry.

<\user-input>

<file-patch> {"id":"it-1","path":"CHANGELOG.md","status":"applied"}

+### Refactored
+- Extracted token validation into `src/token.ts`

<\file-patch>

<\turn>

<\tail>
```

### 10 — `session info`

```
<session-info> {"name":"auth-refactor","thread_id":"th-9f2a","state":"live","generated_at":"2026-04-22T15:00:00Z"}

- **model**: gpt-5.4
- **cwd**: `/home/wzq/repo`
- **turns**: 62
- **sandbox**: workspace-write
- **approval_policy**: on-request
- **effort**: medium
- **created**: 2026-03-20T09:14:00Z
- **last_active**: 2026-04-22T14:59:12Z
- **token_usage**: 412k in / 187k out
- **live_since**: 2026-04-22T10:00:00Z

<\session-info>
```

### 11 — `message tail --follow` 流式快照

未完成 turn / item 标 `status:"in-progress"` / `"running"`。完成时**重新输出完整 tag**替换原来的 open-only 版本（cli 用游标替换；agent 按 tag id 覆盖）：

```
<turn> {"id":"tu-71","status":"in-progress","started":"2026-04-22T15:10:00Z"}

<user-input>{}

Deploy to staging.

<\user-input>

<agent-message> {"id":"it-1"}

Starting deployment...

<\agent-message>

<shell> {"id":"it-2","cmd":"./scripts/deploy.sh staging","status":"running"}

<\shell>

<\turn>
```

要看流式 token delta 用 `monitor events --include-delta`。

### 12 — 含附件

```
<turn> {"id":"tu-80","status":"completed","duration_ms":5400}

<attachment>{"path":"/home/wzq/Downloads/err.png","mime":"image/png","bytes":124533}<\attachment>

<user-input>{}

What's wrong with this screenshot?

<\user-input>

<agent-message> {"id":"it-1"}

The screenshot shows a 404 response. Looks like your reverse-proxy strips the `/api` prefix — check the `location` block in nginx.conf.

<\agent-message>

<\turn>
```

### 13 — file-read

```
<file-read> {"id":"it-2","path":"src/config.ts","from_line":1,"to_line":40,"lang":"ts"}

export interface Config {
  host: string;
  port: number;
  ...
}

<\file-read>
```

### 14 — web-search

```
<web-search> {"id":"it-3","query":"drizzle orm postgres connection pool","engine":"bing"}

- [Drizzle ORM — PostgreSQL](https://orm.drizzle.team/docs/pg) — official connection guide
- [node-postgres pool docs](https://node-postgres.com/features/pooling) — `pg.Pool` options

<\web-search>
```

### 15 — 通用 `<item>` 兜底

```
<item> {"id":"it-5","type":"terminal_interaction","exit":0}

User pressed `q` to exit the pager.

<\item>
```

### 16 — 嵌套 item（`parent_item_id`）

某些副产物（如 `cargo build` 更新了 `Cargo.lock`）仍然平铺，通过 `parent_item_id` 关联：

```
<shell> {"id":"it-2","cmd":"cargo build","exit":0,"duration_ms":4200}

   Compiling foo v0.1.0
    Finished dev [unoptimized + debuginfo]

<\shell>

<file-patch> {"id":"it-3","parent_item_id":"it-2","path":"Cargo.lock","status":"applied"}

-rand = "0.8.5"
+rand = "0.8.7"

<\file-patch>
```

### 17 — `<agent-message>` 里的 markdown 代码块

Prose 里穿插代码时 **才** 用 ``` ``` —— 这是自然 markdown 用法：

```
<agent-message> {"id":"it-1"}

I'll start by creating `src/token.ts`:

```typescript
export function validateToken(raw: string): TokenPayload | null {
  return parseJwt(raw);
}
```

Then update callers in `src/auth.ts` to import from the new module.

<\agent-message>
```

---

## JSONL 序列化

DFS 前序遍历；每条：

```
{
  "tag":     "...",
  "id":      "<id attr, if present>",
  "parent":  "<nearest ancestor with id>",
  "attrs":   { ...其余属性... },
  "content": "<markdown 正文，如果有>"
}
```

"示例 2" 的前几条：

```jsonl
{"tag":"turn","id":"tu-7","attrs":{"status":"completed","model":"gpt-5.4","started":"2026-04-22T10:25:00Z","duration_ms":78000,"tokens_in":2100,"tokens_out":890}}
{"tag":"user-input","parent":"tu-7","content":"Run the linter and fix any warnings."}
{"tag":"reasoning","id":"it-1","parent":"tu-7","content":"The user wants me to lint and fix. I'll run the linter first..."}
{"tag":"shell","id":"it-2","parent":"tu-7","attrs":{"cmd":"npm run lint","exit":1,"duration_ms":3200},"content":"src/auth.ts:42:5  warning  Prefer const  prefer-const\n..."}
{"tag":"agent-message","id":"it-3","parent":"tu-7","content":"Two warnings in `src/auth.ts`. I'll fix both."}
```

内联 tag（如 `<approval-request>`）序列化时正文为空：

```jsonl
{"tag":"approval-request","id":"req-1","parent":"tu-14","attrs":{"kind":"command_execution","status":"accepted","decided_by":"agent-1","decided_at":"2026-04-22T11:00:08Z","cmd":"rm -rf build","reason":"cleanup old build artifacts","decision":{"type":"accept"}}}
```

反向：按 `parent` 重建树，按 tag 词表生成 `<...>` / `<\...>`。

---

## 实现注意事项

- **转义**：JSON 属性值按 JSON 规则；正文不转义
- **大内容**：>10KB 的输出 / diff 直接写进正文，daemon 不截断
- **未知 tag**：解析器遇到未在词表中的 tag 保留原文（forward-compat）
- **空正文**：`<tag>` 后直接空行 + `<\tag>`，或内联 `<tag>{}<\tag>` 均可
- **正文首尾空白**：消费侧应 `.trim()`；生产侧开闭 tag 前后留空行是为了渲染，不是内容的一部分
- **渲染**：markdown 渲染器大概率会把 `<tag>` 当未知元素穿透、`<\tag>` 当字面量——两种都不影响正文 markdown 的渲染

## Regenerating Snapshots

当 markdown renderer 有意变更时，用下面的命令重写 `tests/fixtures/markdown/*.expected.md`：

```bash
npm test -- -u
```

- `-u` / `--update` 会让 `tests/markdown-snapshot.test.ts` 重新渲染每个 JSON fixture 并覆盖对应的 `.expected.md`
- 提交前仍然跑一次常规 `npm test`，确认无需更新时快照保持稳定
