---
name: manage-codex-team
description: Authoritative source for codex-team session lifecycle (create / send / interrupt / close), the send-prompt style (short + pointing at a brief), the instruction-file pattern, the per-session work-doc discipline, and the known long-context prompt-apply quirk. Trigger when starting a session, dispatching work, responding to a `turn-done` / `turn-attn` event, or retiring a session. Not for: arming monitors (`watch-codex-team`), failure triage (`recover-codex-team`), compaction (`compact-codex-team`).
---

# Manage codex-team sessions

The main workflow skill. Everything you do *to* a session happens through `codex-team` CLI in Bash.

Prerequisites:

- You've internalized the collaboration philosophy. → `using-codex-team` + `philosophy.md`
- You know which workspace you're in. Usually auto-derived; verify with `codex-team workspace show` if unsure. → `using-codex-team` §Workspaces
- The `events` Monitor stream is armed. → `watch-codex-team`

**Every CLI call in this skill operates in your current workspace** unless you pass `--workspace <name>`. Sessions in other workspaces are invisible by default and destructive operations across them are rejected with `E_WRONG_WORKSPACE`.

## Session lifecycle

```
  (nothing)
     │
     │  codex-team session create <name> --cwd <path> [--profile X]
     ▼
   idle ◄────────────────── turn/completed
     │                          ▲
     │  codex-team send ...     │
     ▼                          │
   running ────────────── codex finishes
     │                          │
     │  codex-team interrupt    │
     └──────────────────────────┘
     │
     │  codex-team session close <name>
     ▼
   closed  (thread preserved; can session resume <name>)
```

Recovery states `errored` / `compacting` are handled by `recover-codex-team` and `compact-codex-team`.

## Create

```bash
codex-team session create <name> \
    --cwd <absolute-path> \
    --profile <profile-name>
```

Facts:

- Session names are **unique within a workspace**, not globally. Two workspaces can both have a session called `reviewer`.
- Pick names that describe the worker's scope (role, module, dimension of the chunking you chose).
- Each session spawns its own `codex app-server` subprocess. Four sessions = four subprocesses. Intentional.
- `session create` blocks until the thread is readable. No protective sleep needed before the first `send`.
- `--cwd` is Codex's working directory — typically a git worktree you created beforehand.
- `--profile <name>` pulls defaults from `[profiles.<name>]`. Prefer profiles over long flag lists.
- Sandbox defaults to `danger_full_access`, approval to `never`. Workers edit and run commands without asking — intentional (see `using-codex-team` §Invariants #6).

## Send (the main loop)

```bash
codex-team send <name> "<prompt>"
```

**Default is non-blocking.** Returns as soon as the turn is queued/started. The outcome arrives through the `events` Monitor stream (filtered to your workspace), not stdout. `turn-start` maps the returned `pending-*` id to the real `turn_id`.

### Send-prompt style

Two rules:

1. **Short and pointing.** A send is a dispatch, not a specification. It names the target, the entry point (work doc or brief file), and the expected deliverable — nothing more.
2. **Concrete direction.** The send or the brief it points at must name the target, constraint, reference, and deliverable. "Strong" ≠ "long". → `philosophy.md` §6

Weak send (vague, over-describes):

```
codex-team send W "You are working on the refactor. Your job is to convert
the old pattern to the new pattern across all affected files. Make sure to
update tests. Please be careful about edge cases."
```

Strong send (short, pointing at work doc):

```
codex-team send W "continue: read <work-doc-path>, tackle the top Next up item, update Progress/Findings/Next up when done; reply 'done' with a one-line summary"
```

Answering a question returned by `turn-attn`: the answer goes in the next send verbatim, no framing:

```
codex-team send W "relax the tolerance to 1e-5; re-enable fastmath and re-run the two failing tests"
```

### Instruction-file pattern (for anything longer than a paragraph)

If the direction takes more than a paragraph, **write a brief file in the repo and reference its path.** Do not embed it in the send.

Brief file shape (the user picks the path; you stick with it):

```markdown
# Task brief: <short title>

## Objective
<what and why>

## Scope
- In scope: …
- Out of scope: …

## Approach
<your design call, if any>

## Success criteria
<tests, benchmarks, work-doc updates, etc.>

## Reference
<files, prior decisions, similar patterns>
```

Corresponding send:

```bash
codex-team send W "execute the tasks in <path-to-brief>; update the work doc when done; reply 'done' with a one-line summary"
```

Why: sends stay clean, briefs are revisable without re-dispatching, multiple workers can share a spec, and the user can review the brief *before* you send. See `philosophy.md` §§6,8.

### Work-doc discipline

Every session owns **one durable Markdown work doc** in the repo. The user picks the path at session creation; you stick with it. Every send references it.

Shape (adapt section names to the session's nature):

```markdown
## Current task
## Progress (newest on top)
## Findings & decisions
## Open questions / blockers
## Next up
```

If the doc doesn't exist yet, your opening send should instruct the worker to create it at the agreed path.

See `philosophy.md` §7 and `compact-codex-team` for details.

### Prompt sources: `--stdin` and `--prompt-file`

For a multi-line send that doesn't warrant a brief file in the repo (one-off, throwaway):

```bash
codex-team send W --stdin <<'EOF'
…
EOF

codex-team send W --prompt-file /tmp/one-off.md
```

Use sparingly. Anything reusable belongs in the repo, not `/tmp`.

### `--wait` (almost never)

`--wait` blocks the CLI until `turn/completed` arrives. Wastes your context window and serializes work. Use only when:

- Interactively debugging a single session (REPL feel).
- A script genuinely needs the turn result inline.

For the normal orchestration loop: **send, then sleep.**

### Per-turn overrides

```bash
codex-team send <name> "<prompt>" \
    --model <model> \
    --cwd /some/other/path \
    --effort high \
    --personality concise \
    --summary detailed \
    --output-schema-file X.json
```

Do not override lightly. Session defaults exist for a reason. Per-turn only; with cause.

## Queue behaviour

Sends while a session is `running` **queue** — they do not reject. Per-session queue, max 5 by default.

- Pipeline: `send A "step 1"`, then `send A "step 2"` — they run sequentially.
- Inspect: `codex-team queue show <name>`.
- On overflow: default policy `warn` still enqueues + emits `queue-overflow`. Change to `reject` in config for hard failure.

## Interrupt

```bash
codex-team interrupt <name>
```

Cancels the current turn at the next safe point. Turn emits `turn-done` with partial state or `errored`. Queue continues.

Use when:

- Worker is looping on non-productive reasoning.
- You need to redirect after partial results.
- A long turn has produced the valuable output and is now polishing.

## Close

```bash
codex-team session close <name>
```

Stops the subprocess, marks session `closed`, **preserves the thread**. `codex-team session resume <name>` re-attaches a fresh subprocess.

For permanent removal: `codex-team session forget <name>`. → `recover-codex-team` covers when to escalate.

## Decision on every Monitor wake

Every event payload carries a `workspace` field. If it doesn't match yours, ignore the event (the Monitor's scoping should prevent this, but defense-in-depth never hurts).

| Event | Decide |
|---|---|
| `turn-done` (normal) | Read summary → pick next prompt → one `send` → sleep |
| `turn-attn` with question | Answer verbatim in next `send` → sleep |
| `turn-attn` with failure (command / test) | Fix the input, re-dispatch |
| `turn-done` but reply doesn't match the prompt | **Known quirk** — see below — re-send same prompt |
| `compact-suggest` | → `compact-codex-team` ritual |
| `session-down` / `turn-err` / `auto-heal` | → `recover-codex-team` |

## Known quirks

### Long-context prompt-apply skip (not a recovery case)

After many turns in a single thread, a worker occasionally returns a reply that **doesn't match the prompt you just sent** — the content looks like it came from an earlier turn's context. Signs:

- Reply talks about a file you didn't reference.
- Reply answers a question you didn't ask.
- Reply continues old work verbatim instead of acting on the new send.

**Response:** re-send the exact same prompt, unchanged.

**Do not:**

- Climb the escalation ladder. This is not a failure — no `interrupt` / `restart` / `kill`.
- Rephrase the prompt. That introduces new ambiguity.
- Assume the session is confused and needs a reset.

One re-send typically resolves it. Two consecutive re-sends with the same bad behavior = genuine problem → `recover-codex-team`.

See `philosophy.md` §5 for why this happens.

## Red flags

| Thought | Correction |
|---|---|
| "I'll use `--wait` to keep things simple." | Default async. Keep the Monitor loop. |
| "Let me stuff the full task description into the send." | Point at a brief file instead. → §Instruction-file pattern |
| "I'll figure out the approach myself, then tell Codex what to type." | Over-specified. Name the target + constraint + reference; let the worker execute. → `philosophy.md` §3 |
| "I'll just write this small fix inline — faster than sending." | You're the orchestrator. Delegate. → `philosophy.md` §1 |
| "Session is slow — switch to `--effort minimal`." | Do not override effort casually. Per-turn only, with cause. |
| "5 minutes running — something must be wrong." | Turns can take minutes. Wait for `turn-done` or `turn-stuck` heartbeat. |
| "Worker's reply doesn't match my prompt — must be broken." | Long-context skip? Re-send once. → §Known quirks |
| "I'll send a new prompt to cancel the current turn." | Sends queue. Use `codex-team interrupt`. |
| "Worker is disagreeing — let me override and force the plan." | Read the pushback seriously. They often see the code better. → `philosophy.md` §4 |
| "This session name collides with one I saw before — use a number suffix." | Session names are per-workspace unique, not globally. Same name in a different workspace is fine. |
| "`E_WRONG_WORKSPACE` — the daemon is broken." | A session with that name exists in another workspace. Check `/codex-team:workspaces`; either switch workspace or pick a different name. |

## Cross-references

- Collaboration principles: `using-codex-team` → `philosophy.md`
- Prerequisites: `watch-codex-team` (events stream)
- After `turn-done` needing deeper review: `inspect-codex-team`
- On `compact-suggest`: `compact-codex-team`
- On `session-down` / `turn-err` / wrong-workspace: `recover-codex-team`
