export function parseAutoApprovePatterns(raw: string): string[] {
  if (raw.length === 0) return [];
  return raw
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

export function parseConfiguredAutoApprovePatterns(value: unknown): string[] {
  return typeof value === "string" ? parseAutoApprovePatterns(value) : [];
}

export function validateAutoApprovePatterns(raw: string): string | null {
  try {
    for (const pattern of parseAutoApprovePatterns(raw)) {
      validateAutoApprovePattern(pattern);
    }
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function validateAutoApprovePattern(pattern: string): void {
  if (!pattern.startsWith("/")) return;
  parseRegexPattern(pattern);
}

function parseRegexPattern(pattern: string): RegExp {
  const trailingSlash = pattern.lastIndexOf("/");
  if (trailingSlash <= 0) {
    throw new Error(`invalid auto-approve regex '${pattern}': expected /pattern/flags`);
  }
  const source = pattern.slice(1, trailingSlash);
  const flags = pattern.slice(trailingSlash + 1);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(`invalid auto-approve regex '${pattern}': ${(error as Error).message}`);
  }
}
