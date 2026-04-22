export type ApprovalAction = "accept" | "accept-session" | "decline" | "cancel";

const APPROVAL_ACTIONS: Record<string, readonly ApprovalAction[]> = {
  "approval.command_execution": ["accept", "accept-session", "decline", "cancel"],
  "approval.file_change": ["accept", "accept-session", "decline", "cancel"],
  "approval.permissions": ["accept", "accept-session", "decline"],
  "approval.mcp_elicitation": ["accept", "decline", "cancel"],
} as const;

export type ApprovalKind = keyof typeof APPROVAL_ACTIONS;

export function validateApprovalAction(kind: string, action: string): { ok: true; validActions: readonly ApprovalAction[] } | {
  ok: false;
  message: string;
  validActions?: readonly ApprovalAction[];
} {
  const validActions = APPROVAL_ACTIONS[kind as ApprovalKind];
  if (!validActions) {
    return {
      ok: false,
      message: `unknown approval kind '${kind}'. Valid kinds: ${Object.keys(APPROVAL_ACTIONS).join(", ")}`,
    };
  }
  if (validActions.includes(action as ApprovalAction)) {
    return { ok: true, validActions };
  }
  return {
    ok: false,
    validActions,
    message: `shortcut '${action}' is not valid for ${kind}; valid actions: ${validActions.join(", ")}`,
  };
}
