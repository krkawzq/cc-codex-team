# Profiles

Reference for `configure-codex-team`. The profile system lets you specialise a session at creation without passing a dozen flags.

A profile layers over `[defaults]` — set only what you want different.

---

## Defining a profile

In `config.toml`:

```toml
[profiles.<name>]
model = "gpt-5.4"                    # optional override
model_provider = ""
reasoning_effort = "high"            # low | medium | high | minimal
approval_policy = "never"            # never | on-request | on-failure
sandbox = "danger_full_access"
personality = ""                     # concise | default | verbose | …
service_tier = ""
base_instructions = ""               # prepended to every turn
developer_instructions = """
Review correctness, risk, and tests. Do not commit.
"""
```

All keys are optional; missing keys inherit from `[defaults]`.

## Applying a profile

```bash
codex-team session create <name> --cwd <abs-path> --profile <name>
```

Per-turn overrides (without touching the profile):

```bash
codex-team send <name> "<prompt>" --effort low --personality concise
```

Per-turn overrides are for exceptions. If you find yourself overriding the same flag on most sends, promote it to the profile.

## Suggested shapes

Minimal baseline; workers do targeted, well-scoped tasks:

```toml
[profiles.worker]
model = "gpt-5.4"
reasoning_effort = "medium"
developer_instructions = """
Execute the task in the work doc you were pointed at. Update Progress / Findings / Next up.
Do not run git commit|merge|push|branch|tag — Claude owns version control.
"""
```

Code reviewer; higher effort, concise output:

```toml
[profiles.reviewer]
model = "gpt-5.4"
reasoning_effort = "high"
personality = "concise"
developer_instructions = """
Review correctness, risk, style, and tests. Report findings in the work doc.
Do not commit. Do not modify code unless explicitly asked; suggest diffs instead.
"""
```

Critic / reflexion loop; iterating on the same deliverable:

```toml
[profiles.critic]
model = "gpt-5.4"
reasoning_effort = "high"
personality = "concise"
developer_instructions = """
You are the critic. Point at the current deliverable, identify the top 3 weaknesses with line refs, and propose specific fixes. Do not rewrite the deliverable yourself.
"""
```

Quickfix; for small bugs where `high` is wasteful:

```toml
[profiles.quickfix]
model = "gpt-5.4-mini"
reasoning_effort = "low"
```

Ephemeral scratch; for exploratory probes you won't resume:

```toml
[profiles.scratch]
model = "gpt-5.4-mini"
reasoning_effort = "medium"
```

Usage:

```bash
codex-team session create probe --cwd <abs-path> --profile scratch --ephemeral
```

Ephemeral sessions die with their app-server; cannot be resumed after daemon shutdown.

## Profile naming

- Keep names descriptive of the **role**, not the task — `reviewer`, `worker`, `critic`, `quickfix`, `scratch`.
- A playbook in `codex-team-playbooks/` typically names which profile each role should use. Define those profiles once; reuse across tasks.

## Interaction with per-turn overrides

| Source | Wins over |
|---|---|
| Per-turn flag (`send --effort X`) | profile value |
| Profile value | `[defaults]` |
| `[defaults]` | built-in default |

Command-line visible; profile-invisible; defaults-implicit. When in doubt, `codex-team session status <name>` reports the effective values.

## Red flags

| Thought | Correction |
|---|---|
| "I'll add every override as a CLI flag for clarity." | Flag lists longer than ~3 items → make a profile. |
| "One profile to rule them all — `universal`." | Profile per role, not per project. A reviewer profile, a worker profile, etc. |
| "Crank `reasoning_effort=high` on every profile." | → `codex-tricks.md`. `high` is for ambiguous/deep problems. |
| "Ship a `danger_full_access=false` profile for safety." | The plugin's `never` approval + full-access sandbox is intentional. Narrowing defeats the async loop. If the user asks for safety, build a named profile (e.g. `sandbox-gated`) and use only on their explicit request. |
