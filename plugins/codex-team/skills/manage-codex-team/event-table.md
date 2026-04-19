# Event table

Reference for `manage-codex-team`. Every kind the `events` and `watchdog` streams emit, its payload, and the decision you should take.

Both streams are **workspace-filtered** — the daemon scopes to your workspace before publishing, and every payload carries a `workspace` field for defence-in-depth. If `workspace` doesn't match yours, ignore.

---

## `events` stream

### Kinds at a glance

| kind | Meaning | Response |
|---|---|---|
| `turn-start` | A turn has begun; maps `pending-*` → real `turn_id`. | Note the mapping if tracking; otherwise ignore. |
| `turn-done` | Turn finished normally (`status=ok`). | Read summary → next send or sleep. |
| `turn-attn` | Turn finished but needs attention (question, failed command, `status != ok`). | Read carefully; often needs an answer. |
| `turn-err` | Turn raised / was interrupted. | Retry or triage. → `recover-codex-team`. |
| `queue-overflow` | New send exceeded `max_per_session`. | You are over-dispatching; throttle. |
| `compact-suggest` | Session context crossed compaction threshold. | 2-step ritual. → `recover-codex-team/compaction-ritual.md`. |
| `compact-done` | A compaction you triggered succeeded. | Usage reset; resume normal sends. |
| `session-down` | Codex subprocess exited unexpectedly. | Wait ~10s for `auto-heal`; if none, → `recover-codex-team`. |
| `auto-heal` | Daemon successfully resumed a crashed session. | Check `was_during_turn`; may need to re-dispatch lost work. |

### `turn-done` payload

```json
{
  "kind": "turn-done",
  "workspace": "proj-abcd1234",
  "session": "<name>",
  "turn_id": "tr_abc",
  "elapsed_ms": 42000,
  "status": "ok",
  "tier": "trivial | normal | attn",
  "final_message": "...",
  "files_added": 3,
  "files_removed": 0,
  "lines": [ ... DigestLine entries, in arrival order ... ],
  "usage_last_tokens": 8321,
  "usage_total_tokens": 192000
}
```

- `workspace` is always present; confirm it matches yours.
- `usage_last_tokens` — current **context-window snapshot** (the number that matters for compaction).
- `usage_total_tokens` — cumulative across the thread; will look scary-large on long threads. **Do not use it to decide compaction.**
- `tier`:
  - `trivial` — no file changes, status ok — often an answer or no-op turn.
  - `normal` — file changes happened, no failures.
  - `attn` — a command failed, final message ends with `?`, or status is non-ok.
- `lines` — ordered digest. See the Timeline format emitted by `codex-team history` (§`docs/refactor-history-display.md` once the history refactor lands).

### `turn-attn` — the decision branches

Read the `final_message` and the command statuses in `lines`.

| Signal | Decide |
|---|---|
| `final_message` ends with `?` (a question) | Answer verbatim in the next send. → `send-patterns.md`. |
| A command exited non-zero | Read `stderrTail` on that line. Fix the input; re-dispatch. |
| Worker said "I can't X because Y" | Treat seriously. They often see the code better than your summary. → `philosophy.md` §4. |
| Reply doesn't match the prompt | Long-context skip — re-send same prompt. → `philosophy.md` §5. |
| Nothing obvious | Dump + read the work doc + `history --last-n 1 --format md` before deciding. |

### `session-down` / `auto-heal` key fields

Both carry:

- `was_during_turn: bool` — was a turn active when the subprocess died?
- `turn_id`, `turn_age_ms` — which turn, how long it had been running.
- `reason` (on `session-down`) / `heal_reason` (on `auto-heal`).

Use these to distinguish "worker died mid-turn — work lost" from "idle child recycled — nothing to do".

### `compact-suggest`

```json
{
  "kind": "compact-suggest",
  "workspace": "<ws>",
  "session": "<name>",
  "tokens": 523412,
  "threshold": 500000
}
```

**Advisory**, not automatic. Triggers the ritual in `recover-codex-team/compaction-ritual.md`. You can also trigger the ritual proactively before a verbose turn even if no `compact-suggest` fired.

### `queue-overflow`

You're dispatching faster than the worker can complete. Either raise `[queue].max_per_session` in config (usually wrong), or slow down and wait for `turn-done` before the next `send`.

### Don't pre-filter

The daemon already drops high-frequency chatter (reasoning deltas, file-change hunks, command-output streams). What reaches the stream is distilled terminal signals. Wrapping `command:` in a `grep` would silently drop failure notifications. Trust the pre-filter.

---

## `watchdog` stream (opt-in)

A **periodic reminder + self-check** channel for you (the orchestrator). Not a health monitor — that job is the `events` stream's `session-down` / `turn-err`. Arm only for long-horizon work.

### `watchdog-tick` payload

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

- `message` is the rendered template — usually what you read.
- Structured fields are there if you want to act programmatically.
- Template variables and custom templates: `configure-codex-team/config-schema.md` §Watchdog alarms.

### Per-tick checklist

1. Read `message`. Let it re-anchor you to the task.
2. If `summary.errored > 0` → `/codex-team:heal` or `recover-codex-team`.
3. If any `advisories` include `crossed compaction threshold` → `recover-codex-team/compaction-ritual.md`.
4. If `taskBrief` is present, compare it with what your sessions are actually doing. Drift? Nudge the off-course session with a re-anchoring send.
5. Sleep.

---

## When events stop arriving

`events` going silent is a real problem; `watchdog` silence is normal if no alarm is armed or no signal is present.

For `events`, >25 minutes with no expected `turn-done`:

1. **Did you actually arm it?** #1 cause. Check the task panel for a Monitor whose `description` starts with `codex-team events:`.
2. **Did the Monitor child exit?** Claude Code notifies you when one does. If ignored, re-arm.
3. **Is the daemon dead?** `codex-team daemon status` — connection refused → `codex-team daemon start`, then **re-arm**. Old socket is gone.
4. **Workspace mismatch?** If the Monitor was armed under a different workspace (e.g., `CLAUDE_PROJECT_DIR` changed, or `CODEX_TEAM_WORKSPACE` was re-exported mid-session), you may be subscribed to the wrong tenant. Verify `codex-team workspace show`, then re-arm.
5. **Harness auto-stopped monitor for flooding?** Rare (daemon pre-filters). Re-arm.

For `watchdog` silence: likely fine. Check `emit_idle` on your alarm — if `false` with no signal, silence is expected. Run `codex-team watch alarm list` to confirm the alarm is registered + enabled.
