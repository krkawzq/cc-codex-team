---
description: Branching walkthrough of the codex-team plugin for users new to it. Uses AskUserQuestion to let the user pick a topic; each branch summarizes the relevant SKILL.md (≤150 words per block) rather than restating content.
argument-hint: "[topic]  optional: jump to a branch (what|quickstart|monitor|send|recovery|config|boundaries|workspaces)"
allowed-tools: Bash, AskUserQuestion, Read
---

Run an interactive tutorial. This is a **branching conversation**, not a monologue.

Raw user request:
$ARGUMENTS

## How to run

- One `AskUserQuestion` call per decision point. Never bundle multiple questions.
- At every leaf, offer exactly these three choices: "Dig deeper on …", "Back to main menu", "I'm done".
- Keep each content block ≤150 words.
- **Ground every branch in the authoritative SKILL.md file.** Read it at runtime; do not fabricate. Skills live at `skills/<name>/SKILL.md` in the plugin root.
- On "I'm done" → one-sentence sign-off, stop.

## Entry

If `$ARGUMENTS` names a branch (`what`, `quickstart`, `monitor`, `send`, `recovery`, `config`, `boundaries`, `workspaces`), jump straight there. Otherwise intro:

> This plugin lets Claude (you) manage a team of long-lived Codex worker sessions. Each session is a `codex app-server` subprocess. You drive them through the `codex-team` CLI; per-turn results are pushed back via the `events` Monitor stream. A second stream (`watchdog`) is opt-in for long-horizon work. One daemon is shared across all Claude Code sessions on this plugin, but it is partitioned into **workspaces** so different tasks / windows don't see each other. You are the orchestrator. Codex does the coding.

Then `AskUserQuestion` with exactly these options (order, English names):

- `What is this plugin and why does it exist? (Recommended)` → **A**
- `Walk me through creating my first session` → **B**
- `How does Claude stay in sync with codex workers?` → **C**
- `How do I send instructions and manage sends?` → **D**
- `How do I recover when something breaks?` → **E**
- `Show me the config file and profiles` → **F**
- `What are the rules — things Claude does and doesn't do?` → **G**
- `How do workspaces isolate sessions across Claude Code windows?` → **H**
- `I'm done, thanks` → exit

## Branches (each ≤150 words; read the cited skill at runtime)

| Branch | Title | Source | Summarize |
|---|---|---|---|
| A | What & why | `using-codex-team` | Mental model + why one subprocess per session + why event-driven |
| B | Quickstart | `using-codex-team` §Bootstrap + `manage-codex-team` §Create | `/codex-team:bootstrap` vs manual CLI; first `send` example; workspace auto-derived from project |
| C | Monitor loop | `watch-codex-team` | Events = always arm (via bootstrap); watchdog = opt-in runtime alarm per workspace |
| D | Send patterns | `manage-codex-team` §Send + `philosophy.md` §§6,8 | Non-blocking default; short+pointing style; instruction-file pattern; work-doc discipline |
| E | Recovery | `recover-codex-team` + `philosophy.md` §5 | Escalation ladder + symptom→action table + long-context quirk (re-send, not recovery) + `E_WRONG_WORKSPACE` |
| F | Config & profiles | `configure-codex-team` | Config location + profile example + env overrides + persistent vs runtime alarms |
| G | Interaction boundaries | `using-codex-team` §Invariants + `philosophy.md` | The 10 invariants + collaboration principles |
| H | Workspaces | `using-codex-team` §Workspaces + `/codex-team:workspaces` | Workspace resolution order; default per-project derivation; how to override; `E_WRONG_WORKSPACE` basics |

At each leaf, `AskUserQuestion` with three options:

- `Dig deeper on <one specific sub-topic>` (Recommended)
- `Back to main menu` → re-emit the 9-option question
- `I'm done`

## Fallback

User asks a free-form question instead of picking an option:

- Answer in ≤100 words, sourced from the relevant SKILL.md.
- Re-present the most recent `AskUserQuestion` to put the tutorial back on rails.

## Exit

On "I'm done": one sentence, e.g. *"Great — `using-codex-team` is the entry skill whenever you need the full mental model."* Stop.

## Do not

- Dispatch work to any codex session.
- Modify files or config.
- Run `codex-team send`, `compact`, `restart`, or any state-changing CLI command.
- Present more than ~150 words of prose in a single block — split with a sub-branch question.
- Restate content that's already in a SKILL.md. Summarize and link.
