/**
 * On-demand backlog triage: the pure argv builder for the gh browse call
 * (command-string lock, per AGENTS.md) and the dispatch-status overlay. No gh is
 * spawned — the argv is asserted directly and the overlay is fed canned rows.
 */
import { describe, it, expect } from "vitest";
import { buildOpenIssueArgs } from "@/lib/dispatch/issues";
import {
  annotateTriageIssues,
  canDispatchExisting,
} from "@/lib/dispatch/triage";
import type { EligibleIssue, IssueDispatch } from "@/lib/dispatch/types";

const issue = (
  n: number,
  over: Partial<EligibleIssue> = {}
): EligibleIssue => ({
  number: n,
  title: `#${n}`,
  url: `https://github.com/o/r/issues/${n}`,
  createdAt: "2026-06-01T00:00:00Z",
  labels: [],
  ...over,
});

const row = (
  n: number,
  status: IssueDispatch["status"],
  id = `d${n}`
): Pick<IssueDispatch, "issue_number" | "status" | "id"> => ({
  issue_number: n,
  status,
  id,
});

describe("buildOpenIssueArgs", () => {
  it("lists a repo's open issues with no label by default (the whole backlog)", () => {
    expect(buildOpenIssueArgs("o/r")).toEqual([
      "issue",
      "list",
      "--repo",
      "o/r",
      "--state",
      "open",
      "--json",
      "number,title,url,createdAt,labels",
      "--limit",
      "50",
    ]);
  });

  it("appends --label and --search (trimmed) only when provided", () => {
    const a = buildOpenIssueArgs("o/r", {
      label: "  bug ",
      search: " is:open ",
    });
    expect(a[a.indexOf("--label") + 1]).toBe("bug");
    expect(a[a.indexOf("--search") + 1]).toBe("is:open");
  });

  it("omits blank label/search and clamps the limit to MAX_ISSUES", () => {
    const a = buildOpenIssueArgs("o/r", {
      label: "   ",
      search: "",
      limit: 9999,
    });
    expect(a).not.toContain("--label");
    expect(a).not.toContain("--search");
    expect(a[a.indexOf("--limit") + 1]).toBe("50");
  });

  it("honors a smaller positive limit and ignores non-positive ones", () => {
    expect(buildOpenIssueArgs("o/r", { limit: 10 }).at(-1)).toBe("10");
    expect(buildOpenIssueArgs("o/r", { limit: 0 }).at(-1)).toBe("50");
    expect(buildOpenIssueArgs("o/r", { limit: -5 }).at(-1)).toBe("50");
  });

  it("never injects a shell — the slug is a discrete argv token", () => {
    const a = buildOpenIssueArgs("evil/repo; rm -rf /");
    expect(a[a.indexOf("--repo") + 1]).toBe("evil/repo; rm -rf /");
  });
});

describe("canDispatchExisting", () => {
  it("only a fresh 'pending' candidate may be spawned now", () => {
    expect(canDispatchExisting("pending")).toBe(true);
  });
  it("never re-dispatches an in-flight / finished / parked issue", () => {
    for (const s of [
      "scheduled",
      "dispatched",
      "pr_open",
      "merged",
      "failed",
      "cancelled",
    ] as const) {
      expect(canDispatchExisting(s)).toBe(false);
    }
  });
});

describe("annotateTriageIssues", () => {
  it("overlays dispatch status by issue number, null when never dispatched", () => {
    const out = annotateTriageIssues(
      [issue(1), issue(2), issue(3)],
      [row(2, "dispatched"), row(3, "merged")]
    );
    expect(out.map((i) => [i.number, i.dispatchStatus])).toEqual([
      [1, null],
      [2, "dispatched"],
      [3, "merged"],
    ]);
    expect(out[0].dispatchId).toBeNull();
    expect(out[1].dispatchId).toBe("d2");
  });

  it("preserves gh order and passes the issue fields through untouched", () => {
    const out = annotateTriageIssues(
      [issue(5, { title: "x", labels: ["bug"] })],
      []
    );
    expect(out[0]).toMatchObject({
      number: 5,
      title: "x",
      labels: ["bug"],
      dispatchStatus: null,
      dispatchId: null,
    });
  });

  it("ignores dispatch rows with no matching open issue (closed/stale rows)", () => {
    const out = annotateTriageIssues([issue(1)], [row(99, "merged")]);
    expect(out).toHaveLength(1);
    expect(out[0].dispatchStatus).toBeNull();
  });
});
