import fs from "node:fs";
import path from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export class Logger {
  private level: LogLevel = "info";
  private stream: fs.WriteStream | null = null;
  private logPath: string | null = null;

  configure(opts: { level?: LogLevel; logPath?: string }): void {
    if (opts.level) this.level = opts.level;
    if (opts.logPath && opts.logPath !== this.logPath) {
      if (this.stream) this.stream.end();
      fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
      this.stream = fs.createWriteStream(opts.logPath, { flags: "a" });
      this.logPath = opts.logPath;
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] > LEVELS[this.level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(meta ?? {}),
    });
    if (this.stream) {
      this.stream.write(line + "\n");
    } else {
      process.stderr.write(line + "\n");
    }
  }

  error(msg: string, meta?: Record<string, unknown>): void { this.emit("error", msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>): void { this.emit("warn", msg, meta); }
  info(msg: string, meta?: Record<string, unknown>): void { this.emit("info", msg, meta); }
  debug(msg: string, meta?: Record<string, unknown>): void { this.emit("debug", msg, meta); }
  trace(msg: string, meta?: Record<string, unknown>): void { this.emit("trace", msg, meta); }
}

export const logger = new Logger();
