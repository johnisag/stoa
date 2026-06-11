import { describe, it, expect } from "vitest";
import {
  shouldOfferSeeChanges,
  type SeeChangesStatus,
} from "../lib/see-changes";

describe("shouldOfferSeeChanges", () => {
  it("offers when an active turn settles to idle (turn completed)", () => {
    expect(shouldOfferSeeChanges("running", "idle")).toBe(true);
    expect(shouldOfferSeeChanges("waiting", "idle")).toBe(true);
  });

  it("does not offer when the next status isn't idle", () => {
    const others: SeeChangesStatus[] = ["running", "waiting", "error", "dead"];
    for (const next of others) {
      expect(shouldOfferSeeChanges("running", next)).toBe(false);
    }
  });

  it("does not offer landing on idle from a non-active prior state", () => {
    // No turn just finished — nothing new to review.
    expect(shouldOfferSeeChanges("idle", "idle")).toBe(false);
    expect(shouldOfferSeeChanges("error", "idle")).toBe(false);
    expect(shouldOfferSeeChanges("dead", "idle")).toBe(false);
  });

  it("does not offer on first sight (no previous status)", () => {
    // Mirrors useNotifications skipping initial load — no transition yet.
    expect(shouldOfferSeeChanges(undefined, "idle")).toBe(false);
  });

  it("is a pure predicate on the prev/next pair (once-per-transition gate is the caller's previousStates map)", () => {
    // Same inputs always yield the same result; the offer fires once because the
    // caller advances previousStates so the running->idle pair isn't seen twice.
    expect(shouldOfferSeeChanges("running", "idle")).toBe(true);
    expect(shouldOfferSeeChanges("running", "idle")).toBe(true);
  });
});
