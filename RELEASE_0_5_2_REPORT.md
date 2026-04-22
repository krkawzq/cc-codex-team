# codex-team 0.5.2 release report

Date: `2026-04-23`
Branch: `0.5.2-docs`

## Doc alignment completed

Committed doc batches:

- `b6c0327` `docs(playbooks): align orchestration guides with 0.5.2`
- `d76d0a2` `docs(skills): refresh codex-team 0.5.2 guidance`
- `f3c9286` `docs(release): add codex-team 0.5.2 notes`

Updated docs:

- Playbooks: `debate.md`, `hierarchical.md`, `map-reduce.md`, `pipeline.md`, `plan-execute-verify.md`, `reflexion.md`, `solo-worker.md`, `swarm.md`, `worker-reviewer.md`, `anti-patterns.md`
- Skills: `skills/configure-codex-team/SKILL.md`, `skills/using-codex-team/SKILL.md`, `skills/manage-codex-team/SKILL.md`, `skills/recover-codex-team/SKILL.md`
- Command walkthrough: `commands/tutorial.md`
- Design doc: `docs/设计文档.md`
- Release docs: `docs/releases/0.5.2.md`, `docs/releases/0.5.2-windows-migration.md`

Main doc changes:

- Updated all orchestration guidance to prefer `message wait`, named cursors, and `monitor events --summary`
- Documented `session health`, `session heal`, `message wait`, cursor commands, `--auto-approve`, `--kind`, `--truncate`, and expanded `--short`
- Documented the compact 0.5.2 `turn.completed` payload and the new crash/close/cancellation events
- Added 0.5.2 release notes plus the Windows migration cross-link

## Version bump completed

Artifacts updated:

- `plugins/codex-team/package.json` -> `0.5.2`
- `plugins/codex-team/.claude-plugin/plugin.json` -> `0.5.2`
- `plugins/codex-team/dist/main.js` rebuilt by `npm run build`

Command run:

- `npm ci`
- `npm run bump-version -- 0.5.2 -y`

Verification:

- `node dist/main.js --daemon-sock /tmp/codex-team-0.5.2-version.sock version`
  - returned `{"ok":true,"data":{"cli_version":"0.5.2","daemon_version":null}}`
- `npm test`
  - passed: `47` files, `253` tests
- `npm run typecheck`
  - passed

## Final state

- Docs aligned with the integrated 0.5.2 surface
- Release notes added
- Version metadata bumped and `dist` rebuilt
- No push, tag, or merge performed
