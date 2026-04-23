function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  const source = Array.from(pattern, (char) => {
    if (char === "*") return ".*";
    if (char === "?") return ".";
    return escapeRegex(char);
  }).join("");
  return new RegExp(`^${source}$`);
}

export function matchesGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}
