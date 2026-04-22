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
    expect(help).toContain("cursor");
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
    expect(help).toContain("--auto-approve");
  });

  it("renders daemon config subgroup help with its child commands", () => {
    const help = renderHelp(["daemon", "config"]);

    expect(help).toContain("codex-team daemon config");
    expect(help).toContain("get");
    expect(help).toContain("set");
    expect(help).toContain("unset");
    expect(help).toContain("list");
    expect(help).toContain("reset");
    expect(renderHelp(["daemon", "config", "set"])).toContain("session.auto_approve_command_patterns");
  });

  it("documents --short for compact status commands", () => {
    expect(renderHelp(["status"])).toContain("--short");
    expect(renderHelp(["daemon", "status"])).toContain("--short");
    expect(renderHelp(["daemon", "user", "list"])).toContain("--short");
    expect(renderHelp(["session", "info"])).toContain("--short");
    expect(renderHelp(["session", "list"])).toContain("cannot be used with --format table");
    expect(renderHelp(["message", "history"])).toContain("cannot be used with --format markdown");
  });

  it("marks monitor events stream and interval flags as mutually exclusive", () => {
    const help = renderHelp(["monitor", "events"]);

    expect(help).toContain("cannot be used with --stream");
    expect(help).toContain("cannot be used with --interval");
    expect(help).toContain("--summary");
    expect(help).toContain("--cursor");
    expect(help).toContain("cannot be used with --since");
  });

  it("renders message approval shortcut and JSON input flags", () => {
    const help = renderHelp(["message", "approval"]);

    expect(help).toContain("[shortcut]");
    expect(help).toContain("--json");
    expect(help).toContain("--file");
    expect(help).toContain("--stdin");
    expect(help).toContain("--kind");
    expect(help).toContain("permissions: cancel is invalid.");
    expect(help).toContain("mcp_elicitation: accept-session is invalid; form mode needs --json.");
  });

  it("renders session heal and message wait help entries", () => {
    const health = renderHelp(["session", "health"]);
    expect(health).toContain("codex-team session health");
    expect(health).toContain("session heal");

    const heal = renderHelp(["session", "heal"]);
    expect(heal).toContain("codex-team session heal");
    expect(heal).toContain("--force");
    expect(heal).toContain("session health");

    const wait = renderHelp(["message", "wait"]);
    expect(wait).toContain("codex-team message wait");
    expect(wait).toContain("--for");
    expect(wait).toContain("--timeout");
    expect(wait).toContain("If the session is idle, waits for the next turn");
  });

  it("renders cursor subcommands and the explicit event-id flag", () => {
    const help = renderHelp(["cursor", "save"]);

    expect(renderHelp(["cursor"])).toContain("codex-team -b <token> cursor");
    expect(renderHelp(["cursor"])).toContain("save");
    expect(renderHelp(["cursor"])).toContain("list");
    expect(renderHelp(["cursor"])).toContain("get");
    expect(renderHelp(["cursor"])).toContain("delete");
    expect(help).toContain("--event-id");
  });

  it("documents truncate on markdown history output", () => {
    const help = renderHelp(["message", "history"]);

    expect(help).toContain("--truncate");
    expect(help).toContain("use 0 to disable clipping");
  });
});
