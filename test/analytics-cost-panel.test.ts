import { describe, it, expect } from "vitest";
import {
  formatCost,
  aggregateByModel,
  aggregateByProvider,
} from "../components/views/AnalyticsView/CostPanel";
import type { SessionCost } from "../app/api/sessions/cost/route";

function makeCost(
  overrides: Partial<SessionCost> & {
    name: string;
    model?: string | null;
    costUsd?: number | null;
  }
): SessionCost {
  const { name, model, costUsd, ...rest } = overrides;
  return {
    name,
    model: model ?? null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: costUsd ?? null,
    contextTokens: 0,
    supported: true,
    ...rest,
  };
}

describe("formatCost", () => {
  it("formats zero as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(null)).toBe("$0.00");
    expect(formatCost(undefined)).toBe("$0.00");
  });

  it("shows <$0.01 for tiny positive amounts", () => {
    expect(formatCost(0.005)).toBe("<$0.01");
    expect(formatCost(0.009)).toBe("<$0.01");
  });

  it("formats normal amounts with two decimals", () => {
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(1234.5)).toBe("$1234.50");
  });
});

describe("aggregateByModel", () => {
  it("returns empty for empty input", () => {
    expect(aggregateByModel({})).toEqual([]);
  });

  it("ignores sessions with zero or null cost", () => {
    const sessions = {
      a: makeCost({ name: "a", model: "claude-3-5-sonnet", costUsd: 0 }),
      b: makeCost({ name: "b", model: "claude-3-5-sonnet", costUsd: null }),
    };
    expect(aggregateByModel(sessions)).toEqual([]);
  });

  it("groups by model and sums cost", () => {
    const sessions = {
      a: makeCost({ name: "a", model: "claude-3-5-sonnet", costUsd: 1.2 }),
      b: makeCost({ name: "b", model: "claude-3-5-sonnet", costUsd: 0.8 }),
      c: makeCost({ name: "c", model: "gpt-4o", costUsd: 2.5 }),
    };
    expect(aggregateByModel(sessions)).toEqual([
      { model: "gpt-4o", costUsd: 2.5, sessions: 1 },
      { model: "claude-3-5-sonnet", costUsd: 2.0, sessions: 2 },
    ]);
  });

  it("uses Unknown for null models", () => {
    const sessions = {
      a: makeCost({ name: "a", costUsd: 1.0 }),
    };
    expect(aggregateByModel(sessions)).toEqual([
      { model: "Unknown", costUsd: 1.0, sessions: 1 },
    ]);
  });
});

describe("aggregateByProvider", () => {
  it("extracts provider from the name prefix before —", () => {
    const sessions = {
      a: makeCost({
        name: "claude — fix bug",
        model: "claude-3-5-sonnet",
        costUsd: 1.0,
      }),
      b: makeCost({
        name: "claude — add test",
        model: "claude-3-5-sonnet",
        costUsd: 0.5,
      }),
      c: makeCost({ name: "codex — refactor", model: "gpt-4o", costUsd: 0.7 }),
    };
    expect(aggregateByProvider(sessions)).toEqual([
      { provider: "claude", costUsd: 1.5, sessions: 2 },
      { provider: "codex", costUsd: 0.7, sessions: 1 },
    ]);
  });

  it("falls back to model when name has no prefix", () => {
    const sessions = {
      a: makeCost({ name: "bare name", model: "gpt-4o", costUsd: 1.0 }),
    };
    expect(aggregateByProvider(sessions)).toEqual([
      { provider: "gpt-4o", costUsd: 1.0, sessions: 1 },
    ]);
  });

  it("falls back to Unknown when neither prefix nor model exists", () => {
    const sessions = {
      a: makeCost({ name: "bare name", costUsd: 1.0 }),
    };
    expect(aggregateByProvider(sessions)).toEqual([
      { provider: "Unknown", costUsd: 1.0, sessions: 1 },
    ]);
  });
});
