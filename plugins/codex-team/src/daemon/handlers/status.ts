import { CodexTeamError } from "../../errors";
import type { HandlerFn } from "../dispatch";

export const status: HandlerFn = async (ctx, req) => {
  const token = req.bearer;
  if (!token) {
    throw new CodexTeamError("invalid_params", "status requires -b <token>");
  }
  const user = ctx.users.get(token);
  if (!user) {
    throw new CodexTeamError("user_not_found", `user '${token}' not found — run 'codex-team daemon user create ${token}'`);
  }
  ctx.users.touch(token);
  const retainedLimit = typeof ctx.config?.getEffective === "function"
    ? ctx.config.getEffective("monitor.event_log_retention")
    : null;
  const appServerCount = typeof ctx.pool?.processCount === "function"
    ? ctx.pool.processCount()
    : null;
  return {
    token: user.token,
    created_at: user.created_at,
    last_active_at: user.last_active_at,
    live_sessions: ctx.sessions.listLive(token).length,
    retained_events: ctx.events.retainedCount(token),
    retained_limit: typeof retainedLimit === "number" ? retainedLimit : null,
    pending_requests: ctx.pending.listForUser(token).length,
    app_server_count: typeof appServerCount === "number" ? appServerCount : null,
    daemon: {
      pid: process.pid,
      started_at: ctx.startedAt.toISOString(),
      data_dir: ctx.dataDir,
    },
  };
};
