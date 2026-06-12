import { describe, it, expect } from "vitest";
import {
  isActionAllowed,
  type BoardAction,
} from "../lib/dispatch/board-actions";

describe("isActionAllowed", () => {
  it("approve only when pending", () => {
    expect(isActionAllowed("approve", "pending")).toBe(true);
    expect(isActionAllowed("approve", "scheduled")).toBe(false);
    expect(isActionAllowed("approve", "failed")).toBe(false);
  });

  it("cancel when pending or scheduled", () => {
    expect(isActionAllowed("cancel", "pending")).toBe(true);
    expect(isActionAllowed("cancel", "scheduled")).toBe(true);
    expect(isActionAllowed("cancel", "dispatched")).toBe(false);
    expect(isActionAllowed("cancel", "failed")).toBe(false);
  });

  it("dismiss and retry only when failed", () => {
    for (const a of ["dismiss", "retry"] as const) {
      expect(isActionAllowed(a, "failed")).toBe(true);
      expect(isActionAllowed(a, "pr_open")).toBe(false);
      expect(isActionAllowed(a, "merged")).toBe(false);
      expect(isActionAllowed(a, "dispatched")).toBe(false);
      expect(isActionAllowed(a, "cancelled")).toBe(false);
    }
  });

  it("reconcile only when pr_open", () => {
    expect(isActionAllowed("reconcile", "pr_open")).toBe(true);
    for (const s of [
      "pending",
      "scheduled",
      "dispatched",
      "merged",
      "failed",
      "cancelled",
    ] as const) {
      expect(isActionAllowed("reconcile", s)).toBe(false);
    }
  });

  it("no action is allowed on a cancelled row", () => {
    for (const a of [
      "approve",
      "cancel",
      "dismiss",
      "retry",
      "reconcile",
    ] as const) {
      expect(isActionAllowed(a, "cancelled")).toBe(false);
    }
  });

  it("an unknown action returns false", () => {
    expect(isActionAllowed("nope" as BoardAction, "failed")).toBe(false);
  });
});
