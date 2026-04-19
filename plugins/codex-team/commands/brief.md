---
description: One-screen snapshot of codex-team state in the current workspace — session list + health + recent turn hint. `--all-workspaces` for daemon-wide audit. Read-only.
argument-hint: "[--all-workspaces]"
allowed-tools: Bash
---

Render a compact status table for the user. Read-only — no state changes.

Raw user request: $ARGUMENTS

## Decision tree

1. **Scope.** `--all-workspaces` in `$ARGUMENTS` → pass through to every CLI call below. Default: current workspace only.

2. Run in parallel:
   ```
   codex-team session list [--all-workspaces]
   codex-team health report [--all-workspaces]
   codex-team workspace show
   ```

3. Merge into one table. Omit `Workspace` column unless `--all-workspaces`.

   Single workspace:
   ```
   | Session | Status | Queue | Transport | Last turn ended | Last error |
   ```

   `--all-workspaces`:
   ```
   | Workspace | Session | Status | Queue | Transport | Last turn ended | Last error |
   ```

4. One-sentence verdict below the table:
   - All healthy → "All sessions healthy."
   - Else → "Attention: `<names>` — `<what you'd do>`."

5. For any `errored` or `transport_alive=false` session, **recommend** (do not execute) `codex-team session restart <name>`. Point at `/codex-team:heal` for a sweep.

6. With `--all-workspaces`: add a note that sessions outside your workspace belong to other Claude Code instances.

## Do not

- Run `send`, `compact`, `restart`, `kill`, `forget` — anything state-changing.
- Dump full `history.md`.
- Use `--all-workspaces` as a default — reserve for audit.
