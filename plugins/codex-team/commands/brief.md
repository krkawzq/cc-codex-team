---
description: One-screen snapshot of codex-team state in the current workspace — session list + health + recent-turn hint. Pass `--all-workspaces` for a daemon-wide audit. Read-only.
argument-hint: "[--all-workspaces]"
allowed-tools: Bash
---

Render a compact status brief for the user. Read-only: do not dispatch, restart, or compact.

Raw user request:
$ARGUMENTS

## Procedure

1. **Scope.** If `$ARGUMENTS` contains `--all-workspaces`, pass it through to every CLI call below. Otherwise the brief is scoped to the current workspace.

2. Run `codex-team session list [--all-workspaces]`. Collect names, statuses, queue lengths, `last_turn_ended_at`, and (when `--all-workspaces`) each entry's `workspace`.

3. Run `codex-team health report [--all-workspaces]`. Collect `transport_alive` and `last_error` per session.

4. `codex-team workspace show` to report the current workspace (so the user sees which tenant they're in).

5. Format as one table. Omit the `Workspace` column when scoping to a single workspace:

   Single workspace (default):
   | Session | Status | Queue | Transport | Last turn ended | Last error |
   |---|---|---|---|---|---|
   | <name-1> | idle | 0 | alive | 14:32:10 | — |
   | <name-2> | running | 1 | alive | 14:28:55 | — |

   `--all-workspaces`:
   | Workspace | Session | Status | Queue | Transport | Last turn ended | Last error |
   |---|---|---|---|---|---|---|
   | proj-abcd1234 | <name-1> | idle | 0 | alive | 14:32:10 | — |
   | proj-55fa9e00 | <other>  | errored | 0 | dead | 13:10:02 | "auth expired" |

6. Below the table, one-sentence judgment:
   - All rows `idle` / `running`, transport alive, no `last_error` → "All sessions healthy."
   - Otherwise → "Attention: <session names> — <what you'd do>."

7. If any session is `errored` or `transport_alive=false`, **recommend** (do not execute) the first-line action from `recover-codex-team`, typically `codex-team session restart <name>`.

8. If run with `--all-workspaces`, add a brief note about workspace-scoped ownership — e.g. "Sessions in workspace `<ws>` belong to another Claude Code; do not modify from here."

## Do not

- Run `codex-team send`, `compact`, `restart`, `kill`, `forget`, or any state-changing command.
- Dump full `history.md`. Point at the session instead.
- Use `--all-workspaces` as the default. It's for audit, not routine checks.
