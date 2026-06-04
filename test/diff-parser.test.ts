import { describe, it, expect } from "vitest";
import { splitUnifiedDiff, parseDiff, diffStats } from "../lib/diff-parser";

const FILE_A = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old
+new
 ctx`;

const FILE_B = `diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,1 @@
+hello`;

describe("splitUnifiedDiff", () => {
  it("returns [] for empty / whitespace-only input", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
    expect(splitUnifiedDiff("   \n  ")).toEqual([]);
  });

  it("returns a single chunk for a one-file diff", () => {
    const chunks = splitUnifiedDiff(FILE_A);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startsWith("diff --git a/src/a.ts")).toBe(true);
  });

  it("splits a multi-file diff into one chunk per file, each re-parseable", () => {
    const chunks = splitUnifiedDiff(`${FILE_A}\n${FILE_B}`);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.startsWith("diff --git "))).toBe(true);
    // Each chunk parses independently to the right file.
    expect(parseDiff(chunks[0]).newFile).toBe("src/a.ts");
    const b = parseDiff(chunks[1]);
    expect(b.newFile).toBe("src/b.ts");
    expect(b.isNew).toBe(true);
  });

  it("drops any preamble before the first 'diff --git' header", () => {
    const chunks = splitUnifiedDiff(`warning: noise\n${FILE_A}`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startsWith("diff --git ")).toBe(true);
  });

  it("falls back to a single chunk when there is no 'diff --git' header", () => {
    expect(splitUnifiedDiff("some non-git content")).toEqual([
      "some non-git content",
    ]);
  });
});

describe("diffStats", () => {
  it("rolls up files and +/- across a multi-file diff", () => {
    // FILE_A: +1 -1; FILE_B: new file +1
    expect(diffStats(`${FILE_A}\n${FILE_B}`)).toEqual({
      files: 2,
      additions: 2,
      deletions: 1,
    });
  });
  it("is all-zero for an empty diff", () => {
    expect(diffStats("")).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});
