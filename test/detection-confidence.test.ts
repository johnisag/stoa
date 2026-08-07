import { describe, it, expect } from "vitest";
import { deriveConfidence, NO_CONFIDENCE } from "@/lib/detection/confidence";

describe("deriveConfidence", () => {
  it("returns all-false when nothing is visible", () => {
    const c = deriveConfidence("some output\n", false, false);
    expect(c.visibleWorking).toBe(false);
    expect(c.visibleBlocker).toBe(false);
    expect(c.visibleIdle).toBe(false);
    expect(c.skipStateUpdate).toBe(false);
  });

  it("sets visibleWorking when busy", () => {
    const c = deriveConfidence("esc to interrupt\n", true, false);
    expect(c.visibleWorking).toBe(true);
    expect(c.visibleBlocker).toBe(false);
  });

  it("sets visibleBlocker when waiting", () => {
    const c = deriveConfidence("[Y/n]\n", false, true);
    expect(c.visibleBlocker).toBe(true);
    expect(c.visibleWorking).toBe(false);
  });

  it("sets visibleIdle for a bare shell prompt", () => {
    const c = deriveConfidence("ls -la\ntotal 0\nuser@host:~$ ", false, false);
    expect(c.visibleIdle).toBe(true);
  });

  it("does NOT set visibleIdle when busy or waiting", () => {
    const c1 = deriveConfidence("$ ", true, false);
    expect(c1.visibleIdle).toBe(false); // busy overrides
    const c2 = deriveConfidence("$ ", false, true);
    expect(c2.visibleIdle).toBe(false); // waiting overrides
  });

  it("sets skipStateUpdate for a transcript viewer", () => {
    const c = deriveConfidence(
      "showing detailed transcript\nctrl+o to toggle\n",
      false,
      false
    );
    expect(c.skipStateUpdate).toBe(true);
    expect(c.visibleIdle).toBe(false); // skipStateUpdate suppresses idle
  });

  it("sets skipStateUpdate for scroll shortcut hint", () => {
    const c = deriveConfidence("some history\n? for shortcuts\n", false, false);
    expect(c.skipStateUpdate).toBe(true);
  });

  it("does NOT set skipStateUpdate for transcript text in scrollback", () => {
    // The pattern must be in the bottom region (last 5 lines), not deep
    // scrollback. Push it far enough that only shell output remains at the
    // bottom.
    const content =
      "showing detailed transcript\n".repeat(2) +
      "ls -la\ntotal 0\nfile.txt\nREADME.md\n$ ";
    const c = deriveConfidence(content, false, false);
    expect(c.skipStateUpdate).toBe(false);
  });

  it("NO_CONFIDENCE is all-false", () => {
    expect(NO_CONFIDENCE.visibleWorking).toBe(false);
    expect(NO_CONFIDENCE.visibleBlocker).toBe(false);
    expect(NO_CONFIDENCE.visibleIdle).toBe(false);
    expect(NO_CONFIDENCE.skipStateUpdate).toBe(false);
  });
});
