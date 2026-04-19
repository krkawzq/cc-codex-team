# cc-codex-team

[English](./README.md)

> **给 Claude Code 装上一支 Codex 团队。** 一个 Claude Code 插件,让 Claude 并行编排多个长期运行的 OpenAI Codex worker。

## 这是什么

Claude Code 擅长对话、上下文、规划和代码 review;OpenAI Codex 擅长长程自主执行代码任务。但二者默认都是单线程 —— 一个 Claude 会话,一个 Codex 线程。

本插件让 Claude Code 成为一个 **编排者**,管理一支 Codex worker **团队**:

- 你把任务告诉 Claude;Claude 把它拆成互相独立的子任务。
- Claude 为每个子任务启动一个 Codex worker(每个都是一个真实的 `codex app-server` 子进程)。
- 多个 worker **并行、异步**运行;Claude 腾出手来调度、审计、合并。
- Worker 每完成一轮、遇到问题、或逼近 token 阈值,Claude 都会通过事件流收到通知。

简而言之:**Claude 决策,Codex 执行,并行进行。**

## 什么时候值得用

- 跨多文件 / 模块 / 仓库的重构、迁移、review(≥ 3 个可独立的子任务)。
- 同一类问题的批量 review 或批量 debug。
- 希望无人值守运行的长程编码任务。
- 单 Claude 或单 Codex 成为瓶颈,而任务本身可并行的场景。

一次性小修、单文件问题不需要用这个 —— 配置成本不值。

## 架构

```
      Claude Code  (编排者 —— 你对话的对象)
             │
             │   codex-team CLI (Bash)            Monitor 事件 ▲
             │                                                  │
             ▼                                                  │
      codex-team daemon (Unix socket, 多租户)
       │   │   │   │
      N × codex app-server 子进程  (workers, 并行运行)
```

- **Daemon** —— 每个 `CLAUDE_PLUGIN_DATA` 对应一个本地 Node 进程,内部按 **workspace** 分区,不同项目 / 不同 Claude Code 窗口彼此隔离。
- **Worker** —— 每个都是真实的 `codex app-server` 子进程,拥有独立的线程、历史、队列和工作文档。
- **事件** —— Claude 订阅 workspace 作用域的事件流;每个 worker turn 产生一条结构化通知。

编排纪律和协作规范详见 `plugins/codex-team/skills/using-codex-team/philosophy.md`。

## 安装

在 Claude Code 会话里:

```text
/plugin marketplace add krkawzq/cc-codex-team
/plugin install codex-team
/reload-plugins
```

然后确认依赖:

```bash
node --version       # 18+
codex --version
codex login
```

装好后,Claude 可通过 Bash 工具使用 `codex-team` CLI,以及一组 slash 命令。

## 第一个任务,完整一遍

在 Claude Code 会话里:

```
/codex-team:bootstrap reviewer:/abs/path/to/repo fixer:/abs/path/to/repo
```

这会启动 daemon、挂上事件流,并在当前 workspace 创建两个 worker。然后告诉 Claude 你想做什么:

> "让 `reviewer` 审计 auth 模块的风险。让 `fixer` 挑最高风险的问题去修。PR 我来 review。"

Claude 会下发任务、睡觉、等事件醒来、回报进度。

任务结束时:

```
/codex-team:shutdown
```

## 深入了解

插件附带一整套 skill,Claude 会按需加载 —— 你通常不需要亲自读。如果你想:

- 看心智模型 → `plugins/codex-team/skills/using-codex-team/SKILL.md`
- 看协作哲学 → `plugins/codex-team/skills/using-codex-team/philosophy.md`
- 跑一遍交互式教程 → `/codex-team:tutorial`
- 配置 profile / watchdog alarm → `plugins/codex-team/skills/configure-codex-team/SKILL.md`

CLI 本身通过 `codex-team --help` 和每个 slash 命令的 frontmatter 就能查。

## 运行要求

- Claude Code(带 plugin 支持)
- Node.js 18+
- 已安装并登录的 Codex CLI

## 本地开发

```bash
cd plugins/codex-team
npm install
npm run typecheck
npm run build
npm test
```

从当前仓库安装:

```bash
claude plugin marketplace add /abs/path/to/cc-codex-team
claude plugin install codex-team@cc-codex-team
```

或直接指向 plugin 目录:

```bash
claude --plugin-dir /abs/path/to/cc-codex-team/plugins/codex-team
```

改完 TypeScript 记得 rebuild 并 `/reload-plugins`。

## 仓库

https://github.com/krkawzq/cc-codex-team

## License

MIT —— 详见 [LICENSE](LICENSE)
