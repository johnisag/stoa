import { describe, it, expect } from "vitest";
import {
  CODEX_CONTEXT_WINDOW,
  GPT_55_CONTEXT_WINDOW,
  contextWindowFor,
  tokenMeter,
  DEFAULT_CONTEXT_WINDOW,
} from "../lib/context-window";

describe("contextWindowFor", () => {
  it("matches Stoa's stored model values: bare aliases, full ids, and free-text", () => {
    expect(contextWindowFor("opus")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(200_000);
    expect(contextWindowFor("anthropic/claude-haiku-4.5")).toBe(200_000);
  });
  it("uses the official GPT-5.5 API context window for the generic model id", () => {
    expect(contextWindowFor("gpt-5.5")).toBe(GPT_55_CONTEXT_WINDOW);
  });
  it("keeps Codex-specific GPT ids on Codex's reported effective budget", () => {
    expect(contextWindowFor("gpt-5-codex")).toBe(CODEX_CONTEXT_WINDOW);
    expect(contextWindowFor("gpt-5.3-codex-spark")).toBe(CODEX_CONTEXT_WINDOW);
  });
  it("falls back to the default cap for unknown / empty models", () => {
    expect(contextWindowFor("gpt-unknown")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor("")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("tokenMeter", () => {
  it("reports the fraction in use and a muted tone well under the cap", () => {
    expect(tokenMeter(50_000, 200_000)).toEqual({ pct: 0.25, tone: "ok" });
  });
  it("tints amber at the 70% warn threshold and red at the 90% full one", () => {
    expect(tokenMeter(140_000, 200_000).tone).toBe("warn"); // exactly 70%
    expect(tokenMeter(179_000, 200_000).tone).toBe("warn"); // 89.5%
    expect(tokenMeter(180_000, 200_000).tone).toBe("full"); // exactly 90%
  });
  it("clamps a count above the window to a full gauge", () => {
    expect(tokenMeter(500_000, 200_000)).toEqual({ pct: 1, tone: "full" });
  });
  it("treats a missing / non-positive window as already full (no divide-by-zero)", () => {
    expect(tokenMeter(10, 0)).toEqual({ pct: 1, tone: "full" });
    expect(tokenMeter(10, -5)).toEqual({ pct: 1, tone: "full" });
  });
  it("floors negative / non-finite token counts to an empty gauge", () => {
    expect(tokenMeter(-100, 200_000)).toEqual({ pct: 0, tone: "ok" });
    expect(tokenMeter(NaN, 200_000)).toEqual({ pct: 0, tone: "ok" });
  });
});
