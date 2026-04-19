# Send patterns

Reference for `manage-codex-team`. How to deliver a prompt to a Codex worker, what a good prompt looks like, and the quoting traps that eat agents alive.

Two independent axes:

1. **Shape** — what the prompt says (short+pointing, concrete direction).
2. **Transport** — how it reaches the CLI (inline string, `--prompt-file`, repo brief).

Pick shape based on intent; pick transport based on content. They are orthogonal.

---

## 1 · Shape (what the prompt says)

Two rules, both from `philosophy.md`:

1. **Short and pointing** (§6 concrete direction). A send is a dispatch, not a specification. It names the target, the entry point (work doc or brief file), and the expected deliverable — nothing more.
2. **Long instructions go in Markdown files** (§8). If the direction takes more than a paragraph, write a brief file and point at it.

### Weak send

```
codex-team send W "You are working on the refactor. Your job is to convert
the old pattern to the new pattern across all affected files. Make sure to
update tests. Please be careful about edge cases."
```

Why it's weak: no named target, no reference path, no deliverable, no work-doc mention. Everything is instruction-by-adjective.

### Strong send (pointing at a work doc)

```
codex-team send W "continue: read <work-doc-path>, tackle the top Next up item, update Progress/Findings/Next up when done; reply 'done' with a one-line summary"
```

### Strong send (pointing at a brief)

```
codex-team send W "execute the tasks in <path-to-brief>; update the work doc <path-to-work-doc> when done; reply 'done' with a one-line summary"
```

### Answering a `turn-attn` question

The answer is the send. No framing, no restatement:

```
codex-team send W "relax the tolerance to 1e-5; re-enable fastmath and re-run the two failing tests"
```

### What a strong send names (§6)

- **Named target.** Which files, which functions, which tests.
- **Named constraint.** Preserve this API. Don't touch that module. Match this style.
- **Named reference.** Read `<path>` first. Follow the pattern in `<other path>`.
- **Named deliverable.** Append to the work doc. Add a test. Leave output in `<path>`.

"Strong" ≠ "long". Four named things in one sentence beat a paragraph of adjectives.

---

## 2 · Transport (how you deliver it)

### Decision table

| Prompt shape | Method | Use when |
|---|---|---|
| Short, single line, no shell metacharacters | **Inline** — direct quoted string | `codex-team send W "continue: read <work-doc>, ..."` |
| Multi-line, or contains any of `"` `` ` `` `$` `!` `\` newline | **Temp prompt file** via `--prompt-file` | See §2.2 |
| Reusable spec, multi-worker, revision-worth | **Repo brief file**, referenced by a short inline send | See §2.3 |

**Rule of thumb: if you're about to escape a quote or backtick, stop and use a file.** The terminal is a minefield of `"`, `` ` ``, `$VAR`, `!`, backslash-escape rules, and heredoc indentation bugs. One mis-escape and you either (a) send garbage to Codex, (b) execute arbitrary shell, or (c) silently truncate.

### 2.1 Inline

```bash
codex-team send W "continue: read <work-doc>, tackle the top Next up item, update Progress/Findings/Next up when done; reply 'done' with a one-line summary"
```

Safe because: no inner `"`, no `` ` ``, no `$`, no `!`, no newline. The single quotes around `done` are fine inside double-quoted Bash.

### 2.2 Temp prompt file

```bash
# 1. Write prompt to a temp file (use the Write tool; do not heredoc in Bash).
#    Path is absolute and uniquely named.
# 2. Send, pointing at the file.
codex-team send W --prompt-file /tmp/codex-send-<iso-ts>.md
```

Conventions:

- `/tmp/` on Unix; `%TEMP%` on Windows. Unique filename to avoid collisions with parallel sends.
- These are throwaway. **Do not reuse** the same temp path for two different sends — delete or pick a new name.
- Anything the user should be able to review *before* dispatch, or that multiple workers will consume, goes in the **repo** (§2.3), not `/tmp`.

**Why not heredoc?** `codex-team send W --stdin <<'EOF' ... EOF` works, but (a) multi-line Bash is harder to review and log, (b) any agent running this loses the ability to see the exact content it sent, (c) file delivery is uniform with the repo-brief pattern. Prefer `--prompt-file` for anything longer than one line.

### 2.3 Repo brief file (instruction-file pattern)

For anything longer than a paragraph, write a brief file in the repo and reference its path. Do not embed it in the send.

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

Why use a brief file:

- Sends stay clean — easy to skim in history, easy to cite in a bug report.
- Briefs are revisable without re-dispatching (the worker re-reads on the next relevant send).
- Multiple workers can share the same brief (see `codex-team-playbooks/map-reduce.md`).
- The user can review the brief *before* you send.

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

Do not override lightly. Session defaults exist for a reason (see `configure-codex-team/profiles.md`). Per-turn only; with cause.

### `--wait` (almost never)

`--wait` blocks the CLI until `turn/completed`. Wastes your context window and serializes work. Use only when (a) you're interactively debugging a single session, or (b) a script genuinely needs the turn result inline.

For the normal orchestration loop: **send, then sleep.**

---

## 3 · Playbook-specific send shapes

Each playbook in `codex-team-playbooks/` lists its own send templates for each role and each iteration step. When a playbook is in use, follow its templates instead of improvising. The shape and transport rules above still apply; the playbook just fills in the *content*.

---

## 4 · Red flags

| Thought | Correction |
|---|---|
| "Let me escape these quotes and backticks in the inline send." | Stop. `--prompt-file`. Escaping is the wrong fix. |
| "I'll heredoc the multi-line prompt inline in Bash." | Prefer `--prompt-file`. |
| "This one-off prompt is 20 lines but I'll paste it anyway." | 20 lines goes in a temp file, not in the Bash command. |
| "I'll re-describe the task in every send." | Point at the work doc. → `work-doc.md`. |
| "Let me stuff the full task description into the send." | Write a brief file. → §2.3. |
| "Session is slow — switch to `--effort minimal`." | Do not override effort casually. Per-turn only, with cause. → `configure-codex-team/codex-tricks.md`. |
| "Same `/tmp/codex-send.md` path for multiple sends" | Unique filename per send; don't collide. |
