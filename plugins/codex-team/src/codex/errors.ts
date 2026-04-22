export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export class AppServerError extends Error {
  readonly kind: string;
  constructor(message: string, kind = "app_server_error") {
    super(message);
    this.name = this.constructor.name;
    this.kind = kind;
  }
}

export class JsonRpcError extends AppServerError {
  readonly code: number;
  readonly rpcMessage: string;
  readonly data: JsonValue | undefined;
  readonly codexErrorInfo: string | null;
  readonly additionalDetails: string | null;

  constructor(code: number, message: string, data?: JsonValue) {
    super(`JSON-RPC error ${code}: ${message}`, "json_rpc_error");
    this.code = code;
    this.rpcMessage = message;
    this.data = data;
    this.codexErrorInfo = extractCodexErrorInfo(data);
    this.additionalDetails = extractAdditionalDetails(data);
  }
}

export class TransportClosedError extends AppServerError {
  constructor(message: string) { super(message, "transport_closed"); }
}

export class RequestTimeoutError extends AppServerError {
  constructor(message: string) { super(message, "request_timeout"); }
}

export class ParseError extends JsonRpcError {}
export class InvalidRequestError extends JsonRpcError {}
export class MethodNotFoundError extends JsonRpcError {}
export class InvalidParamsError extends JsonRpcError {}
export class InternalRpcError extends JsonRpcError {}

export class ServerBusyError extends JsonRpcError {}
export class RetryLimitExceededError extends ServerBusyError {}

const TRANSIENT_CODEX_ERROR_INFOS = new Set([
  "server_overloaded",
  "http_connection_failed",
  "response_stream_connection_failed",
  "response_stream_disconnected",
]);

export function mapJsonRpcError(code: number, message: string, data?: JsonValue): JsonRpcError {
  if (code === -32700) return new ParseError(code, message, data);
  if (code === -32600) return new InvalidRequestError(code, message, data);
  if (code === -32601) return new MethodNotFoundError(code, message, data);
  if (code === -32602) return new InvalidParamsError(code, message, data);
  if (code === -32603) return new InternalRpcError(code, message, data);

  if (code >= -32099 && code <= -32000) {
    const overloaded = isServerOverloaded(data);
    const retryExhausted = containsRetryLimitText(message);
    if (overloaded && retryExhausted) return new RetryLimitExceededError(code, message, data);
    if (overloaded) return new ServerBusyError(code, message, data);
    if (retryExhausted) return new RetryLimitExceededError(code, message, data);
  }

  return new JsonRpcError(code, message, data);
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryLimitExceededError) return false;
  if (err instanceof ServerBusyError) return true;
  if (err instanceof RequestTimeoutError) return false;
  if (err instanceof JsonRpcError) {
    return isServerOverloaded(err.data) || isTransientCodexErrorInfo(err.codexErrorInfo);
  }
  return false;
}

function containsRetryLimitText(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("retry limit") || lower.includes("too many failed attempts");
}

function isServerOverloaded(data: JsonValue | undefined): boolean {
  if (data === undefined || data === null) return false;
  if (typeof data === "string") return data.toLowerCase() === "server_overloaded";
  if (Array.isArray(data)) return data.some(isServerOverloaded);
  if (typeof data === "object") {
    const obj = data as { [k: string]: JsonValue };
    const direct = obj["codex_error_info"] ?? obj["codexErrorInfo"] ?? obj["errorInfo"];
    if (typeof direct === "string" && direct.toLowerCase() === "server_overloaded") return true;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      for (const v of Object.values(direct)) {
        if (typeof v === "string" && v.toLowerCase() === "server_overloaded") return true;
      }
    }
    for (const v of Object.values(obj)) {
      if (isServerOverloaded(v)) return true;
    }
  }
  return false;
}

export function extractCodexErrorInfo(data: JsonValue | undefined): string | null {
  if (data === undefined || data === null || typeof data !== "object") return null;
  if (Array.isArray(data)) return null;
  const obj = data as { [k: string]: JsonValue };
  const direct = obj["codex_error_info"] ?? obj["codexErrorInfo"] ?? obj["errorInfo"];
  if (typeof direct === "string") return snakeCaseVariant(direct);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const innerObj = direct as { [k: string]: JsonValue };
    const type = innerObj["type"];
    if (typeof type === "string") return snakeCaseVariant(type);
    const variantKeys = Object.keys(innerObj);
    if (variantKeys.length === 1) return snakeCaseVariant(variantKeys[0]!);
  }
  return null;
}

export function extractAdditionalDetails(data: JsonValue | undefined): string | null {
  if (data === undefined || data === null || typeof data !== "object") return null;
  if (Array.isArray(data)) return null;
  const obj = data as { [k: string]: JsonValue };
  const v = obj["additional_details"] ?? obj["additionalDetails"];
  return typeof v === "string" ? v : null;
}

function snakeCaseVariant(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
}

function isTransientCodexErrorInfo(info: string | null): boolean {
  return info !== null && TRANSIENT_CODEX_ERROR_INFOS.has(info);
}
