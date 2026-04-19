---
name: watch-codex-team
description: Arm and understand the codex-team event streams by invoking Claude Code's `Monitor` tool on the plugin's two helper scripts. The plugin does NOT auto-start these monitors — you start them yourself when you are about to dispatch work. Use this skill before your first `codex-team send` so you receive per-turn notifications instead of polling. Also covers payload shapes, how to recover when the streams go silent, and when to fall back to `PushNotification`.
---

# Watch codex-team

The plugin ships two shell scripts that stream structured per-turn
events from the daemon. Nothing starts them for you — you decide when
to arm them by calling the `Monitor` tool. Without them, you cannot
wake up when Codex finishes a turn and will have to poll.

## The two scripts

Both live in the plugin root and are safe to invoke via `Monitor`
directly. They bootstrap the Python venv, ensure the daemon is up,
then exec the appropriate `codex-team monitor ...` subcommand:

| Script | Stream | Purpose |
|---|---|---|
| `${CLAUDE_PLUGIN_ROOT}/scripts/monitor-events.sh` | `events` | Per-turn completion, errors, queue overflow, compaction advisories, session-down, auto-heal |
| `${CLAUDE_PLUGIN_ROOT}/scripts/monitor-watchdog.sh` | `watchdog` | ~20-minute heartbeat with aggregate session status + configured task brief |

Both stream one JSON object per stdout line. Exit (e.g. daemon shutdown)
ends the watch.

## Decide per stream — both are opt-in

Arming is **per-stream** and fully opt-in. You do not arm both
automatically. Ask yourself what you need:

| Need | Arm events? | Arm watchdog? |
|---|---|---|
| You will dispatch work and wait for results asynchronously | ✅ | depends (see below) |
| You are doing a single short turn and will block-wait or poll | ❌ | ❌ |
| You want periodic "task brief re-ground + aggregate health" reminders (long multi-session work) | — | ✅ |
| All sessions may go idle at some point and you still need to wake (avoid sleeping forever on a dead queue) | ✅ (not enough alone) | ✅ (this is the guard) |
| You are doing a single session with tight turn-cadence and the user is actively watching | ✅ | ❌ (noise) |

In practice:

- **`events`** is the mostly-always-on stream when using this plugin
  for anything beyond a single-turn test.
- **`watchdog`** is genuinely optional. Arm it when (a) you expect
  long-running / multi-session work with periods of inactivity, or
  (b) you want the configured task brief re-injected every ~20 min.
  Skip it for short / interactive / one-shot sessions — the 20-minute
  heartbeat is noise when the user is already steering.

## How to arm (copy-paste)

Arm only what you need. Use `persistent: true` so the monitor
survives a `ScheduleWakeup` cycle; a 1-hour `timeout_ms` is
defense-in-depth if the harness bounds it:

**Events (turn completions, errors, compact advisories, session-down,
auto-heal):**

```
Monitor({
  description: "codex-team events: turn completions, errors, compact suggestions",
  command: "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-events.sh",
  persistent: true,
  timeout_ms: 3600000
})
```

**Watchdog (periodic health + task brief; skip for short sessions):**

```
Monitor({
  description: "codex-team watchdog: periodic health + task brief",
  command: "${CLAUDE_PLUGIN_ROOT}/scripts/monitor-watchdog.sh",
  persistent: true,
  timeout_ms: 3600000
})
```

Arm each stream **once per Claude Code session.** Re-invoking
`Monitor` with the same command spawns a duplicate; you do not want
that. If you are unsure whether you already armed one, look at the
task panel — each live monitor shows up with its `description`.

## When to arm

- **Before the first `codex-team send`** — events start arriving as
  soon as work begins; no point arming after. Watchdog: arm
  simultaneously only if the task fits the criteria above.
- **After a daemon restart** — the `persistent: true` Monitor child
  keeps running but the underlying daemon connection dropped; re-arm
  the streams you were using.
- **After explicitly killing a monitor** (e.g., via `TaskStop`) —
  only if you still need it.

Do **not** re-arm on every turn, every session create, or every send.
Once per Claude Code session per stream is correct.

## Critical trade-off: events-only vs both

If you arm only `events` and every session becomes idle (queue empty,
all turns finished), the stream emits nothing. If you then
`ScheduleWakeup` and no new event arrives before the wake fires, you
get a clean wake; no problem. But if you sleep without a wake and no
event arrives, you sleep forever.

**Rule of thumb:** if you plan to sleep between wakes without
scheduled self-wakeups, arm the watchdog too. If you are always
pairing sleeps with `ScheduleWakeup`, events-only is safe.

## Why pre-filter is on the daemon side

The daemon's event bus already drops high-frequency non-actionable
notifications (every reasoning token, every command-output delta, every
file-change hunk). What reaches the monitor stream is the distilled
set: turn done, turn attention, turn error, queue overflow, compaction
advisory, session down, auto-heal.

Therefore: **do not wrap the `command:` in a `grep`** to "reduce
noise." That would silently drop failure signals the daemon already
distilled for you (Monitor's own docs warn about this: a filter must
match every terminal state). Trust the pre-filtered stream.

## Event stream payload shapes

Every line on `events` is one JSON object. The `kind` field tells you
what happened. Common kinds:

| `kind` | When | What to do |
|---|---|---|
| `turn-done` | A turn finished normally | Read the summary, dispatch the next prompt (`manage-codex-team`) or sleep |
| `turn-attn` | Turn finished but needs your attention (failed command, question in final_message, or status != ok) | Read carefully; may need to answer a question, fix tolerance, etc. |
| `turn-err` | Turn raised / was interrupted | `recover-codex-team` or send a retry |
| `queue-overflow` | New prompt enqueued past `max_per_session` | Consider whether you are over-dispatching |
| `compact-suggest` | Session token usage crossed `threshold_tokens` | `compact-codex-team` — run the 2-step ritual |
| `compact-done` | You triggered a compact and it succeeded | Usage resets; resume normal sends |
| `session-down` | Codex subprocess exited unexpectedly | Wait briefly for `auto-heal`; if none arrives, `recover-codex-team` |
| `auto-heal` | Daemon successfully resumed a crashed session once | Resume normal sends |

A `turn-done` payload contains at least:

```
{
  "kind": "turn-done",
  "session": "L-kernels",
  "turn_id": "tr_abc",
  "elapsed_ms": 42000,
  "status": "ok",
  "tier": "trivial|normal|attn",
  "final_message": "...",
  "files_added": 3,
  "files_removed": 0,
  "lines": [ ... structured DigestLine entries ... ],
  "usage_last_tokens": 8321,
  "usage_total_tokens": 192000
}
```

When the notification arrives in-chat you will see one pretty-printed
JSON block per line. You do not need to pre-parse it — read, decide,
act.

## Watchdog payload

One line every `monitor.watchdog_interval_seconds` (default 1200s =
20 min). Schema:

```
{
  "kind": "watchdog-tick",
  "at": "<iso-ts>",
  "task_brief": "<first N lines of the configured brief file, if any>",
  "sessions": [
    {
      "name": "L-kernels",
      "status": "idle|running|errored|closed|compacting",
      "thread_id_short": "abc12345",
      "tokens": 234000,
      "queue": 0,
      "advisories": ["crossed compaction threshold", "idle > 30m"]
    },
    ...
  ]
}
```

Every watchdog block is a chance to sanity-check:

1. Is every session healthy or are some stuck?
2. Does the task brief still match what you think you are working on?
3. Any advisories demanding action (stale session, compact threshold
   crossed but no send seen since)?

## The normal wake loop

```
[notification arrives]
  │
  ├─ events / turn-done
  │   └─ read summary → decide → one send → ScheduleWakeup if no event soon
  │
  ├─ events / turn-attn (question / failure)
  │   └─ answer → send → wait for event
  │
  ├─ events / compact-suggest
  │   └─ follow compact-codex-team ritual
  │
  ├─ events / session-down
  │   └─ wait 10s for auto-heal event; else recover-codex-team
  │
  └─ watchdog / tick
      └─ scan all sessions + brief → identify stale / blocked → send
        nudges if needed → sleep
```

Between wakes you should be **asleep** — either waiting for the user
or `ScheduleWakeup`-ed. If you find yourself running Bash commands
just to see what changed, you either didn't arm the streams yet or
they exited. See the next section.

## When events stop arriving

If you have not received any event for more than 25 minutes, work
this list top to bottom:

1. **Did you actually arm them?** It is the #1 cause. Check the task
   panel for entries whose description matches the snippets above. If
   not present, arm them now with the `Monitor` calls at the top of
   this skill.
2. **Did the monitor process exit?** Claude Code will notify you when
   a Monitor child exits (e.g., daemon crash, script error). If you
   saw such a notification and ignored it, re-arm.
3. **Is the daemon dead?** Run:
   ```
   codex-team daemon status
   ```
   If it returns connection refused, run
   `codex-team daemon start` (or see `recover-codex-team` for fuller
   triage). Then re-arm both monitors — the old Monitor children will
   have exited when the daemon dropped.
4. **Did Claude Code auto-stop the monitor?** The harness kills
   monitors that emit too many events. The daemon pre-filters the
   stream so this should be rare; if it happened, the bug is
   upstream — re-arm with the same commands (no filter changes) and
   report.

## PushNotification — when to bring the human back

Rare. Only when:

- All sessions are blocked on an answer only the user can give
  (credentials, a judgment call outside your authority, etc.) and you
  cannot make progress.
- A destructive action requires their approval (rare in this plugin —
  YOLO mode is already granted).
- They explicitly asked to be notified.

```
PushNotification({
  status: "proactive",
  message: "L-kernels is blocked: codex needs a decision on tolerance (1e-5 vs strict). No other sessions are progressing."
})
```

Do not push for `turn-done`, `compact-suggest`, `auto-heal`, or any
event you can handle yourself. Those are your job.

## Red flags

| Thought | Correction |
|---|---|
| "I'll just `tail history.md` to see what codex is doing." | That is polling. Arm the events stream instead. |
| "Monitor seems noisy, let me add a grep." | Events are pre-filtered by the daemon. Do not double-filter. |
| "Let me arm the streams again, just in case." | One arm per Claude Code session. Re-arming creates duplicate processes. |
| "Watchdog is too frequent, I'll crank to 60m." | 20m is chosen so you cannot sleep through "everyone is idle and waiting." Change only via `config.toml`, not at runtime. |
| "I'll arm both streams to be safe." | Watchdog is opt-in; if the task is short / interactive / user-watched, it's noise. Skip unless you genuinely need the periodic heartbeat. |
| "I only armed events; I'll sleep and see what happens." | Events can go silent indefinitely when sessions idle. If you're sleeping without `ScheduleWakeup`, arm the watchdog too — that heartbeat is what prevents infinite sleep. |

## Cross-references

- First time: `using-codex-team` (mental model; bootstrap calls out
  this skill as the "arm the streams" step)
- Respond to `turn-done`: `manage-codex-team`
- Respond to `compact-suggest`: `compact-codex-team`
- Respond to `session-down` / `turn-err`: `recover-codex-team`
- Tune stream cadence or task brief: `configure-codex-team`
