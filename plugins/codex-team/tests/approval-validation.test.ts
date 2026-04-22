import { describe, expect, it } from "vitest";

import { validateApprovalAction } from "../src/cli/approval-validation";

describe("validateApprovalAction", () => {
  const cases = [
    ["approval.command_execution", "accept", true],
    ["approval.command_execution", "accept-session", true],
    ["approval.command_execution", "decline", true],
    ["approval.command_execution", "cancel", true],
    ["approval.file_change", "accept", true],
    ["approval.file_change", "accept-session", true],
    ["approval.file_change", "decline", true],
    ["approval.file_change", "cancel", true],
    ["approval.permissions", "accept", true],
    ["approval.permissions", "accept-session", true],
    ["approval.permissions", "decline", true],
    ["approval.permissions", "cancel", false],
    ["approval.mcp_elicitation", "accept", true],
    ["approval.mcp_elicitation", "accept-session", false],
    ["approval.mcp_elicitation", "decline", true],
    ["approval.mcp_elicitation", "cancel", true],
  ] as const;

  it.each(cases)("validates %s × %s", (kind, action, expectedOk) => {
    const result = validateApprovalAction(kind, action);

    expect(result.ok).toBe(expectedOk);
    if (!expectedOk) {
      expect(result).toMatchObject({
        message: expect.stringContaining(`valid for ${kind}`),
      });
    }
  });

  it("rejects unknown approval kinds", () => {
    expect(validateApprovalAction("approval.unknown", "accept")).toMatchObject({
      ok: false,
      message: expect.stringContaining("unknown approval kind"),
    });
  });
});
