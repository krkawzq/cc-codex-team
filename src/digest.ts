import fs from "node:fs";
import path from "node:path";

import { DigestConfig } from "./config";
import { ensureDirFor, rotateFileIfNeeded } from "./fileIO";
import { DigestLine, TurnSummary, TurnTier } from "./models";

const FENCED_BLOCK = /```.*?```/gs;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const indicator = ` ... (truncated, ${text.length} chars)`;
  return `${text.slice(0, Math.max(0, limit - indicator.length))}${indicator}`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] || "";
}

function tailLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

export function digestItem(item: Record<string, unknown>, cfg: DigestConfig): DigestLine | null {
  const itemType = String(item.type ?? "");
  if (itemType === "commandExecution") {
    return digestCommand(item, cfg);
  }
  if (itemType === "fileChange") {
    return digestFileChange(item);
  }
  if (itemType === "agentMessage") {
    return { kind: "agent_message", text: String(item.text ?? "") };
  }
  if (itemType === "reasoning") {
    if (!cfg.reasoningCapture) {
      return null;
    }
    const summary = Array.isArray(item.summary) ? item.summary.map(String).join(" ") : String(item.summary ?? "");
    return { kind: "agent_message", text: summary };
  }
  if (itemType === "webSearch") {
    return { kind: "web_search", text: String(item.query ?? "") };
  }
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    return digestToolCall(item, cfg);
  }
  if (itemType === "collabAgentToolCall") {
    return { kind: "collab_agent", text: `subagent=${String(item.tool ?? "subagent")}` };
  }
  return null;
}

function digestCommand(item: Record<string, unknown>, cfg: DigestConfig): DigestLine {
  const raw = String(item.command ?? "");
  let shown = firstLine(raw);
  if (raw.length > cfg.commandTruncateChars || raw.includes("\n")) {
    shown = truncate(shown, cfg.commandTruncateChars);
  }
  const exitCode = item.exitCode == null ? null : Number(item.exitCode);
  const stderr = String(item.aggregatedOutput ?? "");
  return {
    kind: "command",
    text: shown,
    exitCode,
    durationMs: item.durationMs == null ? null : Number(item.durationMs),
    stderrTail: exitCode == null || exitCode === 0 ? null : tailLines(stderr, cfg.stderrTailLinesOnFail),
  };
}

function digestFileChange(item: Record<string, unknown>): DigestLine {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const first = (changes[0] as Record<string, unknown> | undefined) || {};
  const pathValue = String(first.path ?? "");
  const linesAdded = Number(first.linesAdded ?? first.lines_added ?? 0);
  const linesRemoved = Number(first.linesRemoved ?? first.lines_removed ?? 0);
  return {
    kind: "file_change",
    text: `${pathValue} (+${linesAdded}/-${linesRemoved})`,
    path: pathValue,
    linesAdded,
    linesRemoved,
  };
}

function digestToolCall(item: Record<string, unknown>, cfg: DigestConfig): DigestLine {
  const server = String(item.server ?? "");
  const tool = String(item.tool ?? "");
  const argsRaw = item.arguments ?? item.args ?? "";
  let argsText = "";
  try {
    argsText = typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw);
  } catch {
    argsText = String(argsRaw);
  }
  const argsHead = argsText ? truncate(argsText, cfg.toolArgsTruncateChars) : "";
  const label = server ? `${server}/${tool}` : tool;
  return {
    kind: "tool_call",
    text: argsHead ? `${label}(${argsHead})` : label,
    toolName: label,
  };
}

function hasQuestion(message: string): boolean {
  const stripped = message.replace(FENCED_BLOCK, "").trimEnd();
  return stripped.endsWith("?");
}

export function classifyTier(lines: DigestLine[], status: string, finalMessage: string | null): TurnTier {
  if (!["ok", "completed"].includes(status)) {
    return "attn";
  }
  if (lines.some((line) => line.kind === "command" && line.exitCode != null && line.exitCode !== 0)) {
    return "attn";
  }
  if (finalMessage && hasQuestion(finalMessage)) {
    return "attn";
  }
  if (lines.some((line) => line.kind === "file_change")) {
    return "normal";
  }
  return "trivial";
}

export function buildTurnSummary(input: Omit<TurnSummary, "filesAdded" | "filesRemoved" | "tier">): TurnSummary {
  const filesAdded = input.lines
    .filter((line) => line.kind === "file_change")
    .reduce((sum, line) => sum + Number(line.linesAdded || 0), 0);
  const filesRemoved = input.lines
    .filter((line) => line.kind === "file_change")
    .reduce((sum, line) => sum + Number(line.linesRemoved || 0), 0);
  return {
    ...input,
    filesAdded,
    filesRemoved,
    tier: classifyTier(input.lines, input.status, input.finalMessage),
  };
}

function formatLine(line: DigestLine): string {
  if (line.kind === "command") {
    const status = line.exitCode === 0 ? "ok" : `FAIL exit=${line.exitCode}`;
    const suffix = line.stderrTail ? `\n    stderr: ${line.stderrTail}` : "";
    return `- [${status} ${line.durationMs || 0}ms] ${line.text}${suffix}`;
  }
  if (line.kind === "file_change") {
    return `- M ${line.path || ""} (+${line.linesAdded || 0}/-${line.linesRemoved || 0})`;
  }
  if (line.kind === "agent_message") {
    return `- msg: ${line.text}`;
  }
  if (line.kind === "tool_call") {
    return `- tool: ${line.text}`;
  }
  if (line.kind === "web_search") {
    return `- search: ${line.text}`;
  }
  return `- ${line.text}`;
}

export function writeHistoryMd(filePath: string, summary: TurnSummary, cfg?: DigestConfig): void {
  ensureDirFor(filePath);
  if (cfg) {
    rotateFileIfNeeded(filePath, cfg.historyRotationMb);
  }
  const parts: string[] = [
    `\n## Turn ${summary.turnId} · ${summary.elapsedMs}ms · status=${summary.status} · tier=${summary.tier}\n`,
  ];
  const fileLines = summary.lines.filter((line) => line.kind === "file_change");
  if (fileLines.length > 0) {
    parts.push("\n### File changes\n");
    parts.push(fileLines.map(formatLine).join("\n"));
    parts.push("\n");
  }
  const commandLines = summary.lines.filter((line) => line.kind === "command");
  if (commandLines.length > 0) {
    parts.push("\n### Commands\n");
    parts.push(commandLines.map(formatLine).join("\n"));
    parts.push("\n");
  }
  const messageLines = summary.lines.filter((line) => line.kind === "agent_message");
  if (messageLines.length > 0) {
    parts.push("\n### Messages\n");
    parts.push(messageLines.map(formatLine).join("\n"));
    parts.push("\n");
  }
  if (summary.finalMessage) {
    parts.push("\n### Final answer\n");
    parts.push(`> ${summary.finalMessage.replace(/\n/g, "\n> ")}\n`);
  }
  fs.appendFileSync(filePath, parts.join(""), "utf8");
}

export function writeTurnsJsonl(filePath: string, summary: TurnSummary, cfg?: DigestConfig): void {
  ensureDirFor(filePath);
  if (cfg) {
    rotateFileIfNeeded(filePath, cfg.historyRotationMb);
  }
  fs.appendFileSync(filePath, `${JSON.stringify(summary)}\n`, "utf8");
}
