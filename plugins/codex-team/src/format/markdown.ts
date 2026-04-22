import type { SessionRecord } from "../daemon/sessions";
import type { Thread, TurnListItem } from "../codex/rpc";

export type TurnItem = Record<string, unknown>;

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

export function renderHistory(input: {
  session: string;
  thread_id: string;
  turns: TurnListItem[];
  nextCursor?: string | null;
}): string {
  const attrs: Record<string, unknown> = {
    session: input.session,
    thread_id: input.thread_id,
    count: input.turns.length,
    generated_at: new Date().toISOString(),
  };
  if (input.nextCursor) attrs.next_cursor = input.nextCursor;

  const body = input.turns.map(renderTurn).join("\n\n");
  return renderTag("history", attrs, body);
}

export function renderTail(input: {
  session: string;
  thread_id: string;
  turns: TurnListItem[];
  thread: Thread | null;
  follow: boolean;
}): string {
  const attrs: Record<string, unknown> = {
    session: input.session,
    thread_id: input.thread_id,
    count: input.turns.length,
    generated_at: new Date().toISOString(),
  };
  if (input.follow) attrs.follow = true;
  const body = input.turns.map(renderTurn).join("\n\n");
  return renderTag("tail", attrs, body);
}

export function renderContext(input: {
  session: string | null;
  thread_id: string;
  thread: Thread | null;
}): string {
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
    ? ((t as { turns: unknown[] }).turns)
        .filter((turn): turn is TurnListItem => !!turn && typeof turn === "object")
        .map(renderTurn)
        .filter(Boolean)
    : [];

  return renderTag("context", attrs, turns.length > 0
    ? turns.join("\n\n")
    : "<!-- thread/read only returns thread metadata; for turn-level content use 'message history' -->");
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
  bodyLines.push(`- **created**: ${rec.created_at}`);
  bodyLines.push(`- **last_active**: ${rec.last_active_at}`);
  return renderTag("session-info", attrs, bodyLines.join("\n"));
}

function renderTurn(turn: TurnListItem): string {
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
    .map((item) => renderItem(item))
    .filter(Boolean)
    .join("\n\n");
  return renderTag("turn", attrs, body);
}

export function renderItem(item: TurnItem, indent = ""): string {
  const type = normalizeItemType(item.type);
  const rendered = (() => {
    switch (type) {
      case "userMessage":
        return renderUserMessage(item);
      case "agentMessage":
        return renderAgentMessage(item);
      case "commandExecution":
        return renderCommandExecution(item);
      case "fileChange":
      case "file-patch":
        return renderFileChange(item);
      case "reasoning":
        return renderReasoning(item);
      default:
        return renderInline("item", sanitizeInlineAttrs(item));
    }
  })();

  return indent ? indentBlock(rendered, indent) : rendered;
}

function compactJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function renderUserMessage(item: TurnItem): string {
  const attrs = baseItemAttrs(item);
  const text = extractMessageText(item);
  if (text) attrs.text = text;
  return renderInline("item", attrs);
}

function renderAgentMessage(item: TurnItem): string {
  const attrs = baseItemAttrs(item);
  const body = extractMessageText(item);
  if (!body) return renderInline("item", attrs);
  return renderTag("item", attrs, body);
}

function renderCommandExecution(item: TurnItem): string {
  const attrs = baseItemAttrs(item);
  delete attrs.status;
  const shellAttrs: Record<string, unknown> = {};
  const cmd = extractCommand(item);
  if (cmd) shellAttrs.cmd = cmd;
  const cwd = asString(item.cwd);
  if (cwd) shellAttrs.cwd = cwd;
  const exit = item.exit ?? item.exitCode;
  if (exit !== undefined) shellAttrs.exit = exit;
  const durationMs = item.duration_ms ?? item.durationMs;
  if (durationMs !== undefined) shellAttrs.duration_ms = durationMs;
  const shellBody = extractCommandOutput(item) ?? "";
  return renderTag("item", attrs, renderTag("shell", shellAttrs, shellBody));
}

function renderFileChange(item: TurnItem): string {
  const attrs = baseItemAttrs(item);
  delete attrs.status;
  const patchAttrs: Record<string, unknown> = {};
  const path = asString(item.path);
  if (path) patchAttrs.path = path;
  if (item.status !== undefined) patchAttrs.status = item.status;
  const diffBody = extractDiff(item) ?? "";
  return renderTag("item", attrs, renderTag("file-patch", patchAttrs, diffBody));
}

function renderReasoning(item: TurnItem): string {
  const attrs = baseItemAttrs(item);
  const text = extractReasoningText(item);
  if (text) attrs.text = text;
  return renderInline("item", attrs);
}

function baseItemAttrs(item: TurnItem): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (typeof item.id === "string") attrs.id = item.id;
  attrs.type = normalizeItemType(item.type);
  if (item.phase !== undefined) attrs.phase = item.phase;
  if (item.status !== undefined) attrs.status = item.status;
  if (item.kind !== undefined) attrs.kind = item.kind;
  if (item.role !== undefined) attrs.role = item.role;
  if (item.source !== undefined) attrs.source = item.source;
  return attrs;
}

function sanitizeInlineAttrs(item: TurnItem): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined || OMIT_INLINE_KEYS.has(key)) continue;
    attrs[key] = value;
  }
  if (!("id" in attrs) && typeof item.id === "string") attrs.id = item.id;
  if (!("type" in attrs)) attrs.type = normalizeItemType(item.type);
  return attrs;
}

function normalizeItemType(raw: unknown): string {
  const type = typeof raw === "string" && raw ? raw : "unknown";
  return ITEM_TYPE_ALIASES[type] ?? type;
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

const ITEM_TYPE_ALIASES: Record<string, string> = {
  agent_message: "agentMessage",
  command_execution: "commandExecution",
  file_change: "fileChange",
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
]);
