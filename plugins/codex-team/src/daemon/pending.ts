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
  responded_at?: string;
  raw: Record<string, unknown>;
  claimed_at?: string | null;
}

export class PendingRegistry {
  private availableByRequestId = new Map<string, PendingRequest>();
  private inFlightByRequestId = new Map<string, PendingRequest>();
  private byJsonrpcKey = new Map<string, string>();

  add(entry: Omit<PendingRequest, "request_id" | "created_at" | "claimed_at" | "responded_at">): PendingRequest {
    const request_id = `req-${crypto.randomBytes(4).toString("hex")}`;
    const rec: PendingRequest = {
      ...entry,
      request_id,
      created_at: new Date().toISOString(),
      claimed_at: null,
    };
    this.availableByRequestId.set(request_id, rec);
    this.byJsonrpcKey.set(this.jsonrpcKey(entry.client, entry.jsonrpc_id), request_id);
    return rec;
  }

  get(requestId: string): PendingRequest | null {
    return this.availableByRequestId.get(requestId) ?? null;
  }

  claim(requestId: string, user: string): PendingRequest | null {
    const rec = this.availableByRequestId.get(requestId);
    if (!rec || rec.user !== user) return null;
    this.availableByRequestId.delete(requestId);
    rec.claimed_at = new Date().toISOString();
    this.inFlightByRequestId.set(requestId, rec);
    return rec;
  }

  releaseClaim(requestId: string): PendingRequest | null {
    const rec = this.inFlightByRequestId.get(requestId);
    if (!rec || rec.responded_at) return null;
    this.inFlightByRequestId.delete(requestId);
    rec.claimed_at = null;
    this.availableByRequestId.set(requestId, rec);
    return rec;
  }

  markResponded(requestId: string): PendingRequest | null {
    const rec = this.inFlightByRequestId.get(requestId) ?? this.availableByRequestId.get(requestId);
    if (!rec) return null;
    if (!rec.responded_at) rec.responded_at = new Date().toISOString();
    return rec;
  }

  remove(requestId: string): PendingRequest | null {
    const rec = this.availableByRequestId.get(requestId) ?? this.inFlightByRequestId.get(requestId);
    if (!rec) return null;
    this.availableByRequestId.delete(requestId);
    this.inFlightByRequestId.delete(requestId);
    this.byJsonrpcKey.delete(this.jsonrpcKey(rec.client, rec.jsonrpc_id));
    return rec;
  }

  removeByJsonrpcId(client: AppServerClient, jsonrpcId: string | number): PendingRequest | null {
    const reqId = this.byJsonrpcKey.get(this.jsonrpcKey(client, jsonrpcId));
    if (!reqId) return null;
    return this.remove(reqId);
  }

  listForUser(user: string): PendingRequest[] {
    return this.allRequests().filter((r) => r.user === user);
  }

  removeForSession(user: string, sessionName: string): PendingRequest[] {
    return this.removeMatching((rec) => rec.user === user && rec.session_name === sessionName);
  }

  removeForUser(user: string): PendingRequest[] {
    return this.removeMatching((rec) => rec.user === user);
  }

  private removeMatching(predicate: (rec: PendingRequest) => boolean): PendingRequest[] {
    const removed: PendingRequest[] = [];
    for (const rec of this.allRequests()) {
      if (!predicate(rec)) continue;
      this.remove(rec.request_id);
      if (!rec.responded_at) removed.push(rec);
    }
    return removed;
  }

  private allRequests(): PendingRequest[] {
    return [
      ...this.availableByRequestId.values(),
      ...this.inFlightByRequestId.values(),
    ];
  }

  private jsonrpcKey(client: AppServerClient, id: string | number): string {
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
