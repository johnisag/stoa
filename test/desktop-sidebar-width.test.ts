import { describe, expect, it } from "vitest";
import {
  MAIN_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RESIZE_HANDLE_WIDTH,
  getSidebarMaxWidth,
  resolveSidebarWidth,
} from "@/lib/desktop-sidebar-width";

describe("desktop sidebar width helpers", () => {
  it("clamps invalid and out-of-range preferences", () => {
    expect(resolveSidebarWidth(Number.NaN).preference).toBe(
      SIDEBAR_DEFAULT_WIDTH
    );
    expect(resolveSidebarWidth(100).preference).toBe(SIDEBAR_MIN_WIDTH);
    expect(resolveSidebarWidth(900).preference).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("reserves the main area and resize handle from the desktop width", () => {
    const containerWidth = 800;

    expect(getSidebarMaxWidth(containerWidth)).toBe(
      containerWidth - MAIN_MIN_WIDTH - SIDEBAR_RESIZE_HANDLE_WIDTH
    );
    expect(resolveSidebarWidth(520, { containerWidth }).width).toBe(272);
  });

  it("never lets tiny desktop widths shrink the sidebar below its minimum", () => {
    expect(getSidebarMaxWidth(700)).toBe(SIDEBAR_MIN_WIDTH);
    expect(resolveSidebarWidth(520, { containerWidth: 700 }).width).toBe(
      SIDEBAR_MIN_WIDTH
    );
  });

  it("preserves a wider hidden preference when constrained attempts cannot grow visibly", () => {
    const resolved = resolveSidebarWidth(300, {
      containerWidth: 800,
      currentPreference: 520,
      preserveWiderPreference: true,
    });

    expect(resolved.width).toBe(272);
    expect(resolved.preference).toBe(520);
  });

  it("allows the hidden preference to grow when dragging further past the visible clamp", () => {
    const resolved = resolveSidebarWidth(480, {
      containerWidth: 800,
      currentPreference: 360,
      preserveWiderPreference: true,
    });

    expect(resolved.width).toBe(272);
    expect(resolved.preference).toBe(480);
  });

  it("clamps the preserved current preference before using it", () => {
    const resolved = resolveSidebarWidth(300, {
      containerWidth: 800,
      currentPreference: 900,
      preserveWiderPreference: true,
    });

    expect(resolved.width).toBe(272);
    expect(resolved.preference).toBe(SIDEBAR_MAX_WIDTH);
  });
});
