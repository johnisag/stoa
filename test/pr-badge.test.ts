import { describe, it, expect } from "vitest";
import { prBadgeTone } from "@/lib/pr-badge";

describe("prBadgeTone", () => {
  it("draft wins over everything else", () => {
    expect(
      prBadgeTone({
        reviewDecision: "APPROVED",
        isDraft: true,
        checks: "passing",
      })
    ).toBe("draft");
    expect(
      prBadgeTone({
        reviewDecision: "CHANGES_REQUESTED",
        isDraft: true,
        checks: "failing",
      })
    ).toBe("draft");
  });

  it("changes-requested → 'changes'", () => {
    expect(
      prBadgeTone({
        reviewDecision: "CHANGES_REQUESTED",
        isDraft: false,
        checks: "passing",
      })
    ).toBe("changes");
  });

  it("failing checks → 'changes' even with no/positive review", () => {
    expect(
      prBadgeTone({ reviewDecision: "", isDraft: false, checks: "failing" })
    ).toBe("changes");
    // Failing CI overrides an approval — the PR is not actually shippable.
    expect(
      prBadgeTone({
        reviewDecision: "APPROVED",
        isDraft: false,
        checks: "failing",
      })
    ).toBe("changes");
  });

  it("approved (and checks not failing) → 'approved'", () => {
    expect(
      prBadgeTone({
        reviewDecision: "APPROVED",
        isDraft: false,
        checks: "passing",
      })
    ).toBe("approved");
    expect(
      prBadgeTone({
        reviewDecision: "APPROVED",
        isDraft: false,
        checks: "none",
      })
    ).toBe("approved");
    // An approval is green even while non-failing checks are still in flight;
    // only a *failing* check pulls it back to amber (covered above).
    expect(
      prBadgeTone({
        reviewDecision: "APPROVED",
        isDraft: false,
        checks: "pending",
      })
    ).toBe("approved");
  });

  it("review required / no signal → 'pending'", () => {
    expect(
      prBadgeTone({
        reviewDecision: "REVIEW_REQUIRED",
        isDraft: false,
        checks: "passing",
      })
    ).toBe("pending");
    expect(
      prBadgeTone({ reviewDecision: "", isDraft: false, checks: "none" })
    ).toBe("pending");
    expect(
      prBadgeTone({ reviewDecision: "", isDraft: false, checks: "pending" })
    ).toBe("pending");
  });
});
