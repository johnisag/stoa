/**
 * The "needs me" attention selector — the SINGLE source of truth shared by the
 * Verdict Inbox view's "Needs me" tab AND the always-on nav-badge count
 * (useAttentionCount), so the ambient badge and the open queue can't disagree.
 * Pure logic over InboxItem; no db, no react-query.
 */
import { describe, it, expect } from "vitest";
import {
  beingFixed,
  needsMe,
  countNeedsMe,
} from "@/lib/verdict-inbox-selectors";
import type { InboxItem } from "@/lib/verdict-inbox";

// Minimal item factory — only the fields the predicate reads matter.
const item = (o: Partial<InboxItem>): InboxItem =>
  ({
    type: "dispatch",
    id: "i",
    state: "pr_open",
    reviewGate: true,
    reviewDecision: null,
    autoMerge: false,
    ...o,
  }) as unknown as InboxItem;

describe("beingFixed", () => {
  it("is true only for a ceremony in a fixer step", () => {
    expect(beingFixed(item({ type: "ceremony", state: "fixing" }))).toBe(true);
    expect(beingFixed(item({ type: "ceremony", state: "ci_fixing" }))).toBe(
      true
    );
    expect(beingFixed(item({ type: "ceremony", state: "merging" }))).toBe(true);
  });

  it("is false for non-fixer ceremony steps and for dispatch rows", () => {
    expect(beingFixed(item({ type: "ceremony", state: "reviewing" }))).toBe(
      false
    );
    // A dispatch row in a fixing-like state is NOT a ceremony fixer step.
    expect(beingFixed(item({ type: "dispatch", state: "fixing" }))).toBe(false);
  });
});

describe("needsMe", () => {
  it("flags changes-requested, failed, and stuck rows", () => {
    expect(needsMe(item({ reviewDecision: "CHANGES_REQUESTED" }))).toBe(true);
    expect(needsMe(item({ state: "failed" }))).toBe(true);
    expect(needsMe(item({ type: "ceremony", state: "stuck" }))).toBe(true);
  });

  it("flags a ceremony awaiting a human merge", () => {
    expect(needsMe(item({ type: "ceremony", state: "awaiting_merge" }))).toBe(
      true
    );
  });

  it("flags an approved non-auto dispatch (a human must merge)", () => {
    expect(
      needsMe(
        item({ type: "dispatch", reviewDecision: "APPROVED", autoMerge: false })
      )
    ).toBe(true);
    // …but NOT an approved auto-merge dispatch — the fleet merges that itself.
    expect(
      needsMe(
        item({ type: "dispatch", reviewDecision: "APPROVED", autoMerge: true })
      )
    ).toBe(false);
  });

  it("flags an ungated open dispatch PR (no verdict will ever come)", () => {
    expect(
      needsMe(item({ type: "dispatch", reviewGate: false, state: "pr_open" }))
    ).toBe(true);
    // A gated PR with no verdict yet is still in review — not on the human.
    expect(
      needsMe(item({ type: "dispatch", reviewGate: true, state: "pr_open" }))
    ).toBe(false);
  });

  it("never flags a row a fixer is actively working (beingFixed wins)", () => {
    // Even with a CHANGES_REQUESTED verdict, an in-flight ceremony fix is not
    // on the human yet — beingFixed short-circuits.
    expect(
      needsMe(
        item({
          type: "ceremony",
          state: "fixing",
          reviewDecision: "CHANGES_REQUESTED",
        })
      )
    ).toBe(false);
  });
});

describe("countNeedsMe", () => {
  it("counts only the rows that need the human", () => {
    const items = [
      item({ id: "a", reviewDecision: "CHANGES_REQUESTED" }), // needs me
      item({ id: "b", state: "failed" }), // needs me
      item({ id: "c", type: "ceremony", state: "reviewing" }), // in review
      item({ id: "d", type: "ceremony", state: "fixing" }), // in flight
      item({ id: "e", type: "dispatch", reviewGate: true, state: "pr_open" }), // in review
    ];
    expect(countNeedsMe(items)).toBe(2);
  });

  it("is 0 for an empty queue", () => {
    expect(countNeedsMe([])).toBe(0);
  });
});
