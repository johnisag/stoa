import { describe, it, expect } from "vitest";
import { shouldSuppressPush } from "../lib/push-visibility";

describe("shouldSuppressPush (per-device Web Push dedupe)", () => {
  it("sends the push when this device has NO open Stoa window", () => {
    // The regression: a phone with the tab closed must still get the push even
    // though another device (desktop) has the board open. The server fans out
    // to all subscriptions; this device decides on its own clients only.
    expect(shouldSuppressPush([])).toBe(false);
  });

  it("suppresses the push when a Stoa tab is actively visible on this device", () => {
    expect(shouldSuppressPush([{ visibilityState: "visible" }])).toBe(true);
  });

  it("sends the push when the only tab is backgrounded/hidden", () => {
    // A hidden tab isn't being watched — closed-tab notifications should fire.
    expect(shouldSuppressPush([{ visibilityState: "hidden" }])).toBe(false);
  });

  it("suppresses if ANY of several windows is visible", () => {
    expect(
      shouldSuppressPush([
        { visibilityState: "hidden" },
        { visibilityState: "visible" },
      ])
    ).toBe(true);
  });

  it("sends when every window is hidden", () => {
    expect(
      shouldSuppressPush([
        { visibilityState: "hidden" },
        { visibilityState: "prerender" },
      ])
    ).toBe(false);
  });
});
