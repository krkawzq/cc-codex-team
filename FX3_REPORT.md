# FX3 Report

Branch: `0.5.2-FX3-config-docs`
Base: `0.5.2-integration @ 3a8ee18`
Scope: FX3 config + build + docs fixes (Phase 2b)

## Completed

1. R4 M1: `daemon status` now returns `session_count`, aggregated across users from live sessions.
2. R4 M2: replaced the Bash-only version bump helper with cross-platform `plugins/codex-team/scripts/bump-version.mjs`, updated `package.json`, and removed `bump-version.sh`.
3. R4 M3: refreshed the config-key table in `plugins/codex-team/docs/设计文档.md` so it covers the full current registry.
4. R4 M4: extended `tests/version-ssot.test.ts` with a post-build runtime check against `dist/main.js version`, with a graceful skip if `dist/main.js` is absent.
5. R4 N1: added `renderContext` snapshot coverage for populated `thread.turns`.
6. R3 N1: added an event-id overflow guard in `src/daemon/events.ts` that logs an error, emits a one-shot warning event, and refuses further appends once the soft limit is exceeded.

## Files Changed

- `plugins/codex-team/src/daemon/handlers/daemon.ts`
- `plugins/codex-team/src/daemon/events.ts`
- `plugins/codex-team/scripts/bump-version.mjs`
- `plugins/codex-team/package.json`
- `plugins/codex-team/docs/设计文档.md`
- `plugins/codex-team/tests/daemon-handlers-more.test.ts`
- `plugins/codex-team/tests/daemon-status-dist-age.test.ts`
- `plugins/codex-team/tests/events.test.ts`
- `plugins/codex-team/tests/short-format.test.ts`
- `plugins/codex-team/tests/version-ssot.test.ts`
- `plugins/codex-team/tests/markdown-snapshot.test.ts`
- `plugins/codex-team/tests/fixtures/markdown/context-with-turns.json`
- `plugins/codex-team/tests/fixtures/markdown/context-with-turns.expected.md`
- `plugins/codex-team/dist/main.js`

## Verification

Ran in `plugins/codex-team`:

- `npm ci`
- `npm run build`
- `npm test`
- `npm run typecheck`

Result: all tests passed and `tsc --noEmit` passed.

## Residual

- I did not add the optional `check-config-doc.mjs` drift checker. The config table itself has been refreshed to match the current registry, but drift prevention remains manual.

## Notes

- No version bump was performed.
- No push or merge was performed.
