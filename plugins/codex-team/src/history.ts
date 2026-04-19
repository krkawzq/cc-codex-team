export interface FilterResult {
  content: string;
  matchedSinceTurnId: boolean;
}

interface HistorySection {
  turnId: string;
  block: string;
}

export function filterHistoryMarkdown(
  content: string,
  options: {
    lastN?: number;
    sinceTurnId?: string;
  } = {},
): FilterResult {
  const sections = splitMarkdownSections(content);
  let matchedSinceTurnId = true;
  let filtered = sections;

  if (options.sinceTurnId) {
    const index = sections.findIndex((section) => section.turnId === options.sinceTurnId);
    if (index < 0) {
      matchedSinceTurnId = false;
      filtered = [];
    } else {
      filtered = sections.slice(index + 1);
    }
  }

  if (options.lastN && options.lastN > 0) {
    filtered = filtered.slice(-options.lastN);
  }

  return {
    content: filtered.map((section) => section.block).join(""),
    matchedSinceTurnId,
  };
}

export function filterTurnsJsonl(
  content: string,
  options: {
    lastN?: number;
    since?: string;
    sinceTurnId?: string;
  } = {},
): FilterResult {
  const allLines = content.split(/\r?\n/).filter(Boolean);
  let matchedSinceTurnId = true;
  let started = !options.sinceTurnId;
  let lines: string[] = [];

  for (const line of allLines) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const turnId = String(payload.turnId ?? payload.turn_id ?? "");
    if (!started && options.sinceTurnId) {
      if (turnId === options.sinceTurnId) {
        started = true;
      }
      continue;
    }
    if (options.since) {
      const completedAt = String(payload.completedAt ?? payload.completed_at ?? "");
      if (completedAt && completedAt < options.since) {
        continue;
      }
    }
    lines.push(line);
  }

  if (options.sinceTurnId && !started) {
    matchedSinceTurnId = false;
    lines = [];
  }

  if (options.lastN && options.lastN > 0) {
    lines = lines.slice(-options.lastN);
  }

  return {
    content: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    matchedSinceTurnId,
  };
}

function splitMarkdownSections(content: string): HistorySection[] {
  const pattern = /^## Turn ([^\s]+).*$/gm;
  const matches = [...content.matchAll(pattern)];
  if (matches.length === 0) {
    return [];
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? content.length : content.length;
    return {
      turnId: match[1],
      block: content.slice(start, end),
    };
  });
}
