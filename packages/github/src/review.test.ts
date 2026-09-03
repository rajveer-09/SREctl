import { describe, expect, it } from "vitest";
import { REVIEW_MARKER, addedLines, postReview } from "./review.js";

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

/**
 * Pub/Sub is at-least-once, so a review job can be delivered twice - a pod
 * restart mid-review is enough, and that is exactly how PR #6 ended up with two
 * reviews on the same commit during the first cloud run. Ingest deduplicates on
 * the delivery ID, but that is upstream of a message already in flight.
 */
describe("postReview duplicate guard", () => {
  const ref = { owner: "acme", repo: "widgets" };

  function harness(existingReviews: Array<Record<string, unknown>>) {
    const created: Array<Record<string, unknown>> = [];
    const gh = {
      paginate: async (route: unknown, params: Record<string, unknown>) => {
        // Two paginated routes are used: listFiles and listReviews.
        if (route === "listReviews") return existingReviews;
        void params;
        return [{ filename: "src/a.ts", patch: "@@ -1,1 +1,2 @@\n a\n+b" }];
      },
      rest: {
        pulls: {
          listFiles: "listFiles",
          listReviews: "listReviews",
          createReview: async (params: Record<string, unknown>) => {
            created.push(params);
            return { data: { id: 99, html_url: "https://example.com/r/99" } };
          },
        },
      },
    };
    return { gh, created };
  }

  const base = {
    ref,
    pullNumber: 6,
    commitId: "abc123",
    summary: "s",
    comments: [],
    budget: { spend: () => {} },
  };

  it("does not post a second review on a commit it already reviewed", async () => {
    const { gh, created } = harness([
      { id: 41, commit_id: "abc123", body: `hi ${REVIEW_MARKER} x</sub>`, html_url: "https://example.com/r/41" },
    ]);

    const out = await postReview({ ...base, gh } as never);

    expect(out.posted).toBe(false);
    expect(out.alreadyReviewed).toBe(true);
    expect(out.url).toBe("https://example.com/r/41");
    expect(created).toHaveLength(0);
  });

  it("posts when the existing review is on a different commit", async () => {
    const { gh, created } = harness([
      { id: 41, commit_id: "OLDSHA", body: `hi ${REVIEW_MARKER} x</sub>`, html_url: "https://example.com/r/41" },
    ]);

    const out = await postReview({ ...base, gh } as never);

    expect(out.posted).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("ignores a human review on the same commit", async () => {
    const { gh, created } = harness([
      { id: 41, commit_id: "abc123", body: "looks good to me", html_url: "https://example.com/r/41" },
    ]);

    const out = await postReview({ ...base, gh } as never);

    expect(out.posted).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("posts a duplicate only when explicitly asked to", async () => {
    const { gh, created } = harness([
      { id: 41, commit_id: "abc123", body: `hi ${REVIEW_MARKER} x</sub>`, html_url: "https://example.com/r/41" },
    ]);

    const out = await postReview({ ...base, gh, skipIfAlreadyReviewed: false } as never);

    expect(out.posted).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("keeps the marker in the body it posts, or the guard stops working", async () => {
    const { gh, created } = harness([]);
    await postReview({ ...base, gh } as never);
    expect(String(created[0]!["body"])).toContain(REVIEW_MARKER);
  });
});
