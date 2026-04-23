# Anti-patterns

Topologies and habits that sound clever but fail in practice. Read before designing your own.

## 1. N-way parallel without a merge step

Spawning N workers on N independent subtasks then … not integrating. Output sits in N files and whoever inherits the project has to stitch it. Always define the reduce / synthesis step up front, even if it's "Claude writes the final summary".

## 2. Reviewer with workspace-write

If the reviewer can edit, the worker stops trusting the review — "it'll just get fixed anyway". Worse: ambiguous ownership makes diffs hard to follow. Keep reviewers `read-only`.

## 3. Polling events via CLI instead of `message wait` or a Monitor

Running `codex-team -b $TOK status` in a loop from Bash burns context and misses events. Use `message wait` when you are blocked on one session, or a persistent Monitor (`/codex-team:events`) when you're orchestrating asynchronously.

For large fleets, prefer `monitor events --summary` instead of verbose NDJSON.

## 4. Infinite review loops

`worker → review → rework → review → rework …` without a cap. If 3 rounds didn't converge, the brief is wrong or the worker+reviewer pair isn't right. Escalate.

## 5. Sending 20-line prompts

Codex responds best to pointed prompts. 20-line briefs get pattern-matched to training data and you get generic output. Short, specific, cite-files-by-path works better. For long context, put it in `.codex-team/brief.md` and tell the worker to read it.

## 6. Sharing a session across unrelated tasks

Context poisoning. A session that just did a refactor carries those decisions into its next task. Detach, start fresh.

## 7. Detaching mid-turn because "it's taking too long"

Detach kills in-flight work. If the turn is productive but slow, wait. If it's stuck (no item events for minutes), `message interrupt` first, inspect the terminal `turn.completed` status, then decide.

## 8. Ignoring failed `turn.completed` events

An errored turn often means a fundamental issue (context too large, auth, sandbox too tight). Silently retrying via the daemon's overload-retry doesn't fix those. Read the `codex_error_info` and act accordingly.

## 9. Hand-crafted approval JSON when a shortcut exists

Typo-prone, no schema validation. Use `accept` / `decline` / `cancel` shortcuts when they cover the case. Reach for `--json` only for amendments / MCP content / partial permissions.

## 10. Shell loops that poll for approvals in trusted fleets

If the goal is unattended progress, configure it directly with `session new --auto-approve "<patterns>"` or the daemon default `session.auto_approve_command_patterns`. Polling `status`, scraping event logs, or racing `message approval` from Bash is slower and less reliable.

## 11. Using `--takeover` casually

Takeover cancels pending approvals on the previous holder. If another agent had a turn in-flight, you trash their state. Coordinate via bearer token separation instead.

## 12. Reading `turn.completed` as the source of truth for turn content

Events are summaries. `turn.completed` is explicitly compact and does not embed items. Fetch content with `message tail` / `message history` or read the work-doc files on disk.

## 13. Treating `--since <id>` as a durable bookmark

If you need resumable monitoring, save a named cursor and use `monitor events --cursor <name>`. Raw `--since <id>` is useful for ad-hoc replay, but it is not a maintained checkpoint.

## 14. Assuming `session new` plus nothing = a session you can reattach later

A session with zero turns isn't persisted by codex. If you create it and detach without sending, the thread_id won't work on re-attach. Always send at least one turn before detaching a session you want to come back to.

## 15. One bearer token across many unrelated projects

Every session on one token sees your user's live-session count, gets your events in its monitor stream. Useful for coordinating one agent conversation; noisy if you're trying to partition work. Use separate tokens per logical project / agent instance.

## 16. Running monitor alarm for heartbeats you could replace with events

Alarm runs a shell command every N seconds — wastes CPU if all you want is "tell me when something happens". Events + a subscribed Monitor already do that, event-driven. Use alarm for genuinely time-based concerns (scheduled reports, cron-like side effects).

## 17. Spinning up a hierarchical manager for a 2-task problem

The overhead of manager + delegation bookkeeping exceeds the task. Threshold: hierarchical makes sense when you expect ≥5 delegations, and each worker output is substantive.
