---
name: watch-codex-team
description: Understand and debug the codex-team plugin's background Monitor streams that auto-wake you when Codex finishes a turn. Plugin monitors start automatically when the plugin is active — this skill explains what they emit, how to recover when they go silent, and when to escalate to PushNotification. Use when events stop arriving, when an event payload is unclear, or when onboarding to the plugin.
---

# Watch codex-team

The codex-team plugin declares two **background monitors** in
`monitors/monitors.json`. Claude Code auto-starts them when the plugin
is active (you do not call the `Monitor` tool yourself). Every stdout
line they emit arrives in your conversation as a notification — that
is how Codex's per-turn results push back to you while you sleep.

This skill explains the two streams, what payloads to expect, and how
to recover when they go silent. If you are about to run
`codex-team session status` in a loop "to see if a turn finished,"
you are polling; stop and trust the streams.

## Two streams, two jobs

| Stream | Cadence | What it carries | Why |
|---|---|---|---|
| `events` (`codex-team-events`) | bursty, reactive | Per-turn completion, errors, queue overflow, compaction advisories, session-down, auto-heal | This is how Codex tells you "I finished a thing" |
| `watchdog` (`codex-team-watchdog`) | every ~20 min, steady | Aggregate health report + the configured task brief | Keeps you woken on schedule regardless of Codex activity; re-grounds you with the original task description |

Both start when the plugin is enabled and run for the life of the
session. The `events` stream alone is not enough: if every session
goes idle, `events` emits nothing and you would sleep forever — the
watchdog guarantees a periodic wake so you cannot miss
"all sessions are waiting for me."

## Auto-start — no Monitor call needed

The plugin ships `monitors/monitors.json` with two `always`-triggered
entries. Claude Code reads this file at plugin activation and spawns
each `command` as a persistent background process. Their stdout is
piped into your notification channel the same way the `Monitor` tool
works — but you did not have to invoke it.

Concretely, at session start the plugin runs:

```
${CLAUDE_PLUGIN_ROOT}/scripts/monitor-events.sh
${CLAUDE_PLUGIN_ROOT}/scripts/monitor-watchdog.sh
```

Each script first ensures the daemon is up (`codex-team daemon start`)
then execs `codex-team monitor events` / `monitor watchdog`. The
daemon's event bus pre-filters to human-meaningful lines, so the
stream is clean by the time it reaches you — **do not wrap it in
`grep`** to "reduce noise"; the daemon already did, and over-filtering
would silently drop failure signals.

If you ever find yourself tempted to start a manual `Monitor({...})`
for codex-team streams, stop. Either the plugin monitors are already
running (check the task panel), or something is wrong with the plugin
activation (see "When events stop arriving" below).

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

A `turn-done` payload contains `summary` with at least:

```
{
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
just to see what changed, the streams are not running. See the
next section.

## When events stop arriving

If you have not received any event (from either stream) for more than
25 minutes, something is broken. Work this list, top to bottom:

1. **Is the watchdog mute?** It should emit every ~20m regardless. A
   silent watchdog means the plugin monitor is not running. Confirm
   the plugin is active with `/plugin list` or check the task panel
   — you should see `codex-team-events` and `codex-team-watchdog`
   listed. If either is missing, the plugin failed to activate its
   monitor; reload plugins with `/reload-plugins` or check
   `claude --debug` output for monitor startup errors.
2. **Is the daemon dead?** Run:
   ```
   codex-team daemon status
   ```
   If it reports connection refused, run
   `codex-team daemon start` (or see `recover-codex-team` for a fuller
   triage). Once the daemon is up, the plugin's monitor scripts
   auto-reconnect.
3. **Did the monitor process auto-stop?** Claude Code auto-kills
   monitors that emit too many events. The daemon pre-filters the
   stream to human-meaningful lines so this should not happen, but if
   it did you will see a notification saying the monitor stopped.
   `/reload-plugins` restarts it.
4. **Is `codex-team monitor events` exit-coded?** Run it directly in
   a separate Bash call (`timeout 10s codex-team monitor events`) to
   sniff stderr. Common cause: daemon socket stale after a daemon
   crash.

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
| "I'll just `tail history.md` to see what codex is doing." | That is polling. Notifications arrive via the plugin monitors — trust them or debug why they're silent. |
| "Monitor seems noisy, let me add a grep." | Events are pre-filtered by the daemon. Do not double-filter. |
| "Let me call `Monitor({...})` to arm this stream." | Plugin monitors auto-start. Calling Monitor manually would create a duplicate. Check the task panel first. |
| "Watchdog is too frequent, I'll crank to 60m." | 20m is chosen so you cannot sleep through "everyone is idle and waiting." Change only via `config.toml`, not at runtime. |

## Cross-references

- First time: `using-codex-team` (bootstrap order)
- Respond to `turn-done`: `manage-codex-team`
- Respond to `compact-suggest`: `compact-codex-team`
- Respond to `session-down` / `turn-err`: `recover-codex-team`
