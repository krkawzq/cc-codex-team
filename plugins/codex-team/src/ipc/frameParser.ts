import { logger } from "../logger";

export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const NEWLINE_BYTE = 0x0a;
const EMPTY_BUFFER: Buffer<ArrayBufferLike> = Buffer.alloc(0);

export class FrameTooLargeError extends Error {
  readonly peer: string;
  readonly frameBytes: number;
  readonly maxFrameBytes: number;

  constructor(peer: string, frameBytes: number, maxFrameBytes: number) {
    super(`frame from ${peer} exceeded ${maxFrameBytes} bytes`);
    this.name = "FrameTooLargeError";
    this.peer = peer;
    this.frameBytes = frameBytes;
    this.maxFrameBytes = maxFrameBytes;
  }
}

export interface LineParserControl {
  bufferedBytes(): number;
  push(chunk: Buffer | string): void;
  resume(): void;
}

interface LineParserOptions {
  maxFrameBytes?: number;
  onError(error: FrameTooLargeError): void;
  onLine(line: string): unknown;
  peer: string;
}

export function createLineParser(options: LineParserOptions): LineParserControl {
  const maxFrameBytes = normalizeMaxFrameBytes(options.maxFrameBytes);
  let buffer: Buffer<ArrayBufferLike> = EMPTY_BUFFER;
  let readOffset = 0;
  let paused = false;
  let failed = false;

  const compactIfNeeded = (): void => {
    if (readOffset === 0) return;
    if (readOffset >= buffer.length) {
      buffer = EMPTY_BUFFER;
      readOffset = 0;
      return;
    }
    if (readOffset < Math.floor(buffer.length / 2)) return;
    buffer = Buffer.from(buffer.subarray(readOffset));
    readOffset = 0;
  };

  const fail = (frameBytes: number): void => {
    if (failed) return;
    failed = true;
    const error = new FrameTooLargeError(options.peer, frameBytes, maxFrameBytes);
    logger.warn("frame_too_large", {
      peer: options.peer,
      frame_bytes: frameBytes,
      max_frame_bytes: maxFrameBytes,
    });
    options.onError(error);
  };

  const parseAvailable = (): void => {
    if (paused || failed) return;
    while (true) {
      const newlineIdx = buffer.indexOf(NEWLINE_BYTE, readOffset);
      if (newlineIdx < 0) {
        const unreadBytes = buffer.length - readOffset;
        if (unreadBytes > maxFrameBytes) fail(unreadBytes);
        else compactIfNeeded();
        return;
      }

      const frameBytes = newlineIdx - readOffset;
      if (frameBytes > maxFrameBytes) {
        fail(frameBytes);
        return;
      }

      const line = buffer.toString("utf8", readOffset, newlineIdx);
      readOffset = newlineIdx + 1;
      compactIfNeeded();
      if (!line.trim()) continue;
      if (options.onLine(line) === false) {
        paused = true;
        return;
      }
    }
  };

  const appendChunk = (chunk: Buffer): void => {
    if (chunk.length === 0) return;
    if (buffer.length === 0 || readOffset >= buffer.length) {
      buffer = chunk;
      readOffset = 0;
      return;
    }
    const unread = readOffset === 0 ? buffer : buffer.subarray(readOffset);
    buffer = Buffer.concat([unread, chunk]);
    readOffset = 0;
  };

  return {
    bufferedBytes(): number {
      return Math.max(0, buffer.length - readOffset);
    },
    push(chunk: Buffer | string): void {
      if (failed) return;
      appendChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
      parseAvailable();
    },
    resume(): void {
      if (failed || !paused) return;
      paused = false;
      parseAvailable();
    },
  };
}

export function readMaxFrameBytes(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveIntEnv(env.CODEX_TEAM_MAX_FRAME_BYTES, DEFAULT_MAX_FRAME_BYTES);
}

function normalizeMaxFrameBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_FRAME_BYTES;
  return Math.max(1, Math.floor(value));
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
