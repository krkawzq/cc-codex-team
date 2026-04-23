---
description: Branching walkthrough of the codex-team plugin. Picks a topic via AskUserQuestion; each branch summarises (≤150 words) the relevant skill file rather than repeating it. Read-only.
argument-hint: "[topic]  optional: jump to a branch (what|quickstart|cli|events|approvals|playbooks|recovery|config)"
allowed-tools: Bash, AskUserQuestion, Read
---

Run an interactive tutorial. This is a **branching conversation**, not a monologue.

Raw user request: $ARGUMENTS

## Rules

- One `AskUserQuestion` per decision point. Never bundle.
- At every leaf: offer `Dig deeper on …` / `Back to main menu` / `I'm done`.
- Each content block ≤150 words.
- **Ground every branch in the authoritative skill file**; read at runtime, don't fabricate.
- "I'm done" → one-sentence sign-off. Stop.

## Entry

If `$ARGUMENTS` names a branch (`what`, `quickstart`, `cli`, `events`, `approvals`, `playbooks`, `recovery`, `config`), jump straight there. Otherwise intro:

> codex-team runs a team of long-lived Codex worker sessions. You (Claude) are the orchestrator; workers do the coding. Each session is a thread coordinated by a single daemon and backed by `codex app-server`; live sessions are isolated by default, while read-only adhoc work may reuse clients. You pick a bearer token (any string), create a user once, then drive sessions with `codex-team -b <token> ...`. Events stream out via `monitor events`; use `--summary --cursor <name>` for orchestration fleets and `message wait` when you're blocked on one turn. Terminal turn outcomes arrive as `turn.completed` with `status: completed | failed | cancelled | interrupted`; readable details come from `message tail` / `message history`.

Then `AskUserQuestion` with:

- `What is this plugin and when should I reach for it? (Recommended)` → **A**
- `Walk me through the first run` → **B**
- `Show me the CLI surface` → **C**
- `How does the event stream work?` → **D**
- `How do I answer approval / ask-user-question user input?` → **E**
- `Multi-agent patterns (worker+reviewer, map-reduce, …)` → **F**
- `What to do when something breaks` → **G**
- `Daemon config & codex profiles` → **H**
- `I'm done, thanks` → exit

## Branches

| Branch | Title | Source |
|---|---|---|
| A | What & why | `skills/using-codex-team/SKILL.md` |
| B | Quickstart | `skills/using-codex-team/quickstart.md` |
| C | CLI surface | `skills/configure-codex-team/cli-reference.md` |
| D | Events | `skills/manage-codex-team/events.md` |
| E | Approvals & user-input | `skills/manage-codex-team/approvals.md` |
| F | Playbooks | `skills/codex-team-playbooks/SKILL.md` |
| G | Recovery | `skills/recover-codex-team/SKILL.md` |
| H | Config & profiles | `skills/configure-codex-team/SKILL.md` |

At each leaf, `AskUserQuestion` with:

- `Dig deeper on <specific sub-topic>` (Recommended)
- `Back to main menu` → re-emit the main question
- `I'm done`

## Fallback

If the user asks a free-form question instead of picking an option:

- Answer in ≤100 words from the relevant skill.
- Re-present the most recent `AskUserQuestion` to put the tutorial back on rails.

## Exit

One sentence, e.g. "Great — `using-codex-team` is the entry skill whenever you need the full mental model." Stop.

## Do not

- Dispatch to any codex session.
- Modify files or config.
- Run any state-changing CLI command.
- Exceed ~150 words per block — split with a sub-branch.
- Restate content already in a skill file. Summarise and link.
