export type SessionStatus = "idle" | "running" | "errored" | "closed" | "compacting";

export interface RegistryEntry {
  workspace: string;
  name: string;
  threadId: string;
  createdByClientId: string | null;
  ephemeral?: boolean;
  cwd: string;
  model: string;
  modelProvider: string | null;
  sandbox: string;
  approvalPolicy: string;
  serviceTier: string | null;
  reasoningEffort: string | null;
  personality: string | null;
  profile: string | null;
  createdAt: string;
  lastTurnId: string | null;
  lastTurnEndedAt: string | null;
  lastPromptText: string | null;
  status: SessionStatus;
  appServerPid: number | null;
  queueLength: number;
  tokenUsageInput: number;
  contextTokensEstimate?: number | null;
  modelContextWindow?: number | null;
  errorMessage: string | null;
}

export type DigestLineKind =
  | "command"
  | "file_change"
  | "agent_message"
  | "tool_call"
  | "web_search"
  | "collab_agent";

export interface DigestLine {
  kind: DigestLineKind;
  text: string;
  path?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  exitCode?: number | null;
  durationMs?: number | null;
  stderrTail?: string | null;
  toolName?: string | null;
}

export type TurnTier = "trivial" | "normal" | "attn";

export interface TurnSummary {
  workspace?: string;
  session: string;
  turnId: string;
  elapsedMs: number;
  status: string;
  tier: TurnTier;
  finalMessage: string | null;
  filesAdded: number;
  filesRemoved: number;
  lines: DigestLine[];
  usageLastTokens?: number | null;
  usageTotalTokens?: number | null;
  contextTokensEstimate?: number | null;
  modelContextWindow?: number | null;
  errorMessage?: string | null;
  completedAt?: string | null;
}
