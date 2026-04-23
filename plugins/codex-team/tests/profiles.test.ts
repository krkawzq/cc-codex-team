import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockMocks = vi.hoisted(() => ({
  connectSock: vi.fn(),
  probeSock: vi.fn(),
  writeMessage: vi.fn(),
  onMessages: vi.fn(),
}));

vi.mock("../src/ipc/sock", () => sockMocks);

import { runCli } from "../src/cli/run";

describe("profiles commands", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("profiles list returns all 5 profiles with expected structure", async () => {
    const code = await runCli(["profiles", "list"]);

    expect(code).toBe(0);
    expect(readStdout(stdoutSpy)).toBe(JSON.stringify({
      ok: true,
      data: {
        profiles: [
          {
            name: "fixer",
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
            flags: {
              model: "gpt-5.4",
              sandbox: "read-only",
              approval: "never",
              effort: "xhigh",
            },
          },
          {
            name: "planner",
            flags: {
              model: "gpt-5.4",
              sandbox: "read-only",
              approval: "never",
              effort: "xhigh",
            },
          },
          {
            name: "tester",
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
            flags: {
              model: "gpt-5.4-mini",
              sandbox: "read-only",
              approval: "never",
              effort: "medium",
            },
          },
        ],
      },
    }) + "\n");
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("profiles list --short renders a tab-aligned table", async () => {
    const code = await runCli(["profiles", "list", "--short"]);

    expect(code).toBe(0);
    expect(readStdout(stdoutSpy)).toBe(
      "fixer     workspace-write  high    on-request  Default worker — edits code, asks before risky ops\n" +
      "reviewer  read-only        xhigh   never       Read-only critic\n" +
      "planner   read-only        xhigh   never       Read-only strategist\n" +
      "tester    workspace-write  medium  never       Trusted automation — runs tests\n" +
      "explorer  read-only        medium  never       Read-only investigator\n",
    );
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("profiles show fixer returns the named profile with a ready-to-copy command", async () => {
    const code = await runCli(["profiles", "show", "fixer"]);

    expect(code).toBe(0);
    expect(readStdout(stdoutSpy)).toBe(JSON.stringify({
      ok: true,
      data: {
        name: "fixer",
        flags: {
          model: "gpt-5.4",
          sandbox: "workspace-write",
          approval: "on-request",
          effort: "high",
          auto_approve: "git*,npm test,npm run test*,vitest*,pytest*,cargo test*",
        },
        command: "codex-team -b $TOK session new <name> --cwd <repo> --model gpt-5.4 --sandbox workspace-write --approval on-request --effort high --auto-approve 'git*,npm test,npm run test*,vitest*,pytest*,cargo test*'",
      },
    }) + "\n");
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("profiles show bogus returns invalid_params with the known-list suggestion", async () => {
    const code = await runCli(["profiles", "show", "bogus"]);

    expect(code).toBe(1);
    expect(readStdout(stdoutSpy)).toBe(
      "{\"ok\":false,\"error\":{\"code\":\"invalid_params\",\"message\":\"profile 'bogus' not found (known: fixer, reviewer, planner, tester, explorer)\"}}\n",
    );
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("profiles show fixer --short returns the one-line command", async () => {
    const code = await runCli(["profiles", "show", "fixer", "--short"]);

    expect(code).toBe(0);
    expect(readStdout(stdoutSpy)).toBe(
      "codex-team -b $TOK session new <name> --cwd <repo> --model gpt-5.4 --sandbox workspace-write --approval on-request --effort high --auto-approve 'git*,npm test,npm run test*,vitest*,pytest*,cargo test*'\n",
    );
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });

  it("profiles with no subcommand prints group help", async () => {
    const code = await runCli(["profiles"]);

    expect(code).toBe(0);
    const output = readStdout(stdoutSpy);
    expect(output).toContain("codex-team profiles");
    expect(output).toContain("list");
    expect(output).toContain("show");
    expect(sockMocks.probeSock).not.toHaveBeenCalled();
  });
});

function readStdout(stdoutSpy: ReturnType<typeof vi.spyOn>): string {
  return stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
}
