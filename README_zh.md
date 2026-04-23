<div align="center">

# cc-codex-team

**一队长生 Codex worker，由 Claude Code 统一调度。**

[English](./README.md) · [简体中文](./README_zh.md)

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-18%2B-brightgreen.svg)](#环境要求)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-8A4FFF.svg)](https://code.claude.com/docs/en/plugins)
[![Release](https://img.shields.io/badge/Release-0.5.5-success.svg)](plugins/codex-team/docs/releases/0.5.5.md)

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
| **event** | daemon 推出的 NDJSON 摘要行：`turn.started`、终态 `turn.completed`、审批请求、session 崩溃…… |
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

或者在终端里：

```bash
claude plugin marketplace add krkawzq/cc-codex-team
claude plugin install codex-team
```

校验依赖：

```bash
node --version   # 18+
codex --version
codex login
```

## 怎么用

**不需要手动驱动 codex-team。** 装好后，直接告诉 Claude Code 你想干什么。遇到能拆成并行、长程、多 agent 的任务，Claude 会自动加载 `using-codex-team` skill，通过插件调度 Codex worker。

如果想在会话开头显式加载 skill：

```text
/using-codex-team
```

skill 加载之后，Claude 自己选 bearer token、开 worker、接事件流、发 prompt、休眠、在 `turn.completed` 时醒来、把结果汇总给你——全走插件的 CLI。worker 干活的时候你的上下文是空闲的。

### Slash 命令

| 命令 | 作用 |
|---|---|
| `/codex-team:events` | 把一个持久 Monitor 订阅到你 bearer token 对应的 codex-team 事件流。 |
| `/codex-team:logs` | 跟 daemon 日志（daemon 层级调试，不是每个 session 的事件 —— 那个用 `events`）。 |
| `/codex-team:tutorial` | 分支式交互教程，讲心智模型 + 概念。只读。 |

### 长程任务：让 Claude 自己定 alarm

对可能跑几个小时的任务，让 Claude 武装一个**定时 alarm**——即使事件流长时间没动静，它也能按时醒来，防止卡死无感知：

```bash
# Claude 自己发起：每 10 分钟给自己一个 check-in 提示
codex-team -b $TOK monitor alarm 600 "echo '[alarm] 状态检查 —— 看一下 session health 和队列里的 turn'"
```

被 alarm 执行的 shell 命令每一行 stdout 都是一条 Monitor 通知，那行内容就是唤醒 Claude 的提示词。间隔和提示内容都由 Claude 根据任务形状自选。

### Daemon 生命周期

daemon 是**自动管理的**。第一次 `-b` 调用时自动拉起，6 小时无活动时自动关停。你不需要 start/stop/restart。怀疑出问题时跑 `codex-team doctor` —— 它检查 `PATH`、`codex` 二进制、socket bind 权限、stale pidfile、dist 新鲜度，失败时非零退出并给出具体诊断。

**如果 `codex-team` 不在 `PATH` 上**（某些沙盒会），用自带的 launcher：`$CLAUDE_PLUGIN_ROOT/plugins/codex-team/bin/codex-team ...`。

## Power-user CLI

<details>
<summary>绕开 Claude 直接操作 codex-team（基本用不上）</summary>

选个 bearer token —— 任意字符串，你会反复用：

```bash
TOKEN=claude-$(date +%s)
codex-team daemon user create $TOKEN    # 幂等；第一次 -b 调用时 daemon 自动拉起
```

**Session 生命周期**

```bash
codex-team -b $TOK session new NAME --cwd PATH [--auto-approve "git*,npm"] ...
codex-team -b $TOK session health NAME             # 活性快照：state、busy、活跃时的 current_turn_id、非零 pending
codex-team -b $TOK session heal NAME [--force]     # 给崩了/死了的 session 重新拉起 app-server
codex-team -b $TOK session detach NAME             # 释放 app-server；线程留在 codex
codex-team -b $TOK session list [--short]          # 每个 session 一行
```

**Messaging**

```bash
codex-team -b $TOK message send NAME "prompt"       # 非阻塞；启动 turn
codex-team -b $TOK message peer NAME "..."          # 注入活跃 turn（软重定向）
codex-team -b $TOK message wait NAME [--timeout S]  # 阻塞等终态 turn.completed（含 status=failed）或超时
codex-team -b $TOK message tail NAME -n 1 --format markdown    # 拿最后一 turn
codex-team -b $TOK message approval NAME REQ_ID accept          # 回复 approval.request
codex-team -b $TOK message answer NAME REQ_ID "..."             # 回复 user_input.request
```

**事件流**

```bash
codex-team -b $TOK monitor events --stream --cursor NAME             # 默认输出精简摘要 JSONL，游标自动推进
codex-team -b $TOK cursor list                                       # 所有命名 cursor
codex-team -b $TOK cursor get NAME                                   # {"event_id":"evt-..."}
```

**输出模式**

默认情况下，成功的非流式命令会输出单行精简 JSONL。传 `--full` 可改为多行完整 JSON；很多状态类命令还支持 `--short`，输出更适合 grep 和 dashboard 的纯文本单行结果。`message history` / `message tail` 支持 `--truncate <bytes>` 裁剪长内容；`--truncate 0` 表示不裁剪。带标签的 markdown 输出（`--format markdown`）遵循 [`docs/html-md-format.md`](plugins/codex-team/docs/html-md-format.md)。这不是普通 prose markdown，而是标签化的 markdown 交换格式：`<history>` / `<tail>` / `<turn>` 这类容器 tag 承载元数据，`<message>`、`<shell>`、`<file-patch>`、`tool.<name>`、`hook.<name>`、`<reasoning>`、`<auto-approval-review>` 这类 item tag 承载正文。

</details>

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
| 最新版本变更 | [`docs/releases/0.5.5.md`](plugins/codex-team/docs/releases/0.5.5.md) |
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
npm run bump-version 0.5.5
```

改完 TypeScript 记得重建 + `/reload-plugins`。

</details>

## 仓库

[github.com/krkawzq/cc-codex-team](https://github.com/krkawzq/cc-codex-team)

## 许可证

MIT — 见 [LICENSE](LICENSE)
