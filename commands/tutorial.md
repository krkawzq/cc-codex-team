---
description: Interactive, branching walkthrough of the cc-codex-team plugin — uses AskUserQuestion to let the user pick topics and dives deep on the ones they want. Covers architecture, quickstart, monitors, send patterns, recovery, config, and interaction boundaries.
argument-hint: "[topic-shortcut]  optional: jump straight to a section (what|quickstart|monitor|send|recovery|config|boundaries)"
allowed-tools: Bash, AskUserQuestion
---

Run an interactive tutorial for this plugin. This is a **branching
conversation**, not a monologue: you (Claude) present a short block of
content, then use `AskUserQuestion` to let the user choose what to
explore next. Keep every explanation concise (≤150 words per block)
and always refer the user to the authoritative skill for deeper
reading.

Raw user request:
$ARGUMENTS

## How to run this tutorial

- One AskUserQuestion call per decision point. Never bundle multiple
  questions.
- At each leaf, ALWAYS offer three choices: *"Dig deeper on …"*,
  *"Back to main menu"*, *"I'm done"*.
- Keep the first ("Recommended") option the one the user most likely
  wants given the current context.
- When a branch quotes facts about the plugin, ground the explanation
  in the existing skill files (`skills/*/SKILL.md`) — read them at
  runtime if unsure, do not fabricate.
- When the user chooses "I'm done," say a brief sign-off (one
  sentence) and do not ask anything further.

## Entry step

If `$ARGUMENTS` names a section (`what`, `quickstart`, `monitor`,
`send`, `recovery`, `config`, `boundaries`), **skip straight to that
branch**. Otherwise, start with the intro.

### Intro (default)

Print this to the user, then ask the main-menu question:

```
This plugin lets Claude (you) manage a team of long-lived Codex worker
sessions. Each session is a real `codex app-server` subprocess;
Claude drives them through the `codex-team` CLI and gets per-turn
results pushed back through two auto-started plugin monitors.

You are the orchestrator. Codex does the coding. You schedule, audit,
and merge.
```

Then call `AskUserQuestion` with **exactly these choices** (keep
names in English; preserve order):

- `What is this plugin and why does it exist? (Recommended)` →
  go to **A. What & why**
- `Walk me through creating my first session` →
  go to **B. Quickstart**
- `How does Claude stay in sync with codex workers?` →
  go to **C. Monitor loop**
- `How do I send instructions and manage sends?` →
  go to **D. Send patterns**
- `How do I recover when something breaks?` →
  go to **E. Recovery**
- `Show me the config file and profiles` →
  go to **F. Config & profiles**
- `What are the rules — things Claude does and doesn't do?` →
  go to **G. Interaction boundaries**
- `I'm done, thanks` → exit politely

---

## Branch A — What & why

Explain, in this order:

1. The plugin's one-job: long-lived codex sessions that Claude can
   command asynchronously.
2. The mental model (pull from `using-codex-team` §mental model):
   Claude → CLI → daemon → N app-server subprocesses; and
   notifications flow back via plugin monitors.
3. Why one subprocess per session (SDK single-turn-consumer
   constraint; concurrent work needs multiple clients).
4. Why event-driven (Claude sleeps instead of polling — saves context
   and achieves real parallelism).

Then `AskUserQuestion`:

- `Why one subprocess per session? (Recommended)` → explain the SDK's
  `acquire_turn_consumer` lock and why the workaround is one client
  per session.
- `Why event-driven instead of polling?` → explain Claude's context
  cost, Monitor tool integration, parallelism benefit.
- `Back to main menu` → re-present the main-menu question.
- `I'm done` → exit.

Sub-branches end with the same three-option AskUserQuestion.

---

## Branch B — Quickstart

Walk through:

```bash
# Option 1: one-shot via the command
/cc-codex-team:bootstrap L-kernels:/path/to/worktree

# Option 2: manually
codex-team daemon start
codex-team session create L-kernels \
    --cwd /path/to/worktree \
    --profile refactor
codex-team send L-kernels "read docs/refactor/L-kernels/progress.md Next up, tackle top item, update Progress/Findings/Next up when done"
```

Explain:

- The `--profile refactor` loads defaults from `[profiles.refactor]`
  in `config.toml` (point at Branch F).
- `send` is non-blocking — it returns as soon as the turn is queued.
- Results arrive via the auto-started monitors, not via the CLI's
  stdout.

`AskUserQuestion`:

- `Explain the profile system (Recommended)` → go to Branch F-lite
  (profile design patterns), then end with the standard three-option.
- `Show me the send-prompt style` → go to Branch D.
- `Back to main menu` → re-present main menu.
- `I'm done` → exit.

---

## Branch C — Monitor loop

Key points to cover (see `watch-codex-team` for full content):

1. `monitors/monitors.json` declares two streams:
   `codex-team-events` and `codex-team-watchdog`.
2. Claude Code **auto-starts** them when the plugin activates. The
   user does not call the `Monitor` tool.
3. `events` is reactive (turn completions, errors, `compact-suggest`,
   `session-down`, `auto-heal`).
4. `watchdog` emits every ~20 minutes with an aggregated health
   snapshot and optional task brief.
5. If you haven't received any notification for >25 minutes,
   something is wrong — see Branch E.

`AskUserQuestion`:

- `Show me what a turn-done payload looks like (Recommended)` → quote
  the JSON sketch from `watch-codex-team`, explain the `tier` field.
- `How do I debug a silent stream?` → walk through `/plugin list`,
  `/reload-plugins`, `codex-team daemon status`.
- `Back to main menu`
- `I'm done`

---

## Branch D — Send patterns

Cover:

1. Default non-blocking; `--wait` rarely used.
2. Good vs bad send style (from `manage-codex-team` §send-prompt
   style) — short + by-reference beats long + self-contained.
3. Queue behaviour: sends during `running` are queued, not rejected.
4. Per-turn overrides: `--model`, `--effort`, `--cwd`, etc.

Show one good-send example and one bad-send example.

`AskUserQuestion`:

- `Explain the compaction ritual (Recommended)` → walk through the
  2-step ritual from `compact-codex-team`. Emphasize: do NOT combine
  steps.
- `Show me per-turn overrides` → list the override flags and when to
  use each (rarely).
- `Back to main menu`
- `I'm done`

---

## Branch E — Recovery

Show the symptom → action table (abridged from `recover-codex-team`):

| Symptom | First try |
|---|---|
| `session-down` without `auto-heal` for 10s+ | `codex-team session restart` |
| `turn-err` recoverable=yes | `codex-team send <retry>` |
| `turn-stuck` | `codex-team interrupt` |
| zombie subprocess | `codex-team session kill` |
| daemon unreachable | `codex-team daemon stop && codex-team daemon start` |

Explain the escalation ladder: `interrupt` → `restart` → `kill` →
`forget + create`. Never skip rungs.

`AskUserQuestion`:

- `What if a session's state is completely broken? (Recommended)` →
  walk through `session forget` + recreate + send
  "restore from progress.md" as first message.
- `How do I fix the daemon when it's unreachable?` → show
  `daemon status` → `daemon stop` → `daemon start`. Monitors
  auto-reconnect.
- `Back to main menu`
- `I'm done`

---

## Branch F — Config & profiles

Open with the location: `~/.config/codex-team/config.toml`. Show a
minimal profile example from `configure-codex-team`:

```toml
[profiles.reviewer]
reasoning_effort = "high"
developer_instructions = """
You review code for security, correctness, and style. Never write
production code.
"""
```

Explain:

1. Profiles layer over `[defaults]`.
2. `developer_instructions` pins role / refusal boundaries.
3. Scalar keys can be overridden at runtime via
   `CODEX_TEAM_<SECTION>_<KEY>` env vars (for tests).

`AskUserQuestion`:

- `Walk me through building a custom profile (Recommended)` → use the
  profile design checklist from `configure-codex-team`: role
  boundary → model tier → sandbox → approval → cwd.
- `Show me all tunable knobs` → summarize the "when to tune which
  knob" table from `configure-codex-team`; point at the skill for
  the full schema.
- `Back to main menu`
- `I'm done`

---

## Branch G — Interaction boundaries

Cover, verbatim-equivalent to `using-codex-team` §invariants:

1. **One send, then sleep.** No polling.
2. **Git belongs to Claude, not Codex.** Codex sessions must not run
   any `git` command.
3. **Per-session progress file.** Each session owns a Markdown
   progress file; sends reference it instead of re-describing the
   task.
4. **Compaction is manager-driven.** Never call `codex-team compact`
   directly; run the two-step ritual.
5. **YOLO execution.** Sandbox defaults to `danger_full_access` and
   approval to `never` — full write, no interactive approvals. This
   is intentional; do not "fix" it unless a profile explicitly asks
   for a narrower sandbox.

`AskUserQuestion`:

- `Explain the YOLO default in more detail (Recommended)` → why full
  write works here (event-driven loop can't handle approvals, sandbox
  narrowing happens per-profile).
- `Why is git off-limits to Codex?` → merge hygiene + undo story +
  who is the source of truth for branch layout.
- `Back to main menu`
- `I'm done`

---

## Generic leaf template

Any deep-dive that ends without further sub-branches wraps with:

```
AskUserQuestion:
  - Dig deeper on [current topic]? → offer one specific sub-topic you know would be useful
  - Back to main menu → re-emit the 8-option main question
  - I'm done → exit politely
```

## Exit

When the user picks "I'm done," respond with one short sentence (e.g.
*"Great — see `using-codex-team` for the full mental model whenever
you need it."*) and stop. Do not ask anything else.

## Fallback behavior

If the user asks a free-form question instead of choosing from the
AskUserQuestion options, answer briefly (≤100 words) using the
relevant skill as your source, then re-present the most recent
AskUserQuestion to put the tutorial back on rails.

## Do not

- Do not dispatch work to any codex session during the tutorial.
- Do not modify files or config.
- Do not run `codex-team send`, `compact`, `restart`, or any
  destructive CLI command.
- Do not present more than ~150 words of prose in a single block; if
  a topic is longer, split it by asking for a sub-branch choice.
