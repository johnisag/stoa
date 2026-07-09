/**
 * Conflict-aware decomposition — the pure claim model. The segment-boundary overlap
 * check is the load-bearing correctness point: a MISSED overlap = two conflicting
 * open PRs; a false overlap merely over-serializes (safe).
 */
import { describe, it, expect } from "vitest";
import {
  normalizeClaim,
  parseClaims,
  serializeClaims,
  claimsOverlap,
  claimsConflict,
} from "../lib/dispatch/claims";

describe("normalizeClaim", () => {
  it("folds separators + strips ./ leading/trailing/dup slashes (Windows == POSIX)", () => {
    expect(normalizeClaim("lib\\dispatch\\")).toBe("lib/dispatch");
    expect(normalizeClaim("./lib/dispatch/")).toBe("lib/dispatch");
    expect(normalizeClaim("lib//dispatch//")).toBe("lib/dispatch");
    expect(normalizeClaim("  lib/db/schema.ts  ")).toBe("lib/db/schema.ts");
  });

  it("rejects anything that could escape the repo, or is empty", () => {
    for (const bad of [
      "",
      "   ",
      "..",
      "../secrets",
      "lib/../../etc",
      "~/x",
      "C:\\Users\\x",
      "C:Users\\x",
      "/lib/dispatch",
      ".//lib/dispatch",
      "//unc/share",
      "\\\\server\\share",
      42,
      null,
    ]) {
      expect(normalizeClaim(bad as unknown), `${bad}`).toBeNull();
    }
  });
});

describe("claimsOverlap (segment boundary)", () => {
  it("equal or prefix-at-a-boundary overlaps", () => {
    expect(claimsOverlap("lib/dispatch", "lib/dispatch")).toBe(true);
    expect(claimsOverlap("lib/dispatch", "lib/dispatch/foo.ts")).toBe(true);
    expect(claimsOverlap("lib", "lib/db/schema.ts")).toBe(true);
  });

  it("does NOT falsely overlap a shared string prefix that isn't a path boundary", () => {
    expect(claimsOverlap("lib/dispatch", "lib/dispatchX")).toBe(false);
    expect(claimsOverlap("lib/db", "lib/dbx/y.ts")).toBe(false);
  });

  it("disjoint paths don't overlap", () => {
    expect(claimsOverlap("lib/a", "lib/b")).toBe(false);
    expect(claimsOverlap("src", "test")).toBe(false);
  });
});

describe("claimsConflict (sets)", () => {
  it("conflicts iff any claim overlaps any claim", () => {
    expect(claimsConflict(["lib/a", "src"], ["lib/b", "src/x.ts"])).toBe(true);
    expect(claimsConflict(["lib/a"], ["lib/b", "test"])).toBe(false);
  });

  it("EMPTY on either side never conflicts (the legacy-row invariant)", () => {
    expect(claimsConflict([], ["lib/a"])).toBe(false);
    expect(claimsConflict(["lib/a"], [])).toBe(false);
    expect(claimsConflict([], [])).toBe(false);
  });
});

describe("parseClaims / serializeClaims", () => {
  it("round-trips normalized + de-duped claims", () => {
    const json = serializeClaims(["./lib/a/", "lib/a", "src\\b.ts"]);
    expect(parseClaims(json)).toEqual(["lib/a", "src/b.ts"]);
  });

  it("is defensive: junk / non-array / null → []", () => {
    expect(parseClaims(null)).toEqual([]);
    expect(parseClaims("")).toEqual([]);
    expect(parseClaims("not json")).toEqual([]);
    expect(parseClaims('{"x":1}')).toEqual([]);
    expect(parseClaims('["..", "lib/a", "lib/a"]')).toEqual(["lib/a"]);
  });
});
