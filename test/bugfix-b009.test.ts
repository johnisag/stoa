import { describe, it, expect } from "vitest";
import { joinPath } from "@/lib/path-display";

// Regression for B009/B010: the QuickSwitcher onSelectFile handlers in
// MobileView/DesktopView built `${working_directory}/${file}` with a literal
// forward slash, producing a mixed-separator, non-canonical path on Windows
// (e.g. "C:\\repo/src/db.ts"). joinPath detects the separator from the base.
describe("joinPath", () => {
  it("uses a backslash for a Windows drive-letter base", () => {
    expect(joinPath("C:\\Users\\u\\repo", "src/db.ts")).toBe(
      "C:\\Users\\u\\repo\\src\\db.ts"
    );
  });

  it("uses a forward slash for a POSIX base", () => {
    expect(joinPath("/home/u/repo", "src/db.ts")).toBe(
      "/home/u/repo/src/db.ts"
    );
  });

  it("normalizes the relative segment to the base's separator (no mixing)", () => {
    // A relative path can arrive with forward slashes even on Windows.
    const result = joinPath("C:\\repo", "src/views/db.ts");
    expect(result).toBe("C:\\repo\\src\\views\\db.ts");
    expect(result).not.toContain("/");
  });

  it("strips a leading ./ from the relative path", () => {
    expect(joinPath("/home/u/repo", "./src/db.ts")).toBe(
      "/home/u/repo/src/db.ts"
    );
    expect(joinPath("C:\\repo", ".\\src\\db.ts")).toBe("C:\\repo\\src\\db.ts");
  });

  it("collapses a trailing separator on the base", () => {
    expect(joinPath("/home/u/repo/", "a.ts")).toBe("/home/u/repo/a.ts");
    expect(joinPath("C:\\repo\\", "a.ts")).toBe("C:\\repo\\a.ts");
  });

  it("detects Windows from a backslash even without a drive letter", () => {
    expect(joinPath("\\\\server\\share", "a.ts")).toBe(
      "\\\\server\\share\\a.ts"
    );
  });

  it("returns the cleaned relative path when the base is empty", () => {
    expect(joinPath("", "./src/db.ts")).toBe("src/db.ts");
  });
});
