import { describe, it, expect } from "vitest";
import { nextReviewAction, buildFixPrompt } from "../lib/dispatch/reviewer";
import type { DispatchRepo, IssueDispatch } from "../lib/dispatch/types";

const base = {
  reviewGate: true,
  status: "pr_open",
  prNumber: 5,
  reviewerSessionId: null as string | null,
  reviewDecision: null as string | null,
  fixerSessionId: null as string | null,
  fixerAlive: false,
  fixRounds: 0,
  maxFixRounds: 2,
};

describe("nextReviewAction", () => {
  it("idle when gate off / not pr_open / no PR", () => {
    expect(nextReviewAction({ ...base, reviewGate: false })).toBe("idle");
    expect(nextReviewAction({ ...base, status: "dispatched" })).toBe("idle");
    expect(nextReviewAction({ ...base, prNumber: null })).toBe("idle");
  });

  it("spawn_critic when no reviewer yet", () => {
    expect(nextReviewAction(base)).toBe("spawn_critic");
  });

  it("approved when the critic approved", () => {
    expect(
      nextReviewAction({
        ...base,
        reviewerSessionId: "r1",
        reviewDecision: "APPROVED",
      })
    ).toBe("approved");
  });

  it("spawn_fixer when changes requested and under the cap", () => {
    const cr = {
      ...base,
      reviewerSessionId: "r1",
      reviewDecision: "CHANGES_REQUESTED",
    };
    expect(nextReviewAction({ ...cr, fixRounds: 0 })).toBe("spawn_fixer");
    expect(nextReviewAction({ ...cr, fixRounds: 1 })).toBe("spawn_fixer");
  });

  it("stuck when changes requested at/over the cap", () => {
    expect(
      nextReviewAction({
        ...base,
        reviewerSessionId: "r1",
        reviewDecision: "CHANGES_REQUESTED",
        fixRounds: 2,
      })
    ).toBe("stuck");
  });

  it("waits while a fixer is alive, then re-reviews when it finishes", () => {
    const fixing = {
      ...base,
      reviewerSessionId: "r1",
      reviewDecision: "CHANGES_REQUESTED",
      fixerSessionId: "f1",
      fixRounds: 1,
    };
    expect(nextReviewAction({ ...fixing, fixerAlive: true })).toBe("wait");
    expect(nextReviewAction({ ...fixing, fixerAlive: false })).toBe("rereview");
  });

  it("idle while the decision is still pending (critic running)", () => {
    expect(
      nextReviewAction({
        ...base,
        reviewerSessionId: "r1",
        reviewDecision: null,
      })
    ).toBe("idle");
    expect(
      nextReviewAction({
        ...base,
        reviewerSessionId: "r1",
        reviewDecision: "REVIEW_REQUIRED",
      })
    ).toBe("idle");
  });
});

describe("buildFixPrompt", () => {
  it("tells the fixer to push to the same branch and not open a new PR", () => {
    const repo = { repo_slug: "o/r" } as unknown as DispatchRepo;
    const d = {
      pr_number: 9,
      issue_number: 3,
      issue_title: "X",
    } as unknown as IssueDispatch;
    const p = buildFixPrompt(repo, d);
    expect(p).toContain("#9");
    expect(p).toMatch(/push/i);
    expect(p).toMatch(/same branch/i);
    expect(p).toMatch(/do NOT open a new PR/i);
  });
});
