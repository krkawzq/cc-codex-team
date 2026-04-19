import fs from "node:fs";
import path from "node:path";

import { DigestConfig } from "./config";
import { ensureDirFor, rotateFileIfNeeded } from "./fileIO";
import { DigestLine, TurnSummary, TurnTier } from "./models";

const FENCED_BLOCK = /```.*?```/gs;
type ChangeKind = NonNullable<DigestLine["changeKind"]>;

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

function longestBacktickRun(text: string): number {
  return (text.match(/`+/g) || []).reduce((longest, run) => Math.max(longest, run.length), 0);
}

function codeSpan(text: string): string {
  const delimiter = "`".repeat(longestBacktickRun(text) + 1);
  if (!text.includes("`")) {
    return `${delimiter}${text}${delimiter}`;
  }
  return `${delimiter} ${text} ${delimiter}`;
}

function fencedBlock(text: string, language = ""): string {
  const delimiter = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  const opening = language ? `${delimiter}${language}` : delimiter;
  return `  ${opening}\n  ${text.split("\n").join("\n  ")}\n  ${delimiter}`;
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
    const phase = item.phase == null ? null : String(item.phase);
    return {
      kind: "agent_message",
      text: String(item.text ?? ""),
      isFinal: phase === "final_answer" || phase === null,
    };
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
    return { kind: "collab_agent", text: String(item.tool ?? "subagent") };
  }
  return null;
}

function digestCommand(item: Record<string, unknown>, cfg: DigestConfig): DigestLine {
  const raw = String(item.command ?? "");
  const isMultiLine = raw.includes("\n");
  const inlineText = isMultiLine
    ? firstLine(raw)
    : raw.length > cfg.commandTruncateChars
      ? truncate(raw, cfg.commandTruncateChars)
      : raw;
  const exitCode = item.exitCode == null ? null : Number(item.exitCode);
  const stderr = String(item.aggregatedOutput ?? "");
  return {
    kind: "command",
    text: inlineText,
    fullText: isMultiLine ? raw : null,
    exitCode,
    durationMs: item.durationMs == null ? null : Number(item.durationMs),
    stderrTail: exitCode == null || exitCode === 0 ? null : tailLines(stderr, cfg.stderrTailLinesOnFail),
  };
}

function digestFileChange(item: Record<string, unknown>): DigestLine {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const first = (changes[0] as Record<string, unknown> | undefined) || {};
  const pathValue = String(first.path ?? "");
  const content = typeof first.content === "string" ? first.content : "";
  let linesAdded = Number(first.linesAdded ?? first.lines_added ?? 0);
  let linesRemoved = Number(first.linesRemoved ?? first.lines_removed ?? 0);

  if (linesAdded === 0 && linesRemoved === 0 && content) {
    linesAdded = content.split(/\r?\n/).length;
    linesRemoved = 0;
  }

  const rawKind = String(first.kind ?? "").toLowerCase();
  const previousPath = first.previousPath ?? first.previous_path ?? null;
  let changeKind: ChangeKind;
  if (rawKind === "add" || rawKind === "added" || rawKind === "create" || rawKind === "created") {
    changeKind = "A";
  } else if (rawKind === "delete" || rawKind === "deleted" || rawKind === "remove" || rawKind === "removed") {
    changeKind = "D";
  } else if (rawKind === "rename" || rawKind === "renamed" || rawKind === "move" || rawKind === "moved") {
    changeKind = "R";
  } else if (rawKind === "modify" || rawKind === "modified" || rawKind === "update" || rawKind === "updated") {
    changeKind = "M";
  } else if (linesRemoved === 0 && linesAdded > 0 && !previousPath) {
    changeKind = "A";
  } else if (linesAdded === 0 && linesRemoved > 0) {
    changeKind = "D";
  } else {
    changeKind = "M";
  }

  return {
    kind: "file_change",
    text: `${pathValue} (+${linesAdded}/-${linesRemoved})`,
    path: pathValue,
    linesAdded,
    linesRemoved,
    changeKind,
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
    const duration = line.durationMs || 0;
    const header = `- **[cmd ${status} ${duration}ms]**`;
    const stderrSuffix = line.stderrTail
      ? `\n\n  stderr:\n\n${fencedBlock(line.stderrTail)}`
      : "";
    if (line.fullText) {
      return `${header}\n\n${fencedBlock(line.fullText, "sh")}${stderrSuffix}`;
    }
    return `${header} ${codeSpan(line.text)}${stderrSuffix}`;
  }
  if (line.kind === "file_change") {
    return `- **[file ${line.changeKind || "M"}]** ${codeSpan(line.path || "")} (+${line.linesAdded || 0}/-${line.linesRemoved || 0})`;
  }
  if (line.kind === "agent_message") {
    const label = line.isFinal ? "**msg (final):**" : "**msg:**";
    const body = (line.text || "").trimEnd();
    return `- ${label}\n\n${fencedBlock(body, "markdown")}`;
  }
  if (line.kind === "tool_call") {
    return `- **[tool]** ${codeSpan(line.toolName || line.text)}`;
  }
  if (line.kind === "web_search") {
    return `- **[search]** ${codeSpan(line.text)}`;
  }
  if (line.kind === "collab_agent") {
    return `- **[subagent]** ${codeSpan(line.text)}`;
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

  const usageBits: string[] = [];
  if (summary.usageLastTokens != null) {
    usageBits.push(`tokens_last=${summary.usageLastTokens}`);
  }
  if (summary.usageTotalTokens != null) {
    usageBits.push(`tokens_total=${summary.usageTotalTokens}`);
  }
  if (summary.filesAdded || summary.filesRemoved) {
    usageBits.push(`files=+${summary.filesAdded}/-${summary.filesRemoved}`);
  }
  if (usageBits.length > 0 || summary.errorMessage) {
    parts.push("\n### Usage\n");
    if (usageBits.length > 0) {
      parts.push(usageBits.join(" · "));
      parts.push("\n");
    }
    if (summary.errorMessage) {
      parts.push(`error: ${summary.errorMessage}\n`);
    }
  }

  if (summary.lines.length > 0) {
    parts.push("\n### Timeline\n\n");
    parts.push(summary.lines.map(formatLine).join("\n"));
    parts.push("\n");
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
