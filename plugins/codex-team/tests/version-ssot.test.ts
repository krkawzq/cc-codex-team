import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version";

describe("VERSION", () => {
  it("matches package.json", () => {
    const pkg = require("../package.json") as { version?: string };
    expect(VERSION).toBe(pkg.version);
  });
});
