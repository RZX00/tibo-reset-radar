import { describe, expect, it } from "vitest";

import { parsePostId } from "./reprocess-main.js";

describe("parsePostId", () => {
  it("accepts the pnpm argument separator and one numeric X post id", () => {
    expect(parsePostId(["--", "2086188036493344823"])).toBe("2086188036493344823");
  });

  it.each([{ args: [] }, { args: ["--"] }, { args: ["not-a-post"] }, { args: ["123", "456"] }])(
    "rejects invalid arguments: $args",
    ({ args }) => {
      expect(() => parsePostId(args)).toThrow("numeric-x-post-id");
    },
  );
});
