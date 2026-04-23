# Profiles — two separate systems

codex-team has two profile concepts that are often confused. Make sure you're using the right one.

## 1. codex-team built-in profile library (what you want for playbooks)

**Where**: `profiles-library.md` in this skill directory.

**What**: five canonical role profiles — `fixer`, `reviewer`, `planner`, `tester`, `explorer` — defined as `session new` flag bundles.

**How**: Claude reads the library and expands the flags explicitly when spawning a session. **No external config needed.** Every agent that loads the `configure-codex-team` skill has these definitions.

**Use for**: every session in every playbook in `skills/codex-team-playbooks/`. This is the default path.

See [`profiles-library.md`](profiles-library.md) for the full definitions + quick recipes.

## 2. Codex app-server `--profile <name>` (user-local customization)

**Where**: `~/.codex/config.toml` (or wherever `$CODEX_HOME` points).

**What**: user-defined Codex configuration profiles — a separate feature of the `codex` binary itself, not of codex-team.

**How**: `codex-team` exposes a `--profile <name>` flag on `session new` / `session attach` that passes through to the codex app-server's `thread/start` RPC. codex resolves the name from `~/.codex/config.toml`. **codex-team does not read this file.**

**Use for**: user-specific tuning that doesn't fit the canonical roles — e.g. `[profiles.my-rust-strict]` with `strict_mode = true`. If you have no custom codex profiles, you'll never touch this flag.

Example user config:

```toml
# ~/.codex/config.toml — OPTIONAL, user-local
[profiles.my-rust-strict]
model = "gpt-5.4"
reasoning_effort = "xhigh"
approval_policy = "untrusted"
sandbox_mode = "workspace-write"
# plus any custom codex knobs
```

Usage:

```bash
codex-team -b $TOK session new careful-rust --profile my-rust-strict --cwd /repo
```

Precedence (same as before):

```
  explicit single flag  >  profile field  >  codex-team default  >  codex internal default
```

## When to use which

| You want… | Use |
|---|---|
| One of the five canonical roles | Skill library (`profiles-library.md`) — expand flags explicitly |
| A reusable recipe for your own workflow | Your own entry in `~/.codex/config.toml` + `--profile <name>` |
| Daemon-wide defaults (all sessions on this daemon) | `daemon config set codex.default_*` — see `config-keys.md` |

## Inspecting what was requested

After `session new`, the session record shows what codex-team requested (model, sandbox, approval, effort, profile). Codex does not echo a fully expanded "resolved profile" object back over `thread/start`, so treat this as the launch shape, not a proof that every field was applied as you expect.

```bash
codex-team -b $TOK session info <name>
# or with --full for the whole record including auto-approve patterns
```

## Not profiles

These belong to `daemon config`, not to either profile system:

- daemon-side defaults: `codex.default_*`
- retry behaviour
- sock / log path

See `config-keys.md`.
