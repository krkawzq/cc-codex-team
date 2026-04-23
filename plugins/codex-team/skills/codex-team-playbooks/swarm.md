# Swarm (dynamic handoff)

## Adoption signal

- Many loosely-related tasks; who does what isn't fixed upfront
- Workers are interchangeable-ish but pick up work opportunistically
- You want forward progress on *something* even if some tasks block
- Typical: exploratory codebase work ("go find interesting things"), spike clusters, refactor hunts, tech-debt sweeps

Not a good fit when tasks have dependencies (use `pipeline` / `hierarchical`) or when workers have distinct roles (use `worker-reviewer`).

## Team

N sessions (3–6 is the usual range). Each has a broad role:

| Session prefix | Role | Profile |
|---|---|---|
| `explorer-<i>` | Read-only investigation | `explorer` (read-only, medium) |
| `hunter-<i>` | Read-only with diff-proposal ability | `planner` (read-only, xhigh) |
| `fixer-<i>` | Write-enabled for small fixes | `fixer` (workspace-write, on-request) |

Mix profiles based on task type. Don't mix write-capable and read-only under the same prefix — keeps mental model clean.

## Shared artefacts

- `.codex-team/brief.md` — the top-level goal
- `.codex-team/backlog.md` — task pool (Claude appends; workers pull)
- `.codex-team/claimed/<task-id>` — empty marker file with session name as content (workers write on claim)
- `.codex-team/done/<task-id>.md` — worker output on completion
- `.codex-team/skipped/<task-id>.md` — worker couldn't do it, with reason

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null
codex-team -b $TOK cursor save swarm-tail

cd /repo
mkdir -p .codex-team/claimed .codex-team/done .codex-team/skipped
echo "$BRIEF" > .codex-team/brief.md

# Seed the backlog — one line per task, format: <task-id>: <one-line description>
cat > .codex-team/backlog.md <<'EOF'
auth-review: Review src/auth.ts for race conditions
billing-tests: Find un-tested branches in src/billing/*
prom-regex: Audit src/logging.ts regex perf
migrate-to-tsx: Convert top-level .ts files in src/legacy/ to .tsx
...
EOF

N=4
for i in $(seq 0 $((N-1))); do
  # explorer profile (see configure-codex-team/profiles-library.md)
  codex-team -b $TOK session new "explorer-$i" --cwd "$(pwd)" \
    --model gpt-5.4-mini --sandbox read-only --approval never --effort medium
done
codex-team -b $TOK monitor events --stream --summary --cursor swarm-tail
```

### Main worker loop (each session gets this brief)

```bash
CLAIM_SCRIPT='
# Atomically claim the first unclaimed task.
# Returns the task id on stdout or exits 1 if nothing to claim.
for line in $(grep -v "^$" .codex-team/backlog.md); do
  tid=$(echo "$line" | cut -d: -f1)
  if ( set -o noclobber; echo "$SESSION_NAME" > ".codex-team/claimed/$tid" ) 2>/dev/null; then
    echo "$tid"
    exit 0
  fi
done
exit 1
'

for i in $(seq 0 $((N-1))); do
  SESSION="explorer-$i"
  codex-team -b $TOK message send "$SESSION" "
    Your job: claim tasks from .codex-team/backlog.md, do them, report.

    Loop:
      1. Claim a task with this script:
         $CLAIM_SCRIPT
         (use your session name: $SESSION)
      2. If nothing to claim, stop and say 'no more tasks'.
      3. Find the task's full description in backlog.md (line starting with <task-id>:).
      4. Do the task. Write output to .codex-team/done/<task-id>.md.
         If you can't complete, write .codex-team/skipped/<task-id>.md with the reason.
      5. Go back to step 1.

    Keep each task's output concise — ≤300 words. Include file:line references.
  "
done
```

All N workers run concurrently. Each pulls from the shared backlog.

### Claim collision strategy

The script uses `set -o noclobber` (`O_EXCL`) so only one session wins the race on a given task. Losing sessions silently move to the next task. No Claude arbitration required.

For higher-stakes tasks where collision matters, switch to Claude-arbitrated claims:

```
Worker instruction:
  When you find a task, message-stdin claude "CLAIM <task-id>".
  Wait for claude to reply 'GRANTED' or 'TAKEN'.

Claude:
  Serialise all CLAIM requests; first request for each id wins.
```

Expensive (Claude in the loop for every claim), only worth it when tasks are high-stakes or the collision rate is high.

### Monitoring

Claude watches events. Key signals:

- `turn.completed` for a worker — check what it claimed / completed / skipped
- Worker says "no more tasks" — it's idle. Consider detaching it, or feed it a refill (append new items to backlog.md) if more work appeared
- `approval.*` events — handle per `manage-codex-team/approvals.md`; read-only explorers shouldn't fire many of these

For this topology, the summary stream matters: `monitor events --summary --cursor swarm-tail` gives one compact line per worker event and resumes cleanly after Claude restarts. `turn.completed` no longer carries embedded items, so fetch detail with `message tail` only for workers you need to inspect closely, or just read `.codex-team/done/*.md`.

## Refilling the backlog

When workers drain the initial backlog, either:

- **Stop the swarm**: detach all, run a single `reducer` session to synthesise `.codex-team/done/*.md` into a final report
- **Refill**: based on what's in `done/`, append new tasks to `backlog.md` and message each worker to resume

Refill doesn't restart the workers — they pick up on their next loop iteration.

## Synthesis step

Always end a swarm with a synthesis. The done/ files are raw notes; you want a digest:

```bash
# reviewer profile (see configure-codex-team/profiles-library.md)
codex-team -b $TOK session new digest --cwd "$(pwd)" \
  --model gpt-5.4 --sandbox read-only --approval never --effort xhigh
codex-team -b $TOK message send digest "
  Read .codex-team/brief.md, .codex-team/backlog.md, every .codex-team/done/*.md
  and .codex-team/skipped/*.md.
  Produce .codex-team/summary.md:
    - Tasks completed (grouped by theme)
    - Key findings / tech debt / risks surfaced
    - Skipped tasks and why
    - Recommendations
"
codex-team -b $TOK message wait digest --timeout 0
```

Claude reads summary.md, reports to user.

## Termination

```bash
for i in $(seq 0 $((N-1))); do
  codex-team -b $TOK session detach "explorer-$i"
done
codex-team -b $TOK session detach digest
```

## Variants

- **Typed swarm**: multiple prefixes (`hunter-*` read-only, `fixer-*` write-capable). Each worker picks tasks tagged for its type (add `[hunter]` / `[fixer]` tag in backlog lines).
- **YOLO typed swarm**: for trusted write-capable `fixer-*` workers, set `--auto-approve "<patterns>"` on `session new` or configure `session.auto_approve_command_patterns` once at the daemon. Do not implement approval polling in shell.
- **Watchdog swarm**: workers run an alarm that triggers refill from a dynamic source (monitoring a directory, grep output). Swarm persists over hours.
- **Ephemeral swarm**: one-shot; detach each worker as soon as `no more tasks`. Useful for capped sweeps.

## Anti-patterns

- **No atomic claim**. Two workers claim the same task, duplicate work, race on output file. Always use `O_EXCL` or Claude arbitration.
- **Unbounded backlog growth**. If workers refill the backlog as they go, you get a runaway. Cap total tasks per swarm run.
- **Workers directly editing `backlog.md`** to remove claimed tasks. File-level race city. Use the claimed/ marker directory instead.
- **No synthesis step**. You'll end up with 40 `.md` files and no narrative. Always digest at the end.
- **Mixing write-capable and read-only workers** under one prefix. Different profiles = different work = different output expectations. Separate prefixes.
- **Running a swarm for a problem a pipeline would solve better**. Swarm is for parallel + independent. If you need ordering, use pipeline.
