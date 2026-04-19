---
name: watch-codex-team
description: Authoritative source for arming codex-team event streams. Two streams with different roles — `events` is mandatory whenever you dispatch work and is armed via `/codex-team:bootstrap`; `watchdog` is opt-in, only for long-horizon tasks, and configurable into multiple named per-workspace alarms with custom templates. Trigger before your first `codex-team send`, when deciding whether a task is long enough to warrant watchdog, or when >25 minutes pass with no expected event. Not for: interpreting a specific event (that's the downstream skill).
---

# Watch codex-team

The plugin exposes two event streams. They are not symmetric — they serve different purposes.

| Stream | Role | Default behavior |
|---|---|---|
| `events` | Turn-by-turn outcomes and failures; the backbone of the async loop | **Always arm when dispatching work.** Arm explicitly via `/codex-team:bootstrap` or a `Monitor({...})` call. The plugin does not auto-start it. |
| `watchdog` | Reminder + self-check for the orchestrator on long-horizon tasks | **Opt-in per workspace; do not arm by default.** One or more named alarms per workspace. |

Both streams are workspace-filtered: subscribers see only events/alarm ticks for the workspace the CLI call was made in. Arming the wrong stream or arming for another workspace is prevented by default.

---

## The `events` stream (always arm when dispatching)

This is the stream that makes the async loop work. Each line is one distilled per-turn record, scoped to your workspace.

### Arm

```
Monitor({
  description: "codex-team events: turn completions, errors, compact suggestions",
  command: "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-events.sh",
  persistent: true,
  timeout_ms: 3600000
})
```

The script inherits `CODEX_TEAM_WORKSPACE` from the Claude Code session's hook-exported env, so its internal `codex-team monitor events` call is automatically scoped to your workspace.

Arm **once per Claude Code session.** Re-invoking creates duplicates. `/codex-team:bootstrap` does this arming step for you (idempotent check via task panel).

### When to arm

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
  "workspace": "proj-abcd1234",
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

`workspace` is always present; double-check that it matches yours as a sanity guard.

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

## The `watchdog` stream (opt-in, per-workspace alarms)

The watchdog is a **periodic reminder + self-check** channel for the orchestrator. An alarm fires on a cron-like interval, snapshots the current workspace's sessions, optionally injects a task brief, and pushes one JSON line through the shared `watchdog` Monitor stream. It is **not** a health monitor — that job is the `events` stream (`session-down`, `turn-err`).

### Purpose

Two uses, both aimed at the orchestrator (you), not Codex:

1. **Reminder.** "You are working on task X. These N sessions are in flight. Don't forget." Useful on overnight runs, multi-hour waits, or work you'll resume tomorrow.
2. **Self-check.** "Tick arrived. Any session stale? Any queue backed up? Any drift from the task brief?" Forces you to scan when nothing else has woken you.

### When to arm

**Only when the work is long-horizon.** Rough threshold:

- Expected runtime > 1 hour of wall-clock with mostly-idle orchestrator → consider it
- Overnight / cross-day / multi-day → arm it
- Short iterations, interactive sessions, one-off fixes → **don't arm it** (pure noise)

### How to arm

The recommended path is the slash command:

```
/codex-team:watch <alarm-name> [--task-brief FILE] [--interval-seconds N] [--template-file FILE] [--emit-idle]
```

It creates a **runtime alarm** (stored under the daemon's data dir, not in `config.toml`) in the current workspace, and arms the shared `watchdog` Monitor stream once per Claude Code session.

Manual equivalent:

```bash
# Register the alarm in the current workspace
codex-team watch alarm create task_brief \
  --interval-seconds 7200 \
  --task-brief-file <abs-path-to-brief> \
  --emit-idle

# Arm the shared watchdog stream (once per CC session)
Monitor({
  description: "codex-team watchdog: periodic reminder + self-check",
  command: "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-watchdog.sh",
  persistent: true,
  timeout_ms: 3600000
})
```

Arm the Monitor **once** per Claude Code session regardless of how many alarms you define. All alarms in your workspace publish to the same stream; each payload carries `alarm: <name>` so you can tell them apart.

### `emit_idle` behavior

- `emit_idle = false` (default): the alarm **skips** its tick when there's no signal — i.e., no running session, no advisories, no task brief. Keeps the stream quiet when nothing needs attention.
- `emit_idle = true`: the alarm **always** emits on cadence. Use when you want a fixed-cadence briefing (morning standup pattern).

### Multi-alarm patterns

Define multiple alarms in the same workspace with different cadence / purpose.

**Pattern A — task-brief reminder (most common for long-horizon tasks)**

```bash
codex-team watch alarm create task_brief \
  --interval-seconds 7200 \
  --task-brief-file /abs/path/to/brief.md \
  --emit-idle
```

Use when: you want to be re-anchored to the task every few hours, even if nothing is happening.

**Pattern B — silent drift detector**

```bash
codex-team watch alarm create drift \
  --interval-seconds 1800
```

Use when: you're actively orchestrating but want a safety net for stuck turns / idle sessions / queue backups. Tick stays silent unless advisories exist (`emit_idle` defaults to false).

**Pattern C — fixed-cadence standup**

```bash
codex-team watch alarm create standup \
  --interval-seconds 28800 \
  --emit-idle \
  --template-file /abs/path/to/standup-template.md
```

Use when: you want a periodic briefing regardless of state, with a custom template.

### Custom template

The template is rendered with Handlebars-style `{{var}}` and `{{#if var}}...{{/if}}`. Available variables:

| Variable | Value |
|---|---|
| `{{at}}`, `{{sentAt}}` | ISO timestamp |
| `{{localTime}}` | Human-readable local time |
| `{{alarm}}` | Name of the firing alarm |
| `{{workspace}}` | Workspace name |
| `{{taskBrief}}` | First N lines of `task_brief_file`, or empty |
| `{{summary.total}}` | Session count (current workspace) |
| `{{summary.running}}` | Running-now count |
| `{{summary.errored}}` | Errored count |
| `{{summary.queued}}` | Queued-items total across workspace sessions |
| `{{sessionsText}}` | Pre-formatted per-session lines |

Minimal custom template:

```
[{{alarm}}/{{workspace}} @ {{localTime}}] {{summary.running}}/{{summary.total}} running, {{summary.errored}} errored
{{#if taskBrief}}
Task: {{taskBrief}}
{{/if}}
```

Task-guidance template (pair with Pattern A):

```
🔔 Watchdog reminder ({{alarm}}, workspace {{workspace}}) — {{localTime}}

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
  "workspace": "<ws>",
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

### Manage existing alarms

```bash
codex-team watch alarm list                      # current workspace
codex-team watch alarm list --all-workspaces     # all (admin)
codex-team watch alarm delete <name>             # remove from current workspace
```

Alarms can also be defined statically in `config.toml` under `[monitor.watchdog_alarms.<workspace>.<name>]`. Runtime alarms (via CLI) are preferred for ephemeral task-specific reminders; config alarms are for permanent setups. → `configure-codex-team`

---

## When events stop arriving

The `events` stream going silent is a real problem; the `watchdog` stream being silent is normal if no alarm is armed or no signal is present.

For `events`, >25 minutes with no expected `turn-done`:

1. **Did you actually arm it?** #1 cause. Check the task panel for the Monitor `description`.
2. **Did the Monitor child exit?** Claude Code notifies you when one does. If ignored, re-arm.
3. **Is the daemon dead?** `codex-team daemon status` — connection refused → `codex-team daemon start`, then **re-arm**. Old socket is gone.
4. **Workspace mismatch?** If the Monitor was armed under a different workspace (e.g., `CLAUDE_PROJECT_DIR` changed, or `CODEX_TEAM_WORKSPACE` was re-exported mid-session), you may be subscribed to the wrong tenant. Verify `codex-team workspace show` matches what you expect, then re-arm.
5. **Did the harness auto-stop the monitor for flooding?** Rare (daemon pre-filters). Re-arm with the same command.

For `watchdog` silence: likely fine. Check `emit_idle` on your alarm — if `false` with no signal, silence is expected. Run `codex-team watch alarm list` to confirm the alarm is registered + enabled.

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
| "The alarm is in a different workspace — the daemon will merge it." | No. Alarms are workspace-scoped. One alarm, one workspace. Define a separate alarm for each workspace that needs one. |
| "I'll edit `config.toml` for a one-off reminder." | Use the runtime CLI (`watch alarm create`). Config alarms are for permanent setups. |

## Cross-references

- Mental model + skill router: `using-codex-team`
- Respond to `turn-done` / `turn-attn`: `manage-codex-team`
- Respond to `compact-suggest`: `compact-codex-team`
- Respond to `session-down` / `turn-err`: `recover-codex-team`
- Alarm config schema + template variables: `configure-codex-team` §Watchdog alarms
- Quick arm / runtime alarm: `/codex-team:watch`
- Inspect all alarms / workspaces: `/codex-team:workspaces`
