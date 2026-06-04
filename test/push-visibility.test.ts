import { describe, it, expect } from "vitest";
import { shouldSuppressPush } from "../lib/push-visibility";

describe("shouldSuppressPush (per-device Web Push dedupe)", () => {
  it("sends the push when this device has NO open Stoa window", () => {
    // A phone with the tab closed must still get the push even though another
    // device (desktop) has the board open. The server fans out to all
    // subscriptions; this device decides on its own clients only.
    expect(shouldSuppressPush([])).toBe(false);
  });

  it("suppresses whenever a Stoa window is open — even hidden/minimized", () => {
    // The fix: an open-but-hidden tab is owned by the in-app path (which fires
    // on blur), so the SW must NOT also push, or the user gets two notifications.
    expect(shouldSuppressPush([{ visibilityState: "visible" }])).toBe(true);
    expect(shouldSuppressPush([{ visibilityState: "hidden" }])).toBe(true);
    expect(shouldSuppressPush([{ visibilityState: "prerender" }])).toBe(true);
  });

  it("suppresses with multiple windows open (any state)", () => {
    expect(
      shouldSuppressPush([
        { visibilityState: "hidden" },
        { visibilityState: "visible" },
      ])
    ).toBe(true);
  });
});
