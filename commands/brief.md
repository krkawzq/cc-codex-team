---
description: One-screen snapshot of the codex-team state — session list, health report, and a hint of recent events. Read-only; use to orient fast.
allowed-tools: Bash
---

Render a compact status brief for the user.

Procedure:

1. `codex-team session list` via `Bash`. Collect the session names,
   statuses, queue lengths, and `last_turn_ended_at` timestamps.
2. `codex-team health report` via `Bash`. Collect `transport_alive`
   and any `last_error` per session.
3. Format the result as a single table the user can read at a glance:

   | Session | Status | Queue | Transport | Last turn ended | Last error |
   |---|---|---|---|---|---|
   | L-kernels | idle | 0 | alive | 14:32:10 | — |
   | L-bench | running | 1 | alive | 14:28:55 | — |
   | L-tests | errored | 0 | dead | 13:10:02 | "auth expired" |

4. Below the table, give a one-sentence judgment:
   - "All sessions healthy." if every row is idle/running with alive
     transport and no last_error.
   - "Attention: ..." with specifics (session names + what you'd do)
     otherwise.

5. If any session is `errored` or `transport_alive=false`, recommend
   (do not execute) the corresponding action from `recover-codex-team`
   — typically `codex-team session restart <name>` as a first try.

Do not dispatch prompts. Do not restart sessions. Do not compact.
This is pure read-out.
