# REVIEW R4 Round 2 — config + build re-audit

## Validation

- `CODEX_TEAM_DATA_DIR=$(mktemp -d ...) node plugins/codex-team/dist/main.js version` returned `{"ok":true,"data":{"cli_version":"0.5.1","daemon_version":null}}`, so the checked-in bundle still resolves runtime version metadata correctly.
- `npm run build` could not be completed in this worktree because `tsup` is not installed locally (`sh: 1: tsup: not found`).
- `npm test -- --run` could not be completed in this worktree either: all 3 requested loop runs failed immediately with `sh: 1: vitest: not found`.
- A direct live-daemon check of `dist/main.js daemon status --short` under an isolated temp `CODEX_TEAM_DATA_DIR` timed out in this sandbox, so the `--short` verdict below is from handler/formatter code plus test coverage rather than a live daemon transcript.
- Linux dry-run for `scripts/bump-version.mjs` was verified in a temp git repo with a stubbed `npm`: it updated `package.json` and `.claude-plugin/plugin.json`, invoked `npm run build`, and did so from `plugins/codex-team`. `plugins/codex-team/scripts/bump-version.sh` is gone.

## Round-1 Verdicts

- Fixed — **B. session `--auto-approve` regex not validated**
  Config-level validation is still enforced by `ConfigStore` in `plugins/codex-team/src/daemon/config.ts:36-41`. Session-level validation now exists on both raw CLI input and inherited session arrays: `session:new` validates `--auto-approve` before persisting (`plugins/codex-team/src/daemon/handlers/session.ts:59-60`, `576-615`), `session:attach`/`session:fork` revalidate inherited arrays before reuse (`plugins/codex-team/src/daemon/handlers/session.ts:110-123`, `253-286`), and persisted invalid arrays are dropped on load (`plugins/codex-team/src/daemon/sessions.ts:431-446`). Regression coverage exists for bad `session:new`, attach, fork, and persisted-session cases (`plugins/codex-team/tests/session-handlers.test.ts:205-231`, `425-545`; `plugins/codex-team/tests/session-registry.test.ts:57-83`).

- Fixed — **M1. `daemon status` missing `session_count`**
  `daemonStatus()` now returns `session_count` (`plugins/codex-team/src/daemon/handlers/daemon.ts:13-33`), and the short formatter consumes that field (`plugins/codex-team/src/format/short.ts:56-63`). Integrated coverage now asserts the compact output contains `sessions=3` from real `daemonStatus()` output (`plugins/codex-team/tests/short-format.test.ts:156-176`).

- Fixed — **M2. `bump-version.sh` bash-only**
  `package.json` now points at `node scripts/bump-version.mjs` (`plugins/codex-team/package.json:10-17`). The new script uses only Node built-ins, updates both JSON manifests, and runs `npm run build` from `pluginDir` (`plugins/codex-team/scripts/bump-version.mjs:10-18`, `30-39`, `42-52`). Temp Linux dry-run confirmed the build is launched from `plugins/codex-team`, and repo search finds no remaining `plugins/codex-team/scripts/bump-version.sh` entrypoint.

- Fixed — **M3. `docs/设计文档.md` stale config table**
  The design doc’s config table is now key-complete against current `CONFIG_KEYS`: 23 documented keys vs. 23 live keys, with no missing or extra entries. Source of truth is `plugins/codex-team/src/daemon/config.ts:23-56`; doc table is `plugins/codex-team/docs/设计文档.md:392-416`. I also checked the FX1 delta directly: approval-cancellation/lifecycle work did not add any new config keys to `CONFIG_KEYS`.

- Fixed — **M4. No post-build SSOT integration test**
  `plugins/codex-team/tests/version-ssot.test.ts:15-48` now runs `dist/main.js version`, parses the JSON result, compares `cli_version` to `package.json`, and explicitly skips when `dist/main.js` is absent (`plugins/codex-team/tests/version-ssot.test.ts:21-25`). That closes the original “no built-bundle runtime check” gap.

- Fixed — **N1. `renderContext` coverage**
  Snapshot coverage now includes a dedicated `context` fixture path in `plugins/codex-team/tests/markdown-snapshot.test.ts:7-73`, and the expected snapshot exercises rendered `thread.turns` content in `plugins/codex-team/tests/fixtures/markdown/context-with-turns.expected.md:1-25`. Determinism is handled by freezing system time in the snapshot suite (`plugins/codex-team/tests/markdown-snapshot.test.ts:50-58`).

## New Findings

- Medium — `plugins/codex-team/tests/version-ssot.test.ts:15-48`, `plugins/codex-team/.claude-plugin/plugin.json:1-13`, `plugins/codex-team/scripts/bump-version.mjs:30-31`
  The new SSOT coverage stops at `package.json`: it proves `VERSION` and the built CLI agree with `package.json`, but it never asserts `.claude-plugin/plugin.json.version` matches the same release version. Because the release script updates `plugin.json` separately, a manual edit or partial cherry-pick can leave plugin metadata stale while all current SSOT tests still pass.
  Fix hint: extend `version-ssot.test.ts` (or add a focused release-metadata test) to assert `package.json.version === .claude-plugin/plugin.json.version` alongside the existing dist runtime check.
