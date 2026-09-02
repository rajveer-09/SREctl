import { describe, expect, it } from "vitest";
import { addedLines } from "./review.js";

/**
 * GitHub rejects an entire review if any inline comment points at a line
 * outside the diff, so getting this wrong loses the whole review, not one
 * comment. The counter must track the NEW file: context lines advance it,
 * removed lines do not.
 */
describe("addedLines", () => {
  it("returns the new-file line numbers of added lines", () => {
    const patch = ["@@ -1,3 +1,4 @@", " const a = 1;", "+const b = 2;", " const c = 3;", " const d = 4;"].join("\n");
    expect([...addedLines(patch)]).toEqual([2]);
  });

  it("does not advance the counter on removed lines", () => {
    const patch = ["@@ -1,4 +1,3 @@", " keep", "-gone", "-also gone", "+added", " tail"].join("\n");
    // keep = 1, added = 2
    expect([...addedLines(patch)]).toEqual([2]);
  });

  it("handles several hunks with independent offsets", () => {
    const patch = [
      "@@ -1,2 +1,3 @@",
      " a",
      "+b",
      " c",
      "@@ -20,2 +21,3 @@",
      " x",
      "+y",
      " z",
    ].join("\n");
    expect([...addedLines(patch)]).toEqual([2, 22]);
  });

  it("handles a single-line hunk header without a count", () => {
    expect([...addedLines(["@@ -0,0 +1 @@", "+only"].join("\n"))]).toEqual([1]);
  });

  it("handles a new file where every line is added", () => {
    const patch = ["@@ -0,0 +1,3 @@", "+one", "+two", "+three"].join("\n");
    expect([...addedLines(patch)]).toEqual([1, 2, 3]);
  });

  it("returns nothing for an empty patch", () => {
    expect([...addedLines("")]).toEqual([]);
  });

  it("ignores the +++ file header, which is not an added line", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", " a", "+b"].join("\n");
    expect([...addedLines(patch)]).toEqual([2]);
  });
});
