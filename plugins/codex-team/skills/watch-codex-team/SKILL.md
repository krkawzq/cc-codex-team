---
name: watch-codex-team
description: Authoritative source for arming codex-team event streams. Two streams with different roles — `events` is mandatory whenever you dispatch work; `watchdog` is opt-in, only for long-horizon tasks, and configurable into multiple named alarms with custom templates. Trigger before your first `codex-team send`, when deciding whether a task is long enough to warrant watchdog, or when >25 minutes pass with no expected event. Not for: interpreting a specific event (that's the downstream skill).
---

# Watch codex-team

The plugin exposes two event streams. They are not symmetric — they serve different purposes.

| Stream | Role | Default behavior |
|---|---|---|
| `events` | Turn-by-turn outcomes and failures; the backbone of the async loop | **Always arm when dispatching work** |
| `watchdog` | Reminder + self-check for the orchestrator on long-horizon tasks | **Opt-in; do not arm by default** |

Arming the wrong one or arming both "just in case" creates noise. Read the two sections below separately.

---

## The `events` stream (always arm when dispatching)

This is the stream that makes the async loop work. Each line is one distilled per-turn record.

### Arm

```
Monitor({
  description: "codex-team events: turn completions, errors, compact suggestions",
  command: "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-events.sh",
  persistent: true,
  timeout_ms: 3600000
})
```

Arm **once per Claude Code session.** Re-invoking creates duplicates.

### When

- Before the first `codex-team send` of the session.
- After a daemon restart (the persistent Monitor child keeps running, but its socket is dead — re-arm).
- After explicitly stopping the monitor, only if you still need it.

Do **not** re-arm on every turn or every session create.

### Event kinds

| `kind` | Meaning | Response |
|---|---|---|
| `turn-start` | A turn has begun; maps `pending-*` → real `turn_id` | Note mapping if tracking; otherwise ignore |
| `turn-done` | Turn finished normally (`status=ok`) | Read summary → next send or sleep. → `manage-codex-team` |
| `turn-attn` | Turn finished but needs attention (question, failed command, `status != ok`) | Read carefully; often needs an answer. → `manage-codex-team` |
| `turn-err` | Turn raised / was interrupted | Retry or triage. → `recover-codex-team` |
| `queue-overflow` | New send exceeded `max_per_session` | You are over-dispatching; throttle |
| `compact-suggest` | Session context crossed threshold | Run the 2-step ritual. → `compact-codex-team` |
| `compact-done` | A compaction you triggered succeeded | Usage reset; resume normal sends |
| `session-down` | Codex subprocess exited unexpectedly | Wait ~10s for `auto-heal`; if none, → `recover-codex-team` |
| `auto-heal` | Daemon successfully resumed a crashed session | Check `was_during_turn`; may need to re-dispatch lost work |

### `turn-done` payload sketch

```json
{
  "kind": "turn-done",
  "session": "<name>",
  "turn_id": "tr_abc",
  "elapsed_ms": 42000,
  "status": "ok",
  "tier": "trivial|normal|attn",
  "final_message": "...",
  "files_added": 3,
  "files_removed": 0,
  "lines": [ ... DigestLine entries ... ],
  "usage_last_tokens": 8321,
  "usage_total_tokens": 192000
}
```

`usage_last_tokens` = current context-window snapshot (the number that matters for compaction).
`usage_total_tokens` = cumulative across the thread; will look scary-large on long threads — **do not** use it to decide compaction.

### `session-down` / `auto-heal` key fields

Both carry:

- `was_during_turn: bool` — was a turn active when the subprocess died?
- `turn_id`, `turn_age_ms` — which turn, how long it had been running
- `reason` (session-down) / `heal_reason` (auto-heal)

Use these to distinguish "worker died mid-turn, work lost" from "idle child recycled, nothing to do."

### Don't pre-filter

The daemon already drops high-frequency chatter (reasoning tokens, command-output deltas, file-change hunks). What reaches the stream is distilled terminal signals. Wrapping `command:` in a `grep` would silently drop failure notifications. Trust the pre-filter.

---

## The `watchdog` stream (opt-in)

The watchdog is a **periodic reminder + self-check** channel for the orchestrator. It fires on a cron-like interval, snapshots all sessions, optionally injects a task brief, and pushes one JSON line through a `Monitor`. It is **not** a health monitor — that job is handled by the `events` stream (`session-down`, `turn-err`, `turn-stuck` come there).

### Purpose

Two uses, both aimed at the orchestrator (you), not Codex:

1. **Reminder.** "You are working on task X. These N sessions are in flight. Don't forget." Useful on overnight runs, multi-hour waits, or work you'll resume tomorrow.
2. **Self-check.** "Tick arrived. Any session stale? Any queue backed up? Any drift from the task brief?" Forces you to scan when nothing else has woken you.

### When to arm

**Only when the work is long-horizon.** Rough threshold:

- Expected runtime > 1 hour of wall-clock with mostly-idle orchestrator → consider it
- Overnight / cross-day / multi-day → arm it
- Short iterations, interactive sessions, one-off fixes → **don't arm it** (pure noise)

**When not to arm** (default):

- You'll be actively dispatching every few minutes anyway.
- The user is present and will notice drift.
- The task is small enough that `events` alone is sufficient.

The daemon is **silent by default** — an alarm with `emit_idle: false` (the default) only fires when there's a signal (task brief set, running turn, advisories, errored session). So a misconfigured watchdog usually goes quiet on its own, but the correct posture is still "arm only when you'll use it."

### How to arm

Use the slash command:

```
/codex-team:watch <alarm-name> [--task-brief <path>] [--interval <secs>] [--template <path>]
```

The command writes (or updates) a `[monitor.watchdog_alarms.<alarm-name>]` block in `config.toml`, calls `codex-team daemon reload-config`, and arms the `watchdog` Monitor stream if not already.

Or manually: edit `config.toml` (→ `configure-codex-team`), then `codex-team daemon reload-config`, then arm the Monitor:

```
Monitor({
  description: "codex-team watchdog: periodic reminder + self-check",
  command: "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-watchdog.sh",
  persistent: true,
  timeout_ms: 3600000
})
```

Arm the Monitor **once** even if you have multiple alarms. All alarms share the same stream; each emission carries an `alarm: <name>` field.

### Alarm config shape

```toml
[monitor.watchdog_alarms.<alarm-name>]
enabled = true
interval_seconds = 7200            # 2h; pick for your task horizon
task_brief_file = ""               # optional; head N lines get injected
task_brief_head_lines = 30
emit_idle = false                  # false = silent when no signal; true = always fire
template = ""                      # inline; overrides default
template_file = ""                 # file; wins over `template` if both set
```

Every key is independent per alarm. You can have several alarms with different cadence / brief / template.

### Multi-alarm patterns

Pick one or combine. Each serves a distinct purpose.

**Pattern A — task-brief reminder (most common)**

```toml
[monitor.watchdog_alarms.task_brief]
interval_seconds = 7200   # every 2h
task_brief_file = "<path to the brief doc>"
emit_idle = true
```

Use when: you want to be re-anchored to the task every few hours, even if nothing is happening. Overnight refactor, weekend port.

**Pattern B — drift detector (silent unless something's off)**

```toml
[monitor.watchdog_alarms.drift]
interval_seconds = 1800   # every 30m
emit_idle = false
```

Use when: you're actively orchestrating but want a safety net for stuck turns / idle sessions / queue backups. Tick stays silent unless advisories exist.

**Pattern C — morning standup**

```toml
[monitor.watchdog_alarms.standup]
interval_seconds = 28800  # approximately 8h
emit_idle = true
template_file = "<path to a custom template>"
```

Use when: you want a daily/periodic fixed-cadence briefing regardless of state. Pair with a custom template that highlights what you care about.

### Custom template

The template is rendered with Handlebars-style `{{var}}` and `{{#if var}}...{{/if}}`. Available variables:

| Variable | Value |
|---|---|
| `{{at}}`, `{{sentAt}}` | ISO timestamp |
| `{{localTime}}` | Human-readable local time |
| `{{alarm}}` | Name of the firing alarm |
| `{{taskBrief}}` | First N lines of `task_brief_file`, or empty |
| `{{summary.total}}` | Session count |
| `{{summary.running}}` | Running-now count |
| `{{summary.errored}}` | Errored count |
| `{{summary.queued}}` | Total queued items across sessions |
| `{{sessionsText}}` | Pre-formatted per-session lines |

Minimal custom template:

```
[{{alarm}} @ {{localTime}}] {{summary.running}}/{{summary.total}} running, {{summary.errored}} errored
{{#if taskBrief}}
Task: {{taskBrief}}
{{/if}}
```

Task-guidance template (pair with Pattern A):

```
🔔 Watchdog reminder ({{alarm}}) — {{localTime}}

You are running: {{summary.total}} sessions ({{summary.running}} running, {{summary.errored}} errored, {{summary.queued}} queued).

{{#if taskBrief}}
Active task brief:
{{taskBrief}}
{{/if}}

Self-check before continuing:
  1. Any session stale or drifting from the brief?
  2. Any compact-suggest advisories pending action?
  3. Any Findings in a worker's work doc that change your plan?
{{#if sessionsText}}

Sessions:
{{sessionsText}}
{{/if}}
```

### Watchdog payload

```json
{
  "kind": "watchdog-tick",
  "alarm": "<alarm-name>",
  "at": "<iso>",
  "sentAt": "<iso>",
  "localTime": "<local>",
  "message": "<rendered template>",
  "taskBrief": "<injected brief or null>",
  "summary": { "total": 4, "running": 2, "errored": 0, "queued": 1 },
  "sessions": [
    {
      "name": "…",
      "status": "idle|running|errored|closed|compacting",
      "threadIdShort": "abc12345",
      "tokens": 234000,
      "metricKind": "context_estimate|cumulative_usage",
      "queue": 0,
      "transportAlive": true,
      "currentTurnId": null,
      "currentTurnAgeMs": null,
      "advisories": []
    }
  ]
}
```

`message` is the rendered template — usually what you read. The structured fields underneath are there if you want to act programmatically.

### On every watchdog tick

1. Read `message`. Let it re-anchor you.
2. If `summary.errored > 0` → `/codex-team:heal` or `recover-codex-team`.
3. If any `advisories` include `crossed compaction threshold` → `compact-codex-team`.
4. If `taskBrief` is present, compare it to what your sessions are actually working on. Drift? Nudge the off-course session with a re-anchoring send.
5. Sleep.

---

## When events stop arriving

The `events` stream going silent is a real problem; the `watchdog` stream being silent is normal if no alarm is armed or no signal is present.

For `events`, >25 minutes with no expected `turn-done`:

1. **Did you actually arm it?** #1 cause. Check the task panel for the Monitor `description`.
2. **Did the Monitor child exit?** Claude Code notifies you when one does. If ignored, re-arm.
3. **Is the daemon dead?** `codex-team daemon status` — connection refused → `codex-team daemon start`, then **re-arm**. Old socket is gone.
4. **Did the harness auto-stop the monitor for flooding?** Rare (daemon pre-filters). Re-arm with the same command.

For `watchdog` silence: likely fine. Check `emit_idle` on your alarm — if `false` with no signal, silence is expected.

## Red flags

| Thought | Correction |
|---|---|
| "I'll `tail history.md` to see what's happening." | Polling. Arm the `events` stream. |
| "I'll arm both streams just in case." | Watchdog is opt-in. Default to events-only. |
| "Monitor is noisy — let me add a `grep`." | Daemon pre-filters. Double-filtering drops terminal signals. |
| "Let me arm the streams again, just in case." | One arm per session. Re-arming creates duplicates. Check the task panel first. |
| "Usage is 2M tokens, I should compact right now." | Check `usage_last_tokens` (context window), not `usage_total_tokens` (cumulative). |
| "`auto-heal` fired — session is broken." | Check `was_during_turn` and `heal_reason`. Idle recycle ≠ crash. |
| "Watchdog is for monitoring session health." | No. That's `events` (`session-down`, `turn-err`). Watchdog is reminder + self-check. |
| "I'll set `emit_idle = true` on every alarm so I don't miss ticks." | Only when you want a fixed-cadence briefing. Otherwise silent-on-no-signal is better. |

## Cross-references

- Mental model + skill router: `using-codex-team`
- Respond to `turn-done` / `turn-attn`: `manage-codex-team`
- Respond to `compact-suggest`: `compact-codex-team`
- Respond to `session-down` / `turn-err`: `recover-codex-team`
- Alarm config schema: `configure-codex-team` §`[monitor.watchdog_alarms.*]`
- Quick arm: `/codex-team:watch`
