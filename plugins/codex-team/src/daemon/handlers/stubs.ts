import type { HandlerFn } from "../dispatch";
import { notImplemented } from "../../errors";

export function stubHandler(method: string): HandlerFn {
  return async () => {
    throw notImplemented(method);
  };
}
