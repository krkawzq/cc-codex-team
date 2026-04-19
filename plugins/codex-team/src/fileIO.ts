import fs from "node:fs";
import path from "node:path";

export function ensureDirFor(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function rotateFileIfNeeded(filePath: string, maxMb: number): void {
  if (maxMb <= 0 || !fs.existsSync(filePath)) {
    return;
  }
  const maxBytes = maxMb * 1024 * 1024;
  const stat = fs.statSync(filePath);
  if (stat.size < maxBytes) {
    return;
  }
  const rotated = `${filePath}.1`;
  if (fs.existsSync(rotated)) {
    fs.unlinkSync(rotated);
  }
  fs.renameSync(filePath, rotated);
}

export function readLastLines(filePath: string, lineCount: number): string {
  if (lineCount <= 0 || !fs.existsSync(filePath)) {
    return "";
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) {
      return "";
    }
    const chunkSize = 64 * 1024;
    let position = stat.size;
    let buffer = "";
    let lines: string[] = [];
    while (position > 0 && lines.length <= lineCount) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      fs.readSync(fd, chunk, 0, size, position);
      buffer = `${chunk.toString("utf8")}${buffer}`;
      lines = buffer.split(/\r?\n/);
    }
    const trimmed = lines.filter((line) => line.length > 0);
    return trimmed.slice(Math.max(0, trimmed.length - lineCount)).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonlTail(filePath: string, lineCount: number): string[] {
  const tail = readLastLines(filePath, lineCount);
  return tail ? tail.split(/\r?\n/).filter(Boolean) : [];
}
