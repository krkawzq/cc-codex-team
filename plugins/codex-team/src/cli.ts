import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

import { loadConfig, resolveDataDir, resolveSocketPath } from "./config";
import { DaemonNotRunning, wireToError } from "./errors";

export type ParsedArgs =
  | { group: "session"; action: string; args: Record<string, unknown> }
  | { group: "send"; args: Record<string, unknown> }
  | { group: "interrupt"; name: string }
  | { group: "compact"; name: string }
  | { group: "history"; args: Record<string, unknown> }
  | { group: "tail"; args: Record<string, unknown> }
  | { group: "queue"; action: string; args: Record<string, unknown> }
  | { group: "health"; action: string }
  | { group: "daemon"; action: string; args: Record<string, unknown> }
  | { group: "monitor"; action: "events" | "watchdog" };

interface ParsedOptions {
  _: string[];
  [key: string]: string | boolean | string[] | undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function diagnoseStalePid(dataDir: string): { stale: boolean; pid: number | null; pidPath: string } {
  const pidPath = path.join(dataDir, "daemon.pid");
  if (!fs.existsSync(pidPath)) {
    return { stale: false, pid: null, pidPath };
  }
  const raw = fs.readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0 || !pidAlive(pid)) {
    return { stale: true, pid: Number.isFinite(pid) ? pid : null, pidPath };
  }
  return { stale: false, pid, pidPath };
}

async function socketReady(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 100);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(false);
    });
  });
}

export async function sendRequest(
  socketPath: string,
  cmd: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    socket.once("error", (error) => {
      rl.close();
      reject(new DaemonNotRunning(`no daemon at ${socketPath}: ${error.message}`));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: cryptoId(), cmd, params })}\n`);
    });
    void (async () => {
      try {
        const iterator = rl[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done || !first.value) {
          reject(new DaemonNotRunning("daemon closed connection"));
          return;
        }
        resolve(JSON.parse(first.value) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      } finally {
        rl.close();
        socket.end();
      }
    })();
  });
}

async function streamSubscribe(socketPath: string, cmd: string): Promise<number> {
  return await new Promise<number>((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.once("error", () => {
      process.stderr.write("daemon not running\n");
      resolve(4);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: cryptoId(), cmd, params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    socket.once("close", () => resolve(0));
  });
}

async function streamHistorySubscribe(socketPath: string, params: Record<string, unknown>): Promise<number> {
  return await new Promise<number>((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.once("error", () => {
      process.stderr.write("daemon not running\n");
      resolve(4);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: cryptoId(), cmd: "history.subscribe", params })}\n`);
    });
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    void (async () => {
      try {
        for await (const line of rl) {
          if (!line) {
            continue;
          }
          try {
            const event = JSON.parse(line) as {
              payload?: { content?: unknown; matched_since_turn_id?: unknown };
            };
            warnIfHistoryAnchorMissing(event.payload || {});
            const content = event.payload?.content;
            if (typeof content === "string" && content) {
              process.stdout.write(content);
            }
          } catch {
            process.stdout.write(`${line}\n`);
          }
        }
      } finally {
        rl.close();
      }
    })();
    socket.once("close", () => resolve(0));
  });
}

async function followFile(filePath: string, startAtEnd = false): Promise<number> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf8");
  }
  let offset = startAtEnd ? fs.statSync(filePath).size : 0;
  while (true) {
    const size = fs.statSync(filePath).size;
    if (size > offset) {
      const fd = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        process.stdout.write(buffer.toString("utf8"));
      } finally {
        fs.closeSync(fd);
      }
      offset = size;
    }
    await sleep(250);
  }
}

async function followFileFromOffset(filePath: string, offset = 0): Promise<number> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf8");
  }
  let cursor = offset;
  while (true) {
    const size = fs.statSync(filePath).size;
    if (size > cursor) {
      const fd = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(size - cursor);
        fs.readSync(fd, buffer, 0, buffer.length, cursor);
        process.stdout.write(buffer.toString("utf8"));
      } finally {
        fs.closeSync(fd);
      }
      cursor = size;
    }
    await sleep(250);
  }
}

function parseOptions(
  args: string[],
  spec: { boolean?: string[]; string?: string[] } = {},
): ParsedOptions {
  const options: ParsedOptions = { _: [] };
  const booleanFlags = new Set(spec.boolean || []);
  const stringFlags = new Set(spec.string || []);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const eqIndex = token.indexOf("=");
    const rawFlag = token.slice(2, eqIndex >= 0 ? eqIndex : undefined);
    const key = flagToCamel(rawFlag);
    if (booleanFlags.has(rawFlag)) {
      options[key] = true;
      continue;
    }
    if (stringFlags.has(rawFlag)) {
      if (eqIndex >= 0) {
        options[key] = token.slice(eqIndex + 1);
      } else {
        index += 1;
        options[key] = args[index] ?? "";
      }
      continue;
    }
    throw new Error(`unknown option: --${rawFlag}`);
  }
  return options;
}

function flagToCamel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function parseCli(argv: string[]): ParsedArgs {
  const [group, action, ...rest] = argv;
  if (!group) {
    throw new Error("usage: codex-team <group> ...");
  }
  if (group === "session") {
    const opts = parseOptions(rest, {
      boolean: ["ephemeral", "include-turns"],
      string: [
        "cwd",
        "model",
        "model-provider",
        "sandbox",
        "approval-policy",
        "service-tier",
        "reasoning-effort",
        "personality",
        "profile",
        "thread-id",
        "base-instructions-file",
        "developer-instructions-file",
      ],
    });
    const name = opts._[0];
    return { group, action, args: { ...opts, name } };
  }
  if (group === "send") {
    const opts = parseOptions([action || "", ...rest].filter(Boolean), {
      boolean: ["stdin", "wait"],
      string: [
        "prompt-file",
        "model",
        "cwd",
        "effort",
        "personality",
        "service-tier",
        "summary",
        "output-schema-file",
      ],
    });
    return { group, args: { ...opts, name: opts._[0], text: opts._[1] || "" } };
  }
  if (group === "interrupt" || group === "compact") {
    return { group, name: action || "" };
  }
  if (group === "history") {
    const opts = parseOptions([action || "", ...rest].filter(Boolean), {
      boolean: ["follow"],
      string: ["last-n", "since", "since-turn-id", "format"],
    });
    return {
      group,
      args: {
        ...opts,
        name: opts._[0],
        lastN: Number(opts.lastN || 0),
      },
    };
  }
  if (group === "tail") {
    const opts = parseOptions([action || "", ...rest].filter(Boolean), {
      boolean: ["stderr"],
      string: ["lines"],
    });
    return { group, args: { ...opts, name: opts._[0] } };
  }
  if (group === "queue") {
    const opts = parseOptions(rest, {
      boolean: ["wait"],
    });
    return { group, action, args: { ...opts, name: opts._[0] } };
  }
  if (group === "health") {
    return { group, action };
  }
  if (group === "daemon") {
    const opts = parseOptions(rest, {
      boolean: ["follow"],
    });
    return { group, action, args: opts };
  }
  if (group === "monitor" && (action === "events" || action === "watchdog")) {
    return { group, action };
  }
  throw new Error(`unknown command group: ${group}`);
}

function cryptoId(): string {
  return `cli-${Math.random().toString(16).slice(2)}`;
}

export function textContentForResponse(parsed: ParsedArgs, data: Record<string, unknown>): string | null {
  const content = data.content;
  if (typeof content !== "string") {
    return null;
  }
  if (parsed.group === "history" || parsed.group === "tail") {
    return content;
  }
  if (parsed.group === "daemon" && parsed.action === "logs") {
    return content;
  }
  return null;
}

function writeTextContent(content: string): void {
  process.stdout.write(content);
  if (content && !content.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

export function historyAnchorWarningForResponse(data: Record<string, unknown>): string | null {
  if (data.matched_since_turn_id === false) {
    return "codex-team: since-turn-id was not found; no history content was emitted";
  }
  return null;
}

function warnIfHistoryAnchorMissing(data: Record<string, unknown>): void {
  const warning = historyAnchorWarningForResponse(data);
  if (warning) {
    process.stderr.write(`${warning}\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CliClient {
  private readonly socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || resolveSocketPath(loadConfig());
  }

  private async ensureDaemon(): Promise<void> {
    if (await socketReady(this.socketPath)) {
      return;
    }
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }
    const cfg = loadConfig();
    const dataDir = resolveDataDir(cfg);
    cfg.daemon.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    const stale = diagnoseStalePid(dataDir);
    if (stale.stale) {
      try {
        fs.unlinkSync(stale.pidPath);
      } catch (error) {
        throw new DaemonNotRunning(
          `stale pid file at ${stale.pidPath} could not be removed automatically: ${(error as Error).message}`,
          { pid_path: stale.pidPath, stale_pid: stale.pid },
        );
      }
    }
    const errPath = path.join(dataDir, "daemon-startup.err");
    const errFd = fs.openSync(errPath, "a");
    try {
      const child = spawn(process.execPath, [process.argv[1] || "", "__daemon"], {
        detached: true,
        stdio: ["ignore", "ignore", errFd],
      });
      child.unref();
    } finally {
      fs.closeSync(errFd);
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await socketReady(this.socketPath)) {
        return;
      }
      await sleep(100);
    }
    const tail = fs.existsSync(errPath)
      ? fs.readFileSync(errPath, "utf8").split(/\r?\n/).slice(-40).join("\n")
      : "";
    let hint = `daemon did not become ready at ${this.socketPath}. Check ${errPath} for the daemon stderr.`;
    if (tail) {
      hint += `\n--- last stderr lines ---\n${tail}\n--- end ---`;
    }
    throw new DaemonNotRunning(hint, {
      socket_path: this.socketPath,
      startup_err_path: errPath,
      startup_err_tail: tail,
    });
  }

  private async readPrompt(args: Record<string, unknown>): Promise<string> {
    if (args.stdin) {
      return await new Promise<string>((resolve) => {
        let body = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          body += chunk;
        });
        process.stdin.on("end", () => resolve(body));
      });
    }
    if (typeof args.promptFile === "string" && args.promptFile) {
      return fs.readFileSync(args.promptFile, "utf8");
    }
    return String(args.text || "");
  }

  private readOptionalFile(value: unknown): string | null {
    if (typeof value !== "string" || !value) {
      return null;
    }
    return fs.readFileSync(value, "utf8");
  }

  async run(argv: string[] = process.argv.slice(2)): Promise<number> {
    const parsed = parseCli(argv);
    if (parsed.group === "monitor") {
      await this.ensureDaemon();
      return await streamSubscribe(this.socketPath, `monitor.${parsed.action}.subscribe`);
    }
    if (!(parsed.group === "daemon" && (parsed.action === "start" || parsed.action === "restart"))) {
      await this.ensureDaemon();
    }
    let response: Record<string, unknown> | number;
    if (parsed.group === "daemon" && parsed.action === "start") {
      await this.ensureDaemon();
      response = { ok: true, data: { started: true } };
    } else if (parsed.group === "daemon" && parsed.action === "restart") {
      try {
        await sendRequest(this.socketPath, "daemon.stop", {});
      } catch {
        // ignore
      }
      await sleep(300);
      await this.ensureDaemon();
      response = { ok: true, data: { restarted: true } };
    } else if (parsed.group === "daemon" && parsed.action === "logs" && parsed.args.follow) {
      const cfg = loadConfig();
      return await followFile(path.join(resolveDataDir(cfg), "daemon.log"));
    } else {
      response = await this.handle(parsed);
    }
    if (typeof response === "number") {
      return response;
    }
    if (response.ok) {
      const data = (response.data || {}) as Record<string, unknown>;
      const textContent = textContentForResponse(parsed, data);
      if (textContent !== null) {
        warnIfHistoryAnchorMissing(data);
        writeTextContent(textContent);
      } else {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      }
      return 0;
    }
    const error = wireToError((response.error || {}) as never);
    process.stderr.write(`codex-team: ${error.code}: ${error.message}\n`);
    if (Object.keys(error.detail).length > 0) {
      process.stderr.write(`  detail: ${JSON.stringify(error.detail)}\n`);
    }
    return error.exitCode;
  }

  private async handle(parsed: ParsedArgs): Promise<Record<string, unknown> | number> {
    if (parsed.group === "session") {
      const args = parsed.args;
      const cmd = `session.${parsed.action.replace(/-/g, "_")}`;
      const params: Record<string, unknown> = {};
      if (args.name) {
        params.name = String(args.name);
      }
      if (parsed.action === "create" || parsed.action === "attach") {
        for (const key of [
          "cwd",
          "model",
          "modelProvider",
          "sandbox",
          "approvalPolicy",
          "serviceTier",
          "reasoningEffort",
          "personality",
          "profile",
          "threadId",
        ]) {
          if (args[key] !== undefined) {
            params[key] = args[key] as string;
          }
        }
        params.baseInstructions = this.readOptionalFile(args.baseInstructionsFile);
        params.developerInstructions = this.readOptionalFile(args.developerInstructionsFile);
        params.ephemeral = Boolean(args.ephemeral);
      } else if (parsed.action === "read") {
        params.includeTurns = Boolean(args.includeTurns);
      }
      return await sendRequest(this.socketPath, cmd, params);
    }
    if (parsed.group === "send") {
      const outputSchema =
        typeof parsed.args.outputSchemaFile === "string" && parsed.args.outputSchemaFile
          ? JSON.parse(fs.readFileSync(parsed.args.outputSchemaFile, "utf8"))
          : null;
      return await sendRequest(this.socketPath, "send", {
        name: parsed.args.name,
        text: await this.readPrompt(parsed.args),
        wait: Boolean(parsed.args.wait),
        model: parsed.args.model,
        cwd: parsed.args.cwd,
        effort: parsed.args.effort,
        personality: parsed.args.personality,
        serviceTier: parsed.args.serviceTier,
        summary: parsed.args.summary,
        outputSchema,
      });
    }
    if (parsed.group === "interrupt") {
      return await sendRequest(this.socketPath, "interrupt", { name: parsed.name });
    }
    if (parsed.group === "compact") {
      return await sendRequest(this.socketPath, "compact", { name: parsed.name });
    }
    if (parsed.group === "history") {
      if (parsed.args.follow) {
        return await streamHistorySubscribe(this.socketPath, {
          name: parsed.args.name,
          lastN: parsed.args.lastN,
          since: parsed.args.since,
          sinceTurnId: parsed.args.sinceTurnId,
          format: parsed.args.format || "md",
        });
      }
      return await sendRequest(this.socketPath, "history.get", {
        name: parsed.args.name,
        lastN: parsed.args.lastN,
        since: parsed.args.since,
        sinceTurnId: parsed.args.sinceTurnId,
        format: parsed.args.format || "md",
      });
    }
    if (parsed.group === "tail") {
      return await sendRequest(this.socketPath, "history.tail_stderr", {
        name: parsed.args.name,
        lines: Number(parsed.args.lines || 200),
      });
    }
    if (parsed.group === "queue") {
      return await sendRequest(this.socketPath, `queue.${parsed.action.replace(/-/g, "_")}`, {
        name: parsed.args.name,
        wait: Boolean(parsed.args.wait),
      });
    }
    if (parsed.group === "health") {
      return await sendRequest(this.socketPath, `health.${parsed.action}`, {});
    }
    if (parsed.group === "daemon") {
      return await sendRequest(this.socketPath, `daemon.${parsed.action.replace(/-/g, "_")}`, {});
    }
    throw new Error("unreachable");
  }
}
