import type { HandlerFn } from "../dispatch";
import { VERSION } from "../../version";

export const version: HandlerFn = async (_ctx, _req) => {
  return {
    daemon_version: VERSION,
  };
};
