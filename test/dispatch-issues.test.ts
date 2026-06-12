/**
 * gh issue ingestion parsing. `parseIssues` normalizes `gh issue list --json`
 * output (defensive: bad JSON or malformed entries are dropped, labels flattened
 * from [{name}] to string[]). No gh is spawned — canned JSON only.
 */
import { describe, it, expect } from "vitest";
import { parseIssues, buildPrListByBranchArgs } from "@/lib/dispatch/issues";

describe("parseIssues", () => {
  it("normalizes a well-formed gh issue list", () => {
    const json = JSON.stringify([
      {
        number: 42,
        title: "Fix login",
        url: "https://github.com/o/r/issues/42",
        createdAt: "2026-06-01T10:00:00Z",
        labels: [{ name: "bug" }, { name: "ready" }],
      },
    ]);
    expect(parseIssues(json)).toEqual([
      {
        number: 42,
        title: "Fix login",
        url: "https://github.com/o/r/issues/42",
        createdAt: "2026-06-01T10:00:00Z",
        labels: ["bug", "ready"],
      },
    ]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseIssues("{not json")).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseIssues(JSON.stringify({ number: 1 }))).toEqual([]);
  });

  it("drops entries with no numeric issue number", () => {
    const json = JSON.stringify([
      { title: "no number" },
      { number: "7", title: "string number" },
      { number: 9, title: "ok" },
    ]);
    expect(parseIssues(json).map((i) => i.number)).toEqual([9]);
  });

  it("defaults missing string fields and absent labels", () => {
    const json = JSON.stringify([{ number: 5 }]);
    expect(parseIssues(json)).toEqual([
      { number: 5, title: "", url: "", createdAt: "", labels: [] },
    ]);
  });

  it("skips malformed label entries", () => {
    const json = JSON.stringify([
      { number: 1, labels: [{ name: "keep" }, {}, { name: 123 }, "nope"] },
    ]);
    expect(parseIssues(json)[0].labels).toEqual(["keep"]);
  });
});

describe("buildPrListByBranchArgs — repo-explicit branch→PR lookup", () => {
  it("appends --repo <slug> only when given (so the sweep is worktree-independent)", () => {
    expect(buildPrListByBranchArgs("feature/x")).not.toContain("--repo");
    expect(buildPrListByBranchArgs("feature/x", "owner/repo")).toEqual([
      "pr",
      "list",
      "--head",
      "feature/x",
      "--state",
      "all",
      "--json",
      "number,url,state",
      "--limit",
      "1",
      "--repo",
      "owner/repo",
    ]);
  });
});
