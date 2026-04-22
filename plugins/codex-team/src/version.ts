import path from "node:path";

const PACKAGE_JSON_PATH = require.resolve("../package.json");
const pkg = require(PACKAGE_JSON_PATH) as { version?: string };

export const PACKAGE_ROOT = path.dirname(PACKAGE_JSON_PATH);
export const VERSION: string = pkg.version ?? "unknown";
