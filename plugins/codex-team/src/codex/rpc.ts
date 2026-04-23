import type { AppServerClient } from "./appServerClient";
import type { JsonValue } from "./errors";
import { retryOnOverload, type RetryOptions, DEFAULT_RETRY } from "./retry";

export interface Thread {
  id: string;
  name?: string;
  preview?: string;
  status?: string;
  cwd?: string;
  source?: string;
  model_provider?: string;
  created_at?: number;
  updated_at?: number;
  turns?: unknown[];
  [k: string]: unknown;
}

export interface ThreadLifecycleResponse {
  thread: Thread;
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: unknown;
  [k: string]: unknown;
}

export interface ThreadListResponse {
  data: Thread[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface ThreadReadResponse {
  thread: Thread;
}

export interface TurnStartResult {
  turnId: string;
}

export async function threadStart(
  client: AppServerClient,
  params: Record<string, JsonValue>,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<ThreadLifecycleResponse> {
  const result = await retryOnOverload(() => client.request("thread/start", params as JsonValue), retry);
  return coerceLifecycle(result, "thread/start");
}

export async function threadResume(
  client: AppServerClient,
  threadId: string,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<ThreadLifecycleResponse> {
  const result = await retryOnOverload(() => client.request("thread/resume", { threadId }), retry);
  return coerceLifecycle(result, "thread/resume");
}

export async function threadFork(
  client: AppServerClient,
  threadId: string,
  atTurnId?: string,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<ThreadLifecycleResponse> {
  const params: Record<string, JsonValue> = { threadId };
  if (atTurnId) params.atTurnId = atTurnId;
  const result = await retryOnOverload(() => client.request("thread/fork", params as JsonValue), retry);
  return coerceLifecycle(result, "thread/fork");
}

export async function threadArchive(
  client: AppServerClient,
  threadId: string,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<void> {
  await retryOnOverload(() => client.request("thread/archive", { threadId }), retry);
}

export async function threadUnarchive(
  client: AppServerClient,
  threadId: string,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<void> {
  await retryOnOverload(() => client.request("thread/unarchive", { threadId }), retry);
}

export async function threadRename(
  client: AppServerClient,
  threadId: string,
  name: string,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<void> {
  await retryOnOverload(() => client.request("thread/name/set", { threadId, name }), retry);
}

export async function threadSetName(
  client: AppServerClient,
  threadId: string,
  name: string,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<void> {
  await retryOnOverload(() => client.request("thread/name/set", { threadId, name }), retry);
}

export async function threadList(
  client: AppServerClient,
  params: Record<string, JsonValue> = {},
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<ThreadListResponse> {
  const result = await retryOnOverload(() => client.request("thread/list", params as JsonValue), retry);
  const obj = asObject(result);
  const data = Array.isArray(obj.data) ? (obj.data as Thread[]) : [];
  return {
    data,
    nextCursor: (obj.nextCursor as string | null | undefined) ?? null,
    backwardsCursor: (obj.backwardsCursor as string | null | undefined) ?? null,
  };
}

export async function threadRead(
  client: AppServerClient,
  threadId: string,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<ThreadReadResponse> {
  const result = await retryOnOverload(() => client.request("thread/read", { threadId }), retry);
  const obj = asObject(result);
  const thread = asObject(obj.thread as JsonValue);
  if (!thread.id) throw new Error(`thread/read: response missing thread.id`);
  return { thread: thread as unknown as Thread };
}

export async function threadUnsubscribe(
  client: AppServerClient,
  threadId: string,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<void> {
  try {
    await retryOnOverload(() => client.request("thread/unsubscribe", { threadId }), retry);
  } catch {
    // best-effort
  }
}

export interface TurnListItem {
  id: string;
  status?: string;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  error?: { message?: string; codexErrorInfo?: unknown } | null;
  [k: string]: unknown;
}

export interface ThreadTurnsListResponse {
  data: TurnListItem[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export async function threadTurnsList(
  client: AppServerClient,
  threadId: string,
  opts: { limit?: number; cursor?: string; sortDirection?: "asc" | "desc" } = {},
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<ThreadTurnsListResponse> {
  const params: Record<string, JsonValue> = { threadId };
  if (opts.limit !== undefined) params.limit = opts.limit;
  if (opts.cursor !== undefined) params.cursor = opts.cursor;
  if (opts.sortDirection !== undefined) params.sortDirection = opts.sortDirection;
  const result = await retryOnOverload(() => client.request("thread/turns/list", params as JsonValue), retry);
  const obj = asObject(result);
  return {
    data: Array.isArray(obj.data) ? (obj.data as TurnListItem[]) : [],
    nextCursor: (obj.nextCursor as string | null | undefined) ?? null,
    backwardsCursor: (obj.backwardsCursor as string | null | undefined) ?? null,
  };
}

export async function turnStart(
  client: AppServerClient,
  threadId: string,
  input: JsonValue,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<TurnStartResult> {
  const result = await retryOnOverload(() => client.request("turn/start", { threadId, input }), retry);
  const obj = asObject(result);
  const turn = asObject(obj.turn as JsonValue);
  const turnId = typeof turn.id === "string" ? turn.id : null;
  if (!turnId) throw new Error("turn/start: response missing turn.id");
  return { turnId };
}

export async function turnSteer(
  client: AppServerClient,
  threadId: string,
  turnId: string,
  input: JsonValue,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<void> {
  await retryOnOverload(() => client.request("turn/steer", { threadId, expectedTurnId: turnId, input }), retry);
}

export async function turnInterrupt(
  client: AppServerClient,
  threadId: string,
  turnId: string,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<void> {
  await retryOnOverload(() => client.request("turn/interrupt", { threadId, turnId }), retry);
}

/** Extract the threadId from a Thread-bearing response. */
export function threadIdOf(resp: ThreadLifecycleResponse): string {
  return resp.thread.id;
}

function coerceLifecycle(result: JsonValue, rpc: string): ThreadLifecycleResponse {
  const obj = asObject(result);
  const thread = asObject(obj.thread as JsonValue);
  if (typeof thread.id !== "string" || !thread.id) {
    throw new Error(`${rpc}: response missing thread.id`);
  }
  return { ...obj, thread: thread as unknown as Thread } as ThreadLifecycleResponse;
}

function asObject(value: JsonValue): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
