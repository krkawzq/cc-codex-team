# Gap: no way to enable `askUserQuestion` tool from codex-team session creation

## Symptom

Three test sessions with different sandbox/approval combos all failed to invoke `askUserQuestion`:

| session | sandbox | approval | result |
|---|---|---|---|
| test-askq | read-only | never | codex: "askUserQuestion is unavailable in this mode" |
| test-askq2 | workspace-write | never | codex: "`askUserQuestion` isn't available in this mode" |
| test-askq3 | workspace-write | on-request | codex: "`askUserQuestion` isn't available in this mode" |

Prompt was identical: "Use the askUserQuestion tool to ask me: 'What is your favorite primary color?' with options red/green/blue. Wait for my answer."

## Status of codex-team's server-side plumbing

Code review confirms the round-trip is implemented. The gap is purely "codex never calls the tool":

- **Event normalization**: `src/daemon/normalize.ts:REQUEST_MAP` maps `item/tool/requestUserInput` → `user_input.request`. ✅
- **Server-initiated request handling**: `src/daemon/wire.ts:server_request` listener registers pending + emits `user_input.request` event with `request_id`. ✅
- **Pending registry**: `src/daemon/pending.ts` stores jsonrpc_id, user, session, raw payload. ✅
- **Response path**: `src/daemon/handlers/message.ts:messageAnswer` validates kind, builds response, calls `pending.client.respond(jsonrpc_id, payload)`. ✅
- **Shortcut for single question**: `buildAnswerResponse` constructs `{answers: {<qid>: {answers: [inline]}}}` when request has exactly one question. ✅
- **Design doc `docs/codex-app-server-protocol.md:344`** marks the RPC **EXPERIMENTAL**.

All infrastructure is there. End-to-end verification blocked on codex not exposing the tool.

## Root cause (hypothesis)

The `askUserQuestion` tool is flagged EXPERIMENTAL in codex app-server. Enabling it likely requires:

1. A codex config flag (`~/.codex/config.toml`): maybe `[tools.ask_user_question] enabled = true` or a feature flag
2. Or a CLI argument to `codex app-server`: e.g., `--experimental-tools ask-user-question`
3. Or a `thread/start` parameter that codex-team currently does not pass

codex-team has `AppServerOptions.configOverrides` (`src/codex/appServerClient.ts:L22`) — passed as `--config key=value` CLI args to `codex app-server`. But there's no codex-team-level CLI flag to set these overrides per session. And `buildThreadStartParams` in `src/daemon/handlers/session.ts` does not include any tool-enabling field.

## What should be fixed

### Short term

Add an investigation task: examine codex's config surface to find the exact opt-in mechanism for askUserQuestion, then surface it through codex-team:

```bash
codex-team -b $TOK session new X --enable-ask-user-question
# or equivalently
codex-team -b $TOK session new X --experimental-tools ask-user-question
```

Under the hood: pass the appropriate `configOverrides` / `thread/start` param through to codex app-server.

### Longer term

Generalize experimental-tool opt-in:

```
--experimental-tools <csv>   # comma-separated experimental tool ids to enable
```

And expose `daemon config set experimental.default_tools <csv>` for a per-user default that auto-applies to new sessions.

Document in `configure-codex-team/cli-reference.md` + `docs/设计文档.md` section "命令 → session new".

## Runtime verification once the tool is enabled

After the fix, re-run the three-sandbox test. Expect one session to produce `user_input.request` event with the color question, then respond via:

```bash
codex-team -b $TOK message answer <session> <request_id> "green"
```

and observe codex continues the turn with "Got it, your favorite is green."

## Priority

Major for agent orchestration use cases (worker → ask user → user → worker continues). Without the tool, codex just answers inline or refuses. Minor for single-shot scripts where the agent is expected to not ask questions.

## Reported by

Claude orchestrator during 2026-04-22 dogfood run.
