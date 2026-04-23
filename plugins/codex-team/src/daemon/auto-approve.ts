import { logger } from "../logger";

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

export interface AutoApproveMatch {
  matchedPattern: string;
  commandPreview: string;
}

export function validateAutoApprovePatterns(raw: string): string | null {
  return validateParsedAutoApprovePatterns(parseAutoApprovePatterns(raw));
}

export function validateParsedAutoApprovePatterns(patterns: string[]): string | null {
  try {
    for (const pattern of patterns) {
      validateAutoApprovePattern(pattern);
    }
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function matchAutoApprovePattern(patterns: string[], target: unknown): AutoApproveMatch | null {
  if (typeof target !== "string" || target.length === 0) return null;
  for (const pattern of patterns) {
    let matched = false;
    try {
      matched = matchesPattern(pattern, target);
    } catch (error) {
      logger.warn("auto-approve pattern match failed; ignoring pattern", {
        pattern,
        err: (error as Error).message,
        target: previewAutoApproveTarget(target),
      });
      continue;
    }
    if (matched) {
      return {
        matchedPattern: pattern,
        commandPreview: previewAutoApproveTarget(target),
      };
    }
  }
  return null;
}

function validateAutoApprovePattern(pattern: string): void {
  if (!pattern.startsWith("/")) return;
  parseRegexPattern(pattern);
}

function matchesPattern(pattern: string, target: string): boolean {
  if (pattern.startsWith("/")) return parseRegexPattern(pattern).test(target);
  if (!pattern.includes("*")) return pattern === target;
  return new RegExp(`^${escapeGlobPattern(pattern)}$`).test(target);
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

function escapeGlobPattern(pattern: string): string {
  return pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*");
}

function previewAutoApproveTarget(target: string): string {
  return target.length > 160 ? `${target.slice(0, 157)}...` : target;
}
