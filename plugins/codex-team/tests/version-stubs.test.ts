import { describe, expect, it } from "vitest";

import { stubHandler } from "../src/daemon/handlers/stubs";
import { version } from "../src/daemon/handlers/version";

describe("version and stubs", () => {
  it("returns daemon version", async () => {
    const result = await version({} as never, {} as never);
    expect(result).toMatchObject({
      daemon_version: expect.any(String),
    });
  });

  it("stub handlers throw not_implemented", async () => {
    await expect(stubHandler("future:thing")({} as never, {} as never))
      .rejects.toMatchObject({ code: "not_implemented" });
  });
});
