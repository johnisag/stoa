import { describe, it, expect } from "vitest";
import { isValidBranchName } from "@/lib/git-status";

// Regression: a `-`-leading branchName reached `git checkout -b <name>` and was
// parsed as a flag. isValidBranchName gates the commit route + createBranch.
describe("isValidBranchName", () => {
  it("accepts ordinary branch names", () => {
    for (const ok of [
      "feature/foo",
      "fix-bug-123",
      "release_2.0",
      "user/topic.with.dots",
    ]) {
      expect(isValidBranchName(ok)).toBe(true);
    }
  });

  it("rejects option-shaped names (leading dash)", () => {
    expect(isValidBranchName("--orphan")).toBe(false);
    expect(isValidBranchName("-D")).toBe(false);
  });

  it("rejects empty, whitespace, control chars, and git-illegal chars", () => {
    for (const bad of [
      "",
      "has space",
      "tab\tname",
      "ctrl\x00name",
      "a..b",
      "ends/",
      "x.lock",
      "ti~lde",
      "ca^ret",
      "co:lon",
      "qu?mark",
      "as*terisk",
      "br[acket",
      "back\\slash",
    ]) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });
});
