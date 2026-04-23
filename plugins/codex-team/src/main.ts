import fs from "node:fs";
import path from "node:path";

import { runCli } from "./cli/run";
import { runDaemon } from "./daemon/run";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const hasDaemonInternal = argv.includes("--daemon-internal");
  const stderrPath = hasDaemonInternal ? takeOptionValue(argv, "--stderr-to") : null;
  const daemonIdx = argv.indexOf("--daemon-internal");
  if (daemonIdx >= 0) {
    argv.splice(daemonIdx, 1);
    if (stderrPath) redirectProcessStderr(stderrPath);
    const code = await runDaemon();
    process.exit(code);
  }

  const code = await runCli(argv);
  process.exit(code);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message ?? e}\n`);
  process.exit(1);
});

function takeOptionValue(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx < 0) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  argv.splice(idx, 2);
  return value;
}

function redirectProcessStderr(stderrPath: string): void {
  fs.mkdirSync(path.dirname(stderrPath), { recursive: true });
  const stream = fs.createWriteStream(stderrPath, { flags: "a" });
  stream.on("error", () => undefined);

  const write = stream.write.bind(stream);
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error: Error | null | undefined) => void), cb?: (error: Error | null | undefined) => void) => {
    if (typeof encoding === "function") return write(chunk, encoding);
    if (typeof encoding === "string") {
      return typeof cb === "function" ? write(chunk, encoding, cb) : write(chunk, encoding);
    }
    if (typeof cb === "function") return write(chunk, cb);
    return write(chunk);
  }) as typeof process.stderr.write;

  process.on("exit", () => stream.end());
}
