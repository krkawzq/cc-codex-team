---
description: One-screen snapshot of codex-team state — session list + health + recent-turn hint. Read-only; use to orient fast.
allowed-tools: Bash
---

Render a compact status brief for the user. Read-only: do not dispatch, restart, or compact.

## Procedure

1. `codex-team session list` via Bash. Collect names, statuses, queue lengths, `last_turn_ended_at`.
2. `codex-team health report` via Bash. Collect `transport_alive` and `last_error` per session.
3. Format as one table:

   | Session | Status | Queue | Transport | Last turn ended | Last error |
   |---|---|---|---|---|---|
   | <name-1> | idle | 0 | alive | 14:32:10 | — |
   | <name-2> | running | 1 | alive | 14:28:55 | — |
   | <name-3> | errored | 0 | dead | 13:10:02 | "auth expired" |

4. Below the table, one-sentence judgment:
   - All rows `idle` / `running`, transport alive, no `last_error` → "All sessions healthy."
   - Otherwise → "Attention: <session names> — <what you'd do>."

5. If any session is `errored` or `transport_alive=false`, **recommend** (do not execute) the first-line action from `recover-codex-team`, typically `codex-team session restart <name>`.

## Do not

- Run `codex-team send`, `compact`, `restart`, `kill`, `forget`, or any state-changing command.
- Dump full `history.md`. Point at the session instead.
