import { describe, expect, it } from "vitest";

import { renderHelp } from "../src/cli/help";

describe("renderHelp", () => {
  it("mentions all top-level command groups on root help", () => {
    const help = renderHelp([]);

    expect(help).toContain("version");
    expect(help).toContain("status");
    expect(help).toContain("daemon");
    expect(help).toContain("session");
    expect(help).toContain("message");
    expect(help).toContain("monitor");
  });

  it("renders session new flags from the schema", () => {
    const help = renderHelp(["session", "new"]);

    expect(help).toContain("codex-team session new");
    expect(help).toContain("--model");
    expect(help).toContain("--cwd");
    expect(help).toContain("--sandbox");
    expect(help).toContain("--approval");
    expect(help).toContain("--effort");
    expect(help).toContain("--experimental-tools");
  });

  it("renders daemon config subgroup help with its child commands", () => {
    const help = renderHelp(["daemon", "config"]);

    expect(help).toContain("codex-team daemon config");
    expect(help).toContain("get");
    expect(help).toContain("set");
    expect(help).toContain("unset");
    expect(help).toContain("list");
    expect(help).toContain("reset");
  });

  it("marks monitor events stream and interval flags as mutually exclusive", () => {
    const help = renderHelp(["monitor", "events"]);

    expect(help).toContain("cannot be used with --stream");
    expect(help).toContain("cannot be used with --interval");
  });

  it("renders message approval shortcut and JSON input flags", () => {
    const help = renderHelp(["message", "approval"]);

    expect(help).toContain("[shortcut]");
    expect(help).toContain("--json");
    expect(help).toContain("--file");
    expect(help).toContain("--stdin");
    expect(help).toContain("permissions: cancel is invalid.");
    expect(help).toContain("mcp_elicitation: accept-session is invalid; form mode needs --json.");
  });
});
