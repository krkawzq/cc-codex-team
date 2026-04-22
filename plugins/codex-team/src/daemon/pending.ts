import crypto from "node:crypto";

import type { AppServerClient } from "../codex/appServerClient";

export interface PendingRequest {
  request_id: string;
  kind: string;
  client: AppServerClient;
  jsonrpc_id: string | number;
  user: string;
  session_name: string | null;
  thread_id: string | null;
  turn_id: string | null;
  created_at: string;
  raw: Record<string, unknown>;
}

export class PendingRegistry {
  private byRequestId = new Map<string, PendingRequest>();
  private byJsonrpcKey = new Map<string, string>();

  add(entry: Omit<PendingRequest, "request_id" | "created_at">): PendingRequest {
    const request_id = `req-${crypto.randomBytes(4).toString("hex")}`;
    const rec: PendingRequest = {
      ...entry,
      request_id,
      created_at: new Date().toISOString(),
    };
    this.byRequestId.set(request_id, rec);
    this.byJsonrpcKey.set(this.jsonrpcKey(entry.client, entry.jsonrpc_id), request_id);
    return rec;
  }

  get(requestId: string): PendingRequest | null {
    return this.byRequestId.get(requestId) ?? null;
  }

  remove(requestId: string): PendingRequest | null {
    const rec = this.byRequestId.get(requestId);
    if (!rec) return null;
    this.byRequestId.delete(requestId);
    this.byJsonrpcKey.delete(this.jsonrpcKey(rec.client, rec.jsonrpc_id));
    return rec;
  }

  removeByJsonrpcId(client: AppServerClient, jsonrpcId: string | number): PendingRequest | null {
    const reqId = this.byJsonrpcKey.get(this.jsonrpcKey(client, jsonrpcId));
    if (!reqId) return null;
    return this.remove(reqId);
  }

  listForUser(user: string): PendingRequest[] {
    return Array.from(this.byRequestId.values()).filter((r) => r.user === user);
  }

  removeForSession(user: string, sessionName: string): PendingRequest[] {
    const removed: PendingRequest[] = [];
    for (const rec of Array.from(this.byRequestId.values())) {
      if (rec.user === user && rec.session_name === sessionName) {
        this.remove(rec.request_id);
        removed.push(rec);
      }
    }
    return removed;
  }

  removeForUser(user: string): PendingRequest[] {
    const removed: PendingRequest[] = [];
    for (const rec of Array.from(this.byRequestId.values())) {
      if (rec.user === user) {
        this.remove(rec.request_id);
        removed.push(rec);
      }
    }
    return removed;
  }

  private jsonrpcKey(client: AppServerClient, id: string | number): string {
    // Use WeakRef-style identity via a simple counter? Node doesn't give us a stable
    // id for EventEmitter instances; use a symbol tag installed on the client.
    const tag = (client as unknown as { __ct_tag?: string }).__ct_tag;
    const ref = tag ?? assignTag(client);
    return `${ref}::${id}`;
  }
}

function assignTag(client: AppServerClient): string {
  const tag = crypto.randomBytes(4).toString("hex");
  (client as unknown as { __ct_tag: string }).__ct_tag = tag;
  return tag;
}
