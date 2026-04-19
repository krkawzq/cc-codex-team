# Refactor design: workspace isolation + lifecycle

**Status:** draft for review
**Scope:** eliminate cross-session event bleed, orphaned subscribers, and silent resource leaks by making the daemon **multi-tenant** and adding **per-client lifecycle** tracking.

---

## 1. Executive summary

The plugin currently runs a single daemon per `CLAUDE_PLUGIN_DATA` and fans out every event to every subscriber. Combined with an auto-started `monitors/monitors.json`, the result is that two concurrent Claude Code sessions — or a `/resume` transition — see each other's sessions, share each other's event streams, and leak subscribers + subprocesses indefinitely.

This refactor introduces a single concept, **workspace**, and attaches it to every durable piece of daemon state (registry entries, event subscriptions, watchdog alarms, background resources). The daemon stays shared (one process per `CLAUDE_PLUGIN_DATA`) but becomes **tenant-aware**: a client sees only its own workspace by default. Combined with proper `SessionStart` / `SessionEnd` lifecycle hooks, the refactor gives us:

- **No cross-contamination** between Claude Code sessions in different workspaces.
- **No orphaned monitors** after `/resume` — the daemon knows who left and cleans up.
- **No silent resource leaks** — the daemon auto-stops when all workspaces are empty.
- **Zero-configuration** default: workspace derived from `CLAUDE_PROJECT_DIR`.
- **Explicit override** for advanced cases: `CODEX_TEAM_WORKSPACE=foo`.

All existing registry data is preserved via a migration that assigns legacy entries to `workspace = "default"`.

---

## 2. Root causes (the three problems this refactor eliminates)

### 2.1 Auto-armed plugin monitors

`monitors/monitors.json` declares two monitors with no `when` field. Claude Code's default is `when="always"` — so **every** plugin activation (SessionStart, plugin install, reload) auto-starts both monitor child processes. The existing prompts tell Claude to arm them *manually* via the `Monitor` tool, which causes **double subscription**: plugin-started child + Claude-spawned child, both connected to the same UDS socket. On `/resume`, the old CC's children may not be reaped before the new CC's auto-start fires — so you see the events twice.

**Fix:** delete the `monitors/monitors.json` file; arming is exclusively explicit via `/codex-team:bootstrap` and `/codex-team:watch`, which call the `Monitor` tool.

### 2.2 Shared daemon with no tenancy

`bin/codex-team` maps `${CLAUDE_PLUGIN_DATA}` to a per-plugin daemon. `CLAUDE_PLUGIN_DATA` is stable per user, so every Claude Code session running this plugin connects to the **same** daemon, **same** registry, **same** event bus. The EventBus (`src/eventBus.ts`) broadcasts each event to every subscriber on that stream. Destructive RPCs (`session.kill`, `session.forget`, `daemon.stop`) accept any session name regardless of which client created it.

**Fix:** introduce a `workspace` attribute on every session, every subscription, every alarm. Scope reads + writes by default; optional `--all-workspaces` bypasses for inspection.

### 2.3 No client lifecycle tracking

`hooks/hooks.json` only declares `SessionStart`. There is no mechanism to notice that a Claude Code session has ended; stale subscriptions remain in memory, the daemon and its app-server children keep running indefinitely. The existing `/codex-team:shutdown` works but requires the user to remember.

**Fix:** add `SessionStart` / `SessionEnd` hooks that register + detach a client with the daemon. On detach, the daemon reaps that client's subscribers and watchdog alarms. If no sessions remain across any workspace, the daemon stops itself.

---

## 3. Design goals

| Goal | How measured |
|---|---|
| Two CC windows in different projects see **nothing** of each other | Run two CCs; `session list` in each returns only local sessions |
| Same project, same workspace → cooperate (not a bug) | Intentional shared workspace still works |
| Explicit opt-in to cross-workspace visibility | `--all-workspaces` flag on inspection commands |
| `/resume` produces zero duplicate monitors | No zombie subscribers after a single resume cycle |
| Resource leak goes to zero | Daemon auto-stops when all workspaces empty |
| No manual bookkeeping for the common case | Default workspace derived automatically |
| Advanced users can override | `CODEX_TEAM_WORKSPACE=foo` env or `.codex-team/workspace.env` file |
| Backward-compatible with existing registries | Legacy entries migrated to `"default"` workspace on first daemon start |

---

## 4. Target architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  Claude Code sessions (N concurrent processes)                          │
│                                                                          │
│    [CC #1, project /foo]            [CC #2, project /bar]               │
│       workspace=proj-abc123           workspace=proj-def456              │
│       client-id=pid-12345             client-id=pid-67890                │
│                                                                          │
│       ├── bootstrap: arm Monitor       ├── bootstrap: arm Monitor        │
│       │    → subscribe events            │    → subscribe events          │
│       │      (workspace filter)          │      (workspace filter)        │
│       │                                  │                                │
│       └── codex-team send ...            └── codex-team send ...          │
└─────────────────────────────┬────────────────────────────────────────────┘
                              │  all RPCs include workspace + client_id
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Single codex-team daemon (per plugin-data-dir)                          │
│                                                                          │
│    ┌──────────────────────────────────────────────────────────┐         │
│    │  Registry (workspace-scoped)                              │         │
│    │    proj-abc123 → { fixer, reviewer, ... }                 │         │
│    │    proj-def456 → { porter, ... }                          │         │
│    │    default     → { legacy-migrated-session }              │         │
│    └──────────────────────────────────────────────────────────┘         │
│                                                                          │
│    ┌──────────────────────────────────────────────────────────┐         │
│    │  Client registry (in-memory, persisted to disk)           │         │
│    │    client-12345 ↔ workspace proj-abc123 ↔ N subscribers  │         │
│    │    client-67890 ↔ workspace proj-def456 ↔ N subscribers  │         │
│    └──────────────────────────────────────────────────────────┘         │
│                                                                          │
│    ┌──────────────────────────────────────────────────────────┐         │
│    │  EventBus (filtered fan-out)                              │         │
│    │    publish(stream, event) → fan out only to subscribers   │         │
│    │      whose workspace matches event.workspace              │         │
│    └──────────────────────────────────────────────────────────┘         │
│                                                                          │
│    ┌──────────────────────────────────────────────────────────┐         │
│    │  Watchdog alarm scheduler (per workspace)                 │         │
│    │    Each alarm belongs to a workspace; scans only its      │         │
│    │    sessions; publishes to watchdog stream with workspace. │         │
│    └──────────────────────────────────────────────────────────┘         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Workspace model

### 5.1 Identity derivation (CLI side)

Resolve in the following order, first hit wins:

1. **Explicit flag** `--workspace <name>` on the CLI invocation
2. **Environment** `CODEX_TEAM_WORKSPACE`
3. **Workspace file** `${CLAUDE_PROJECT_DIR}/.codex-team/workspace.env` (contains a single `CODEX_TEAM_WORKSPACE=<name>` line)
4. **Project hash** `proj-<sha1(CLAUDE_PROJECT_DIR)[:8]>` if `CLAUDE_PROJECT_DIR` is set
5. **User-level default** `default`

The resolved workspace is exported as `CODEX_TEAM_WORKSPACE` by `bin/codex-team` before exec'ing `node dist/main.js`, so the Node process always sees a concrete value.

### 5.2 Validity rules

- Workspace names match `^[a-zA-Z0-9_.-]{1,64}$`.
- Names are case-sensitive.
- The reserved name `"*"` means "all workspaces" (admin only) — never a valid real workspace.

### 5.3 Lifecycle

- Workspaces are **implicitly created** on first `session.create` with that workspace.
- An empty workspace (zero sessions) is garbage-collected by the daemon on the next tick after the last session is closed/forgotten.
- There is **no admin command to create/delete workspaces directly**; they exist because sessions exist.

### 5.4 Client identity

Each Claude Code process that arms a subscriber or registers an alarm is a **client**. Client identity is:

```
client_id = hash(workspace, hostname, pid, start_time_ms)
```

Recorded by `SessionStart` hook into `<data_dir>/clients/<client_id>.json`:

```json
{
  "client_id": "c-a1b2c3d4e5f6",
  "workspace": "proj-abc123",
  "hostname": "foo",
  "pid": 12345,
  "started_at": "2026-04-19T14:30:00Z",
  "claude_project_dir": "/abs/path/to/project"
}
```

On `SessionEnd` the file is deleted and the daemon is notified via RPC `client.detach`. Daemon-side bookkeeping uses `client_id` as the key for:

- Monitor subscriptions (map `client_id → AsyncQueue`)
- Runtime-registered watchdog alarms (map `client_id → Set<alarm_id>`)

Belt-and-suspenders: the daemon periodically (every 60s) scans `<data_dir>/clients/*.json` and if a client's pid is not alive, reaps it as if detach were called.

---

## 6. Data model changes

### 6.1 Registry schema v2

Current entry (v1):

```ts
{
  name: string,
  threadId: string,
  status: SessionStatus,
  cwd: string,
  ...,
  ephemeral: boolean,
}
```

New entry (v2) adds:

```ts
{
  workspace: string,       // NEW — required; legacy entries get "default"
  createdByClientId: string | null,  // NEW — informational, not authoritative
  ...all v1 fields...
}
```

Registry internal index changes from `Map<name, entry>` to `Map<workspace, Map<name, entry>>`. Session names are only required to be unique **within a workspace**.

Migration: on daemon start, if `registry.json` has any entry without `workspace`, rewrite the file with `workspace: "default"` assigned to each.

### 6.2 Session directory layout

Before: `<data_dir>/sessions/<name>/` (history.md, turns.jsonl, app-server.stderr.log)
After:  `<data_dir>/sessions/<workspace>/<name>/`

Migration: on daemon start, if `<data_dir>/sessions/<legacy-name>/` exists and the name matches a v1 registry entry, move it to `<data_dir>/sessions/default/<legacy-name>/`.

### 6.3 Client directory (new)

```
<data_dir>/clients/
  c-a1b2c3d4e5f6.json   # one file per live Claude Code process
  ...
```

Written at `SessionStart`, deleted at `SessionEnd`, reaped by the daemon's client-sweep loop.

### 6.4 Config schema additions

The watchdog alarm section keys on workspace now:

```toml
[monitor.watchdog_alarms.<workspace>.<alarm-name>]
enabled = true
interval_seconds = 7200
task_brief_file = ""
task_brief_head_lines = 30
emit_idle = false
template = ""
template_file = ""
```

Backward compat: if the daemon encounters a v1 `[monitor.watchdog_alarms.<alarm-name>]` block without a workspace level, it assigns it to `workspace = "default"` and logs a deprecation warning.

Runtime-registered alarms (via `codex-team watch` CLI) are stored separately in `<data_dir>/alarms/<workspace>/<alarm-name>.json` so that CLI-defined alarms don't pollute the user's `config.toml`.

---

## 7. Wire protocol v2

### 7.1 Request envelope

```json
{
  "v": 2,
  "id": "req-...",
  "cmd": "<command>",
  "workspace": "<name>",
  "clientId": "<client_id>",
  "params": { ... }
}
```

- `v` — protocol version; daemon rejects `v` > its own max and accepts `v = 1` only for a compatibility window.
- `workspace` — required for every request except `daemon.*`, `workspace.list`, and `client.*`.
- `clientId` — required for `monitor.*.subscribe`, `client.*`, `watch.alarm.*`. Other commands accept it optionally for attribution logging.

### 7.2 Response envelope

```json
{
  "v": 2,
  "id": "req-...",
  "ok": true,
  "workspace": "<name>",   // echoed for verification
  "data": { ... }
}
```

Errors include `code` and `message` as today.

### 7.3 Backward compatibility

- The daemon accepts `v = 1` requests for a transitional period (exact length: one minor release). v1 requests are auto-assigned `workspace = "default"` and `clientId = null`.
- Response to a v1 request omits the `workspace` field to avoid confusing old clients.
- After the compat window, `v = 1` requests get a hard error with a migration hint.

---

## 8. EventBus and subscription filtering

### 8.1 Publish

Every event publish now carries `workspace` in the payload:

```ts
eventBus.publish("events", { workspace, kind: "turn-done", session: "...", ... });
```

### 8.2 Subscribe

The subscriber specifies its workspace (and optionally `all_workspaces: true` for admin/debug):

```ts
eventBus.subscribe("events", sinceSeq, {
  workspace: "proj-abc123",
  clientId: "c-a1b2c3d4e5f6"
});
```

On each publish, the bus walks its subscribers and skips any whose `workspace` doesn't match `event.workspace` (unless the subscriber is `all_workspaces`).

### 8.3 Cleanup

Every subscriber is tagged with `clientId`. `client.detach` drops all subscribers for that client in one call — fixes the orphan problem on `/resume`.

### 8.4 Replay with filter

When a new subscriber joins with `sinceSeq = N`, the bus replays buffered events `> N`, but only those matching the workspace filter. This preserves the existing replay guarantee while enforcing tenancy.

---

## 9. Watchdog alarms: per-workspace

### 9.1 Scheduling

The daemon maintains one `setInterval` per `(workspace, alarm-name)` pair. Each tick:

1. Filter `registry.list()` to sessions in that workspace.
2. Compute advisories only over those sessions.
3. Render the template (variables unchanged except `summary` now reflects only the workspace).
4. `eventBus.publish("watchdog", { workspace, alarm: <name>, ... })`.

Because the publish carries `workspace`, subscribers of other workspaces never see it.

### 9.2 Registration

Two modes:

**(a) Config file** — `[monitor.watchdog_alarms.<workspace>.<alarm-name>]`. Daemon loads on start / reload.

**(b) Runtime** — `codex-team watch alarm create <name> --workspace <ws> [...]`. Daemon persists to `<data_dir>/alarms/<ws>/<name>.json` and schedules immediately.

`/codex-team:watch` slash command uses (b) by default; users who want a permanent alarm stable across daemon restarts can use either.

### 9.3 Removal

- `codex-team watch alarm delete <name> --workspace <ws>` for runtime alarms.
- Config-file alarms deleted via editing and `daemon.reload-config`.
- On `client.detach`, runtime alarms registered by that client are removed.
- On workspace garbage-collection (last session gone), alarms of that workspace are disabled but kept in storage for the next time the workspace is created.

---

## 10. Hooks and scripts

### 10.1 `hooks/hooks.json` (new content)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh", "timeout": 300 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh", "timeout": 30 }
        ]
      }
    ]
  }
}
```

### 10.2 `scripts/session-start.sh` (new)

Replaces today's `daemon-start.sh` for hook use. Responsibilities:

1. Ensure daemon is up (idempotent — uses pid-lock).
2. Resolve `CODEX_TEAM_WORKSPACE` via the rules in §5.1. If none is set and `CLAUDE_PROJECT_DIR` is available, derive and export it.
3. Optionally write `${CLAUDE_PROJECT_DIR}/.codex-team/workspace.env` so future shell sessions inherit the same workspace.
4. Call `codex-team client register --workspace <ws>` — daemon assigns a `client_id`, returns it, script stores it in `<data_dir>/clients/<client_id>.json`.
5. Exit. Exit code propagates to hook reporter.

### 10.3 `scripts/session-end.sh` (new)

Called on `SessionEnd` (covers quit, `/clear`, resume transitions, crashes with timeout). Responsibilities:

1. Read the client file written by `session-start.sh` (by current `$$` lookup or a `.codex-team/last-client` pointer).
2. Call `codex-team client detach --client-id <id>`:
   - Daemon drops all subscribers for this client.
   - Daemon removes runtime-registered alarms owned by this client.
   - Daemon checks if the global session count is zero across all workspaces; if yes, enters graceful shutdown.
3. Delete the local client file.
4. Exit quickly (hook timeout is 30s; most work happens server-side).

### 10.4 The `SessionEnd` safety boundary

`SessionEnd` must **not**:

- Stop the daemon unconditionally (other workspaces may be in use).
- Close or kill any session (`SessionEnd` on one CC should not affect work another CC is doing, even in the same workspace — they're peers).
- Touch `registry.json` directly.

It only touches **client-scoped** state: subscribers, runtime alarms, client file.

### 10.5 Client-sweep loop (daemon side)

Every 60s the daemon scans `<data_dir>/clients/`. For each file:

- If the `pid` is not alive → treat as `client.detach`.
- If the `started_at` is older than 7 days → treat as stale, detach.

This protects against SessionEnd failing to fire (crash, OOM, containerized CC) and leaves no zombies.

### 10.6 Explicit `codex-team daemon stop`

Still available. Unlike `SessionEnd`'s conditional stop, this is user-invoked and unconditional (after a confirmation prompt in `/codex-team:shutdown`). Useful when the user wants to hard-reset.

---

## 11. CLI changes

### 11.1 Global flags

Every CLI subcommand accepts:

- `--workspace <name>` — override the resolved workspace for this call.
- `--all-workspaces` — show/act across all workspaces (admin / debugging). Mutually exclusive with `--workspace`.

### 11.2 New commands

```
codex-team workspace list                   # list all workspaces with session counts
codex-team workspace show [<name>]          # active workspace details
codex-team client list                      # all registered clients
codex-team client detach <client-id>        # manual cleanup (debug)
codex-team watch alarm create <name> ...    # runtime alarm registration
codex-team watch alarm list                 # workspace-scoped alarm list
codex-team watch alarm delete <name>        # remove alarm
```

### 11.3 Existing commands — behavior changes

| Command | Before | After |
|---|---|---|
| `session list` | All sessions | Current workspace's sessions; `--all-workspaces` for everything |
| `session create <name>` | Global | Creates in current workspace; same name in different workspaces is allowed |
| `session kill/close/forget <name>` | Any session | Rejects if session's workspace ≠ caller's workspace (unless `--all-workspaces`) |
| `health report` | All sessions | Current workspace; `--all-workspaces` for global |
| `daemon stop` | Unconditional | Still unconditional but prints a big warning if active sessions exist in any workspace |
| `daemon doctor` | Current behavior | Adds per-workspace summary + client count |
| `monitor events` | All events | Current workspace; `--all-workspaces` for admin |

### 11.4 bin/codex-team wrapper

Extended to resolve workspace per §5.1 and export it. Also passes `CLAUDE_PLUGIN_DATA` through unchanged (for daemon discovery). Guard against foreign `CLAUDE_PLUGIN_DATA` stays.

---

## 12. Command / skill / prompt impact

### 12.1 `monitors/monitors.json` — **DELETE**

The file is removed entirely. No auto-arming.

### 12.2 `/codex-team:bootstrap`

- After arming `events` Monitor, verify current-workspace `session list` matches the user's expectation. If there are unexpected sessions, stop and report.
- `Monitor({})` uses `${CLAUDE_PLUGIN_ROOT}/scripts/monitor-events.sh` as before; the script inherits `CODEX_TEAM_WORKSPACE` from the shell so its internal `codex-team monitor events` call is workspace-scoped.

### 12.3 `/codex-team:watch` (updated)

Writes a **runtime alarm** (§9.2 mode b) rather than editing `config.toml`. Daemon persists to `<data_dir>/alarms/<workspace>/<name>.json`.

### 12.4 `/codex-team:shutdown`

- Closes sessions in the **current workspace** only by default.
- `--global` flag closes all workspaces and stops the daemon (dangerous; confirm twice).

### 12.5 `/codex-team:brief`, `/codex-team:heal`

- Workspace-scoped by default. `--all-workspaces` flag for global view.

### 12.6 New slash command `/codex-team:workspaces`

Lists all workspaces in the daemon with session counts + client counts + active alarms. Useful for diagnosing "I thought I was alone in this daemon."

### 12.7 Skill prompt updates

All seven skills need review and updates. The biggest changes:

- `using-codex-team`: new §Workspace isolation; invariants grow by one ("Every session belongs to exactly one workspace; you only see yours by default").
- `watch-codex-team`: drop the existing "It won't auto-start" correction (no longer relevant because the auto-start file is deleted — it's true by design now). Add workspace-scoped monitor subscription explanation.
- `manage-codex-team`: mention workspace implicitly in every example.
- `configure-codex-team`: add workspace-keyed alarm schema; document runtime alarm storage.
- `recover-codex-team`: add workspace mismatch as a class of errors (E_WRONG_WORKSPACE).
- `inspect-codex-team`: document `--all-workspaces` for audit.
- `compact-codex-team`: unchanged in substance; workspace is implicit.

---

## 13. File-by-file change catalog

| File | Change |
|---|---|
| `monitors/monitors.json` | **Delete** |
| `hooks/hooks.json` | Add `SessionEnd` hook |
| `.claude-plugin/plugin.json` | (No change required) |
| `bin/codex-team` | Resolve + export workspace per §5.1 |
| `scripts/session-start.sh` | **New** — replaces `daemon-start.sh` for hook |
| `scripts/session-end.sh` | **New** |
| `scripts/daemon-start.sh` | Keep; used by CLI |
| `scripts/daemon-stop.sh` | Keep |
| `scripts/daemon-status.sh` | Keep |
| `scripts/monitor-events.sh` | Keep (inherits env workspace) |
| `scripts/monitor-watchdog.sh` | Keep |
| `src/paths.ts` | `sessionDir(dataDir, workspace, name)`; new `clientsDir`, `alarmsDir`; `workspaceEnvFile(projectDir)` |
| `src/config.ts` | Watchdog alarm section keyed by workspace; v1 fallback; validation |
| `src/protocol.ts` | Add `v`, `workspace`, `clientId` fields; v1 compat decoder |
| `src/registry.ts` | Workspace-scoped storage; migration; query by workspace |
| `src/eventBus.ts` | Subscribers tagged with `(workspace, clientId)`; filtered fan-out |
| `src/watchdog.ts` | Filter sessions by workspace; publish with workspace |
| `src/session.ts` | Session carries workspace; path resolution updated |
| `src/server.ts` | New handlers (`client.register`, `client.detach`, `workspace.list`, `workspace.show`, `watch.alarm.*`); existing handlers workspace-aware; per-workspace watchdog scheduling |
| `src/daemon.ts` | Client-sweep loop (§10.5); auto-resume scoped per workspace; graceful stop on zero-sessions-all-workspaces |
| `src/cli.ts` | Global `--workspace` + `--all-workspaces`; new subcommands; workspace resolution on entry |
| `src/models.ts` | `RegistryEntry` adds `workspace`, `createdByClientId` |
| `test/registry.test.ts` | Multi-workspace cases + migration |
| `test/eventBus.test.ts` | Filter cases |
| `test/server.test.ts` | RPC envelope; wrong-workspace rejection |
| `test/session.test.ts` | Workspace threading |
| `test/watchdog.test.ts` | Per-workspace alarm |
| `test/helpers/fakeAppServer.ts` | Minor — include workspace echo |
| `config/default-config.toml` | Update comment about alarms; no functional change |
| `commands/bootstrap.md` | §Workspace verification step |
| `commands/brief.md` | Workspace-scoped; `--all-workspaces` |
| `commands/heal.md` | Workspace-scoped |
| `commands/shutdown.md` | Workspace-scoped by default; `--global` |
| `commands/watch.md` | Runtime alarm registration (no toml edit) |
| `commands/workspaces.md` | **New** |
| `commands/tutorial.md` | Branch F mentions workspace |
| `skills/using-codex-team/SKILL.md` | New §Workspace isolation; invariants grow |
| `skills/using-codex-team/philosophy.md` | (No change) |
| `skills/watch-codex-team/SKILL.md` | Drop "auto-start" correction; workspace explanation |
| `skills/manage-codex-team/SKILL.md` | Implicit workspace mention |
| `skills/configure-codex-team/SKILL.md` | Workspace-keyed alarm schema |
| `skills/recover-codex-team/SKILL.md` | E_WRONG_WORKSPACE class |
| `skills/inspect-codex-team/SKILL.md` | `--all-workspaces` audit pattern |
| `skills/compact-codex-team/SKILL.md` | (No change) |

---

## 14. Migration

### 14.1 On-disk data

Triggered on first daemon start after upgrade:

1. **Registry.** Parse `registry.json`. For any entry without `workspace`, set `workspace = "default"`. Rewrite file atomically.
2. **Sessions.** For each legacy entry, move `<data_dir>/sessions/<name>/` → `<data_dir>/sessions/default/<name>/`. Update file paths stored in registry if any are absolute.
3. **Alarms config.** If any `[monitor.watchdog_alarms.<name>]` exists in `config.toml` without a workspace key, treat as `default` workspace at runtime. (Do not rewrite the user's `config.toml` — just interpret.)
4. **Clients.** `<data_dir>/clients/` is created if missing. On first run there are no existing client files.

### 14.2 Wire protocol

1. Daemon accepts `v = 1` requests in read-only mode for one minor release; all writes require `v = 2`. Logs a warning on each v1 request with a migration hint.
2. CLI upgrades to always send `v = 2`. Mismatched-version error is descriptive: "this codex-team CLI expects daemon v2+; run `codex-team daemon restart` after upgrading."
3. After one minor release, v1 support is removed entirely.

### 14.3 Hooks

Plugin install / upgrade replaces `hooks/hooks.json`. CC re-reads hooks on next start.

### 14.4 Config — no hard break

Users with a v1 config file are silently migrated at interpretation time. A `codex-team config migrate --preview` command shows what the v2 equivalent would look like and can rewrite the file with `--write`.

---

## 15. Test strategy

### 15.1 Unit

- `registry.test.ts`
  - Same session name in two workspaces works.
  - Migration: v1 entries get `workspace = default`.
  - `list(workspace)` filters correctly.
- `eventBus.test.ts`
  - Filter skips cross-workspace events.
  - `all_workspaces` bypass delivers everything.
  - Replay with filter behaves correctly.
- `config.test.ts`
  - v1 alarm section migrated to `default`.
  - v2 workspace-keyed alarm parses.
- `protocol.test.ts`
  - v2 envelope encode/decode.
  - v1 auto-assigned to default workspace.

### 15.2 Integration

Add `test/integration/multi-workspace.test.ts`:

- Two workspaces, two clients.
- Each client creates a session; `session list` shows only its own.
- Events on A do not reach B's subscriber.
- `client.detach` for A leaves B's subscriber intact.
- Daemon auto-stops when both detach with zero sessions.

Add `test/integration/lifecycle.test.ts`:

- Simulate SessionStart → create session → SessionEnd (client detach). Daemon state clean.
- Simulate crash (delete client file without detach); client-sweep reaps on next tick.

### 15.3 Regression

- `/resume` simulation: run SessionStart, create subscriber, run SessionStart again (same workspace), run SessionEnd for first client. Expect: second subscriber intact, first subscriber gone.

---

## 16. Rollout phases

Each phase is one coherent PR. Phases are ordered so any phase is stable on its own.

### Phase 0 — Kill the auto-arm (hours; merged first)

- Delete `monitors/monitors.json`.
- Update skill prompts to remove the contradiction (no more "it won't auto-arm — it might" language).
- Add a prompt red flag: "if you see a monitor in the task panel you didn't arm, something is wrong with the plugin install."
- No protocol / data changes.

### Phase 1 — Workspace concept end-to-end

- Protocol v2 with workspace + clientId fields; v1 compat.
- Registry v2 with workspace; migration on load.
- EventBus filtered fan-out.
- Watchdog per-workspace scheduling.
- CLI `--workspace` flag resolved per §5.1.
- `bin/codex-team` wrapper exports workspace.
- `session.*` RPC handlers workspace-aware.
- Unit + integration tests.

### Phase 2 — Lifecycle hooks

- `scripts/session-start.sh`, `scripts/session-end.sh`.
- `hooks/hooks.json` adds `SessionEnd`.
- Daemon `client.register` / `client.detach` RPCs.
- Client-sweep loop.
- Integration tests for resume/crash scenarios.

### Phase 3 — Skill and command rewrites

- All commands workspace-aware.
- All skills updated.
- New `/codex-team:workspaces` command.
- `/codex-team:watch` uses runtime alarms.

### Phase 4 — Compatibility window close

- Remove v1 protocol support.
- Remove v1 alarm section fallback.
- `codex-team config migrate --write` available for one more release.

### Phase 5 — Advanced features (optional)

- Per-workspace permissions (e.g., read-only workspaces).
- Workspace lifecycle events on a separate stream.
- `codex-team workspace rename` / `move` admin commands.

---

## 17. Risks and open questions

### 17.1 `CLAUDE_PROJECT_DIR` stability across `/resume`

Claim to verify: when a user runs `/resume`, does CC set `CLAUDE_PROJECT_DIR` to the same value as the resumed session's original? If yes, our project-hash default is stable across resumes. If no, the user would see a different workspace after resume and lose their sessions.

**Mitigation if unstable:** the `${CLAUDE_PROJECT_DIR}/.codex-team/workspace.env` file is the fallback — once written, it pins the workspace regardless of env drift.

### 17.2 `SessionEnd` timeout (1.5s default)

CC's `SessionEnd` default timeout is short. If `client.detach` RPC to the daemon takes longer, the hook returns before the daemon finishes. We set the hook timeout to 30s explicitly; `client.detach` itself is O(subscribers) and should complete in milliseconds.

**Mitigation:** `session-end.sh` ensures the `client.detach` call is fire-and-forget-safe (daemon handles it idempotently even if called twice or if the client-sweep gets there first).

### 17.3 What if daemon is dead when `SessionEnd` fires?

Daemon dead → `client.detach` fails silently. The local client file remains. On next daemon start, the client-sweep loop finds stale files (dead pid) and reaps.

### 17.4 Two clients claim same client_id

Collisions are essentially impossible given the hash input (workspace + hostname + pid + start_ms). Even if one did happen, the server treats `client.register` as idempotent upsert.

### 17.5 Workspace naming conflicts with old session names

Old session names like "default" (if they existed) would be unaffected because workspaces and session names live in separate namespaces. Migration assigns all legacy sessions to `workspace = "default"`, so a user with a session literally named "default" would end up with `workspace=default, name=default` — perfectly valid.

### 17.6 Single daemon still = single point of failure

This refactor doesn't address "daemon crash takes down all workspaces." That's a separate reliability concern. The existing `auto_resume_on_daemon_start` mitigates for persistent sessions. A future phase could explore per-workspace daemon child processes, but it's out of scope here.

---

## 18. Decisions to confirm before implementation

These are the choices I've committed to in this document. Flag any you'd change before Phase 0 starts.

| # | Decision | Rationale for flagging |
|---|---|---|
| D1 | Single daemon per plugin-data-dir (not per-project) | Simplicity; preserves the "registry persists across Claude Code sessions" feature |
| D2 | Default workspace derived from `CLAUDE_PROJECT_DIR` hash; `default` when project dir unavailable | Zero-config per-project isolation |
| D3 | `CODEX_TEAM_WORKSPACE` env var overrides everything | Explicit control for advanced cases |
| D4 | `/codex-team:watch` writes runtime alarms by default, not `config.toml` | Ephemeral alarms shouldn't pollute user config |
| D5 | Watchdog alarm config keyed by workspace `[monitor.watchdog_alarms.<ws>.<name>]` | Per-workspace state stays workspace-scoped |
| D6 | `SessionEnd` hook only detaches the client; daemon stop is conditional on zero sessions everywhere | Safe across concurrent CC |
| D7 | Wire protocol bumps to v2; v1 supported for one minor release | Clean break, short compat window |
| D8 | Session filesystem layout changes to `sessions/<workspace>/<name>/` | Makes workspace cleanup trivial |
| D9 | `monitors/monitors.json` is deleted, not kept-but-disabled | Unambiguous; prevents future regressions if CC adds a `"when": "always"` implicit default |
| D10 | Client identity = `hash(workspace, hostname, pid, start_ms)`; tracked in `<data_dir>/clients/<id>.json` | Stable per process, reap-able by pid liveness |

---

## 19. Out of scope (future work)

- Per-workspace auth / ACL (who can create/kill in which workspace).
- Workspace templates (`codex-team workspace create-from-template <tpl>`).
- Cross-workspace coordination (e.g., "this session in workspace A waits on session in workspace B").
- Multi-daemon / horizontal scale.
- Encryption-at-rest for registry / history.
- Observability hooks (OpenTelemetry-style spans around RPC handlers).

---

## 20. What this document is not

This is a design doc. Once decisions D1-D10 are confirmed, implementation proceeds phase by phase. Each phase gets its own PR with its own description and test results.

When the refactor lands in main, this document moves to `docs/adr/` as a historical record rather than being deleted.
