import { describe, it, expect } from "vitest";
import { appBadgeAction } from "@/lib/notifications";

describe("appBadgeAction (#3 — OS app-icon badge)", () => {
  it("shows the count when sessions need you", () => {
    expect(appBadgeAction(3)).toEqual({ set: 3 });
    expect(appBadgeAction(1)).toEqual({ set: 1 });
  });

  it("clears the badge at zero (no lingering dot)", () => {
    expect(appBadgeAction(0)).toEqual({ clear: true });
  });

  it("clamps bad input (negative/fractional) to a safe whole number or clear", () => {
    expect(appBadgeAction(-3)).toEqual({ clear: true });
    expect(appBadgeAction(2.7)).toEqual({ set: 2 });
  });
});
