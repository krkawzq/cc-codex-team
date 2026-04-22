export interface IpcRequest {
  kind: "request";
  id: string;
  method: string;
  bearer?: string;
  params: Record<string, unknown>;
}

export interface IpcResponse {
  kind: "response";
  id: string;
  result?: unknown;
  error?: { code: string; message: string; data?: unknown };
}

export interface IpcNotification {
  kind: "notification";
  method: string;
  params: Record<string, unknown>;
}

export interface IpcStreamStart {
  kind: "stream_start";
  id: string;
}

export interface IpcStreamChunk {
  kind: "stream_chunk";
  id: string;
  data: unknown;
}

export interface IpcStreamEnd {
  kind: "stream_end";
  id: string;
  error?: { code: string; message: string; data?: unknown };
}

export type IpcMessage =
  | IpcRequest
  | IpcResponse
  | IpcNotification
  | IpcStreamStart
  | IpcStreamChunk
  | IpcStreamEnd;

export function isRequest(m: IpcMessage): m is IpcRequest { return m.kind === "request"; }
export function isResponse(m: IpcMessage): m is IpcResponse { return m.kind === "response"; }
