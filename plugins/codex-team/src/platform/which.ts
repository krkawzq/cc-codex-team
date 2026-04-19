import fs from "node:fs";
import path from "node:path";

import { isWindows } from "./os";

export interface WhichOptions {
  pathExt?: string[];
}

const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

export function whichExecutable(name: string, opts: WhichOptions = {}): string | null {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = isWindows
    ? opts.pathExt || (process.env.PATHEXT || DEFAULT_PATHEXT.join(";")).split(";").filter(Boolean)
    : [""];
  const nameExt = path.extname(name).toUpperCase();
  const candidates = isWindows && nameExt && extensions.map((ext) => ext.toUpperCase()).includes(nameExt)
    ? [name]
    : [name, ...extensions.map((ext) => `${name}${ext}`)];

  for (const entry of pathEntries) {
    for (const candidateName of candidates) {
      const candidate = path.join(entry, candidateName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isExecutable(filePath: string): boolean {
  try {
    if (isWindows) {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
