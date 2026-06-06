import { describe, it, expect } from "vitest";
import {
  shouldSpawnReviewer,
  parseReviewDecision,
  buildReviewPrompt,
} from "../lib/dispatch/reviewer";
import type { DispatchRepo, IssueDispatch } from "../lib/dispatch/types";

describe("shouldSpawnReviewer", () => {
  const base = {
    status: "pr_open" as const,
    pr_number: 5,
    reviewer_session_id: null,
  };

  it("true only when gate on, pr_open, has PR, not yet reviewed", () => {
    expect(shouldSpawnReviewer({ review_gate: 1 }, base)).toBe(true);
  });
  it("false when the gate is off", () => {
    expect(shouldSpawnReviewer({ review_gate: 0 }, base)).toBe(false);
  });
  it("false when not pr_open", () => {
    expect(
      shouldSpawnReviewer({ review_gate: 1 }, { ...base, status: "dispatched" })
    ).toBe(false);
  });
  it("false when there's no PR number", () => {
    expect(
      shouldSpawnReviewer({ review_gate: 1 }, { ...base, pr_number: null })
    ).toBe(false);
  });
  it("false when a reviewer was already spawned", () => {
    expect(
      shouldSpawnReviewer(
        { review_gate: 1 },
        { ...base, reviewer_session_id: "sess-1" }
      )
    ).toBe(false);
  });
});

describe("parseReviewDecision", () => {
  it("extracts the reviewDecision", () => {
    expect(parseReviewDecision('{"reviewDecision":"APPROVED"}')).toBe(
      "APPROVED"
    );
    expect(parseReviewDecision('{"reviewDecision":"CHANGES_REQUESTED"}')).toBe(
      "CHANGES_REQUESTED"
    );
  });
  it("returns null for empty / missing / invalid", () => {
    expect(parseReviewDecision('{"reviewDecision":""}')).toBeNull();
    expect(parseReviewDecision('{"reviewDecision":null}')).toBeNull();
    expect(parseReviewDecision("{}")).toBeNull();
    expect(parseReviewDecision("not json")).toBeNull();
  });
});

describe("buildReviewPrompt", () => {
  it("names the PR + issue, the gh review commands, and the read-only guard", () => {
    const repo = { repo_slug: "octo/app" } as unknown as DispatchRepo;
    const d = {
      pr_number: 12,
      issue_number: 7,
      issue_title: "Fix X",
    } as unknown as IssueDispatch;
    const p = buildReviewPrompt(repo, d);
    expect(p).toContain("#12");
    expect(p).toContain("octo/app");
    expect(p).toContain("gh pr review 12 --approve");
    expect(p).toContain("--request-changes");
    expect(p).toMatch(/do NOT modify/i);
  });
});
