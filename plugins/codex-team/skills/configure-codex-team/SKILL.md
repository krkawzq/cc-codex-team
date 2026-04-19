---
name: configure-codex-team
description: >-
  Entry for codex-team configuration + codex tuning tricks. Trigger when setting up a new profile, defining a persistent watchdog alarm, tuning a daemon / monitor / queue knob, debugging unexpected session defaults, verifying Node / Codex CLI prerequisites, picking reasoning_effort / model / personality / summary for a session, or looking up a CLI subcommand. Not for: session lifecycle (`manage-codex-team`), failure triage (`recover-codex-team`), picking a collaboration pattern (`codex-team-playbooks`).
---

# Configure codex-team

> **You are reading this because you need to tune, look up, or adjust behaviour that isn't session-lifecycle-level.** This skill is a thin index over four reference files; pick the one you need.

The Node daemon talks directly to `codex app-server` over JSON-RPC. No Python bootstrap, no SDK package. Config is TOML-first; profiles layer on top; env vars override scalar keys at runtime.

## Reference files

| File | Use when |
|---|---|
| `config-schema.md` | You need to know what a TOML key does, its default, or how it's env-overridden. Also: persistent watchdog alarms, template variables, data-dir resolution. |
| `profiles.md` | You want to define / pick / modify a per-session profile (model, effort, personality, developer instructions). |
| `codex-tricks.md` | You want to pick `--model` / `--effort` / `--personality` / `--summary` for a specific send or session. Behavioural tips, cost/quality trade-offs, sandbox edges. |
| `cli-cheatsheet.md` | You forgot a CLI subcommand or its flags. Quick lookup. |

## Runtime prerequisites

| Dependency | Role |
|---|---|
| Node.js 18+ | Runs `dist/main.js` and the wrapper. |
| `codex` CLI | Daemon spawns `codex app-server --listen stdio://` subprocesses. |

Verify:

```bash
node --version
codex --version
codex login
# from plugin checkout:
npm install && npm run typecheck && npm run build
```

Common failures:

| Symptom | Fix |
|---|---|
| `node: command not found` | Install Node 18+. |
| `dist/main.js missing` | `npm install && npm run build` in plugin checkout. |
| `E_NO_CODEX_BIN` | `npm install -g @openai/codex && codex login`; or pin `[daemon].codex_bin` (→ `config-schema.md`). |

## Hot-reload behaviour

- `session create` / `session resume` / `session restart` / `health repair` refresh `config.toml` from disk before acting. New profiles do **not** require a daemon restart.
- `daemon reload-config` reapplies heartbeat / watchdog intervals + alarm definitions immediately.
- Runtime alarms (`watch alarm create|delete`) restart background loops automatically.
- `compact` retries automatically on failure — tune with `compaction.retry_attempts` / `compaction.retry_delay_ms`.
- `history_rotation_mb` enforces rotation for both `history.md` and `turns.jsonl`.
- `launch_args_override` replaces the default app-server argv entirely — reach for it only when you need complete control. Use `config_overrides` for single-flag tweaks.

## When to tune which knob

| Goal | Knob / file |
|---|---|
| Different default model | `[defaults].model` or `[profiles.X].model` → `profiles.md` |
| Change session-level effort | `[profiles.X].reasoning_effort` → `profiles.md` |
| Lower cost on one turn | `codex-team send ... --effort low` (no config change) → `codex-tricks.md` |
| More/fewer parallel queued sends | `[queue].max_per_session` → `config-schema.md` |
| Stricter queue behaviour | `[queue].overflow_policy = "reject"` → `config-schema.md` |
| One-off task reminder | `codex-team watch alarm create …` (runtime) → `config-schema.md` §Watchdog alarms |
| Permanent project-wide reminder | `[monitor.watchdog_alarms.<ws>.<name>]` (config) → `config-schema.md` §Watchdog alarms |
| Silent drift detector | Any alarm with `emit_idle = false` (the default) |
| Faster turn-stuck detection | `[heartbeat].turn_stuck_seconds` |
| Different compact threshold | `[compaction].threshold_tokens` |
| Pin a specific Codex binary | `[daemon].codex_bin` |

## Red flags

| Thought | Correction |
|---|---|
| "I need to install a Python SDK first." | No. Node talks to app-server directly. |
| "I'll set `launch_args_override` for a tiny tweak." | Use `config_overrides`. Replace argv only when necessary. |
| "Cut `watchdog_interval_seconds` to 30 for fast feedback." | Fast feedback = `events` stream. Watchdog is low-frequency reminder. |
| "Define an alarm so I'll know the moment a session breaks." | That's the `events` stream's job (`session-down`, `turn-err`). Watchdog is reminder + self-check. |
| "Add `emit_idle = true` to every alarm." | Only for fixed-cadence briefings. Otherwise silence-on-no-signal is a feature. |
| "I'll write a runtime alarm that spans multiple workspaces." | Alarms are workspace-scoped by design. |
| "Edit config then restart the daemon." | Most changes hot-reload. `daemon reload-config` first. |
| "I'll put one-off task reminders in `config.toml`." | Runtime CLI (`watch alarm create`). Config alarms are for permanent setups. |
| "Crank `reasoning_effort` to high on every send for 'better' answers." | Burns 2-3× tokens for well-specified tasks. → `codex-tricks.md`. |

## Cross-references

- Session lifecycle: `manage-codex-team`
- Event stream arming: `manage-codex-team` §Arming events
- Watchdog (when to arm at all): `manage-codex-team` §Watchdog
- Failure triage: `recover-codex-team`
- Quick runtime alarm + Monitor arming: `/codex-team:watch`
- Workspace concept + resolution order: `using-codex-team` §Workspaces
