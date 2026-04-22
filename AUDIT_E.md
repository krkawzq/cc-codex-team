# AUDIT_E

## Version SSOT
- Added `plugins/codex-team/src/version.ts` as the runtime source of truth.
- `VERSION` is loaded from `../package.json`, which resolves correctly from both `src/` in tests and bundled `dist/main.js` at runtime.
- Runtime version reporting now flows through `VERSION` in the CLI, daemon status/version handlers, and the default Codex app-server `clientInfo`.
- `.claude-plugin/plugin.json` stays non-runtime data; it is synchronized by the release script instead of being read by the daemon or CLI.

## Dist Freshness
- `daemon:status` now reports `dist_built_at`, `dist_age_seconds`, and `source_newer_than_dist`.
- `dist_built_at` and `dist_age_seconds` come from the filesystem mtime of `plugins/codex-team/dist/main.js`.
- `source_newer_than_dist` compares that dist mtime with the newest file mtime found under `plugins/codex-team/src/`.
- If `dist/main.js` is missing, all three freshness fields return `null`.
- If `src/` is unavailable in an installed environment, `source_newer_than_dist` returns `null` while dist metadata still reports when available.
- This keeps the freshness signal passive: no new CLI flag, just extra data on existing daemon status output.

## Spawn Stderr
- `ensureDaemon` still does a clean detached spawn first with `stdio: "ignore"`.
- If the daemon is still unreachable after the configured timeout, the CLI retries once with `--stderr-to <stable-path>`.
- That retry also wires child stderr to a stable file descriptor so early startup failures are preserved even before logging is configured.
- The final CLI error now points operators at the captured stderr path instead of only reporting `daemon_unreachable`.

## Bump Script
- Added `plugins/codex-team/scripts/bump-version.sh` and `npm run bump-version`.
- The script requires a target version and refuses to proceed on a dirty tree unless `-y` is supplied.
- It updates `package.json` and `.claude-plugin/plugin.json`, runs `npm run build`, and prints the changed release files plus the suggested commit command.
- It intentionally does not create a commit, so Phase 4 can review and commit the release explicitly.
