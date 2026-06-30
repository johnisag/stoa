import { describe, it, expect } from "vitest";
import {
  nextCompactAction,
  parseCompactThreshold,
  parseCompactCooldownMs,
  parseCompactMaxPerDay,
} from "@/lib/auto-compact";

const NOW = 1_700_000_000_000;

function input(over: Partial<Parameters<typeof nextCompactAction>[0]> = {}) {
  return {
    contextPct: 0.9,
    threshold: 0.85,
    isIdle: true,
    lastCompactMs: null,
    cooldownMs: 300_000,
    nowMs: NOW,
    ...over,
  };
}

describe("nextCompactAction (decision matrix)", () => {
  it("compacts when over threshold, idle, and past the cooldown", () => {
    expect(nextCompactAction(input())).toBe("compact");
    expect(nextCompactAction(input({ lastCompactMs: NOW - 300_001 }))).toBe(
      "compact"
    ); // cooldown elapsed
  });

  it("is idle when disabled, has headroom, or the context is unknown", () => {
    expect(nextCompactAction(input({ threshold: 0 }))).toBe("idle"); // disabled
    expect(nextCompactAction(input({ contextPct: 0.5 }))).toBe("idle"); // headroom
    expect(nextCompactAction(input({ contextPct: null }))).toBe("idle"); // unknown
    expect(nextCompactAction(input({ contextPct: NaN }))).toBe("idle");
  });

  it("waits when over threshold but NOT at a clean idle boundary (never writes mid-turn)", () => {
    expect(nextCompactAction(input({ isIdle: false }))).toBe("wait");
  });

  it("waits when a prompt is detected even at idle (canonical idle && !hasPrompt gate, Gate D)", () => {
    expect(nextCompactAction(input({ hasPrompt: true }))).toBe("wait");
  });

  it("waits once the per-session daily cap is spent, but not under it (loop backstop, Gate D)", () => {
    expect(
      nextCompactAction(input({ maxPerDay: 12, compactionsUsedToday: 12 }))
    ).toBe("wait"); // cap reached
    expect(
      nextCompactAction(input({ maxPerDay: 12, compactionsUsedToday: 11 }))
    ).toBe("compact"); // still under
    expect(
      nextCompactAction(input({ maxPerDay: 0, compactionsUsedToday: 999 }))
    ).toBe("compact"); // 0 = unlimited
  });

  it("waits while still inside the post-compact cooldown", () => {
    expect(nextCompactAction(input({ lastCompactMs: NOW - 60_000 }))).toBe(
      "wait"
    ); // 1 min < 5 min cooldown
  });

  it("compacts exactly at the threshold (>=)", () => {
    expect(
      nextCompactAction(input({ contextPct: 0.85, threshold: 0.85 }))
    ).toBe("compact");
  });
});

describe("parseCompactThreshold (opt-in tuning, fail-safe to 0.85, clamped 0.5..0.99)", () => {
  it("accepts a fraction or a percent", () => {
    expect(parseCompactThreshold("0.9")).toBe(0.9);
    expect(parseCompactThreshold("90")).toBeCloseTo(0.9);
    expect(parseCompactThreshold("0.85")).toBe(0.85);
  });

  it("falls back to 0.85 for unset / empty / garbage / <= 0", () => {
    expect(parseCompactThreshold(undefined)).toBe(0.85);
    expect(parseCompactThreshold("")).toBe(0.85);
    expect(parseCompactThreshold("nope")).toBe(0.85);
    expect(parseCompactThreshold("0")).toBe(0.85);
    expect(parseCompactThreshold("-1")).toBe(0.85);
  });

  it("clamps to the sane [0.5, 0.99] band", () => {
    expect(parseCompactThreshold("0.3")).toBe(0.5); // too eager → floor
    expect(parseCompactThreshold("0.999")).toBe(0.99); // too late → cap
    expect(parseCompactThreshold("100")).toBe(0.99); // 100% → cap
  });
});

describe("parseCompactCooldownMs (fail-safe to 5m, floored at 60s)", () => {
  it("accepts a valid value, defaults on junk, floors a tiny value", () => {
    expect(parseCompactCooldownMs("600000")).toBe(600_000);
    expect(parseCompactCooldownMs(undefined)).toBe(300_000);
    expect(parseCompactCooldownMs("nope")).toBe(300_000);
    expect(parseCompactCooldownMs("-1")).toBe(300_000);
    expect(parseCompactCooldownMs("5000")).toBe(60_000); // floored
  });
});

describe("parseCompactMaxPerDay (mirrors parseResumeMaxPerDay, default 12)", () => {
  it("defaults to 12; 0 = unlimited; sub-1 floors to 1; junk → 12", () => {
    expect(parseCompactMaxPerDay(undefined)).toBe(12);
    expect(parseCompactMaxPerDay("")).toBe(12);
    expect(parseCompactMaxPerDay("nope")).toBe(12);
    expect(parseCompactMaxPerDay("-5")).toBe(12);
    expect(parseCompactMaxPerDay("20")).toBe(20);
    expect(parseCompactMaxPerDay("0")).toBe(0); // explicit unlimited opt-out
    expect(parseCompactMaxPerDay("0.5")).toBe(1); // floors to 1, never unlimited by accident
  });
});
