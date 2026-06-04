import { describe, it, expect } from "vitest";
import {
  evaluateBudget,
  budgetEnabled,
  detectBudgetBreaches,
  snapshotBudgetLevels,
  type BudgetConfig,
  type BudgetLevel,
} from "../lib/budget";

const CFG: BudgetConfig = { softUsd: 5, hardUsd: 20 };

describe("evaluateBudget", () => {
  it("classifies cost vs the caps", () => {
    expect(evaluateBudget(1, CFG)).toBe("ok");
    expect(evaluateBudget(5, CFG)).toBe("soft"); // at the threshold
    expect(evaluateBudget(19.99, CFG)).toBe("soft");
    expect(evaluateBudget(20, CFG)).toBe("hard");
    expect(evaluateBudget(100, CFG)).toBe("hard");
  });
  it("is 'ok' for an unpriced (null) cost — can't enforce what we can't price", () => {
    expect(evaluateBudget(null, CFG)).toBe("ok");
  });
  it("respects a soft-only or hard-only config", () => {
    expect(evaluateBudget(10, { softUsd: 5, hardUsd: null })).toBe("soft");
    expect(evaluateBudget(10, { softUsd: null, hardUsd: 8 })).toBe("hard");
    expect(evaluateBudget(10, { softUsd: null, hardUsd: null })).toBe("ok");
  });
});

describe("budgetEnabled", () => {
  it("true if any cap is set", () => {
    expect(budgetEnabled({ softUsd: 5, hardUsd: null })).toBe(true);
    expect(budgetEnabled({ softUsd: null, hardUsd: 9 })).toBe(true);
    expect(budgetEnabled({ softUsd: null, hardUsd: null })).toBe(false);
  });
});

describe("detectBudgetBreaches", () => {
  it("notifies once per NEW escalation; kills on a new hard breach", () => {
    const prev = new Map<string, BudgetLevel>([
      ["a", "ok"],
      ["b", "soft"], // already alerted
      ["c", "hard"], // already stopped
    ]);
    const costs = [
      { id: "a", costUsd: 6 }, // ok → soft  → notify
      { id: "b", costUsd: 25 }, // soft → hard → notify + kill
      { id: "c", costUsd: 30 }, // hard → hard → nothing (deduped)
      { id: "d", costUsd: 1 }, // ok → ok    → nothing
    ];
    const { notify, kill } = detectBudgetBreaches(prev, costs, CFG);
    expect(notify).toEqual([
      { id: "a", level: "soft", costUsd: 6 },
      { id: "b", level: "hard", costUsd: 25 },
    ]);
    expect(kill).toEqual(["b"]);
  });

  it("kills a session that jumps straight ok→hard in one pass", () => {
    const { notify, kill } = detectBudgetBreaches(
      new Map(),
      [{ id: "x", costUsd: 50 }],
      CFG
    );
    expect(notify).toEqual([{ id: "x", level: "hard", costUsd: 50 }]);
    expect(kill).toEqual(["x"]);
  });

  it("ignores unpriced sessions", () => {
    const { notify, kill } = detectBudgetBreaches(
      new Map(),
      [{ id: "x", costUsd: null }],
      CFG
    );
    expect(notify).toEqual([]);
    expect(kill).toEqual([]);
  });
});

describe("snapshotBudgetLevels", () => {
  it("captures the level per session for the next pass's dedup", () => {
    const snap = snapshotBudgetLevels(
      [
        { id: "a", costUsd: 1 },
        { id: "b", costUsd: 7 },
        { id: "c", costUsd: 50 },
      ],
      CFG
    );
    expect(snap.get("a")).toBe("ok");
    expect(snap.get("b")).toBe("soft");
    expect(snap.get("c")).toBe("hard");
  });
});
