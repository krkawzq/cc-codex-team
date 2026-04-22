import type { HandlerFn } from "../dispatch";

export const version: HandlerFn = async (_ctx, _req) => {
  let pkgVersion = "unknown";
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../../package.json");
    pkgVersion = pkg.version ?? "unknown";
  } catch {
    // ignore
  }
  return {
    daemon_version: pkgVersion,
  };
};
