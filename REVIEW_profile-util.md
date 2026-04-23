# Review: profile-util (0.5.5 dogfood)

## P0 — crash / data loss / security / protocol
- none

## P1 — wrong behavior
- [P1] `plugins/codex-team/src/profiles/builtin.ts:74` — `profiles show` advertises a "copy-ready" command, but the rendered command uses literal `<name>` / `<repo>` placeholders, which shells treat as redirection syntax rather than arguments.
  Why it's P1: copying the emitted command verbatim fails immediately in normal zsh/bash use, so the hot-path UX is wrong exactly where the command claims to be ready to paste.
  Fix sketch: render shell-safe placeholders (`SESSION_NAME`, `"/abs/path/to/repo"`, or quoted tokens) and add a shell-parse test instead of snapshotting the broken string.

- [P1] `plugins/codex-team/src/daemon/handlers/session.ts:680` — relative `--cwd` is resolved against the daemon process cwd, not the caller's cwd, while CLI preflight in `plugins/codex-team/src/cli/run.ts:804` validates the raw relative path from the caller side.
  Why it's P1: once the daemon is already running from a different directory, `session new --cwd ../repo` can validate on the CLI and still resolve to the wrong directory on the daemon, contradicting the documented "current dir" contract.
  Fix sketch: canonicalize `--cwd` in the CLI before dispatch (or send the caller cwd explicitly) so both preflight and daemon resolution use the same absolute path.

- [P1] `plugins/codex-team/src/logger.ts:19` — the logger opens a long-lived append stream with neither an `'error'` handler nor a reopen strategy, so bad log destinations can crash the daemon and rename-based rotation strands writes on the old inode.
  Why it's P1: this can wedge daemon logging or the daemon itself during ordinary admin actions (`daemon.log_path` changes, external logrotate), and the failure mode is silent until logs are needed.
  Fix sketch: attach a stream error handler with fallback-to-stderr behavior, and reopen the file on rotation or implement an explicit rotation policy.

## P2 — polish / smell / docs drift
- [P2] `plugins/codex-team/src/profiles/builtin.ts:53` — the bundled `tester` profile omits `npm run test*` from `auto_approve`, but the skill library documents that pattern and the role is explicitly positioned as the generic "runs tests" preset.
  Why it's P2: this is a small but user-visible mismatch in the canonical profile bundle rather than a crash or protocol error.
  Fix sketch: either add `npm run test*` to the builtin `tester` profile or update the skill docs so the library and CLI output match exactly.

## Contract drift (docs vs code)
- `skill:plugins/codex-team/skills/configure-codex-team/profiles.md:23` says `--profile <name>` is exposed on `session attach`, but code at `plugins/codex-team/src/daemon/handlers/session.ts:115` ignores that flag and help at `plugins/codex-team/src/cli/help.ts:615` does not advertise it.
- `skill:plugins/codex-team/skills/configure-codex-team/profiles-library.md:5` says `profiles show <name>` prints a ready-to-copy command, but code at `plugins/codex-team/src/profiles/builtin.ts:72` renders shell-active `<...>` placeholders that are not paste-safe.
- `skill:plugins/codex-team/skills/configure-codex-team/profiles-library.md:70` says the `tester` bundle includes `npm run test*`, but code at `plugins/codex-team/src/profiles/builtin.ts:46` emits an `auto_approve` string without that pattern.
- `skill:plugins/codex-team/skills/recover-codex-team/known-quirks.md:89` says `daemon logs --follow` survives rename-based log rotation, but code at `plugins/codex-team/src/logger.ts:19` keeps writing to the old file descriptor and never reopens the rotated path.

## Test gaps
- `tests/profiles.test.ts` — missing a shell-safety/executability check for the rendered `profiles show --short` command, and missing parity assertions between builtin profiles and `skills/configure-codex-team/profiles-library.md`.
- `tests/cli-cwd-preflight.test.ts` and `tests/session-cwd-preflight.test.ts` — missing cases where the daemon cwd differs from the caller cwd, plus symlinked and space-containing `--cwd` values.
- `tests/logger.test.ts` and `tests/daemon-handlers-more.test.ts` — missing coverage for `WriteStream` error events and rename-based log rotation behavior.
- no suite currently exercises `session attach --profile ...`, so the documented silent no-op is easy to miss.

## Notes
- Focused suites passed locally: `profiles`, `logger`, `version-ssot`, `paths-and-args`, `help`, `short-format`, `compact-format`, `cli-cwd-preflight`, `session-cwd-preflight`, and `cohort` (134 tests total).
- `plugins/codex-team/src/version.ts` is currently a good SSOT wrapper around `package.json`; `tests/version-ssot.test.ts` also keeps `.claude-plugin/plugin.json` aligned. The only version-related drift I saw was the README bump example still showing `0.5.3` at `README.md:213`.
- I did not find a concrete issue in `plugins/codex-team/src/errors.ts`; the flat `ErrorCode` taxonomy and helper constructors are internally consistent in this slice.
