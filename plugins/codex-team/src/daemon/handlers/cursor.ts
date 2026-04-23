import { CodexTeamError, invalidParams } from "../../errors";
import type { IpcRequest } from "../../ipc/protocol";
import type { HandlerFn } from "../dispatch";

export const cursorSave: HandlerFn = async (ctx, req) => {
  const user = requireUser(ctx, req);
  const name = reqPositional(req, 0, "name");
  const explicitEventId = asString(getFlag(req, "event-id"));
  const eventId = explicitEventId ?? await currentTailEventId(ctx, user);
  const cursor = await ctx.cursors.save(user, {
    name,
    event_id: eventId,
    auto_update: true,
  });
  return { cursor };
};

export const cursorList: HandlerFn = async (ctx, req) => {
  const user = requireUser(ctx, req);
  return { cursors: ctx.cursors.list(user) };
};

export const cursorGet: HandlerFn = async (ctx, req) => {
  const user = requireUser(ctx, req);
  const name = reqPositional(req, 0, "name");
  const cursor = ctx.cursors.get(user, name);
  if (!cursor) throw invalidParams(`cursor '${name}' not found`);
  return { event_id: cursor.event_id };
};

export const cursorDelete: HandlerFn = async (ctx, req) => {
  const user = requireUser(ctx, req);
  const name = reqPositional(req, 0, "name");
  const deleted = await ctx.cursors.delete(user, name);
  if (!deleted) throw invalidParams(`cursor '${name}' not found`);
  return { deleted: true, name };
};

async function currentTailEventId(
  ctx: Parameters<HandlerFn>[0],
  user: string,
): Promise<string | null> {
  const listed = await ctx.events.listSince(user, null, { includeDelta: true });
  if (!listed.ok) {
    throw new CodexTeamError("internal", `failed to resolve current event tail for '${user}'`);
  }
  const last = listed.events[listed.events.length - 1];
  return last?.id ?? null;
}

function requireUser(ctx: Parameters<HandlerFn>[0], req: IpcRequest): string {
  const user = req.bearer;
  if (!user) throw invalidParams("bearer token required");
  if (!ctx.users.has(user)) {
    throw new CodexTeamError("user_not_found", `user '${user}' not found`);
  }
  return user;
}

function reqPositional(req: IpcRequest, index: number, name: string): string {
  const value = asPositionals(req)[index];
  if (!value) throw invalidParams(`missing positional '${name}'`);
  return value;
}

function asPositionals(req: IpcRequest): string[] {
  const positionals = req.params.positionals;
  return Array.isArray(positionals) ? positionals.filter((value): value is string => typeof value === "string") : [];
}

function getFlag(req: IpcRequest, key: string): unknown {
  const flags = req.params.flags;
  if (!flags || typeof flags !== "object") return undefined;
  return (flags as Record<string, unknown>)[key];
}

function asString(value: unknown): string | null {
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === "string" ? last : null;
  }
  return typeof value === "string" ? value : null;
}
