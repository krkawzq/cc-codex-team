export interface HelpPositional {
  name: string;
  required: boolean;
  description: string;
}

export interface HelpFlag {
  long?: string;
  short?: string;
  type: string;
  default?: string;
  required?: boolean;
  description: string;
}

export interface HelpNode {
  name: string;
  summary: string;
  usage: string;
  positionals: HelpPositional[];
  flags: HelpFlag[];
  notes?: string[];
  examples: string[];
  subcommands: HelpNode[];
  needs_bearer: boolean;
}

const FULL_FLAG: HelpFlag = {
  long: "--full",
  type: "bool",
  default: "false",
  required: false,
  description: "Print the full JSON response body instead of the default concise projection.",
};

function leaf(node: Omit<HelpNode, "subcommands">): HelpNode {
  const flags = node.flags.some((flag) => flag.long === "--full")
    ? [...node.flags]
    : [...node.flags, { ...FULL_FLAG }];
  return { ...node, flags, subcommands: [] };
}

const PROMPT_SOURCE_FLAGS: HelpFlag[] = [
  {
    long: "--stdin",
    type: "bool",
    default: "false",
    required: false,
    description: "Read the prompt from stdin.",
  },
  {
    long: "--file",
    type: "path",
    required: false,
    description: "Read the prompt from a file.",
  },
  {
    long: "--attach",
    type: "path[]",
    required: false,
    description: "Attach input files such as images.",
  },
];

const JSON_RESPONSE_FLAGS: HelpFlag[] = [
  {
    long: "--json",
    type: "string",
    required: false,
    description: "Pass the full JSON response inline.",
  },
  {
    long: "--file",
    type: "path",
    required: false,
    description: "Read the full JSON response from a file.",
  },
  {
    long: "--stdin",
    type: "bool",
    default: "false",
    required: false,
    description: "Read the full JSON response from stdin.",
  },
];

const SESSION_TARGET: HelpPositional = {
  name: "name|thread_id",
  required: true,
  description: "Session name or thread ID.",
};

const LIVE_SESSION_TARGET: HelpPositional = {
  name: "name|thread_id",
  required: true,
  description: "Target live session name or thread ID.",
};

const LIVE_SESSION_TARGETS: HelpPositional = {
  name: "name|thread_id...",
  required: true,
  description: "One or more live session names or thread IDs.",
};

const REQUEST_ID: HelpPositional = {
  name: "request_id",
  required: true,
  description: "Request ID from event payload.request_id.",
};

const daemonUserGroup: HelpNode = {
  name: "user",
  summary: "Manage daemon users keyed by bearer token.",
  usage: "codex-team daemon user <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team daemon user list",
  ],
  subcommands: [
    leaf({
      name: "create",
      summary: "Create a daemon user for a bearer token.",
      usage: "codex-team daemon user create <token>",
      positionals: [
        {
          name: "token",
          required: true,
          description: "Bearer token for the new user.",
        },
      ],
      flags: [],
      examples: [
        "codex-team daemon user create agent-a",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "destroy",
      summary: "Delete a daemon user and its tracked state.",
      usage: "codex-team daemon user destroy <token> [flags]",
      positionals: [
        {
          name: "token",
          required: true,
          description: "Bearer token for the user to delete.",
        },
      ],
      flags: [
        {
          long: "--force",
          type: "bool",
          default: "false",
          required: false,
          description: "Delete the user even if live sessions remain.",
        },
      ],
      examples: [
        "codex-team daemon user destroy agent-a --force",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "list",
      summary: "List all daemon users and their activity.",
      usage: "codex-team daemon user list [flags]",
      positionals: [],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact line per user to stdout.",
        },
      ],
      examples: [
        "codex-team daemon user list",
      ],
      needs_bearer: false,
    }),
  ],
  needs_bearer: false,
};

const daemonConfigGroup: HelpNode = {
  name: "config",
  summary: "Read and update daemon configuration.",
  usage: "codex-team daemon config <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team daemon config set codex.default_model gpt-5.4",
  ],
  subcommands: [
    leaf({
      name: "get",
      summary: "Read one daemon configuration key.",
      usage: "codex-team daemon config get <key>",
      positionals: [
        {
          name: "key",
          required: true,
          description: "Config key such as daemon.idle_shutdown_hours.",
        },
      ],
      flags: [],
      examples: [
        "codex-team daemon config get codex.default_model",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "set",
      summary: "Set one daemon configuration key.",
      usage: "codex-team daemon config set <key> <value>",
      positionals: [
        {
          name: "key",
          required: true,
          description: "Config key to write.",
        },
        {
          name: "value",
          required: true,
          description: "Value parsed according to the key type.",
        },
      ],
      flags: [],
      examples: [
        "codex-team daemon config set monitor.default_interval_seconds 10",
        "codex-team daemon config set session.auto_approve_command_patterns 'git*,node *'",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "unset",
      summary: "Restore one daemon configuration key to default.",
      usage: "codex-team daemon config unset <key>",
      positionals: [
        {
          name: "key",
          required: true,
          description: "Config key to reset.",
        },
      ],
      flags: [],
      examples: [
        "codex-team daemon config unset codex.default_model",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "list",
      summary: "List daemon configuration values and sources.",
      usage: "codex-team daemon config list [flags]",
      positionals: [],
      flags: [
        {
          long: "--explicit-only",
          type: "bool",
          default: "false",
          required: false,
          description: "Show only keys set explicitly by the user.",
        },
      ],
      examples: [
        "codex-team daemon config list --explicit-only",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "reset",
      summary: "Reset every daemon configuration key to default.",
      usage: "codex-team daemon config reset [flags]",
      positionals: [],
      flags: [
        {
          long: "--yes",
          type: "bool",
          default: "false",
          required: true,
          description: "Confirm the full reset operation.",
        },
      ],
      examples: [
        "codex-team daemon config reset --yes",
      ],
      needs_bearer: false,
    }),
  ],
  needs_bearer: false,
};

const daemonGroup: HelpNode = {
  name: "daemon",
  summary: "Manage the shared daemon and daemon-owned resources.",
  usage: "codex-team daemon <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team daemon status",
    "codex-team daemon logs -f --level warn",
  ],
  subcommands: [
    leaf({
      name: "status",
      summary: "Show daemon process, socket, and resource status.",
      usage: "codex-team daemon status [flags]",
      positionals: [],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact status line to stdout.",
        },
      ],
      examples: [
        "codex-team daemon status",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "start",
      summary: "Start the daemon if it is not already running.",
      usage: "codex-team daemon start",
      positionals: [],
      flags: [],
      examples: [
        "codex-team daemon start",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "stop",
      summary: "Stop the daemon and persist its state.",
      usage: "codex-team daemon stop [flags]",
      positionals: [],
      flags: [
        {
          long: "--force",
          type: "bool",
          default: "false",
          required: false,
          description: "Kill the daemon without detach or persistence.",
        },
      ],
      examples: [
        "codex-team daemon stop --force",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "restart",
      summary: "Restart the daemon.",
      usage: "codex-team daemon restart",
      positionals: [],
      flags: [],
      examples: [
        "codex-team daemon restart",
      ],
      needs_bearer: false,
    }),
    leaf({
      name: "logs",
      summary: "Print daemon logs with optional tail-style streaming.",
      usage: "codex-team daemon logs [flags]",
      positionals: [],
      flags: [
        {
          long: "--follow",
          short: "-f",
          type: "bool",
          default: "false",
          required: false,
          description: "Stream new log lines as they arrive.",
        },
        {
          short: "-n",
          type: "int",
          default: "100",
          required: false,
          description: "Print this many trailing lines first.",
        },
        {
          long: "--level",
          type: "enum",
          required: false,
          description: "Filter by error, warn, info, debug, or trace.",
        },
      ],
      examples: [
        "codex-team daemon logs -f --level warn",
      ],
      needs_bearer: false,
    }),
    daemonUserGroup,
    daemonConfigGroup,
  ],
  needs_bearer: false,
};

const sessionGroup: HelpNode = {
  name: "session",
  summary: "Manage live Codex sessions for the current user.",
  usage: "codex-team -b <token> session <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team -b $TOKEN session list --all",
  ],
  subcommands: [
    leaf({
      name: "new",
      summary: "Create a live session with optional runtime settings.",
      usage: "codex-team -b <token> session new [name] [flags]",
      positionals: [
        {
          name: "name",
          required: false,
          description: "Human-friendly session name.",
        },
      ],
      flags: [
        {
          long: "--model",
          type: "string",
          default: "codex.default_model",
          required: false,
          description: "Model name such as gpt-5.4.",
        },
        {
          long: "--cwd",
          type: "path",
          default: "current directory",
          required: false,
          description: "Working directory for Codex.",
        },
        {
          long: "--sandbox",
          type: "enum",
          default: "codex.default_sandbox",
          required: false,
          description: "Sandbox mode for the session.",
        },
        {
          long: "--approval",
          type: "enum",
          default: "codex.default_approval",
          required: false,
          description: "Approval policy for risky actions.",
        },
        {
          long: "--effort",
          type: "enum",
          default: "codex.default_effort",
          required: false,
          description: "Reasoning effort level.",
        },
        {
          long: "--personality",
          type: "string",
          required: false,
          description: "Personality preset name.",
        },
        {
          long: "--base-instructions",
          type: "path",
          required: false,
          description: "Load system-level instructions from a file.",
        },
        {
          long: "--developer-instructions",
          type: "path",
          required: false,
          description: "Load developer instructions from a file.",
        },
        {
          long: "--profile",
          type: "string",
          required: false,
          description: "Use a Codex config profile for defaults.",
        },
        {
          long: "--experimental-tools",
          type: "csv",
          default: "experimental.default_tools",
          required: false,
          description: "Enable experimental Codex tools such as ask-user-question.",
        },
        {
          long: "--auto-approve",
          type: "csv|regex",
          required: false,
          description: "Comma-separated approval target patterns to auto-accept for this session.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN session new audit --model gpt-5.4 --cwd /repo",
        "codex-team -b $TOKEN session new --profile fast-review",
        "codex-team -b $TOKEN session new askq --experimental-tools ask-user-question",
        "codex-team -b $TOKEN session new audit --auto-approve 'git*,node *'",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "attach",
      summary: "Mark an existing Codex session as live for this user.",
      usage: "codex-team -b <token> session attach <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET },
      ],
      flags: [
        {
          long: "--takeover",
          type: "bool",
          default: "false",
          required: false,
          description: "Seize a live session from another user.",
        },
        {
          long: "--experimental-tools",
          type: "csv",
          default: "inherit session or experimental.default_tools",
          required: false,
          description: "Enable experimental Codex tools when attaching or rehydrating a thread.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN session attach th-abc123 --takeover",
        "codex-team -b $TOKEN session attach th-abc123 --experimental-tools ask-user-question",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "detach",
      summary: "Stop tracking a live session and release its runtime.",
      usage: "codex-team -b <token> session detach [<name|thread_id>|--all] [flags]",
      positionals: [
        { ...SESSION_TARGET, required: false, description: "Target session unless using --all." },
      ],
      flags: [
        {
          long: "--all",
          type: "bool",
          default: "false",
          required: false,
          description: "Detach every live session for the current bearer.",
        },
        {
          long: "--match",
          type: "glob",
          required: false,
          description: "Filter --all targets by session name using * and ? wildcards.",
        },
        {
          long: "--graceful",
          type: "bool",
          default: "false",
          required: false,
          description: "Wait for the current turn before detaching.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN session detach audit --graceful",
        "codex-team -b $TOKEN session detach --all --match 'mapper-*'",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "fork",
      summary: "Fork a session into a new live session.",
      usage: "codex-team -b <token> session fork <name|thread_id> [new_name] [flags]",
      positionals: [
        { ...SESSION_TARGET, description: "Source session name or thread ID." },
        {
          name: "new_name",
          required: false,
          description: "Name for the forked session.",
        },
      ],
      flags: [
        {
          long: "--at-turn",
          type: "string",
          default: "tip",
          required: false,
          description: "Fork from the specified turn ID.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN session fork audit audit-fix --at-turn turn-42",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "rename",
      summary: "Rename a session without attaching it.",
      usage: "codex-team -b <token> session rename <name|thread_id> <new_name>",
      positionals: [
        { ...SESSION_TARGET, description: "Current session name or thread ID." },
        {
          name: "new_name",
          required: true,
          description: "New session name.",
        },
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN session rename audit audit-review",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "info",
      summary: "Show metadata for one session.",
      usage: "codex-team -b <token> session info <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET },
      ],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact status line to stdout.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN session info audit",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "context",
      summary: "Show the compacted session context from Codex.",
      usage: "codex-team -b <token> session context <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET },
      ],
      flags: [
        {
          long: "--format",
          type: "enum",
          default: "json",
          required: false,
          description: "Render output as json or markdown.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN session context audit --format markdown",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "list",
      summary: "List live sessions or every known Codex session.",
      usage: "codex-team -b <token> session list [flags]",
      positionals: [],
      flags: [
        {
          long: "--all",
          type: "bool",
          default: "false",
          required: false,
          description: "List every known session, not only live ones.",
        },
        {
          long: "--cursor",
          type: "string",
          default: "",
          required: false,
          description: "Pagination cursor from a previous session list page.",
        },
        {
          long: "--limit",
          type: "int",
          default: "50",
          required: false,
          description: "Maximum number of sessions to return.",
        },
        {
          long: "--archived",
          type: "enum",
          default: "exclude",
          required: false,
          description: "Include archived sessions, exclude them, or return only archived sessions.",
        },
        {
          long: "--state",
          type: "string",
          default: "",
          required: false,
          description: "Comma-separated session states to keep: live, crashed, closed, archived.",
        },
        {
          long: "--owner",
          type: "string",
          default: "self",
          required: false,
          description: "Best-effort owner filter: self, any, or an explicit bearer token.",
        },
        {
          long: "--loaded-only",
          type: "bool",
          default: "false",
          required: false,
          description: "List threads currently loaded in app-server memory instead of persisted thread/list results.",
        },
        {
          long: "--sort",
          type: "enum",
          default: "last_active",
          required: false,
          description: "Sort by name, last_active, turn_count, or created_at.",
        },
        {
          long: "--format",
          type: "enum",
          default: "json",
          required: false,
          description: "Render output as json or table.",
        },
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact line per session to stdout; cannot be used with --format table.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN session list --all --format table",
        "codex-team -b $TOKEN session list --all --limit 25 --cursor abc123",
        "codex-team -b $TOKEN session list --loaded-only --owner any",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "health",
      summary: "Show a compact live health snapshot for one session.",
      usage: "codex-team -b <token> session health <name|thread_id>",
      positionals: [
        { ...SESSION_TARGET },
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN session health audit",
      ],
      notes: [
        "If the session is crashed or the app-server is dead, run 'codex-team -b <token> session heal <name|thread_id>'.",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "heal",
      summary: "Re-attach a crashed or dead live session to a fresh app-server.",
      usage: "codex-team -b <token> session heal <name|thread_id> [flags]",
      positionals: [
        { ...SESSION_TARGET },
      ],
      flags: [
        {
          long: "--force",
          type: "bool",
          default: "false",
          required: false,
          description: "Drop half-baked in-memory queue state before retrying the resume.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN session heal audit",
        "codex-team -b $TOKEN session heal audit --force",
      ],
      notes: [
        "Use 'codex-team -b <token> session health <name|thread_id>' first to inspect crash state and pending work.",
        "Healthy live sessions return { ok: true, note: \"already healthy\" }.",
      ],
      needs_bearer: true,
    }),
  ],
  needs_bearer: true,
};

const messageGroup: HelpNode = {
  name: "message",
  summary: "Send prompts and inspect turns on a live session.",
  usage: "codex-team -b <token> message <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team -b $TOKEN message history audit --limit 10",
  ],
  subcommands: [
    leaf({
      name: "send",
      summary: "Queue a prompt on a live session without interrupting it.",
      usage: "codex-team -b <token> message send <name|thread_id> [prompt] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET },
        {
          name: "prompt",
          required: false,
          description: "Prompt text when not using --stdin or --file.",
        },
      ],
      flags: PROMPT_SOURCE_FLAGS,
      examples: [
        "codex-team -b $TOKEN message send audit \"Summarize the failing tests.\"",
        "codex-team -b $TOKEN message send audit --file prompt.md --attach screenshot.png",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "send-many",
      summary: "Broadcast one prompt to multiple live sessions.",
      usage: "codex-team -b <token> message send-many <name|thread_id> <name|thread_id> [...name|thread_id] [prompt] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGETS, description: "Two or more live sessions to broadcast to." },
        {
          name: "prompt",
          required: false,
          description: "Prompt text when not using --stdin or --file.",
        },
      ],
      flags: [
        {
          long: "--stdin",
          type: "bool",
          default: "false",
          required: false,
          description: "Read the prompt from stdin.",
        },
        {
          long: "--file",
          type: "path",
          required: false,
          description: "Read the prompt from a file.",
        },
      ],
      notes: [
        "Requires at least two explicit targets.",
      ],
      examples: [
        "codex-team -b $TOKEN message send-many audit lint typecheck \"Run all pending checks.\"",
        "codex-team -b $TOKEN message send-many audit lint typecheck --file prompt.md",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "peer",
      summary: "Soft-interrupt the session, then send a prompt.",
      usage: "codex-team -b <token> message peer <name|thread_id> [prompt] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET },
        {
          name: "prompt",
          required: false,
          description: "Prompt text when not using --stdin or --file.",
        },
      ],
      flags: PROMPT_SOURCE_FLAGS,
      examples: [
        "codex-team -b $TOKEN message peer audit \"Stop after the current file write.\"",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "interrupt",
      summary: "Hard-interrupt the current work on a live session.",
      usage: "codex-team -b <token> message interrupt <name|thread_id>",
      positionals: [
        { ...LIVE_SESSION_TARGET },
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN message interrupt audit",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "approval",
      summary: "Resolve an approval request on a live session.",
      usage: "codex-team -b <token> message approval <name|thread_id> <request_id> [shortcut] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET, description: "Session that owns the request." },
        { ...REQUEST_ID },
        {
          name: "shortcut",
          required: false,
          description: "Use a shortcut that matches the approval kind.",
        },
      ],
      flags: [
        ...JSON_RESPONSE_FLAGS,
        {
          long: "--kind",
          type: "string",
          required: false,
          description: "Optional approval kind hint for local shortcut validation.",
        },
      ],
      notes: [
        "command_execution and file_change: all shortcuts are valid.",
        "permissions: cancel is invalid.",
        "mcp_elicitation: accept-session is invalid; form mode needs --json.",
        "--kind validates the shortcut before contacting the daemon.",
      ],
      examples: [
        "codex-team -b $TOKEN message approval audit req-17 accept-session",
        "codex-team -b $TOKEN message approval audit req-17 accept --kind approval.permissions",
        "codex-team -b $TOKEN message approval audit req-17 --file approval.json",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "answer",
      summary: "Answer a user_input request on a live session.",
      usage: "codex-team -b <token> message answer <name|thread_id> <request_id> [answer] [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET, description: "Session that owns the request." },
        { ...REQUEST_ID },
        {
          name: "answer",
          required: false,
          description: "Single-answer shortcut for a one-question request.",
        },
      ],
      flags: JSON_RESPONSE_FLAGS,
      examples: [
        "codex-team -b $TOKEN message answer audit req-21 \"Use the staging URL.\"",
        "codex-team -b $TOKEN message answer audit req-21 --json '{\"answers\":{}}'",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "history",
      summary: "Show runtime history for a session from newest to oldest.",
      usage: "codex-team -b <token> message history <name|thread_id> [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET, description: "Session to inspect." },
      ],
      flags: [
        {
          long: "--limit",
          type: "int",
          default: "50",
          required: false,
          description: "Return at most this many history entries.",
        },
        {
          long: "--since",
          type: "string|int",
          default: "tip",
          required: false,
          description: "Start from a turn ID or a relative negative offset.",
        },
        {
          long: "--format",
          type: "enum",
          default: "json",
          required: false,
          description: "Render output as json or markdown.",
        },
        {
          long: "--truncate",
          type: "int",
          default: "2048",
          required: false,
          description: "Clip long markdown bodies to this many bytes; use 0 to disable clipping.",
        },
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact line per turn to stdout; cannot be used with --format markdown.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN message history audit --since -3 --format markdown",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "tail",
      summary: "Show recent turns and optionally follow new ones.",
      usage: "codex-team -b <token> message tail <name|thread_id> [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGET, description: "Session to inspect." },
      ],
      flags: [
        {
          long: "--follow",
          short: "-f",
          type: "bool",
          default: "false",
          required: false,
          description: "Keep printing turns until the CLI exits.",
        },
        {
          short: "-n",
          type: "int",
          default: "3",
          required: false,
          description: "Return this many recent turns first.",
        },
        {
          long: "--format",
          type: "enum",
          default: "json",
          required: false,
          description: "Render output as json or markdown.",
        },
        {
          long: "--truncate",
          type: "int",
          default: "2048",
          required: false,
          description: "Clip long markdown bodies to this many bytes; use 0 to disable clipping.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN message tail audit -n 5 --follow",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "wait",
      summary: "Block until a turn completes, errors, or times out.",
      usage: "codex-team -b <token> message wait <name|thread_id>... [flags]",
      positionals: [
        { ...LIVE_SESSION_TARGETS, description: "One session by default, or multiple with --all/--any." },
      ],
      flags: [
        {
          long: "--all",
          type: "bool",
          default: "false",
          required: false,
          description: "Wait until every listed session reaches a terminal outcome.",
        },
        {
          long: "--any",
          type: "bool",
          default: "false",
          required: false,
          description: "Return when the first listed session reaches a terminal outcome.",
        },
        {
          long: "--for",
          type: "string",
          required: false,
          description: "Wait for a specific turn ID instead of inferring the current or next turn.",
        },
        {
          long: "--timeout",
          type: "int",
          default: "600",
          required: false,
          description: "Seconds to wait before returning timeout; use 0 to disable the timeout.",
        },
      ],
      notes: [
        "Without --for, waits for the current in-flight turn. If the session is idle, waits for the next turn that starts after this call.",
        "--all and --any are mutually exclusive. --for only applies to single-session waits.",
      ],
      examples: [
        "codex-team -b $TOKEN message wait audit",
        "codex-team -b $TOKEN message wait audit --for turn-42 --timeout 30",
        "codex-team -b $TOKEN message wait --all audit lint typecheck --timeout 300",
        "codex-team -b $TOKEN message wait --any audit lint typecheck --timeout 60",
      ],
      needs_bearer: true,
    }),
  ],
  needs_bearer: true,
};

const monitorGroup: HelpNode = {
  name: "monitor",
  summary: "Stream events and run interval alarms.",
  usage: "codex-team -b <token> monitor <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team -b $TOKEN monitor events --stream",
  ],
  subcommands: [
    leaf({
      name: "events",
      summary: "Stream normalized daemon events as NDJSON.",
      usage: "codex-team -b <token> monitor events [flags]",
      positionals: [],
      flags: [
        {
          long: "--interval",
          type: "int",
          default: "monitor.default_interval_seconds",
          required: false,
          description: "Poll in batches every N seconds; cannot be used with --stream.",
        },
        {
          long: "--stream",
          type: "bool",
          default: "false",
          required: false,
          description: "Emit events immediately; cannot be used with --interval.",
        },
        {
          long: "--filter",
          type: "string",
          required: false,
          description: "Comma-separated event type allowlist.",
        },
        {
          long: "--exclude",
          type: "string",
          required: false,
          description: "Comma-separated event type denylist.",
        },
        {
          long: "--include-delta",
          type: "bool",
          default: "false",
          required: false,
          description: "Include high-frequency *.delta events.",
        },
        {
          long: "--summary",
          type: "bool",
          default: "false",
          required: false,
          description: "Emit compact NDJSON lines with only id, ts, type, session, and a type-specific key.",
        },
        {
          long: "--since",
          type: "string",
          required: false,
          description: "Resume from the given event ID; cannot be used with --cursor.",
        },
        {
          long: "--cursor",
          type: "string",
          required: false,
          description: "Resume from a saved named cursor and auto-update it; cannot be used with --since.",
        },
        {
          long: "--session",
          type: "string",
          required: false,
          description: "Filter to one session name or thread ID.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN monitor events --stream --session audit",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "alarm",
      summary: "Run a shell command at a fixed interval.",
      usage: "codex-team -b <token> monitor alarm <interval_s> <command> [flags]",
      positionals: [
        {
          name: "interval_s",
          required: true,
          description: "Execution interval in seconds.",
        },
        {
          name: "command",
          required: true,
          description: "Shell command string to run.",
        },
      ],
      flags: [
        {
          long: "--once",
          type: "bool",
          default: "false",
          required: false,
          description: "Run the command once and exit.",
        },
        {
          long: "--timeout",
          type: "int",
          default: "60",
          required: false,
          description: "Kill one run if it exceeds this many seconds.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN monitor alarm 30 \"codex-team -b $TOKEN status\"",
      ],
      needs_bearer: true,
    }),
  ],
  needs_bearer: true,
};

const cursorGroup: HelpNode = {
  name: "cursor",
  summary: "Manage persisted named event cursors.",
  usage: "codex-team -b <token> cursor <subcommand>",
  positionals: [],
  flags: [],
  examples: [
    "codex-team -b $TOKEN cursor save audit-tail",
  ],
  subcommands: [
    leaf({
      name: "save",
      summary: "Save the current event tail or an explicit event ID under a cursor name.",
      usage: "codex-team -b <token> cursor save <name> [flags]",
      positionals: [
        {
          name: "name",
          required: true,
          description: "Cursor name to create or update.",
        },
      ],
      flags: [
        {
          long: "--event-id",
          type: "string",
          required: false,
          description: "Override the saved event ID instead of using the current tail.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN cursor save audit-tail",
        "codex-team -b $TOKEN cursor save audit-tail --event-id evt-42",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "list",
      summary: "List saved named cursors for the current user.",
      usage: "codex-team -b <token> cursor list",
      positionals: [],
      flags: [],
      examples: [
        "codex-team -b $TOKEN cursor list",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "get",
      summary: "Print only the saved event ID for a cursor name.",
      usage: "codex-team -b <token> cursor get <name>",
      positionals: [
        {
          name: "name",
          required: true,
          description: "Cursor name to resolve.",
        },
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN cursor get audit-tail",
      ],
      needs_bearer: true,
    }),
    leaf({
      name: "delete",
      summary: "Delete a saved cursor.",
      usage: "codex-team -b <token> cursor delete <name>",
      positionals: [
        {
          name: "name",
          required: true,
          description: "Cursor name to delete.",
        },
      ],
      flags: [],
      examples: [
        "codex-team -b $TOKEN cursor delete audit-tail",
      ],
      needs_bearer: true,
    }),
  ],
  needs_bearer: true,
};

const HELP_TREE: HelpNode = {
  name: "codex-team",
  summary: "CLI and daemon for orchestrating Codex app-server sessions.",
  usage: "codex-team [-b <token>] <command> [args] [flags]",
  positionals: [],
  flags: [
    {
      long: "--bearer",
      short: "-b",
      type: "string",
      required: false,
      description: "User identity token for user-scoped commands.",
    },
    {
      long: "--verbose",
      short: "-v",
      type: "bool",
      default: "false",
      required: false,
      description: "Write CLI debug logs to stderr.",
    },
    {
      long: "--daemon-sock",
      type: "path",
      default: "config value",
      required: false,
      description: "Override the daemon socket path.",
    },
    {
      long: "--help",
      short: "-h",
      type: "bool",
      default: "false",
      required: false,
      description: "Show help for the resolved command path.",
    },
  ],
  examples: [
    "codex-team --help",
    "codex-team -b $TOKEN session new audit --model gpt-5.4",
  ],
  notes: [
    "Default JSON output is concise. Pass --full on any leaf command to restore the complete response body.",
  ],
  subcommands: [
    leaf({
      name: "version",
      summary: "Print the CLI version and the daemon version when available.",
      usage: "codex-team version",
      positionals: [],
      flags: [],
      examples: [
        "codex-team version",
      ],
      needs_bearer: false,
    }),
    {
      name: "doctor",
      summary: "Run local environment and daemon bootstrap diagnostics.",
      usage: "codex-team doctor [flags]",
      positionals: [],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one summary line with verdict, failed checks, and warnings.",
        },
      ],
      examples: [
        "codex-team doctor",
        "codex-team doctor --short",
      ],
      notes: [
        "Checks: node version, codex binary, plugin launcher, daemon.data_dir writable.",
        "Checks: local socket bind, daemon process state, daemon socket reachability, dist freshness.",
      ],
      subcommands: [],
      needs_bearer: false,
    },
    leaf({
      name: "status",
      summary: "Show live sessions, pending events, and recent activity.",
      usage: "codex-team -b <token> status [flags]",
      positionals: [],
      flags: [
        {
          long: "--short",
          type: "bool",
          default: "false",
          required: false,
          description: "Print one compact status line to stdout.",
        },
      ],
      examples: [
        "codex-team -b $TOKEN status",
      ],
      needs_bearer: true,
    }),
    daemonGroup,
    sessionGroup,
    messageGroup,
    monitorGroup,
    cursorGroup,
  ],
  needs_bearer: false,
};

function findNode(path: string[], node: HelpNode = HELP_TREE): HelpNode | null {
  if (path.length === 0) return node;
  const [head, ...rest] = path;
  const child = node.subcommands.find((entry) => entry.name === head);
  if (!child) return null;
  return findNode(rest, child);
}

function formatCommandPath(path: string[]): string {
  return path.length === 0 ? "codex-team" : `codex-team ${path.join(" ")}`;
}

function formatPositional(positional: HelpPositional): string {
  return positional.required ? `<${positional.name}>` : `[${positional.name}]`;
}

function formatFlag(flag: HelpFlag): string {
  if (flag.short && flag.long) return `${flag.short}, ${flag.long}`;
  return flag.short ?? flag.long ?? "-";
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );

  return [
    `  ${headers.map((header, index) => header.padEnd(widths[index])).join("  ")}`,
    `  ${widths.map((width) => "-".repeat(width)).join("  ")}`,
    ...rows.map((row) =>
      `  ${row.map((cell, index) => cell.padEnd(widths[index])).join("  ")}`,
    ),
  ];
}

function renderPositionals(node: HelpNode): string[] {
  const lines = ["POSITIONALS"];
  if (node.positionals.length === 0) {
    lines.push("  None.");
    return lines;
  }

  lines.push(
    ...renderTable(
      ["Name", "Required", "Description"],
      node.positionals.map((positional) => [
        formatPositional(positional),
        positional.required ? "yes" : "no",
        positional.description,
      ]),
    ),
  );
  return lines;
}

function renderFlags(node: HelpNode, title = "FLAGS"): string[] {
  const lines = [title];
  if (node.flags.length === 0) {
    lines.push("  None.");
    return lines;
  }

  lines.push(
    ...renderTable(
      ["Flag", "Type", "Default", "Required", "Description"],
      node.flags.map((flag) => [
        formatFlag(flag),
        flag.type,
        flag.default ?? "-",
        flag.required ? "yes" : "no",
        flag.description,
      ]),
    ),
  );
  return lines;
}

function renderNotes(node: HelpNode): string[] {
  return [
    "NOTES",
    ...((node.notes ?? []).map((note) => `  ${note}`)),
  ];
}

function renderSubcommands(node: HelpNode): string[] {
  return [
    "SUBCOMMANDS",
    ...renderTable(
      ["Command", "Summary"],
      node.subcommands.map((subcommand) => [subcommand.name, subcommand.summary]),
    ),
  ];
}

function renderExamples(node: HelpNode): string[] {
  return [
    "EXAMPLES",
    ...node.examples.map((example) => `  ${example}`),
  ];
}

export function renderHelp(path: string[]): string {
  const node = findNode(path) ?? HELP_TREE;
  const resolvedPath = findNode(path) ? path : [];
  const sections: string[][] = [
    [formatCommandPath(resolvedPath), node.summary],
    ["USAGE", `  ${node.usage}`],
  ];

  if (resolvedPath.length === 0) {
    sections.push(renderSubcommands(node));
    sections.push(renderFlags(node, "GLOBAL FLAGS"));
  } else if (node.subcommands.length > 0) {
    sections.push(renderSubcommands(node));
  } else {
    sections.push(renderPositionals(node));
    sections.push(renderFlags(node));
  }
  if (node.notes && node.notes.length > 0) sections.push(renderNotes(node));

  sections.push(renderExamples(node));

  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}
