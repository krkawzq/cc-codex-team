# Built-in codex-team profile library

These are the canonical role profiles referenced by every playbook in `skills/codex-team-playbooks/`. They ship **with the plugin** — you do NOT need to pre-configure anything in `~/.codex/config.toml`. Claude reads the definitions here and passes the fields to `session new` directly as explicit flags.

Quick inspection shortcut: `codex-team profiles list` shows all bundled recipes, and `codex-team profiles show <name>` prints one profile plus a paste-safe `session new` command.

> **Why this lives in the skill, not in `~/.codex/config.toml`:** those playbooks used to depend on user-local Codex profiles that fresh agents had no way to know about. Dogfood testing showed `--profile fixer` silently falling back to defaults when the profile wasn't defined. Now the profile IS the skill content — every agent that loads this skill gets the definitions, regardless of user-local Codex config.

## The five canonical profiles

Pass the `session new` flag bundle directly; the `--profile` flag is NOT used for these — that flag targets user-local Codex profiles in `~/.codex/config.toml`, which is a separate (optional) extension path.

### `fixer` — default worker profile

Writes code in the workspace. Asks before risky ops. High reasoning effort.

```bash
codex-team -b $TOK session new SESSION_NAME \
  --cwd /abs/path/to/repo \
  --model gpt-5.4 \
  --sandbox workspace-write \
  --approval on-request \
  --effort high \
  --auto-approve 'git*,npm test,npm run test*,vitest*,pytest*,cargo test*'
```

**Use for**: worker role in worker+reviewer, mappers in map-reduce that produce diffs, executors in plan-execute-verify, implementers in pipelines, workers in hierarchical and swarm topologies, single session in solo-worker.

### `reviewer` — read-only critic

Never writes. Reads everything. Maximum reasoning effort. No approval pauses since it can't touch anything.

```bash
codex-team -b $TOK session new SESSION_NAME \
  --cwd /abs/path/to/repo \
  --model gpt-5.4 \
  --sandbox read-only \
  --approval never \
  --effort xhigh
```

**Use for**: reviewer in worker+reviewer, critic in reflexion, judge in debate, verifier in plan-execute-verify, reducer in map-reduce, final reviewer in pipeline, digest session in swarm.

### `planner` — read-only strategist

Same safety envelope as reviewer but used when the role is about producing plans, not auditing work. Same defaults but the naming keeps playbooks readable.

```bash
codex-team -b $TOK session new SESSION_NAME \
  --cwd /abs/path/to/repo \
  --model gpt-5.4 \
  --sandbox read-only \
  --approval never \
  --effort xhigh
```

**Use for**: planner in plan-execute-verify, manager in hierarchical, designer in pipelines, advocates in debate, hunters (read-only diff proposers) in swarm.

### `tester` — runs tests, low friction

Writable workspace so tests can create caches and fixtures. Never pauses for approval — trusted automation. Medium effort is enough for running a known test command and reporting pass/fail.

```bash
codex-team -b $TOK session new SESSION_NAME \
  --cwd /abs/path/to/repo \
  --model gpt-5.4-mini \
  --sandbox workspace-write \
  --approval never \
  --effort medium \
  --auto-approve 'npm test,npm run test*,vitest*,pytest*,cargo test*,go test*,make test*'
```

**Use for**: tester in plan-execute-verify or pipelines, smoke-test role in any topology that wants a quick pass/fail signal.

### `explorer` — read-only investigator

Small model, medium effort, read-only. Cheapest role — pick this when the job is "survey N files and summarize", not "audit for correctness".

```bash
codex-team -b $TOK session new SESSION_NAME \
  --cwd /abs/path/to/repo \
  --model gpt-5.4-mini \
  --sandbox read-only \
  --approval never \
  --effort medium
```

**Use for**: explorer in pipelines, mappers in map-reduce that produce summaries (not diffs), workers in swarm that scan code for interesting spots, initial investigation before a planner/reviewer takes over.

## Picking the right profile

| Need | Profile |
|---|---|
| "Edit this module, propose tests, handle approvals" | `fixer` |
| "Read this diff and tell me what's wrong" | `reviewer` |
| "Design an approach and break into steps" | `planner` |
| "Run `npm test` and report" | `tester` |
| "Summarize what's in `src/legacy/`" | `explorer` |

## Overrides

All five profiles are starting points, not prescriptions. Override any flag for the specific task — cwd is always required and must be set explicitly; override `--model` for tricky work; widen `--sandbox` to `danger-full-access` only for trusted setup scripts; tighten `--approval` to `untrusted` for risky territory.

Valid enum values:
- `--sandbox`: `read-only` / `workspace-write` / `danger-full-access`
- `--approval`: `never` / `on-request` / `on-failure` / `untrusted`
- `--effort`: `minimal` / `low` / `medium` / `high` / `xhigh`
- `--model`: any codex model id supported by the installed `codex` binary

## Daemon-wide defaults vs per-session overrides

If a field appears on every `session new` you run, consider a daemon-wide default:

```bash
codex-team daemon config set codex.default_model gpt-5.4
codex-team daemon config set codex.default_sandbox workspace-write
codex-team daemon config set session.auto_approve_command_patterns 'git*,npm test,npm run test*,vitest*'
```

Then a profile's explicit flags only apply the *differences* from the daemon default. See `config-keys.md` for the full list of `codex.default_*` keys.

## About `--profile` (the CLI flag)

`codex-team` does expose a `--profile <name>` flag that passes through to `codex app-server`. That resolves from `~/.codex/config.toml` (or `$CODEX_HOME`) and is **separate** from this library. It's useful for user-local customization — e.g. you have your own `[profiles.careful-rust]` in codex config — but don't rely on it for the canonical roles above, because fresh agents won't have those local profiles.

**Rule**: for the five profiles documented here, always expand the flags explicitly. For user-defined Codex profiles, use `--profile <name>`.

## Quick recipes

Spin up a worker+reviewer pair:

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK

codex-team -b $TOK session new worker \
  --cwd /repo --model gpt-5.4 --sandbox workspace-write --approval on-request --effort high \
  --auto-approve 'git*,npm test,npm run test*,vitest*'

codex-team -b $TOK session new reviewer \
  --cwd /repo --model gpt-5.4 --sandbox read-only --approval never --effort xhigh
```

Spin up a plan-execute-verify trio:

```bash
codex-team -b $TOK session new planner  --cwd /repo --model gpt-5.4 --sandbox read-only --approval never --effort xhigh
codex-team -b $TOK session new executor --cwd /repo --model gpt-5.4 --sandbox workspace-write --approval on-request --effort high --auto-approve 'git*,npm test,npm run test*,vitest*'
codex-team -b $TOK session new verifier --cwd /repo --model gpt-5.4 --sandbox read-only --approval never --effort xhigh
```
