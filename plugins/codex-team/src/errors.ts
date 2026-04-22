export type ErrorCode =
  | "daemon_unreachable"
  | "internal"
  | "user_not_found"
  | "user_already_exists"
  | "session_not_found"
  | "session_not_live"
  | "session_busy"
  | "invalid_params"
  | "invalid_decision"
  | "id_rotated"
  | "codex_error"
  | "not_implemented"
  | "method_not_found";

export class CodexTeamError extends Error {
  readonly code: ErrorCode;
  readonly data?: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "CodexTeamError";
  }
}

export function invalidParams(message: string, data?: unknown): CodexTeamError {
  return new CodexTeamError("invalid_params", message, data);
}

export function notImplemented(method: string): CodexTeamError {
  return new CodexTeamError("not_implemented", `method '${method}' is not implemented yet`);
}

export function methodNotFound(method: string): CodexTeamError {
  return new CodexTeamError("method_not_found", `unknown method '${method}'`);
}
