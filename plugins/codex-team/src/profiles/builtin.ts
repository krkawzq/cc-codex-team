export interface BuiltinProfile {
  name: string;
  description: string;
  flags: {
    model: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approval: "never" | "on-request" | "on-failure" | "untrusted";
    effort: "minimal" | "low" | "medium" | "high" | "xhigh";
    auto_approve?: string;
  };
}

export const BUILTIN_PROFILES: BuiltinProfile[] = [
  {
    name: "fixer",
    description: "Default worker — edits code, asks before risky ops",
    flags: {
      model: "gpt-5.4",
      sandbox: "workspace-write",
      approval: "on-request",
      effort: "high",
      auto_approve: "git*,npm test,npm run test*,vitest*,pytest*,cargo test*",
    },
  },
  {
    name: "reviewer",
    description: "Read-only critic",
    flags: {
      model: "gpt-5.4",
      sandbox: "read-only",
      approval: "never",
      effort: "xhigh",
    },
  },
  {
    name: "planner",
    description: "Read-only strategist",
    flags: {
      model: "gpt-5.4",
      sandbox: "read-only",
      approval: "never",
      effort: "xhigh",
    },
  },
  {
    name: "tester",
    description: "Trusted automation — runs tests",
    flags: {
      model: "gpt-5.4-mini",
      sandbox: "workspace-write",
      approval: "never",
      effort: "medium",
      auto_approve: "npm test,vitest*,pytest*,cargo test*,go test*,make test*",
    },
  },
  {
    name: "explorer",
    description: "Read-only investigator",
    flags: {
      model: "gpt-5.4-mini",
      sandbox: "read-only",
      approval: "never",
      effort: "medium",
    },
  },
];

export function findProfile(name: string): BuiltinProfile | undefined {
  return BUILTIN_PROFILES.find((profile) => profile.name === name);
}

export function renderSessionNewCommand(
  profile: BuiltinProfile,
  sessionName = "<name>",
  cwd = "<repo>",
): string {
  const args = [
    "codex-team",
    "-b",
    "$TOK",
    "session",
    "new",
    sessionName,
    "--cwd",
    cwd,
    "--model",
    profile.flags.model,
    "--sandbox",
    profile.flags.sandbox,
    "--approval",
    profile.flags.approval,
    "--effort",
    profile.flags.effort,
  ];

  if (profile.flags.auto_approve) {
    args.push("--auto-approve", shellQuote(profile.flags.auto_approve));
  }

  return args.join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
