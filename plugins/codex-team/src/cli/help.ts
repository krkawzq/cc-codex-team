export const HELP_TEXT = `codex-team — cli + daemon for orchestrating codex app-server sessions

USAGE
  codex-team -b <token> <command> [args] [flags]

GLOBAL FLAGS
  -b, --bearer <token>     user identity (required, except for 'daemon' subcommands)
  -v, --verbose            cli debug logs to stderr
  --daemon-sock <path>     override daemon sock path (for debug/test isolation)
  -h, --help               show this help

TOP-LEVEL
  version                  print cli + daemon version
  status                   summary of current user (requires -b)

COMMAND GROUPS
  daemon   <subcmd>        daemon-level management (no -b needed)
  session  <subcmd>        session management
  message  <subcmd>        message / turn operations on a live session
  monitor  <subcmd>        event subscription & alarms

Run 'codex-team <group> --help' for details on each group.
Full specification: plugins/codex-team/docs/设计文档.md
`;

const GROUP_HELP: Record<string, string> = {
  daemon: `codex-team daemon — daemon management

USAGE
  codex-team daemon <subcmd> [flags]

SUBCOMMANDS
  status
  start
  stop [--force]
  restart
  logs [--n <N>] [--level <level>] [--follow]
  user create <token>
  user destroy <token>
  user list
  config get <key>
  config set <key> <value>
  config unset <key>
  config list [--explicit-only]
  config reset --yes
`,
  session: `codex-team session — live session management

USAGE
  codex-team -b <token> session <subcmd> [args] [flags]

SUBCOMMANDS
  new [name]
  attach <name|thread_id> [--takeover]
  detach <name|thread_id> [--graceful]
  fork <name|thread_id> [new_name] [--at-turn <turn_id>]
  rename <name|thread_id> <new_name>
  info <name|thread_id>
  context <name|thread_id> [--format json|markdown]
  list [--all] [--sort <field>] [--format json|table]
`,
  message: `codex-team message — turn operations on a live session

USAGE
  codex-team -b <token> message <subcmd> [args] [flags]

SUBCOMMANDS
  send <session> <text>|--file <path>|--stdin [--attach <image>...]
  peer <session> <text>|--file <path>|--stdin [--attach <image>...]
  interrupt <session>
  approval <session> <request_id> <shortcut>|--json <payload>|--file <path>|--stdin
  answer <session> <request_id> <text>|--json <payload>|--file <path>|--stdin
  history <session> [--since <cursor|-N>] [--limit <N>] [--format json|markdown]
  tail <session> [--n <N>] [--follow] [--format json|markdown]
`,
  monitor: `codex-team monitor — event streams and alarms

USAGE
  codex-team -b <token> monitor <subcmd> [args] [flags]

SUBCOMMANDS
  events [--stream|--follow] [--since <event_id>] [--interval <seconds>]
  alarm <session> <command> [--interval <seconds>] [--timeout <seconds>]
`,
};

export function helpTextFor(commandPath: string[]): string {
  if (commandPath.length === 1) {
    return GROUP_HELP[commandPath[0]] ?? HELP_TEXT;
  }
  return HELP_TEXT;
}
