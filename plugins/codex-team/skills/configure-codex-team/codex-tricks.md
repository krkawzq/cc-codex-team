# Codex tricks & tuning

Reference for `configure-codex-team`. Behavioural tips, cost/quality trade-offs, and sandbox edges for Codex workers under codex-team. Opinionated; grounded in observed patterns. When you disagree with a guideline, do the thing anyway and tell the user so they can update the skill.

---

## 1 · Model selection

Session-level: `[defaults].model` or `[profiles.<name>].model`. Per-turn: `codex-team send ... --model <name>`.

| Model | Character | Use when | Avoid when |
|---|---|---|---|
| `gpt-5.4` | Capable, slower, more expensive | Reviewer, critic, long-horizon refactor, debug on unfamiliar code | Small well-scoped tasks where the time-cost isn't worth it |
| `gpt-5.4-mini` | Fast, cheap, less strategic | Quickfix, scratch, summarising, simple tests, boilerplate conversion | Anything that needs cross-file reasoning or deep planning |

**Rule of thumb.** Default the main worker to `gpt-5.4`. Default scratch / quickfix / "do 40 of these in parallel" to `gpt-5.4-mini`. Never use `mini` as the reviewer — reviewers need to *find* bugs, and that's exactly where `gpt-5.4` earns its cost.

## 2 · `reasoning_effort`

Controls how many internal reasoning tokens the model burns before producing output. Four levels: `minimal` / `low` / `medium` / `high`.

| Effort | What it does | Send to it |
|---|---|---|
| `minimal` | Skip the reasoning phase almost entirely | Pure formatting tasks, tiny bugfixes where you've told it exactly what to change |
| `low` | Short reasoning, fast output | Targeted implementation with a clear spec; mechanical refactors |
| `medium` (default) | Balanced | 90% of worker sends |
| `high` | Extended reasoning | Debugging across files; architecture review; tricky correctness questions where a wrong answer is expensive |

**Don't crank to `high` reflexively.** On a well-specified task, `high` burns 2-3× the tokens and 10× the wall-clock for marginal improvement. Codex reviewers benefit from `high`; code *executors* rarely do if the brief is tight.

**When to drop to `low` mid-session.** If a worker is repeating the same investigation over and over, it's over-thinking. One-off per-turn override:

```bash
codex-team send W "<prompt>" --effort low
```

Profile-level change is a bigger commitment; prefer the override first.

## 3 · `personality`

Shapes the tone/length of replies. Common values: `default`, `concise`.

| Personality | Effect | Use when |
|---|---|---|
| `default` | Full narration, explains reasoning | Debugging, review, exploratory work — you want the "why" |
| `concise` | Short replies, minimal narration | Workers that run dozens of turns; critics that flag issues terse-style |

Watch the trade-off: `concise` workers produce less useful `history.md` and `final_message` content. You'll read the work doc more and the turn summaries less. For a critic or a repeat-executor, that's fine. For a debugger you're trying to understand, it isn't.

## 4 · `summary`

Controls the `final_message` distillation Codex produces at the end of a turn. Values: `auto` (default), `concise`, `detailed`.

- `auto` — usually right. Let Codex decide.
- `concise` — when you don't read the `final_message` carefully (e.g. mass-parallel workers whose output only gets aggregated).
- `detailed` — when you want the `final_message` itself to serve as your merge notes.

If you find yourself reading `history.md --last-n 1` after every `turn-done` because the summary was too thin, switch to `detailed` for that session.

## 5 · Sandbox and approval

`sandbox = "danger_full_access"`, `approval_policy = "never"` — intentional. The worker can read, write, execute shell commands without asking. This is what makes the async loop work: if the worker stopped to ask "may I `pip install X`?" on every sub-step, you'd be awake on every turn.

**What workers may do.** Anything their unix user can. Read/write files anywhere inside `--cwd` (and outside, if they walk paths). Run compilers, linters, tests, curl, git (except commit/push — see below).

**What workers must not do** (enforce via profile `developer_instructions`):

- `git commit | merge | push | branch | tag` — version control is yours. A worker running these destroys the invariant from `using-codex-team` §Invariants #2.
- `rm -rf` outside `--cwd`.
- Modify files outside the repo unless the brief names them.
- `docker push` / other distribution actions.

If a user explicitly asks for a safer sandbox, build a named profile (e.g. `sandbox-gated`) with `approval_policy = "on-request"` and use only on that specific session.

## 6 · `service_tier` and rate limits

Codex honors `service_tier` if the account has multiple. For a fleet of workers, leaving tier empty and letting OpenAI pick is usually fine. If you see `rate_limit_exceeded` turn errors in `turn-err`, check the tier and consider lowering worker concurrency rather than escalating the tier.

## 7 · Worker development instructions (`developer_instructions`)

Profile-level instructions that prepend every turn. Use for **persistent discipline**, not task content (task content goes in the brief or the work doc).

Good developer_instructions:

- "Update the work doc every turn. Current task + Next up rewritten; Progress / Findings / Open questions appended."
- "Do not run `git commit | merge | push | branch | tag`. Claude owns version control."
- "When proposing a diff, include line refs (`file:N`). When disagreeing with the brief, say so explicitly before acting."

Bad developer_instructions:

- Task-specific goals ("fix the auth bug" — belongs in the brief).
- Step-by-step procedures ("first read X, then do Y" — belongs in the brief or work doc).
- Vague tone ("be careful" — means nothing).

## 8 · Long threads & compaction timing

Codex threads degrade after several hundred k tokens — see `recover-codex-team/known-quirks.md` on the long-context prompt-apply skip.

**Proactive compaction.** If you see the worker start to produce mismatched replies more than once in a session, compact early even if `compact-suggest` hasn't fired. Set `[compaction].threshold_tokens` lower for sessions you know will run long.

**After compaction.** The internal summary Codex carries is approximate. If the next turn needs specifics, point at the work doc. Do not assume the post-compact thread remembers pre-compact file state.

## 9 · Parallelism limits

There's no hard cap on worker count, but:

- Each session is a `codex app-server` subprocess (~memory per session).
- Each session talks to OpenAI over its own thread; rate limits apply globally.
- Each session competes for your attention (you're still the serial manager).

**Sweet spot.** 2-6 active workers. Past 6, the orchestration overhead usually outgrows the parallelism benefit for a single human-in-the-loop. If you need 20+ parallel runs, consider a non-interactive script rather than the codex-team loop.

## 10 · Prompt-shape tips specific to Codex

- Codex parses Markdown well. Use headings in briefs (`## Scope`, `## Success criteria`) — it doesn't need bullet-numbered prose.
- Fenced code blocks in briefs are treated as read-only examples; Codex rarely rewrites what's fenced unless told to.
- Asking for a specific reply phrase (e.g. "reply 'done' when finished") is reliable — Codex honours final-message contracts. Useful for compaction Step 1 readiness detection (`compaction-ritual.md` §Recognising readiness).
- `## Reference` sections in briefs should list absolute paths. Codex follows them literally.
- Paths matter: Codex is good with absolute paths, wobbly with relative paths across nested directories. When in doubt, absolutize.

## 11 · Cost control checklist

- `gpt-5.4-mini` for parallel fan-out; `gpt-5.4` for the strategic roles.
- `medium` effort by default; `high` only for diagnosis/review; `low` for mechanical work.
- Compact at threshold — long threads reason worse *and* cost more.
- Close idle sessions (`codex-team session close <name>`) — a closed session's thread is preserved and costs nothing.
- Avoid `--wait` — it doesn't cost Codex tokens, but it costs your context window.

## Red flags

| Thought | Correction |
|---|---|
| "Higher effort → better output, always." | No. For well-specified tasks, `medium` is the sweet spot; `high` wastes. |
| "`gpt-5.4-mini` is fine for the reviewer." | No. Reviewers must find bugs; that's where model quality matters most. |
| "Let me narrow the sandbox by default." | `danger_full_access` + `never` approval is the async-loop requirement. Narrow only on explicit user request. |
| "I'll put the whole task in `developer_instructions`." | No. Profile instructions = persistent discipline. Task content = brief + work doc. |
| "Turn is slow, bump effort to high." | Opposite. Slow turns often mean over-thinking. Try `low` first. |
| "I'll run 20 parallel workers." | Past ~6 the orchestration overhead usually exceeds the parallel benefit for a single human manager. |
