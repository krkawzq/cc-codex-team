import { CodexTeamError, methodNotFound } from "../errors";
import type { DaemonContext } from "./context";
import type { IpcRequest } from "../ipc/protocol";

import { version } from "./handlers/version";
import { status } from "./handlers/status";
import {
  daemonStatus,
  daemonStart,
  daemonStop,
  daemonRestart,
  daemonUserCreate,
  daemonUserDestroy,
  daemonUserList,
  daemonConfigGet,
  daemonConfigSet,
  daemonConfigUnset,
  daemonConfigList,
  daemonConfigReset,
  daemonLogsStream,
} from "./handlers/daemon";
import { stubHandler } from "./handlers/stubs";
import {
  sessionNew,
  sessionAttach,
  sessionDetach,
  sessionFork,
  sessionRename,
  sessionInfo,
  sessionContext,
  sessionList,
} from "./handlers/session";
import {
  messageSend,
  messagePeer,
  messageInterrupt,
  messageApproval,
  messageAnswer,
  messageHistory,
  messageTail,
} from "./handlers/message";
import {
  cursorSave,
  cursorList,
  cursorGet,
  cursorDelete,
} from "./handlers/cursor";
import { monitorEvents, monitorAlarm } from "./handlers/monitor";

export interface StreamHandle {
  chunk(data: unknown): void;
  end(error?: CodexTeamError): void;
  onClose(cb: () => void): void;
}

export type HandlerFn = (
  ctx: DaemonContext,
  req: IpcRequest,
  stream?: StreamHandle,
) => Promise<unknown>;

const HANDLERS: Record<string, HandlerFn> = {
  "version": version,
  "status": status,
  "daemon:status": daemonStatus,
  "daemon:start": daemonStart,
  "daemon:stop": daemonStop,
  "daemon:restart": daemonRestart,
  "daemon:logs": daemonLogsStream,
  "daemon:user:create": daemonUserCreate,
  "daemon:user:destroy": daemonUserDestroy,
  "daemon:user:list": daemonUserList,
  "daemon:config:get": daemonConfigGet,
  "daemon:config:set": daemonConfigSet,
  "daemon:config:unset": daemonConfigUnset,
  "daemon:config:list": daemonConfigList,
  "daemon:config:reset": daemonConfigReset,

  "session:new": sessionNew,
  "session:attach": sessionAttach,
  "session:detach": sessionDetach,
  "session:fork": sessionFork,
  "session:rename": sessionRename,
  "session:info": sessionInfo,
  "session:context": sessionContext,
  "session:list": sessionList,

  "message:send": messageSend,
  "message:peer": messagePeer,
  "message:interrupt": messageInterrupt,
  "message:approval": messageApproval,
  "message:answer": messageAnswer,
  "message:history": messageHistory,
  "message:tail": messageTail,

  "monitor:events": monitorEvents,
  "monitor:alarm": monitorAlarm,

  "cursor:save": cursorSave,
  "cursor:list": cursorList,
  "cursor:get": cursorGet,
  "cursor:delete": cursorDelete,
};

export function getHandler(method: string): HandlerFn {
  const h = HANDLERS[method];
  if (!h) throw methodNotFound(method);
  return h;
}
