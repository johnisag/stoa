import { describe, it, expect } from "vitest";
import { formatReviewComment } from "@/lib/diff-comment";

describe("formatReviewComment (#1-A diff review note)", () => {
  it("includes the file, line, quoted line, and the trimmed comment", () => {
    const m = formatReviewComment(
      "src/app.ts",
      42,
      "const x = 1;",
      "  rename x to count  "
    );
    expect(m).toMatch(/^\[Stoa\] Review note on/);
    expect(m).toContain("src/app.ts (line 42)");
    expect(m).toContain("> const x = 1;");
    expect(m.endsWith("rename x to count")).toBe(true); // comment trimmed
  });

  it("omits the line number when null or 0", () => {
    const a = formatReviewComment("src/app.ts", null, "x", "c");
    expect(a).toContain("on src/app.ts:");
    expect(a).not.toContain("(line");
    expect(formatReviewComment("src/app.ts", 0, "x", "c")).not.toContain(
      "(line"
    );
  });

  it("omits the quote block when the line content is blank", () => {
    expect(formatReviewComment("f", 1, "   ", "c")).not.toContain(">");
  });

  it("strips control bytes (ESC / bracketed-paste escape) but keeps newlines", () => {
    // A line content with an embedded bracketed-paste-end + ESC must not survive
    // into the keystroke channel.
    const m = formatReviewComment(
      "f",
      1,
      "code\x1b[201~rm -rf",
      "line one\ntwo\x1b[A"
    );
    expect(m).not.toContain("\x1b");
    expect(m).toContain("code[201~rm -rf"); // ESC removed, rest inert text
    expect(m).toContain("line one\ntwo[A"); // newline kept, ESC removed
  });
});
