import { describe, it, expect } from "vitest";
import {
  priceForModel,
  computeCostUsd,
  totalTokens,
  cacheHitRate,
  cacheSavingsUsd,
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
    expect(priceForModel("gpt-unknown")).toBeNull();
    expect(priceForModel("")).toBeNull();
    expect(priceForModel(null)).toBeNull();
  });
  it("matches current OpenAI GPT/Codex published token prices", () => {
    expect(priceForModel("gpt-5.5")).toMatchObject({
      input: 5,
      cacheRead: 0.5,
      output: 30,
    });
    expect(priceForModel("gpt-5.4-mini")).toMatchObject({
      input: 0.75,
      cacheRead: 0.075,
      output: 4.5,
    });
    expect(priceForModel("gpt-5.4-nano")).toMatchObject({
      input: 0.2,
      cacheRead: 0.02,
      output: 1.25,
    });
    expect(priceForModel("gpt-5.3-codex-spark")).toMatchObject({
      input: 1.75,
      cacheRead: 0.175,
      output: 14,
    });
    expect(priceForModel("gpt-5-codex")).toMatchObject({
      input: 1.75,
      cacheRead: 0.175,
      output: 14,
    });
    expect(priceForModel("gpt-5.5", { longContext: true })).toMatchObject({
      input: 10,
      cacheRead: 1,
      output: 45,
    });
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
  it("is null when the model is unpriced", () => {
    expect(
      computeCostUsd(
        { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
        "gpt-unknown"
      )
    ).toBeNull();
  });
  it("prices OpenAI cached input separately from fresh input", () => {
    const cost = computeCostUsd(
      {
        input: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
        cacheWrite: 0,
      },
      "gpt-5.5"
    );
    expect(cost).toBeCloseTo(35.5, 6);
  });
  it("applies OpenAI long-context rates when a GPT prompt crosses 272K input tokens", () => {
    const cost = computeCostUsd(
      {
        input: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
        cacheWrite: 0,
      },
      "gpt-5.5",
      { longContext: true }
    );
    expect(cost).toBeCloseTo(56, 6);
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

describe("cacheHitRate (#12)", () => {
  it("is cacheRead over the input-side total (input+cacheRead+cacheWrite)", () => {
    // 900 cacheRead of 1000 input-side (50 fresh + 900 read + 50 write) = 0.9.
    expect(
      cacheHitRate({ input: 50, output: 999, cacheRead: 900, cacheWrite: 50 })
    ).toBeCloseTo(0.9, 6);
  });
  it("ignores OUTPUT tokens entirely", () => {
    expect(
      cacheHitRate({
        input: 0,
        output: 1_000_000,
        cacheRead: 100,
        cacheWrite: 0,
      })
    ).toBe(1); // 100/100 input-side
  });
  it("is null when there is no input-side token yet", () => {
    expect(cacheHitRate(ZERO_USAGE)).toBeNull();
    expect(
      cacheHitRate({ input: 0, output: 500, cacheRead: 0, cacheWrite: 0 })
    ).toBeNull();
  });
});

describe("cacheSavingsUsd (#12)", () => {
  it("values cache reads at the (input - cacheRead) $/Mtok gap", () => {
    // Sonnet: input 3, cacheRead 0.3 → 1M reads save (3 - 0.3) = $2.70.
    expect(
      cacheSavingsUsd(
        { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
        "claude-sonnet-4-6"
      )
    ).toBeCloseTo(2.7, 6);
  });
  it("is zero with no cache reads, null when the model is unpriced", () => {
    expect(cacheSavingsUsd(ZERO_USAGE, "claude-opus-4-8")).toBe(0);
    expect(
      cacheSavingsUsd(
        { input: 0, output: 0, cacheRead: 1_000, cacheWrite: 0 },
        "gpt-unknown"
      )
    ).toBeNull();
  });
});
