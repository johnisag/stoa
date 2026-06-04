import { describe, it, expect } from "vitest";
import {
  priceForModel,
  computeCostUsd,
  totalTokens,
  ZERO_USAGE,
} from "../lib/pricing";

describe("priceForModel", () => {
  it("matches Stoa's stored model values: bare aliases, full ids, and free-text", () => {
    // The DB stores bare aliases — the regression that shipped null cost.
    expect(priceForModel("opus")?.input).toBe(15);
    expect(priceForModel("sonnet")?.input).toBe(3);
    expect(priceForModel("haiku")?.input).toBe(0.8);
    // Full ids + Hermes free-text still match.
    expect(priceForModel("claude-opus-4-8")?.input).toBe(15);
    expect(priceForModel("claude-sonnet-4-6")?.input).toBe(3);
    expect(priceForModel("anthropic/claude-haiku-4.5")?.input).toBe(0.8);
  });
  it("returns null for unknown / empty models", () => {
    expect(priceForModel("gpt-5-codex")).toBeNull();
    expect(priceForModel("")).toBeNull();
    expect(priceForModel(null)).toBeNull();
  });
});

describe("computeCostUsd", () => {
  it("sums each token class at its per-Mtok rate", () => {
    // 1M input + 1M output on Sonnet = $3 + $15 = $18.
    const cost = computeCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      "claude-sonnet-4-6"
    );
    expect(cost).toBeCloseTo(18, 6);
  });
  it("prices cache read + write at their discounted/premium rates", () => {
    // Opus: 1M cacheRead ($1.50) + 1M cacheWrite ($18.75) = $20.25.
    const cost = computeCostUsd(
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      "claude-opus-4-8"
    );
    expect(cost).toBeCloseTo(20.25, 6);
  });
  it("is null when the model is unpriced (e.g. Codex/Hermes)", () => {
    expect(
      computeCostUsd(
        { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
        "gpt-5"
      )
    ).toBeNull();
  });
  it("zero usage costs zero", () => {
    expect(computeCostUsd(ZERO_USAGE, "claude-opus-4-8")).toBe(0);
  });
});

describe("totalTokens", () => {
  it("sums all token classes", () => {
    expect(
      totalTokens({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })
    ).toBe(100);
  });
});
