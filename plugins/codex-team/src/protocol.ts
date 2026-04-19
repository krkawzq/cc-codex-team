import { InvalidRequest, ProtocolError, WireError } from "./errors";

export interface RequestMessage {
  v: number;
  id: string;
  cmd: string;
  workspace: string;
  clientId: string | null;
  allWorkspaces: boolean;
  params: Record<string, unknown>;
}

export interface ResponseMessage {
  v?: number;
  id: string;
  ok: boolean;
  workspace?: string;
  data?: Record<string, unknown>;
  error?: WireError;
}

export interface StreamEventMessage {
  kind: "event";
  stream: "events" | "watchdog";
  seq: number;
  payload: Record<string, unknown>;
}

export function encodeMessage(message: RequestMessage | ResponseMessage | StreamEventMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeRequest(line: string): RequestMessage {
  const payload = decodeJsonObject(line);
  if (typeof payload.id !== "string" || typeof payload.cmd !== "string") {
    throw new InvalidRequest("request must include string id and cmd");
  }
  const v = Number(payload.v);
  if (v !== 2) {
    throw new ProtocolError("request must include protocol v=2");
  }
  if (typeof payload.workspace !== "string" || !payload.workspace) {
    throw new ProtocolError("request must include workspace");
  }
  return {
    v,
    id: payload.id,
    cmd: payload.cmd,
    workspace: payload.workspace,
    clientId: payload.clientId == null ? null : String(payload.clientId),
    allWorkspaces: Boolean(payload.allWorkspaces),
    params: isObject(payload.params) ? payload.params : {},
  };
}

export function decodeJsonObject(line: string): Record<string, unknown> {
  const payload = line.replace(/\n$/, "");
  if (!payload) {
    throw new InvalidRequest("empty line");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new InvalidRequest(`bad JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) {
    throw new InvalidRequest("message is not an object");
  }
  return parsed;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
