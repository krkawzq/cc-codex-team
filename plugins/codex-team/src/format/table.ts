export function renderTable(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) return `(no rows)`;
  const matrix: string[][] = [columns];
  for (const row of rows) {
    matrix.push(columns.map((c) => stringify(row[c])));
  }
  const widths = columns.map((_, colIdx) => Math.max(...matrix.map((r) => (r[colIdx] ?? "").length)));
  const pad = (cell: string, w: number) => cell + " ".repeat(Math.max(0, w - cell.length));
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const lines: string[] = [];
  lines.push(matrix[0].map((c, i) => pad(c, widths[i])).join("  "));
  lines.push(sep);
  for (let i = 1; i < matrix.length; i++) {
    lines.push(matrix[i].map((c, j) => pad(c, widths[j])).join("  "));
  }
  return lines.join("\n");
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}
