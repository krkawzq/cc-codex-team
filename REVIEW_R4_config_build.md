# REVIEW R4 — config + build + tests

## Validation

- `npm run build` could not be rerun in this worktree because `plugins/codex-team/node_modules` is absent and `tsup` is not installed.
- `npm run typecheck` could not be rerun because `@types/node` is not installed in this worktree.
- `npm test` could not be rerun because `vitest` is not installed in this worktree.
- Manual runtime checks against the checked-in bundle did work: `node plugins/codex-team/dist/main.js version` returned `cli_version: 0.5.1`, and a temp copied `dist/main.js` plus `package.json` pair also resolved `0.5.1`.

## Blockers

- High — `plugins/codex-team/src/daemon/handlers/session.ts:568-575`, `plugins/codex-team/src/daemon/sessions.ts:299-305`, `plugins/codex-team/src/daemon/auto-approve.ts:42-64`, `plugins/codex-team/src/daemon/wire.ts:302-323`
  `session new --auto-approve` parses raw patterns but never validates regex literals. An invalid value such as `/unterminated` is persisted onto the session record, and the first approval request that touches that pattern will throw out of `matchAutoApprovePattern()`. The outer `server_request` catch only logs the failure, so the request is neither auto-approved nor registered as pending. This means the daemon-default config path is validated, but the explicit per-session path can still poison approval handling.
  Fix hint: run the same validator used by `ConfigStore` before persisting session-supplied patterns, reject invalid values with `invalid_params`, and add a regression test for bad CLI/session patterns plus bad persisted arrays.

## Majors

- High — `plugins/codex-team/src/daemon/handlers/daemon.ts:13-27`, `plugins/codex-team/src/format/short.ts:41-52`, `plugins/codex-team/tests/short-format.test.ts:27-37`, `plugins/codex-team/tests/daemon-handlers-more.test.ts:76-98`
  `daemonStatus()` never returns `session_count`, but the `--short` formatter and the audit contract both expect it. In real runtime output, `codex-team daemon status --short` will therefore print `sessions=unknown`. The current tests miss this because the formatter is tested with a synthetic payload and the handler test never asserts the field.
  Fix hint: include `session_count` in the handler result, using the same per-user aggregation pattern already used in `src/daemon/run.ts:91-93`, and add an integrated handler/CLI short-output assertion.

- High — `plugins/codex-team/package.json:12`, `plugins/codex-team/scripts/bump-version.sh:1-55`
  `npm run bump-version` hard-depends on `bash` and Bash-specific features (`[[ ... ]]`, `${BASH_SOURCE[0]}`, heredoc usage). That works on Linux and typically on macOS, but it does not run in a native Windows shell, even though this package otherwise carries explicit Windows support.
  Fix hint: move the release entrypoint to a Node script such as `node scripts/bump-version.mjs`, or provide a documented cross-platform wrapper instead of requiring Bash.

- High — `plugins/codex-team/docs/设计文档.md:390-409`, `plugins/codex-team/src/daemon/config.ts:23-57`
  The config registry documentation is stale. The table omits `daemon.ready_timeout_seconds`, the full `daemon.connect_*` group, `session.auto_approve_command_patterns`, and `experimental.default_tools`, so operators consulting the design doc will not see several supported keys.
  Fix hint: generate this table from `CONFIG_KEYS`, or update the doc in the same change that adds or removes config keys.

- Medium — `plugins/codex-team/tests/version-ssot.test.ts:5-9`, `plugins/codex-team/package.json:11-17`
  The SSOT coverage only checks source-time `VERSION === require("../package.json").version`. Nothing in CI appears to execute the built CJS bundle and verify that `dist/main.js` still resolves `../package.json` correctly after `tsup` runs. The checked-in artifact works today, but that guarantee is manual, not automated.
  Fix hint: add a post-build integration test that runs `node dist/main.js version` and compares the reported CLI version to `package.json`, or run the same assertion against a temp copied `dist` + `package.json` package layout.

## Nits

- Medium — `plugins/codex-team/src/format/markdown.ts:96-109`, `plugins/codex-team/tests/status-and-format.test.ts:84-89`, `plugins/codex-team/tests/markdown-snapshot.test.ts:54-67`
  The `renderContext()` branch that walks `thread.turns` is not covered explicitly. Current tests exercise context metadata without `turns`, and snapshot coverage only covers `item`, `history`, and `tail`, not `context`.
  Fix hint: add a focused `renderContext` test or snapshot with a populated `thread.turns` payload.

## Non-findings

- `plugins/codex-team/src/version.ts:1-7` and the checked-in `plugins/codex-team/dist/main.js` currently resolve `package.json` correctly from the bundle location; the runtime SSOT itself looks sound.
- `plugins/codex-team/src/daemon/config.ts:73-87` and `214-233` re-validate persisted config values on load, so an invalid `session.auto_approve_command_patterns` string injected directly into `config.json` is dropped rather than applied.
- `plugins/codex-team/src/paths.ts:149-168` gates the legacy HOME probe on `platform === "win32"`, and `plugins/codex-team/tests/paths-windows-legacy.test.ts:48-67` covers the non-Windows suppression path. A weird Linux `HOME` override does not trigger the Windows warning logic.
- `plugins/codex-team/src/daemon/handlers/daemon.ts:328-380` derives dist freshness from `PACKAGE_ROOT/dist/main.js` and only walks `PACKAGE_ROOT/src`, so it does not recurse through repo-level `.git`, `dist`, or `node_modules`.
- `plugins/codex-team/scripts/bump-version.sh:31-38` parses and re-serializes JSON, so trailing newlines and unusual indentation in `.claude-plugin/plugin.json` do not break the version bump; the tradeoff is that original formatting is normalized.
- `plugins/codex-team/tsconfig.json:2-15` already has `strict: true`, and I did not find any `@ts-ignore` or `@ts-expect-error` comments in the package.
- I did not find obvious parallel-test collisions from shared `/tmp/codex-team-*` paths; the suite generally uses `fs.mkdtempSync(...)` with unique prefixes rather than fixed directories.
