/**
 * Locks the fix for the terminal mouse-selection bug: clicking to focus a pane
 * must NOT steal focus while its terminal holds a text selection, because the
 * focus() fired by that mouse-up click clears the xterm selection (so it can't
 * be copied). The inner terminal div was already guarded; this covers the
 * bubbled Pane-level click (components/Pane/index.tsx handleFocus), which was
 * the remaining unguarded path. Pure predicate → runs on the 3-OS matrix.
 */
import { describe, it, expect } from "vitest";
import { shouldFocusPaneOnClick } from "@/components/Pane/focus-guard";

describe("shouldFocusPaneOnClick — preserve terminal selection on click", () => {
  it("focuses on a plain click (no selection)", () => {
    expect(shouldFocusPaneOnClick({ hasSelection: () => false })).toBe(true);
  });

  it("does NOT focus while the terminal has a selection (keeps it copyable)", () => {
    expect(shouldFocusPaneOnClick({ hasSelection: () => true })).toBe(false);
  });

  it("focuses when there is no terminal yet (null handle)", () => {
    expect(shouldFocusPaneOnClick(null)).toBe(true);
  });

  it("focuses when the handle lacks hasSelection (defensive)", () => {
    expect(shouldFocusPaneOnClick({})).toBe(true);
  });
});
