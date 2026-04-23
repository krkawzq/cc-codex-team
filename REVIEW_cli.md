# Review: cli (0.5.5 dogfood)

## P0 — crash / data loss / security / protocol
- none

## P1 — wrong behavior
- [P1] plugins/codex-team/src/cli/args.ts:139 — global flags that require values (`-b`, `--bearer`, `--daemon-sock`) accept the next flag token as the value instead of treating it as a missing-value error.
  Why it's P1: normal typos like `codex-team -b --help status` or `codex-team --daemon-sock --verbose daemon status` silently change routing instead of failing fast with a stable `invalid_params`.
  Fix sketch: reject flag-like follow-on tokens for required-value globals, mirroring `takeOptionValue()` in `src/main.ts`.

- [P1] plugins/codex-team/src/cli/run.ts:115 — CLI-side approval shortcut validation rewrites invalid decisions into `invalid_params` and exits `2`, even though the daemon contract uses `invalid_decision` for the same class of failure.
  Why it's P1: machine callers cannot rely on a stable error code or exit code for bad approval shortcuts, and the CLI disagrees with both the documented contract and the daemon handler.
  Fix sketch: emit `err("invalid_decision", ...)` here and keep the exit path aligned with other CLI validation failures unless there is a documented reason to reserve `2`.

- [P1] plugins/codex-team/src/cli/doctor.ts:462 — plugin-mode launcher detection hard-codes `${CLAUDE_PLUGIN_ROOT}/plugins/codex-team`, but the shipped launcher script resolves `${CLAUDE_PLUGIN_ROOT}` as the plugin root directly.
  Why it's P1: in the layout implied by `bin/codex-team` and the skill docs, `doctor` falsely reports `codex-team not on PATH`, turning the main support command into a misleading DEGRADED result in plugin mode.
  Fix sketch: accept both layouts or derive the expected bundled launcher path from `ctx.packageRoot` / `ctx.invokedAs` instead of appending `plugins/codex-team` blindly.

## P2 — polish / smell / docs drift
- [P2] plugins/codex-team/src/cli/run.ts:149 — `version --full` is advertised by the generic leaf-help machinery, but `runVersion()` always renders the concise one-line body and ignores the flag entirely.
  Why it's P2: small output-contract inconsistency; users following `version --help` cannot actually opt into the documented verbose mode.
  Fix sketch: thread `parsed.flags.full` into `runVersion()` or opt `version` out of the auto-added `--full` flag.

- [P2] plugins/codex-team/src/cli/doctor.ts:340 — hidden `doctor --json` wraps success as `{ok:true,data:{...}}`, unlike the rest of the CLI's successful JSON outputs, which return the body directly.
  Why it's P2: scripts cannot share one success-parser across `doctor --json` and the rest of the CLI, even though errors consistently use the shared envelope.
  Fix sketch: either emit `{verdict, checks, exit_code}` directly or document the wrapper as an explicit special case in help/docs.

- [P2] plugins/codex-team/bin/codex-team:14 — the launcher only checks that `dist/main.js` exists; it does not proactively gate unsupported/missing `node` or warn on stale `dist`, despite `doctor` having dedicated checks for both.
  Why it's P2: this is mostly a dogfood/developer-smell issue, but it leaves the wrapper failing late with shell/runtime errors or silently running old JS.
  Fix sketch: add a lightweight preflight in the launcher (or a shared helper) for `node >=18` and stale-build detection before `exec node`.

## Contract drift (docs vs code)
- skill:plugins/codex-team/skills/configure-codex-team/cli-reference.md:13 says `--short` is available on `daemon config list/get`, but code at plugins/codex-team/src/cli/args.ts:270 and plugins/codex-team/src/cli/run.ts:71 rejects `--short` for both methods.

- skill:plugins/codex-team/skills/configure-codex-team/cli-reference.md:29 says `--full` is a global flag, but code at plugins/codex-team/src/cli/args.ts:82 only treats `bearer`, `verbose`, `help`, and `daemonSock` as globals; `doctor` also rejects `--full` explicitly at plugins/codex-team/src/cli/run.ts:79.

- skill:plugins/codex-team/skills/configure-codex-team/cli-reference.md:298 says bad approval shortcuts return `invalid_decision`, but code at plugins/codex-team/src/cli/run.ts:115 emits `invalid_params` instead.

- skill:plugins/codex-team/skills/configure-codex-team/cli-reference.md:42 says `doctor` is `codex-team doctor [--short]`, but code at plugins/codex-team/src/cli/run.ts:69 and plugins/codex-team/src/cli/doctor.ts:340 also accepts an undocumented `--json` mode with a different success envelope.

- skill:plugins/codex-team/skills/using-codex-team/quickstart.md:74 says raw plugin invocations use `node "${CLAUDE_PLUGIN_ROOT}/dist/main.js"`, but code at plugins/codex-team/src/cli/doctor.ts:462 only recognizes plugin mode when the launcher lives under `${CLAUDE_PLUGIN_ROOT}/plugins/codex-team/bin/`.

## Test gaps
- `paths-and-args.test.ts` — missing case where `-b` / `--daemon-sock` is followed by another flag token, which is the parser bug in `args.ts:139`.

- `cli-run.test.ts` — the invalid approval shortcut test checks the message and exit code, but does not assert the returned error code, so `invalid_params` vs `invalid_decision` drift is invisible.

- `paths-and-args.test.ts` / `cli-run.test.ts` — no explicit coverage for unknown subcommands such as `daemon nope` or `session nope`; only totally unknown top-level commands are pinned.

- `doctor.test.ts` — plugin-mode coverage only models `CLAUDE_PLUGIN_ROOT` as a parent directory containing `plugins/codex-team`, not the direct-plugin-root layout implied by the shipped launcher/docs.

- `help.test.ts` — spot-checks selected commands, but does not enumerate every leaf for `USAGE` / `EXAMPLES` presence or verify that all advertised `--full` leaf contracts are actually honored by the router.

- no suite exercises `plugins/codex-team/bin/codex-team` directly for missing `node`, old `node`, or stale `dist`.

## Notes
- Targeted suites passed during audit: `paths-and-args`, `help`, `cli-run`, `doctor`, `profiles`, and `version-ssot`.
