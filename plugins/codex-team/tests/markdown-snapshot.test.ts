import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INLINE_MAX_BYTES, renderContext, renderHistory, renderItem, renderTail, type MarkdownRenderOptions, type TurnItem } from "../src/format/markdown";

type Fixture =
  | {
      renderer: "item";
      options?: MarkdownRenderOptions;
      item: TurnItem;
    }
  | {
      renderer: "history";
      options?: MarkdownRenderOptions;
      input: Parameters<typeof renderHistory>[0];
    }
  | {
      renderer: "tail";
      options?: MarkdownRenderOptions;
      input: Parameters<typeof renderTail>[0];
    }
  | {
      renderer: "context";
      input: Parameters<typeof renderContext>[0];
    };

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(THIS_DIR, "fixtures", "markdown");
const UPDATE_SNAPSHOTS = process.argv.includes("-u") || process.argv.includes("--update");
const FIXTURE_FILES = fs.readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();

function renderFixture(fixture: Fixture): string {
  switch (fixture.renderer) {
    case "item":
      return renderItem(fixture.item, "", fixture.options);
    case "history":
      return renderHistory(fixture.input, fixture.options);
    case "tail":
      return renderTail(fixture.input, fixture.options);
    case "context":
      return renderContext(fixture.input);
  }
}

describe("markdown snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const fileName of FIXTURE_FILES) {
    it(`matches ${fileName}`, () => {
      const fixturePath = path.join(FIXTURE_DIR, fileName);
      const expectedPath = fixturePath.replace(/\.json$/, ".expected.md");
      const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
      const actual = renderFixture(fixture);

      if (UPDATE_SNAPSHOTS || !fs.existsSync(expectedPath)) {
        fs.writeFileSync(expectedPath, actual);
      }

      const expected = fs.readFileSync(expectedPath, "utf8");
      expect(actual).toBe(expected);
    });
  }

  it("collapses long userMessage bodies into truncated blocks", () => {
    const rendered = renderItem({
      id: "huge-user-message",
      type: "userMessage",
      content: [{ type: "text", text: "a".repeat(10240) }],
    }, "", { truncate: INLINE_MAX_BYTES });

    expect(rendered).toContain("<user-input> {\"id\":\"huge-user-message\"}");
    expect(rendered).not.toContain("\"text\":");
    expect(rendered).toContain("…[8192 bytes truncated; use --truncate 0 to disable]");
  });
});
