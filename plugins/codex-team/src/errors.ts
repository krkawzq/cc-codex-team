export class CodexTeamError extends Error {
  code = "E_INTERNAL";
  exitCode = 1;
  detail: Record<string, unknown>;

  constructor(message = "", detail: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.detail = detail;
  }
}

export class ConfigError extends CodexTeamError {
  code = "E_CONFIG";
  exitCode = 2;
}

export class InvalidRequest extends CodexTeamError {
  code = "E_INVALID";
  exitCode = 2;
}

export class DaemonNotRunning extends CodexTeamError {
  code = "E_DAEMON_DOWN";
  exitCode = 4;
}

export class DaemonAlreadyRunning extends CodexTeamError {
  code = "E_DAEMON_UP";
  exitCode = 4;
}

export class SessionNotFound extends CodexTeamError {
  code = "E_NOT_FOUND";
  exitCode = 3;
}

export class SessionExists extends CodexTeamError {
  code = "E_EXISTS";
  exitCode = 3;
}

export class SessionBusy extends CodexTeamError {
  code = "E_BUSY";
  exitCode = 3;
}

export class SessionErrored extends CodexTeamError {
  code = "E_ERRORED";
  exitCode = 3;
}

export class QueueFull extends CodexTeamError {
  code = "E_QUEUE_FULL";
  exitCode = 3;
}

export class TransportError extends CodexTeamError {
  code = "E_TRANSPORT";
  exitCode = 5;
}

export class TurnTimeout extends CodexTeamError {
  code = "E_TIMEOUT";
  exitCode = 5;
}

export class CodexCliMissing extends CodexTeamError {
  code = "E_NO_CODEX_BIN";
  exitCode = 4;
}

export interface WireError {
  code: string;
  msg: string;
  detail?: Record<string, unknown>;
}

const errorClasses: Record<string, new (message?: string, detail?: Record<string, unknown>) => CodexTeamError> = {
  E_CONFIG: ConfigError,
  E_INVALID: InvalidRequest,
  E_DAEMON_DOWN: DaemonNotRunning,
  E_DAEMON_UP: DaemonAlreadyRunning,
  E_NOT_FOUND: SessionNotFound,
  E_EXISTS: SessionExists,
  E_BUSY: SessionBusy,
  E_ERRORED: SessionErrored,
  E_QUEUE_FULL: QueueFull,
  E_TRANSPORT: TransportError,
  E_TIMEOUT: TurnTimeout,
  E_NO_CODEX_BIN: CodexCliMissing,
};

export function errorToWire(error: CodexTeamError): WireError {
  return {
    code: error.code,
    msg: error.message,
    detail: { ...error.detail },
  };
}

export function wireToError(wire: Partial<WireError> | null | undefined): CodexTeamError {
  const ErrorClass = errorClasses[String(wire?.code ?? "")] ?? CodexTeamError;
  return new ErrorClass(String(wire?.msg ?? ""), { ...(wire?.detail ?? {}) });
}

export function asCodexTeamError(error: unknown): CodexTeamError {
  if (error instanceof CodexTeamError) {
    return error;
  }
  if (error instanceof Error) {
    return new CodexTeamError(error.message);
  }
  return new CodexTeamError(String(error));
}
