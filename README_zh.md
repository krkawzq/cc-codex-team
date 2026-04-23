<div align="center">

# cc-codex-team

**一队长生 Codex worker，由 Claude Code 统一调度。**

[English](./README.md) · [简体中文](./README_zh.md)

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-18%2B-brightgreen.svg)](#环境要求)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-8A4FFF.svg)](https://code.claude.com/docs/en/plugins)
[![Release](https://img.shields.io/badge/Release-0.5.3-success.svg)](plugins/codex-team/docs/releases/0.5.3.md)

</div>

---

Claude Code 与 Codex **能力互补。Claude Code** 强在规划、创造性的问题拆解、MVP 实现、任务编排、长程自动化工作流；**Codex** 更细致，擅长代码细节实现与严谨的 review。

**cc-codex-team 把两者组合起来。** Claude Code 稳坐上层做编排者——拆解任务、分派子工作、做判断、评审产出；一队常驻的 Codex worker 并行完成底层代码细节。如果你同时订阅了 Claude Code 和 Codex，两份订阅的用量也会自然地匹配起来，不会出现一边闲置的情况。

- Claude 拆解任务、派发 worker、在事件上醒来。
- Worker 是真实的 `codex app-server` 进程，各自拥有独立线程、任务队列、日志。
- 审批、用户输入、崩溃、turn 完成——一切都是事件流上的一行。

## 心智模型

```
   Claude（编排者）
      │   codex-team -b <token> ...   （无状态 CLI）
      ▼
   codex-team daemon   （每个 OS 用户一份；按 bearer token 多租户隔离）
      │   JSON-RPC 2.0 over stdio
      ▼
   N × codex app-server 子进程   （worker，并行）
      │
      └── session（codex 持久线程，每个对应一次 live 绑定）
```

四个核心概念：

| | |
| --- | --- |
| **bearer token** | 任意字符串。隔离你的 session 与其他共享 daemon 的 agent。 |
| **session** | 具名的 codex 线程。codex 在磁盘上持久化线程；codex-team 管理 **live 绑定**（指向某个 app-server）。 |
| **event** | daemon 推出的 NDJSON 摘要行：turn 开始/完成/报错、审批请求、session 崩溃…… |
| **命名 cursor** | daemon 维护的事件流恢复点，跨重启。 |

每 OS 用户一个 daemon；按 token 隔离。不再有 "workspace" 的概念——token 就是作用域。

## 何时用

- **并行编码** — 任务能拆成 ≥2 个机械上独立的子任务
- **长战线工作** — 批量重构、多模块迁移、全库审计+修复
- **多 agent 模式** — worker+reviewer、map-reduce、plan→execute→verify、debate、swarm
- **带检查点的自主** — 派发任务后 Claude 上下文解放，事件到达时再醒来

不适合一次性小修改（直接用 `codex` CLI 或 `codex:codex-rescue` subagent）、需要逐步手把手的工作。

## 安装

在 Claude Code 会话内：

```text
/plugin marketplace add krkawzq/cc-codex-team
/plugin install codex-team
/reload-plugins
```

校验依赖：

```bash
node --version   # 18+
codex --version
codex login
```

装好后 Claude 就能通过 `codex-team` CLI 和自带的 slash 命令操作插件了。

**如果 `codex-team` 不在 `PATH` 上**（某些沙盒会），用自带的 launcher：`$CLAUDE_PLUGIN_ROOT/plugins/codex-team/bin/codex-team ...`。遇到问题先跑 `codex-team doctor`（或 `<launcher> doctor`）—— 它检查 `PATH`、`codex` 二进制、socket bind 权限、stale pidfile、dist 新鲜度，失败时非零退出并给出具体诊断。

## 首次上手

选个 bearer token，开一个 worker，接上事件流，派任务：

```bash
TOKEN=claude-$(date +%s)

# 注册 user（幂等；第一次 -b 调用时 daemon 自动拉起）
codex-team daemon user create $TOKEN

# 在仓库里开一个常驻 worker session
codex-team -b $TOKEN session new refactor --cwd /abs/path/to/repo \
  --model gpt-5.4 --sandbox workspace-write --approval on-request

# 持久化 cursor，断线可恢复
codex-team -b $TOKEN cursor save refactor-tail

# 开事件 Monitor（或在 Claude Code 里：/codex-team:events -b $TOKEN）
codex-team -b $TOKEN monitor events --stream --summary --cursor refactor-tail
```

然后告诉 Claude：

> *"让 `refactor` 审阅 auth 模块找风险，然后重写 token-validation 路径。改完给我过 diff。"*

Claude 用 `message send` 投递 prompt，休眠，`turn.completed` 到达时醒来，`message tail` 取详情。收工时 `codex-team -b $TOKEN session detach refactor`——线程留在 codex 里，下次可以 resume。

## 日常操作

**Session 生命周期**

```bash
codex-team -b $TOK session new NAME --cwd PATH [--auto-approve "git*,npm"] ...
codex-team -b $TOK session health NAME             # 活性快照：busy、current_turn_id、pending、token_usage
codex-team -b $TOK session heal NAME [--force]     # 给崩了/死了的 session 重新拉起 app-server
codex-team -b $TOK session detach NAME             # 释放 app-server；线程留在 codex
codex-team -b $TOK session list [--short]          # 每个 session 一行
```

**Messaging**

```bash
codex-team -b $TOK message send NAME "prompt"       # 非阻塞；启动 turn
codex-team -b $TOK message peer NAME "..."          # 注入活跃 turn（软重定向）
codex-team -b $TOK message wait NAME [--timeout S]  # 阻塞等 turn.completed / turn.error / 超时
codex-team -b $TOK message tail NAME -n 1 --format markdown    # 拿最后一 turn
codex-team -b $TOK message approval NAME REQ_ID accept          # 回复 approval.request
codex-team -b $TOK message answer NAME REQ_ID "..."             # 回复 user_input.request
```

**事件流**

```bash
codex-team -b $TOK monitor events --stream --summary --cursor NAME   # 紧凑 NDJSON，游标自动推进
codex-team -b $TOK cursor list                                       # 所有命名 cursor
codex-team -b $TOK cursor get NAME                                   # 打印 event id
```

**输出与状态**

所有返回状态的命令都支持 `--short`——单行紧凑输出，方便 grep 和 dashboard。`message history` / `message tail` 支持 `--truncate <bytes>` 裁剪长内容。带标签的 markdown 输出（`--format markdown`）遵循 [`docs/html-md-format.md`](plugins/codex-team/docs/html-md-format.md)，对 user message、agent message、shell、file patch、MCP tool call、hook、reasoning、auto-approval review 都有专用渲染器。

## Playbooks

九种多 session 协作拓扑以 skill 形式内置，Claude 按需加载。你通常不用自己读——Claude 按任务形状自选。

| Playbook | 适用场景 |
| --- | --- |
| `solo-worker` | 一个 session 搞定一件事，无 review 回路 |
| `worker-reviewer` | 生成者 + 批评者，迭代直到通过 |
| `map-reduce` | N 个独立同类子任务 + 聚合者 |
| `pipeline` | 阶段 1 → 阶段 2 → 阶段 3，每阶段一个专家 |
| `plan-execute-verify` | planner + executor + verifier 三 session |
| `reflexion` | 失败 → 自我反思 → 带教训重试 |
| `debate` | 正反双方辩论，judge 汇总 |
| `hierarchical` | manager 派发给自己生的子 session |
| `swarm` | 松耦合 worker，按共识交接 |

详见 [`skills/codex-team-playbooks/`](plugins/codex-team/skills/codex-team-playbooks/) 和 [`anti-patterns.md`](plugins/codex-team/skills/codex-team-playbooks/anti-patterns.md)。

## 文档

CLI 自带完整 help（`codex-team --help`、`<cmd> --help`）。进阶材料：

| 想做的事 | 去哪看 |
| --- | --- |
| 理解心智模型 | [`skills/using-codex-team/`](plugins/codex-team/skills/using-codex-team/) |
| 日常驱动 session | [`skills/manage-codex-team/`](plugins/codex-team/skills/manage-codex-team/) |
| 挑一种协作拓扑 | [`skills/codex-team-playbooks/`](plugins/codex-team/skills/codex-team-playbooks/) |
| 调模型、profile、小技巧 | [`skills/configure-codex-team/`](plugins/codex-team/skills/configure-codex-team/) |
| 错误、崩溃、恢复 | [`skills/recover-codex-team/`](plugins/codex-team/skills/recover-codex-team/) |
| 交互式走一遍 | `/codex-team:tutorial` |
| 最新版本变更 | [`docs/releases/0.5.3.md`](plugins/codex-team/docs/releases/0.5.3.md) |
| 输出格式规范 | [`docs/html-md-format.md`](plugins/codex-team/docs/html-md-format.md) |

## 环境要求

- 支持插件的 Claude Code
- Node.js 18+
- 安装并登录了的 Codex CLI（`codex login`）
- Windows 10+、macOS 12+ 或 Linux

## 本地开发

<details>
<summary>在当前 checkout 里构建与运行</summary>

```bash
cd plugins/codex-team
npm install
npm run typecheck
npm test
npm run build
```

从本地 marketplace manifest 安装：

```bash
claude plugin marketplace add /abs/path/to/cc-codex-team
claude plugin install codex-team@cc-codex-team
```

或者直接把 Claude Code 指到插件目录：

```bash
claude --plugin-dir /abs/path/to/cc-codex-team/plugins/codex-team
```

版本号 bump（同步 `package.json` + `.claude-plugin/plugin.json` + 重建 dist）：

```bash
npm run bump-version 0.5.3
```

改完 TypeScript 记得重建 + `/reload-plugins`。

</details>

## 仓库

[github.com/krkawzq/cc-codex-team](https://github.com/krkawzq/cc-codex-team)

## 许可证

MIT — 见 [LICENSE](LICENSE)
