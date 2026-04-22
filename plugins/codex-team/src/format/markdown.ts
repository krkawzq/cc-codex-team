import type { SessionRecord } from "../daemon/sessions";
import type { Thread, TurnListItem } from "../codex/rpc";

export function renderTag(name: string, attrs: Record<string, unknown>, body: string): string {
  const line = `<${name}> ${compactJson(attrs)}`;
  if (!body || body.trim().length === 0) {
    return `${line}\n\n<\\${name}>`;
  }
  return `${line}\n\n${body.trim()}\n\n<\\${name}>`;
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

  return renderTag("context", attrs, [
    "<!-- thread/read only returns thread metadata; for turn-level content use 'message history' -->",
  ].join("\n"));
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
  const body = items.map(renderItem).filter(Boolean).join("\n\n");
  return renderTag("turn", attrs, body);
}

function renderItem(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const item = raw as Record<string, unknown>;
  const type = typeof item.type === "string" ? item.type : "unknown";
  const id = typeof item.id === "string" ? item.id : undefined;
  const attrs: Record<string, unknown> = {};
  if (id) attrs.id = id;

  switch (type) {
    case "agent_message": {
      const text = typeof item.text === "string" ? item.text : stringifyMaybe(item.content);
      return renderTag("agent-message", attrs, text ?? "");
    }
    case "reasoning": {
      const text = typeof item.text === "string" ? item.text : stringifyMaybe(item.summary);
      return renderTag("reasoning", attrs, text ?? "");
    }
    case "command_execution": {
      if (item.command !== undefined) attrs.cmd = item.command;
      if (item.exit !== undefined) attrs.exit = item.exit;
      if (item.durationMs !== undefined) attrs.duration_ms = item.durationMs;
      if (item.stderr !== undefined) attrs.stderr = item.stderr;
      const body = typeof item.stdout === "string" ? item.stdout : stringifyMaybe(item.output) ?? "";
      return renderTag("shell", attrs, body);
    }
    case "file_change": {
      if (item.path !== undefined) attrs.path = item.path;
      if (item.status !== undefined) attrs.status = item.status;
      const body = typeof item.diff === "string" ? item.diff : stringifyMaybe(item.changes) ?? "";
      return renderTag("file-patch", attrs, body);
    }
    default: {
      attrs.type = type;
      const body = stringifyMaybe(item) ?? "";
      return renderTag("item", attrs, body);
    }
  }
}

function stringifyMaybe(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); }
  catch { return String(v); }
}

function compactJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}
