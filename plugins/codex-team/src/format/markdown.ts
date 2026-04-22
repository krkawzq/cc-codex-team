import type { SessionRecord } from "../daemon/sessions";
import type { Thread, TurnListItem } from "../codex/rpc";

export type TurnItem = Record<string, unknown>;

export interface MarkdownRenderOptions {
  truncate?: number | null;
}

interface RenderContext {
  inlineMaxBytes: number;
  truncateBytes: number | null;
}

export const INLINE_MAX_BYTES = 2048;

export function renderTag(name: string, attrs: Record<string, unknown>, body: string): string {
  const line = `<${name}> ${compactJson(attrs)}`;
  const normalizedBody = stripOuterNewlines(body);
  if (!normalizedBody) {
    return `${line}\n\n<\\${name}>`;
  }
  return `${line}\n\n${normalizedBody}\n\n<\\${name}>`;
}

export function renderInline(name: string, attrs: Record<string, unknown>): string {
  return `<${name}>${compactJson(attrs)}<\\${name}>`;
}

export function renderHistory(
  input: {
    session: string;
    thread_id: string;
    turns: TurnListItem[];
    nextCursor?: string | null;
  },
  options: MarkdownRenderOptions = {},
): string {
  const ctx = createRenderContext(options);
  const attrs: Record<string, unknown> = {
    session: input.session,
    thread_id: input.thread_id,
    count: input.turns.length,
    generated_at: new Date().toISOString(),
  };
  if (input.nextCursor) attrs.next_cursor = input.nextCursor;

  const body = input.turns.map((turn) => renderTurn(turn, ctx)).join("\n\n");
  return renderTag("history", attrs, body);
}

export function renderTail(
  input: {
    session: string;
    thread_id: string;
    turns: TurnListItem[];
    thread: Thread | null;
    follow: boolean;
  },
  options: MarkdownRenderOptions = {},
): string {
  const ctx = createRenderContext(options);
  const attrs: Record<string, unknown> = {
    session: input.session,
    thread_id: input.thread_id,
    count: input.turns.length,
    generated_at: new Date().toISOString(),
  };
  if (input.follow) attrs.follow = true;
  const body = input.turns.map((turn) => renderTurn(turn, ctx)).join("\n\n");
  return renderTag("tail", attrs, body);
}

export function renderContext(input: {
  session: string | null;
  thread_id: string;
  thread: Thread | null;
}): string {
  const ctx = createRenderContext();
  const t = input.thread;
  const attrs: Record<string, unknown> = {
    session: input.session,
    thread_id: input.thread_id,
    generated_at: new Date().toISOString(),
  };
  if (t) {
    if (typeof t.model_provider === "string") attrs.model_provider = t.model_provider;
    if (typeof t.preview === "string") attrs.preview = t.preview;
    if (typeof t.cwd === "string") attrs.cwd = t.cwd;
    const status = (t.status as unknown as { type?: string })?.type;
    if (typeof status === "string") attrs.status = status;
    if (typeof t.created_at === "number") attrs.created_at = t.created_at;
    if (typeof t.updated_at === "number") attrs.updated_at = t.updated_at;
  }

  const turns = Array.isArray((t as { turns?: unknown[] } | null)?.turns)
    ? (((t as unknown as { turns: unknown[] })).turns)
        .filter((turn): turn is TurnListItem => !!turn && typeof turn === "object")
        .map((turn) => renderTurn(turn, ctx))
        .filter(Boolean)
    : [];

  return renderTag(
    "context",
    attrs,
    turns.length > 0
      ? turns.join("\n\n")
      : "<!-- thread/read only returns thread metadata; for turn-level content use 'message history' -->",
  );
}

export function renderSessionInfo(rec: SessionRecord): string {
  const attrs = {
    name: rec.name,
    thread_id: rec.thread_id,
    state: rec.state,
    generated_at: new Date().toISOString(),
  };
  const bodyLines: string[] = [];
  if (rec.model) bodyLines.push(`- **model**: ${rec.model}`);
  if (rec.cwd) bodyLines.push(`- **cwd**: \`${rec.cwd}\``);
  if (typeof rec.turn_count === "number") bodyLines.push(`- **turns**: ${rec.turn_count}`);
  if (rec.sandbox) bodyLines.push(`- **sandbox**: ${rec.sandbox}`);
  if (rec.approval) bodyLines.push(`- **approval_policy**: ${rec.approval}`);
  if (rec.effort) bodyLines.push(`- **effort**: ${rec.effort}`);
  if (rec.profile) bodyLines.push(`- **profile**: ${rec.profile}`);
  if (rec.experimental_tools?.length) bodyLines.push(`- **experimental_tools**: ${rec.experimental_tools.join(", ")}`);
  bodyLines.push(`- **created**: ${rec.created_at}`);
  bodyLines.push(`- **last_active**: ${rec.last_active_at}`);
  return renderTag("session-info", attrs, bodyLines.join("\n"));
}

function renderTurn(turn: TurnListItem, ctx: RenderContext): string {
  const attrs: Record<string, unknown> = {
    id: turn.id,
    status: turn.status ?? null,
  };
  if (turn.durationMs !== undefined && turn.durationMs !== null) attrs.duration_ms = turn.durationMs;
  if (turn.startedAt !== undefined && turn.startedAt !== null) attrs.started_at = turn.startedAt;
  if (turn.completedAt !== undefined && turn.completedAt !== null) attrs.completed_at = turn.completedAt;
  const err = turn.error ?? null;
  if (err) attrs.error = err;

  const items = Array.isArray((turn as unknown as { items?: unknown[] }).items)
    ? (turn as unknown as { items: unknown[] }).items
    : [];
  if (items.length === 0) {
    return renderInline("turn", attrs);
  }
  const body = items
    .filter((item): item is TurnItem => !!item && typeof item === "object")
    .map((item) => renderItemWithContext(item, ctx))
    .filter(Boolean)
    .join("\n\n");
  return renderTag("turn", attrs, body);
}

export function renderItem(item: TurnItem, indent = "", options: MarkdownRenderOptions = {}): string {
  const rendered = renderItemWithContext(item, createRenderContext(options));
  return indent ? indentBlock(rendered, indent) : rendered;
}

function renderItemWithContext(item: TurnItem, ctx: RenderContext): string {
  const type = normalizeItemType(item.type);
  switch (type) {
    case "userMessage":
      return renderUserMessage(item, ctx);
    case "agentMessage":
      return renderAgentMessage(item, ctx);
    case "commandExecution":
      return renderCommandExecution(item, ctx);
    case "fileChange":
    case "file-patch":
      return renderFileChange(item, ctx);
    case "mcpToolCall":
      return renderMcpToolCall(item, ctx);
    case "autoApprovalReview":
      return renderAutoApprovalReview(item, ctx);
    case "reasoning":
      return renderReasoning(item, ctx);
    default:
      if (type.startsWith("hook.")) return renderHook(item, type, ctx);
      return renderInline("item", sanitizeInlineAttrs(item, ctx));
  }
}

function createRenderContext(options: MarkdownRenderOptions = {}): RenderContext {
  const normalized = normalizeTruncateOption(options.truncate);
  return {
    inlineMaxBytes: normalized === 0 ? INLINE_MAX_BYTES : normalized ?? INLINE_MAX_BYTES,
    truncateBytes: normalized === 0 ? null : normalized ?? INLINE_MAX_BYTES,
  };
}

function normalizeTruncateOption(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function compactJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function renderInlineValue(name: string, value: unknown): string {
  return `<${name}>${compactJson(value)}<\\${name}>`;
}

function renderBodyTag(name: string, attrs: Record<string, unknown>, body: string, ctx: RenderContext): string {
  return renderTag(name, attrs, applyBodyTruncation(body, ctx));
}

function renderJsonValueTag(name: string, value: unknown, ctx: RenderContext): string {
  const compact = compactJson(value);
  if (byteLength(compact) <= ctx.inlineMaxBytes) {
    return renderInlineValue(name, value);
  }
  return renderBodyTag(name, {}, prettyJson(value), ctx);
}

function renderUserMessage(item: TurnItem, ctx: RenderContext): string {
  const attrs = baseItemAttrs(item, { includeType: false });
  const text = extractMessageText(item);
  if (!text) return renderInline("user-input", attrs);
  if (byteLength(text) > ctx.inlineMaxBytes) {
    return renderBodyTag("user-input", attrs, text, ctx);
  }
  attrs.text = text;
  return renderInline("user-input", attrs);
}

function renderAgentMessage(item: TurnItem, ctx: RenderContext): string {
  const attrs = baseItemAttrs(item, { includeType: false });
  const body = extractMessageText(item);
  if (!body) return renderInline("agent-message", attrs);
  return renderBodyTag("agent-message", attrs, body, ctx);
}

function renderCommandExecution(item: TurnItem, ctx: RenderContext): string {
  const attrs = baseItemAttrs(item, { includeType: false });
  const cmd = extractCommand(item);
  if (cmd) attrs.cmd = fitInlineText(cmd, ctx);
  const cwd = asString(item.cwd);
  if (cwd) attrs.cwd = cwd;
  const exit = item.exit ?? item.exitCode;
  if (exit !== undefined) attrs.exit = exit;
  const durationMs = item.duration_ms ?? item.durationMs;
  if (durationMs !== undefined) attrs.duration_ms = durationMs;
  const shellBody = extractCommandOutput(item) ?? "";
  return renderBodyTag("shell", attrs, shellBody, ctx);
}

function renderFileChange(item: TurnItem, ctx: RenderContext): string {
  const attrs = baseItemAttrs(item, { includeType: false });
  const path = asString(item.path);
  if (path) attrs.path = path;
  if (item.status !== undefined) attrs.status = item.status;
  const diffBody = extractDiff(item) ?? "";
  return renderBodyTag("file-patch", attrs, diffBody, ctx);
}

function renderMcpToolCall(item: TurnItem, ctx: RenderContext): string {
  const attrs = baseItemAttrs(item, { includeType: false });
  const server = asString(item.server) ?? asString(item.serverName);
  if (server) attrs.server = server;
  const tool = extractToolName(item);
  attrs.tool = tool;
  const durationMs = item.duration_ms ?? item.durationMs;
  if (durationMs !== undefined) attrs.duration_ms = durationMs;

  const bodyParts: string[] = [];
  const args = extractMcpArgs(item);
  if (args !== undefined) bodyParts.push(renderJsonValueTag("mcp-args", args, ctx));

  const result = extractMcpResult(item);
  if (result) bodyParts.push(renderBodyTag("mcp-result", {}, result, ctx));

  return renderTag(`tool.${toTagSegment(tool)}`, attrs, bodyParts.join("\n\n"));
}

function renderHook(item: TurnItem, type: string, ctx: RenderContext): string {
  const run = asObject(item.run);
  const attrs = baseItemAttrs(item, { includeType: false });

  const hookId = asString(item.hook_id) ?? asString(item.hookId) ?? asString(run.id);
  if (hookId) attrs.hook_id = hookId;
  const status = asString(item.status) ?? asString(run.status);
  if (status) attrs.status = status;
  const command = extractCommand(item) ?? extractCommand(run);
  if (command) attrs.command = fitInlineText(command, ctx);
  const cwd = asString(item.cwd) ?? asString(run.cwd);
  if (cwd) attrs.cwd = cwd;
  const exit = item.exit ?? item.exitCode ?? run.exit ?? run.exitCode;
  if (exit !== undefined) attrs.exit = exit;
  const durationMs = item.duration_ms ?? item.durationMs ?? run.duration_ms ?? run.durationMs;
  if (durationMs !== undefined) attrs.duration_ms = durationMs;

  const output = extractHookOutput(item, run);
  const tagName = typeToTagName(type);
  if (!output) return renderInline(tagName, attrs);
  return renderTag(tagName, attrs, renderBodyTag("hook-output", {}, output, ctx));
}

function renderAutoApprovalReview(item: TurnItem, ctx: RenderContext): string {
  const review = asObject(item.review);
  const attrs = baseItemAttrs(item, { includeType: false });

  const kind = asString(item.kind)
    ?? asString(review.kind)
    ?? asString(review.request_kind)
    ?? asString(review.requestKind)
    ?? asString(review.approval_kind)
    ?? asString(review.approvalKind);
  if (kind) attrs.kind = kind;

  const matchedPattern = asString(item.matched_pattern)
    ?? asString(item.matchedPattern)
    ?? asString(review.matched_pattern)
    ?? asString(review.matchedPattern)
    ?? asString(review.pattern);
  if (matchedPattern) attrs.matched_pattern = fitInlineText(matchedPattern, ctx);

  const commandPreview = extractCommandPreview(item, review);
  if (commandPreview) attrs.command_preview = fitInlineText(commandPreview, ctx);

  const decision = asString(item.decision)
    ?? asString(item.action)
    ?? asString(item.decision_source)
    ?? asString(item.decisionSource)
    ?? asString(review.decision)
    ?? asString(review.action);
  if (decision) attrs.decision = fitInlineText(decision, ctx);

  return renderInline("auto-approval-review", attrs);
}

function renderReasoning(item: TurnItem, ctx: RenderContext): string {
  const attrs = baseItemAttrs(item, { includeType: false });
  const text = extractReasoningText(item);
  if (!text) return renderInline("reasoning", attrs);
  if (byteLength(text) <= ctx.inlineMaxBytes) {
    attrs.text = text;
    return renderInline("reasoning", attrs);
  }
  return renderBodyTag("reasoning", attrs, text, ctx);
}

function baseItemAttrs(item: TurnItem, options: { includeType?: boolean } = {}): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (typeof item.id === "string") attrs.id = item.id;
  if (options.includeType !== false) attrs.type = normalizeItemType(item.type);
  if (item.phase !== undefined) attrs.phase = item.phase;
  if (item.status !== undefined) attrs.status = item.status;
  if (item.kind !== undefined) attrs.kind = item.kind;
  if (item.role !== undefined) attrs.role = item.role;
  if (item.source !== undefined) attrs.source = item.source;
  return attrs;
}

function sanitizeInlineAttrs(item: TurnItem, ctx: RenderContext): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined || OMIT_INLINE_KEYS.has(key)) continue;
    attrs[key] = typeof value === "string" ? fitInlineText(value, ctx) : value;
  }
  if (!("id" in attrs) && typeof item.id === "string") attrs.id = item.id;
  if (!("type" in attrs)) attrs.type = normalizeItemType(item.type);
  return attrs;
}

function normalizeItemType(raw: unknown): string {
  const type = typeof raw === "string" && raw ? raw : "unknown";
  return ITEM_TYPE_ALIASES[type] ?? type;
}

function typeToTagName(type: string): string {
  return type.split(".").map(toTagSegment).join(".");
}

function toTagSegment(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function extractMessageText(item: TurnItem): string | null {
  return firstText(item.text, item.content);
}

function extractReasoningText(item: TurnItem): string | null {
  return firstText(item.text, item.summaryText, item.summary, item.content);
}

function extractCommand(item: TurnItem): string | null {
  const direct = asString(item.command) ?? asString(item.cmd);
  if (direct) return direct;

  const command = item.command;
  if (Array.isArray(command)) {
    const parts = command
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "number" || typeof part === "boolean") return String(part);
        return null;
      })
      .filter((part): part is string => !!part);
    if (parts.length > 0) return parts.join(" ");
  }

  return null;
}

function extractCommandOutput(item: TurnItem): string | null {
  const direct = asString(item.output);
  if (direct) return direct;

  const output = item.output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const stdout = asString((output as Record<string, unknown>).stdout);
    const stderr = asString((output as Record<string, unknown>).stderr);
    const merged = joinText([stdout, stderr], "\n");
    if (merged) return merged;
  }

  return joinText([asString(item.stdout), asString(item.stderr)], "\n");
}

function extractDiff(item: TurnItem): string | null {
  return asString(item.diff) ?? asString(item.patch) ?? asString(item.changes);
}

function extractToolName(item: TurnItem): string {
  return asString(item.tool)
    ?? asString(item.toolName)
    ?? asString(item.name)
    ?? "unknown";
}

function extractMcpArgs(item: TurnItem): unknown {
  const args = item.args ?? item.arguments ?? item.input ?? item.parameters;
  return args === undefined ? undefined : args;
}

function extractMcpResult(item: TurnItem): string | null {
  return extractRichBody(item.result, item.output, item.content, item.text);
}

function extractHookOutput(item: TurnItem, run: TurnItem): string | null {
  return extractCommandOutput(item)
    ?? extractCommandOutput(run)
    ?? extractRichBody(item.result, run.result);
}

function extractCommandPreview(...values: TurnItem[]): string | null {
  for (const value of values) {
    const preview = asString(value.command_preview)
      ?? asString(value.commandPreview)
      ?? extractCommand(value);
    if (preview) return preview;
  }
  return null;
}

function extractRichBody(...values: unknown[]): string | null {
  for (const value of values) {
    const text = extractText(value);
    if (text) return text;

    if (Array.isArray(value)) {
      const serialized = compactJson(value);
      if (serialized !== "[]") return serialized;
      continue;
    }

    if (value && typeof value === "object") {
      const serialized = JSON.stringify(value, null, 2);
      if (serialized && serialized !== "{}") return serialized;
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = extractText(value);
    if (text) return text;
  }
  return null;
}

function extractText(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (!Array.isArray(value)) return null;

  const parts = value
    .map((entry) => extractTextEntry(entry))
    .filter((entry): entry is string => !!entry);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function extractTextEntry(entry: unknown): string | null {
  if (typeof entry === "string" && entry.length > 0) return entry;
  if (!entry || typeof entry !== "object") return null;

  const obj = entry as Record<string, unknown>;
  if (typeof obj.text === "string" && obj.text.length > 0) return obj.text;
  if (Array.isArray(obj.content)) return extractText(obj.content);
  return null;
}

function applyBodyTruncation(text: string, ctx: RenderContext): string {
  if (ctx.truncateBytes === null) return text;
  const truncated = truncateText(text, ctx.truncateBytes);
  return truncated.truncatedBytes > 0
    ? `${truncated.text}\n${buildTruncationMarker(truncated.truncatedBytes)}`
    : text;
}

function fitInlineText(text: string, ctx: RenderContext): string {
  if (ctx.truncateBytes === null) return text;
  const truncated = truncateText(text, ctx.truncateBytes);
  return truncated.truncatedBytes > 0
    ? `${truncated.text}${buildTruncationMarker(truncated.truncatedBytes)}`
    : text;
}

function truncateText(text: string, maxBytes: number): { text: string; truncatedBytes: number } {
  const totalBytes = byteLength(text);
  if (totalBytes <= maxBytes) {
    return { text, truncatedBytes: 0 };
  }

  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = chars.slice(0, mid).join("");
    if (byteLength(candidate) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const truncatedText = chars.slice(0, low).join("");
  return {
    text: stripOuterNewlines(truncatedText),
    truncatedBytes: totalBytes - byteLength(truncatedText),
  };
}

function buildTruncationMarker(truncatedBytes: number): string {
  return `…[${truncatedBytes} bytes truncated; use --truncate 0 to disable]`;
}

function prettyJson(value: unknown): string {
  if (value === undefined) return "{}";
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function joinText(values: Array<string | null>, separator: string): string | null {
  const present = values.filter((value): value is string => !!value);
  return present.length > 0 ? present.join(separator) : null;
}

function stripOuterNewlines(value: string): string {
  return value.replace(/^\n+/, "").replace(/\n+$/, "");
}

function indentBlock(text: string, indent: string): string {
  return text.split("\n").map((line) => (line ? `${indent}${line}` : line)).join("\n");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

const ITEM_TYPE_ALIASES: Record<string, string> = {
  agent_message: "agentMessage",
  auto_approval_review: "autoApprovalReview",
  command_execution: "commandExecution",
  file_change: "fileChange",
  mcp_tool_call: "mcpToolCall",
  user_message: "userMessage",
};

const OMIT_INLINE_KEYS = new Set([
  "content",
  "stdout",
  "stderr",
  "output",
  "diff",
  "patch",
  "changes",
  "result",
  "review",
  "run",
]);
