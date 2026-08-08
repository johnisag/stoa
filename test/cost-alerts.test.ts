import { describe, it, expect } from "vitest";
import { evaluateAlerts, type BudgetThresholds } from "../lib/cost-alerts";

const NO_THRESHOLDS: BudgetThresholds = {
  warnUsd: null,
  criticalUsd: null,
  perSessionWarnUsd: null,
  dailyWarnUsd: null,
};

describe("evaluateAlerts", () => {
  it("returns no alerts when all thresholds are null", () => {
    expect(
      evaluateAlerts({
        totalFleetUsd: 100,
        dailySpendUsd: 50,
        maxSessionCostUsd: 20,
        thresholds: NO_THRESHOLDS,
      })
    ).toEqual([]);
  });

  it("fires a warn alert when fleet spend crosses the warning threshold", () => {
    const alerts = evaluateAlerts({
      totalFleetUsd: 15,
      dailySpendUsd: 0,
      maxSessionCostUsd: 0,
      thresholds: { ...NO_THRESHOLDS, warnUsd: 10 },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warn");
    expect(alerts[0].id).toBe("fleet-warn");
  });

  it("fires a critical alert when fleet spend crosses the critical threshold", () => {
    const alerts = evaluateAlerts({
      totalFleetUsd: 25,
      dailySpendUsd: 0,
      maxSessionCostUsd: 0,
      thresholds: { ...NO_THRESHOLDS, warnUsd: 10, criticalUsd: 20 },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].id).toBe("fleet-critical");
  });

  it("does NOT fire warn when critical already fired", () => {
    const alerts = evaluateAlerts({
      totalFleetUsd: 25,
      dailySpendUsd: 0,
      maxSessionCostUsd: 0,
      thresholds: { ...NO_THRESHOLDS, warnUsd: 10, criticalUsd: 20 },
    });
    const warnAlert = alerts.find((a) => a.id === "fleet-warn");
    expect(warnAlert).toBeUndefined();
  });

  it("fires per-session alert when a session crosses the threshold", () => {
    const alerts = evaluateAlerts({
      totalFleetUsd: 0,
      dailySpendUsd: 0,
      maxSessionCostUsd: 5,
      thresholds: { ...NO_THRESHOLDS, perSessionWarnUsd: 3 },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe("session-warn");
  });

  it("fires daily alert when daily spend crosses the threshold", () => {
    const alerts = evaluateAlerts({
      totalFleetUsd: 0,
      dailySpendUsd: 8,
      maxSessionCostUsd: 0,
      thresholds: { ...NO_THRESHOLDS, dailyWarnUsd: 5 },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe("daily-warn");
  });

  it("fires multiple alerts when multiple thresholds are crossed", () => {
    const alerts = evaluateAlerts({
      totalFleetUsd: 25,
      dailySpendUsd: 8,
      maxSessionCostUsd: 5,
      thresholds: {
        warnUsd: 10,
        criticalUsd: null,
        perSessionWarnUsd: 3,
        dailyWarnUsd: 5,
      },
    });
    expect(alerts).toHaveLength(3);
  });

  it("handles NaN and Infinity defensively", () => {
    expect(
      evaluateAlerts({
        totalFleetUsd: Number.NaN,
        dailySpendUsd: Number.POSITIVE_INFINITY,
        maxSessionCostUsd: -1,
        thresholds: { ...NO_THRESHOLDS, warnUsd: 10 },
      })
    ).toEqual([]);
  });

  it("does not fire when threshold is 0 or negative", () => {
    const alerts = evaluateAlerts({
      totalFleetUsd: 100,
      dailySpendUsd: 100,
      maxSessionCostUsd: 100,
      thresholds: {
        warnUsd: 0,
        criticalUsd: -1,
        perSessionWarnUsd: 0,
        dailyWarnUsd: null,
      },
    });
    expect(alerts).toEqual([]);
  });
});
