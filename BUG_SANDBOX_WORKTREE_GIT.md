# Bug: Codex worker cannot `git commit` in worktree with `sandbox=workspace-write`

## Symptom

One of the 4 parallel codex workers (`audit-async`) produced 21 modified files but failed to commit them with the error:

> `git commit` was blocked because this worktree's Git metadata is outside the writable sandbox, and earlier escalation for commit creation was denied

Two sibling workers (`audit-multi`, `audit-edge`) in identically-configured worktrees successfully committed 5 and 9 times respectively, each going through an `approval.command_execution` escalation that auto-approve captured.

## Root cause (hypothesis)

A git worktree stores its `HEAD`, `index`, and refs under `<main-repo>/.git/worktrees/<name>/`, which is **outside** the worktree's `cwd`. With `--sandbox workspace-write`, codex's sandbox only grants write to cwd. `git commit` needs to write outside, so it escalates via `approval.command_execution`.

The flow works when:
- codex detects sandbox rejection
- issues `requestApproval` with the git command
- orchestrator (or auto-approver) accepts
- codex retries

But `audit-async` reports "earlier escalation for commit creation was denied". Possibilities:

1. A specific transient state caused codex to give up and not re-escalate
2. The `acceptWithExecpolicyAmendment` approval mid-session somehow made later commits skip escalation but hit raw sandbox denial
3. codex's escalation retry budget is per-command; after N denials it stops asking (and none of my actions denied)
4. Some race: codex scheduled the commit before the auto-approver's first npm-install approval went through, and flagged the worktree as "commits won't work"

## Where to look

- `src/codex/appServerClient.ts` — how command approvals and escalations are handed to codex
- codex internals (not in this repo) — understanding the "give up after N escalation denials" logic
- `src/daemon/handlers/session.ts:buildThreadStartParams` — sandbox/approval policy passed to `thread/start`

Alternatively, the fix might be at the **session creation level**: pre-approve `git` as an execpolicy amendment when creating audit/fix sessions, so codex never needs to escalate for it.

## Workaround

Orchestrator (Claude) committed the 21 dirty files as one bulk commit (`37176e3`) with a body listing all 9 findings it addressed. Test suite confirmed green (105/105 pass) before the commit. Per-finding attribution lost.

## Related feature request

A better long-term story: codex-team should expose a config key:

```
codex-team daemon config set session.pre_approved_commands "git,npm,node,vitest"
```

When a session's approval policy is `on-request`, these commands auto-accept without round-trip to the orchestrator. This avoids the auto-approve-script entirely.

## Reported by

Claude orchestrator during 2026-04-22 dogfood run, 4-session parallel audit+fix.
