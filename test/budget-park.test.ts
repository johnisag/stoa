import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  stageForBudget,
  decideBudgetActions,
  budgetParkEnabled,
  isBudgetParked,
  getBudgetStage,
  applyBudgetDecision,
  currentBudgetStages,
  currentParked,
  pruneBudgetState,
  _resetBudgetParkState,
  type CarriedStage,
} from "../lib/budget-park";

const sess = (id: string, budget: number | null) => ({
  id,
  name: id,
  budget_usd: budget,
});

const carried = (
  entries: Array<[string, CarriedStage]>
): Map<string, CarriedStage> => new Map(entries);

describe("stageForBudget", () => {
  it("classifies cost vs the budget with inclusive thresholds", () => {
    expect(stageForBudget(0, 10)).toBe("ok");
    expect(stageForBudget(7.99, 10)).toBe("ok");
    expect(stageForBudget(8, 10)).toBe("warn80"); // exactly 80%
    expect(stageForBudget(9.99, 10)).toBe("warn80");
    expect(stageForBudget(10, 10)).toBe("cap"); // exactly 100%
    expect(stageForBudget(25, 10)).toBe("cap");
  });

  it("is 'ok' when the budget is null/invalid — no budget, no restriction", () => {
    expect(stageForBudget(100, null)).toBe("ok");
    expect(stageForBudget(100, undefined)).toBe("ok");
    expect(stageForBudget(100, 0)).toBe("ok");
    expect(stageForBudget(100, -5)).toBe("ok");
    expect(stageForBudget(100, NaN)).toBe("ok");
    expect(stageForBudget(100, Infinity)).toBe("ok");
  });

  it("is 'ok' when the cost is null/invalid — can't enforce an unknown spend", () => {
    expect(stageForBudget(null, 10)).toBe("ok");
    expect(stageForBudget(undefined, 10)).toBe("ok");
    expect(stageForBudget(NaN, 10)).toBe("ok");
  });
});

describe("decideBudgetActions", () => {
  it("alerts once on escalation, never while sitting in a stage", () => {
    // Tick 1: fresh session crosses into warn80.
    const t1 = decideBudgetActions({
      sessions: [sess("a", 10)],
      costs: { a: { costUsd: 8.5 } },
      prevStages: new Map(),
      parked: new Set(),
      parkEnabled: false,
    });
    expect(t1.alert80).toEqual([
      { id: "a", name: "a", costUsd: 8.5, budgetUsd: 10 },
    ]);
    expect(t1.alert100).toEqual([]);
    expect(t1.nextStages.get("a")).toEqual({ stage: "warn80", budgetUsd: 10 });

    // Tick 2: still warn80 → silence (edge-triggered, not level-triggered).
    const t2 = decideBudgetActions({
      sessions: [sess("a", 10)],
      costs: { a: { costUsd: 9 } },
      prevStages: t1.nextStages,
      parked: new Set(),
      parkEnabled: false,
    });
    expect(t2.alert80).toEqual([]);
    expect(t2.alert100).toEqual([]);

    // Tick 3: escalates warn80 → cap → one alert100, no repeat alert80.
    const t3 = decideBudgetActions({
      sessions: [sess("a", 10)],
      costs: { a: { costUsd: 11 } },
      prevStages: t2.nextStages,
      parked: new Set(),
      parkEnabled: false,
    });
    expect(t3.alert80).toEqual([]);
    expect(t3.alert100).toEqual([
      { id: "a", name: "a", costUsd: 11, budgetUsd: 10 },
    ]);
  });

  it("alerts on a straight ok→cap jump (cost outran the tick)", () => {
    const d = decideBudgetActions({
      sessions: [sess("a", 10)],
      costs: { a: { costUsd: 50 } },
      prevStages: new Map(),
      parked: new Set(),
      parkEnabled: false,
    });
    expect(d.alert80).toEqual([]);
    expect(d.alert100).toEqual([
      { id: "a", name: "a", costUsd: 50, budgetUsd: 10 },
    ]);
  });

  it("RATCHET: a cost under-read with an UNCHANGED budget cannot lower the stage, unpark, or re-alert", () => {
    // Parked at cap; the cost reader transiently under-reads (cache hiccup,
    // /compact truncation) → raw stage would be "ok", but the ratchet holds.
    const prev = carried([["a", { stage: "cap", budgetUsd: 10 }]]);
    const t1 = decideBudgetActions({
      sessions: [sess("a", 10)],
      costs: { a: { costUsd: 3 } }, // noise: dipped under 80%
      prevStages: prev,
      parked: new Set(["a"]),
      parkEnabled: true,
    });
    expect(t1.unpark).toEqual([]); // still parked
    expect(t1.park).toEqual([]);
    expect(t1.alert80).toEqual([]);
    expect(t1.alert100).toEqual([]);
    expect(t1.nextStages.get("a")).toEqual({ stage: "cap", budgetUsd: 10 });

    // Cost recovers to its true value → still no re-alert (no escalation).
    const t2 = decideBudgetActions({
      sessions: [sess("a", 10)],
      costs: { a: { costUsd: 11 } },
      prevStages: t1.nextStages,
      parked: new Set(["a"]),
      parkEnabled: true,
    });
    expect(t2.alert100).toEqual([]);
    expect(t2.unpark).toEqual([]);
    expect(t2.park).toEqual([]);
  });

  it("RATCHET: a missing cost read this tick keeps a parked session parked", () => {
    const d = decideBudgetActions({
      sessions: [sess("a", 10)],
      costs: {}, // cost reader returned nothing this tick
      prevStages: carried([["a", { stage: "cap", budgetUsd: 10 }]]),
      parked: new Set(["a"]),
      parkEnabled: true,
    });
    expect(d.unpark).toEqual([]);
    expect(d.nextStages.get("a")).toEqual({ stage: "cap", budgetUsd: 10 });
  });

  it("changing the budget RE-BASES the ratchet: raise unparks, a later climb re-alerts as a fresh edge", () => {
    // Sitting parked at cap on a $10 budget; user raises it to $100.
    const t1 = decideBudgetActions({
      sessions: [sess("a", 100)],
      costs: { a: { costUsd: 11 } },
      prevStages: carried([["a", { stage: "cap", budgetUsd: 10 }]]),
      parked: new Set(["a"]),
      parkEnabled: true,
    });
    expect(t1.unpark).toEqual(["a"]);
    expect(t1.alert80).toEqual([]);
    expect(t1.alert100).toEqual([]);
    expect(t1.nextStages.has("a")).toBe(false); // ok stages aren't carried

    // Costs climb over 80% of the NEW budget → alerts again (fresh edge).
    const t2 = decideBudgetActions({
      sessions: [sess("a", 100)],
      costs: { a: { costUsd: 85 } },
      prevStages: t1.nextStages,
      parked: new Set(),
      parkEnabled: true,
    });
    expect(t2.alert80).toHaveLength(1);
  });

  it("a small budget raise that lands in warn80 unparks WITHOUT alerting (no escalation)", () => {
    const d = decideBudgetActions({
      sessions: [sess("a", 12)], // raised 10 → 12; cost 10.5 = 87.5%
      costs: { a: { costUsd: 10.5 } },
      prevStages: carried([["a", { stage: "cap", budgetUsd: 10 }]]),
      parked: new Set(["a"]),
      parkEnabled: true,
    });
    expect(d.unpark).toEqual(["a"]);
    expect(d.alert80).toEqual([]); // cap→warn80 is a de-escalation
    expect(d.alert100).toEqual([]);
    expect(d.nextStages.get("a")).toEqual({ stage: "warn80", budgetUsd: 12 });
  });

  it("unparks a parked session whose budget was CLEARED entirely (whole-fleet input)", () => {
    const d = decideBudgetActions({
      sessions: [sess("a", null)],
      costs: {},
      prevStages: carried([["a", { stage: "cap", budgetUsd: 10 }]]),
      parked: new Set(["a"]),
      parkEnabled: true,
    });
    expect(d.unpark).toEqual(["a"]);
    expect(d.nextStages.has("a")).toBe(false);
  });

  it("parks at cap only when the opt-in is armed", () => {
    const input = {
      sessions: [sess("a", 10)],
      costs: { a: { costUsd: 12 } },
      prevStages: new Map<string, CarriedStage>(),
      parked: new Set<string>(),
    };
    expect(decideBudgetActions({ ...input, parkEnabled: false }).park).toEqual(
      []
    );
    expect(decideBudgetActions({ ...input, parkEnabled: true }).park).toEqual([
      "a",
    ]);
  });

  it("does not re-park an already-parked session, still alerts nobody while sitting", () => {
    const d = decideBudgetActions({
      sessions: [sess("a", 10)],
      costs: { a: { costUsd: 12 } },
      prevStages: carried([["a", { stage: "cap", budgetUsd: 10 }]]),
      parked: new Set(["a"]),
      parkEnabled: true,
    });
    expect(d.park).toEqual([]);
    expect(d.unpark).toEqual([]);
    expect(d.alert100).toEqual([]);
  });

  it("handles a mixed fleet in one pass", () => {
    const d = decideBudgetActions({
      sessions: [sess("a", 10), sess("b", 10), sess("c", 10), sess("d", null)],
      costs: {
        a: { costUsd: 9 }, // ok → warn80: alert
        b: { costUsd: 15 }, // ok → cap: alert + park
        c: { costUsd: 1 }, // ok → ok: nothing
        d: { costUsd: 999 }, // no budget: nothing
      },
      prevStages: new Map(),
      parked: new Set(),
      parkEnabled: true,
    });
    expect(d.alert80.map((a) => a.id)).toEqual(["a"]);
    expect(d.alert100.map((a) => a.id)).toEqual(["b"]);
    expect(d.park).toEqual(["b"]);
    expect(d.unpark).toEqual([]);
    expect(d.nextStages.get("a")?.stage).toBe("warn80");
    expect(d.nextStages.get("b")?.stage).toBe("cap");
    expect(d.nextStages.has("c")).toBe(false);
    expect(d.nextStages.has("d")).toBe(false);
  });
});

describe("budgetParkEnabled", () => {
  const orig = process.env.STOA_BUDGET_PARK;
  afterEach(() => {
    if (orig === undefined) delete process.env.STOA_BUDGET_PARK;
    else process.env.STOA_BUDGET_PARK = orig;
  });

  it("is opt-in: only '1' arms it", () => {
    delete process.env.STOA_BUDGET_PARK;
    expect(budgetParkEnabled()).toBe(false);
    process.env.STOA_BUDGET_PARK = "0";
    expect(budgetParkEnabled()).toBe(false);
    process.env.STOA_BUDGET_PARK = "true";
    expect(budgetParkEnabled()).toBe(false);
    process.env.STOA_BUDGET_PARK = "1";
    expect(budgetParkEnabled()).toBe(true);
  });
});

describe("module state lifecycle (applyBudgetDecision / prune / reset)", () => {
  beforeEach(() => _resetBudgetParkState());
  afterEach(() => _resetBudgetParkState());

  it("apply → read: park set + stages become visible to consumers", () => {
    const d = decideBudgetActions({
      sessions: [sess("a", 10), sess("b", 10)],
      costs: { a: { costUsd: 12 }, b: { costUsd: 8.5 } },
      prevStages: currentBudgetStages(),
      parked: currentParked(),
      parkEnabled: true,
    });
    applyBudgetDecision(d);
    expect(isBudgetParked("a")).toBe(true);
    expect(isBudgetParked("b")).toBe(false);
    expect(getBudgetStage("a")).toBe("cap");
    expect(getBudgetStage("b")).toBe("warn80");
    expect(getBudgetStage("nope")).toBe("ok");
  });

  it("a full park → raise-budget → unpark round-trip through the real state", () => {
    // Tick 1: cap → parked.
    applyBudgetDecision(
      decideBudgetActions({
        sessions: [sess("a", 10)],
        costs: { a: { costUsd: 12 } },
        prevStages: currentBudgetStages(),
        parked: currentParked(),
        parkEnabled: true,
      })
    );
    expect(isBudgetParked("a")).toBe(true);

    // Tick 2: user raises the budget → unparked, stage drops.
    applyBudgetDecision(
      decideBudgetActions({
        sessions: [sess("a", 100)],
        costs: { a: { costUsd: 12 } },
        prevStages: currentBudgetStages(),
        parked: currentParked(),
        parkEnabled: true,
      })
    );
    expect(isBudgetParked("a")).toBe(false);
    expect(getBudgetStage("a")).toBe("ok");
  });

  it("pruneBudgetState drops deleted sessions from both maps", () => {
    applyBudgetDecision(
      decideBudgetActions({
        sessions: [sess("dead", 10), sess("live", 10)],
        costs: { dead: { costUsd: 12 }, live: { costUsd: 12 } },
        prevStages: currentBudgetStages(),
        parked: currentParked(),
        parkEnabled: true,
      })
    );
    expect(isBudgetParked("dead")).toBe(true);
    pruneBudgetState(new Set(["live"]));
    expect(isBudgetParked("dead")).toBe(false);
    expect(getBudgetStage("dead")).toBe("ok");
    expect(isBudgetParked("live")).toBe(true);
    expect(getBudgetStage("live")).toBe("cap");
  });
});
