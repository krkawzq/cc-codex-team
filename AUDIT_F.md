# Worker F Audit

## `--short` outputs

- `codex-team status --short`
  `user=<name> live=<N> pending=<M> retained=<X>/<Y> app_servers=<Z> daemon_age=<human>`
- `codex-team daemon status --short`
  `pid=<pid> sock=<short-path> age=<human> sessions=<N> users=<M> dist_age=<human-or-unknown>`
- `codex-team -b $TOK session info <name> --short`
  `<name> state=<state> thread=<short-thread-id> model=<model> busy=<y|n|unknown> turn=<turn-id-or-unknown> items=<N|unknown>`
- `codex-team -b $TOK session list --short`
  One line per session: `<name>  <state>  <model>  busy=<y|n|unknown>`
- `codex-team daemon user list --short`
  One line per user: `<encoded-token-prefix>... name=<name> live=<N|unknown> last_seen=<human>`
- `codex-team -b $TOK message history <name> --short`
  One line per turn: `<turn-id> <status> <duration> items=<N|unknown>`

## D1 rationale

- `messageApproval` and `messageAnswer` now schedule warning persistence with `setImmediate(...)` and do not wait on the event log path before returning the RPC response.
- The reply still waits for the app-server stdin write acknowledgement, but warning-event persistence is no longer on that critical path.
- Added a latency test that keeps `events.append(...)` pending for 500ms and asserts `messageApproval(...)` still resolves in under 50ms.

## O3 behavior

- Added a Windows-only probe for the legacy `%HOME%\\.codex-team` location.
- The probe only warns when:
  legacy `%HOME%` is set and non-empty,
  the legacy path exists,
  the new default path from `os.homedir()` does not exist,
  and `CODEX_TEAM_DATA_DIR` is not explicitly set.
- CLI commands emit the warning to `stderr`.
- Daemon startup emits the warning through the daemon logger.
- The warning is one-shot per process.
- No automatic migration is attempted; the warning tells the operator to move the directory manually.
