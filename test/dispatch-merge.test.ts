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
});
