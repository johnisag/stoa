import { describe, it, expect } from "vitest";
import { buildMergeArgs } from "../lib/dispatch/merge";

describe("buildMergeArgs", () => {
  it("builds a squash merge by default", () => {
    expect(buildMergeArgs(42)).toEqual(["pr", "merge", "42", "--squash"]);
  });

  it("supports merge / rebase methods", () => {
    expect(buildMergeArgs(7, "merge")).toEqual(["pr", "merge", "7", "--merge"]);
    expect(buildMergeArgs(7, "rebase")).toEqual([
      "pr",
      "merge",
      "7",
      "--rebase",
    ]);
  });

  it("never enables GitHub auto-merge (no --auto)", () => {
    expect(buildMergeArgs(1)).not.toContain("--auto");
    expect(buildMergeArgs(1, "merge")).not.toContain("--auto");
  });

  it("adds --repo <slug> when given (so the merge is worktree-independent)", () => {
    expect(buildMergeArgs(7, "squash", null, "owner/repo")).toEqual([
      "pr",
      "merge",
      "7",
      "--squash",
      "--repo",
      "owner/repo",
    ]);
    // sits after --match-head-commit
    expect(buildMergeArgs(7, "merge", "abc123", "owner/repo")).toEqual([
      "pr",
      "merge",
      "7",
      "--merge",
      "--match-head-commit",
      "abc123",
      "--repo",
      "owner/repo",
    ]);
    // omitted (and argv unchanged) when no slug
    expect(buildMergeArgs(7)).not.toContain("--repo");
  });
});
