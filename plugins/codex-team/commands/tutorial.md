---
description: Branching walkthrough of the codex-team plugin. Lets the user pick a topic via AskUserQuestion; each branch summarizes the relevant SKILL.md (≤150 words per block) rather than restating content.
argument-hint: "[topic]  optional: jump to a branch (what|quickstart|events|send|playbooks|recovery|config|boundaries|workspaces)"
allowed-tools: Bash, AskUserQuestion, Read
---

Run an interactive tutorial. This is a **branching conversation**, not a monologue.

Raw user request: $ARGUMENTS

## Rules

- One `AskUserQuestion` per decision point. Never bundle.
- At every leaf: offer exactly `Dig deeper on …` / `Back to main menu` / `I'm done`.
- Each content block ≤150 words.
- **Ground every branch in the authoritative SKILL.md file.** Read at runtime; do not fabricate. Skills live at `skills/<name>/SKILL.md`.
- "I'm done" → one-sentence sign-off. Stop.

## Entry

If `$ARGUMENTS` names a branch (`what`, `quickstart`, `events`, `send`, `playbooks`, `recovery`, `config`, `boundaries`, `workspaces`), jump straight there. Otherwise intro:

> codex-team runs a team of long-lived Codex worker sessions. Claude (you) is the orchestrator; workers do the coding. Each session is a `codex app-server` subprocess driven through the `codex-team` CLI. Results flow back via the `events` Monitor stream. A second stream (`watchdog`) is opt-in for long-horizon work. One daemon is shared across all Claude Code sessions on this plugin but is partitioned into **workspaces** so different tasks and windows don't see each other.

Then `AskUserQuestion` with these options:

- `What is this plugin and why does it exist? (Recommended)` → **A**
- `Walk me through creating my first session` → **B**
- `How does Claude stay in sync with codex workers?` → **C**
- `How do I send instructions and manage sends?` → **D**
- `How do I pick a multi-agent pattern (worker+reviewer, map-reduce, debate, …)?` → **E**
- `How do I recover when something breaks?` → **F**
- `Show me the config file and profiles` → **G**
- `What are the rules — things Claude does and doesn't do?` → **H**
- `How do workspaces isolate sessions across Claude Code windows?` → **I**
- `I'm done, thanks` → exit

## Branches

| Branch | Title | Source | Summarize |
|---|---|---|---|
| A | What & why | `using-codex-team` | Mental model + why one subprocess per session + event-driven loop |
| B | Quickstart | `using-codex-team` §Bootstrap + `manage-codex-team` §Create | `/codex-team:bootstrap` vs manual CLI; first send example; auto-derived workspace |
| C | Events loop | `manage-codex-team` §Arming events + `event-table.md` | Events = always arm; watchdog = opt-in runtime alarm |
| D | Send patterns | `manage-codex-team/send-patterns.md` + `philosophy.md` §§6,8 | Non-blocking default; short+pointing style; instruction-file pattern; work doc |
| E | Playbooks | `codex-team-playbooks` | Decision tree; 9 playbooks; composability; `anti-patterns.md` for "don't do" |
| F | Recovery | `recover-codex-team` + `known-quirks.md` | Escalation ladder + symptom→action + long-context quirk + `E_WRONG_WORKSPACE` |
| G | Config & profiles | `configure-codex-team` | Config location + profile example + env overrides + persistent vs runtime alarms |
| H | Boundaries | `using-codex-team` §Invariants + `philosophy.md` | The 10 invariants + 8 philosophy principles |
| I | Workspaces | `using-codex-team` §Workspaces + `/codex-team:workspaces` | Resolution order; default per-project derivation; override; `E_WRONG_WORKSPACE` |

At each leaf, `AskUserQuestion` with three options:

- `Dig deeper on <one specific sub-topic>` (Recommended)
- `Back to main menu` → re-emit the 9-option question
- `I'm done`

## Fallback

If the user asks a free-form question instead of picking an option:

- Answer in ≤100 words from the relevant SKILL.md.
- Re-present the most recent `AskUserQuestion` to put the tutorial back on rails.

## Exit

One sentence, e.g. "Great — `using-codex-team` is the entry skill whenever you need the full mental model." Stop.

## Do not

- Dispatch to any codex session.
- Modify files or config.
- Run any state-changing CLI command.
- Exceed ~150 words per block — split with a sub-branch.
- Restate content that's already in a SKILL.md. Summarize and link.
