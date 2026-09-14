import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The module boundary, checked rather than promised.
 *
 * A Worker importing `iplook` must get the reader and nothing else: no Node
 * API, and none of the builder. Both are easy to break by reaching for
 * `Buffer.from(b64, "base64")` or by importing a helper that happens to live
 * under build/, and neither break shows up in any other test.
 */

const DIST = new URL("../dist/", import.meta.url);
const built = existsSync(new URL("index.js", DIST));

describe.skipIf(!built)("dist/index.js", () => {
  const read = (f: string) => readFileSync(new URL(f, DIST), "utf8");

  it.each(["node:", "require(", "process.", "Buffer.", "__dirname"])(
    "does not reference %j",
    (needle) => {
      expect(read("index.js")).not.toContain(needle);
    },
  );

  it("does not contain the builder", () => {
    const js = read("index.js");
    // Names that exist only on the build side. If one appears here, an import
    // crossed the boundary and every Worker bundle pays for it.
    for (const name of ["radixSortIndices", "sweepV4", "TableBuilder", "rangeToBlocks"]) {
      expect(js).not.toContain(name);
    }
  });

  it("stays small enough to bundle beside a table", () => {
    const bytes = readFileSync(new URL("index.js", DIST)).length;
    expect(bytes).toBeLessThan(20 * 1024);
  });
});

describe.skipIf(!built)("dist/text.js", () => {
  it("may use the builder but still no Node API", () => {
    const js = readFileSync(new URL("text.js", DIST), "utf8");
    expect(js).toContain("TableBuilder");
    for (const needle of ["node:", "require(", "__dirname"]) {
      expect(js).not.toContain(needle);
    }
  });
});
