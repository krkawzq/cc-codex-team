# Map-reduce

## Adoption signal

- Task decomposes into N similar subtasks that don't need to see each other's state
- Examples: "migrate every file in src/legacy/ to the new API", "run the linter over every subdirectory and collect warnings", "summarise each of these 12 documents"
- Workers can run in parallel
- An aggregator step synthesises the outputs

## Team

| Count | Role | Profile |
|---|---|---|
| N | `mapper-<i>` | role-specific (often `fixer` or `explorer`) |
| 1 | `reducer` | `reviewer` or `planner` |

N depends on how much parallelism codex account can handle. 4–8 is usually sweet.

## Shared artefacts

- `<cwd>/.codex-team/brief.md` — overall brief
- `<cwd>/.codex-team/partition.json` — list of N tasks, one per mapper
- `<cwd>/.codex-team/mapper-<i>.md` — each mapper's output

## Orchestration

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK >/dev/null

cd /repo
mkdir -p .codex-team
echo "$BRIEF" > .codex-team/brief.md

# Claude computes the partition — a JSON list of tasks
cat > .codex-team/partition.json <<'EOF'
[
  {"id": 0, "target": "src/legacy/auth.ts"},
  {"id": 1, "target": "src/legacy/billing.ts"},
  ...
]
EOF

N=$(jq length .codex-team/partition.json)
for i in $(seq 0 $((N-1))); do
  codex-team -b $TOK session new "mapper-$i" --profile fixer --cwd "$(pwd)"
done
codex-team -b $TOK session new reducer --profile reviewer --cwd "$(pwd)"
```

### Dispatch map phase

Claude:

```bash
for i in $(seq 0 $((N-1))); do
  codex-team -b $TOK message send "mapper-$i" "Your task: partition.json[$i].target. Read .codex-team/brief.md. Write your output to .codex-team/mapper-$i.md."
done
```

All N mappers run concurrently. Events flow in. Claude tracks which mappers have fired `turn.completed`.

### Reduce phase

When all N mappers are done:

```bash
codex-team -b $TOK message send reducer "Read .codex-team/brief.md and every mapper-<i>.md file. Produce the final synthesis as stdout in your reply."
```

Claude reads `message tail reducer -n 1 --format markdown` to get the aggregated result.

## Scaling notes

- Live mapper sessions are isolated by default, so wide fan-out mainly costs you more `codex app-server` processes and memory. `app_server.max_sessions_per_process` now mostly matters for reusable adhoc/read-only clients, not the mapper turns themselves.
- Codex account rate limits will bite long before process limits. Watch for `server_overloaded` events; daemon auto-retries but sustained pressure means N is too high.
- Approvals are per-session. N mappers = N independent approval streams. Surface them with `--session` filter per session if you want a dedicated panel per mapper.

## Termination

```bash
for i in $(seq 0 $((N-1))); do
  codex-team -b $TOK session detach "mapper-$i"
done
codex-team -b $TOK session detach reducer
```

## Anti-patterns

- Letting mappers touch each other's files. They should each get their own targets.
- Reducer runs before all mappers complete. Always wait for the final `turn.completed`.
- Fanning out so wide that you spend more time coordinating than the sequential version would take. Rule of thumb: if each subtask is <30s, a loop in one session beats N parallel sessions.
