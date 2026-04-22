# Codex profiles

codex-team does not own the profile concept — it's native to Codex. `session new --profile <name>` passes the selected profile through to app-server as part of the thread-start config payload; codex then resolves that profile from its own config.

## Where profiles live

Codex reads profiles from `~/.codex/config.toml` (or wherever `CODEX_HOME` points). The codex-team daemon does NOT read this file.

Example `~/.codex/config.toml`:

```toml
[profiles.reviewer]
model = "gpt-5.4"
reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "read-only"

[profiles.fixer]
model = "gpt-5.4"
reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[profiles.explorer]
model = "gpt-5.4-mini"
reasoning_effort = "medium"
approval_policy = "never"
sandbox_mode = "read-only"
```

## Usage with codex-team

```bash
codex-team -b $TOK session new review-worker --profile reviewer --cwd /repo
```

Precedence when `--profile` is combined with individual flags:

```
  explicit single flag  >  profile field  >  codex-team default  >  codex internal default
```

So:

```bash
# profile says sandbox=read-only, but we override just for this session
codex-team -b $TOK session new demo --profile reviewer --sandbox workspace-write
```

## Recipe: worker roles

Define once, reuse:

```toml
# ~/.codex/config.toml
[profiles.reviewer]
model = "gpt-5.4"
reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "read-only"

[profiles.fixer]
model = "gpt-5.4"
reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[profiles.tester]
model = "gpt-5.4-mini"
reasoning_effort = "medium"
approval_policy = "never"
sandbox_mode = "workspace-write"
```

Spin up a review-fix-test team:

```bash
TOK=claude-$(date +%s)
codex-team daemon user create $TOK

for role in reviewer fixer tester; do
  codex-team -b $TOK session new "$role" --profile "$role" --cwd /repo
done
```

See `skills/codex-team-playbooks/worker-reviewer.md` for orchestration.

## Inspecting a loaded profile

After `session new`, the session record shows what codex-team requested / defaulted locally (`model`, `sandbox`, `approval`, `effort`, `profile`). Codex does not echo a fully expanded "resolved profile" object back over `thread/start`, so treat this as the requested launch shape, not a proof that every profile field was applied.

Check the stored session metadata with:

```bash
codex-team -b $TOK session info <name>
```

## Not profiles

These belong to `daemon config`, not `~/.codex/config.toml`:

- daemon-side defaults for when `--profile` is unused: `codex.default_*`
- retry behaviour
- sock path / log path

See `config-keys.md`.
