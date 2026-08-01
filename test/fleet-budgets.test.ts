import { describe, expect, it } from "vitest";
import {
  estimateFleetTaskReservation,
  evaluateFleetBudget,
  reconcileFleetWorkerActualCost,
  settleFleetReservation,
  type FleetReservationHistorySample,
  type FleetSessionCostSample,
} from "@/lib/fleet/budgets";

function sample(
  day: string,
  costUsd: number | null,
  tokens: number
): FleetSessionCostSample {
  return {
    session_key: "codex-session-1",
    session_id: "session-1",
    day,
    input_tokens: tokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: costUsd,
  };
}

describe("Fleet budgets", () => {
  it("uses exact history conservatively and reports explicit confidence", () => {
    const history: FleetReservationHistorySample[] = Array.from(
      { length: 5 },
      (_, index) => ({
        provider: "codex",
        model: "gpt-5.4",
        taskType: "implementation",
        actualUsd: 1 + index * 0.1,
        actualTokens: 250_000 + index * 10_000,
      })
    );
    const estimate = estimateFleetTaskReservation({
      provider: "codex",
      model: "gpt-5.4",
      taskType: "implementation",
      history,
    });
    expect(estimate).toMatchObject({
      basis: "exact-history",
      confidence: "high",
      sampleCount: 5,
    });
    expect(estimate.usd).toBeGreaterThanOrEqual(1.4 * 1.2);
    expect(estimate.tokens).toBeGreaterThanOrEqual(290_000 * 1.2);
  });

  it("uses priced models at medium confidence and unknown providers fail closed", () => {
    expect(
      estimateFleetTaskReservation({
        provider: "codex",
        model: "gpt-5.4",
        taskType: "review",
      })
    ).toMatchObject({ basis: "priced-model", confidence: "medium" });
    const unknown = estimateFleetTaskReservation({
      provider: "new-provider",
      model: "unpriced-model",
      taskType: "implementation",
    });
    expect(unknown).toMatchObject({
      basis: "unknown-provider",
      confidence: "unknown",
    });
    expect(
      evaluateFleetBudget({
        config: {
          budgetUsd: 10,
          budgetTokens: null,
          warningThreshold: 0.8,
          stopMode: "hard-stop",
        },
        ledger: {
          spentUsd: 0,
          reservedUsd: 0,
          spentTokens: 0,
          reservedTokens: 0,
        },
        reservation: unknown,
      })
    ).toMatchObject({
      allowed: false,
      reason: "low-confidence",
      stopAction: "pause-new",
    });
  });

  it("does not double-count cumulative session samples across days or dips", () => {
    const actual = reconcileFleetWorkerActualCost([
      sample("2026-07-30", 0.1, 100),
      sample("2026-07-31", 0.2, 200),
      sample("2026-08-01", 0.15, 150),
    ]);
    expect(actual).toEqual({
      costUsd: 0.2,
      tokens: 200,
      confidence: "high",
      sampleCount: 3,
    });
  });

  it("keeps token-only telemetry and charges the reservation for missing USD", () => {
    const actual = reconcileFleetWorkerActualCost([
      sample("2026-08-01", null, 50_000),
    ]);
    expect(actual).toMatchObject({
      costUsd: null,
      tokens: 50_000,
      confidence: "medium",
    });
    expect(
      settleFleetReservation({
        reservedUsd: 1,
        reservedTokens: 100_000,
        actual,
      })
    ).toEqual({
      chargedUsd: 1,
      chargedTokens: 50_000,
      releasedUsd: 0,
      releasedTokens: 50_000,
      confidence: "medium",
    });
  });

  it("warns before a limit and maps hard limits to each stop mode", () => {
    const ledger = {
      spentUsd: 7.9,
      reservedUsd: 0,
      spentTokens: 0,
      reservedTokens: 0,
    };
    const reservation = {
      usd: 0.2,
      tokens: 10,
      confidence: "high" as const,
      basis: "exact-history" as const,
      sampleCount: 5,
    };
    expect(
      evaluateFleetBudget({
        config: {
          budgetUsd: 10,
          budgetTokens: null,
          warningThreshold: 0.8,
          stopMode: "pause-new",
        },
        ledger,
        reservation,
      })
    ).toMatchObject({ allowed: true, warning: true, stopAction: "none" });

    for (const [stopMode, stopAction] of [
      ["pause-new", "pause-new"],
      ["hard-stop", "interrupt-active"],
      ["ask-operator", "ask-operator"],
    ] as const) {
      expect(
        evaluateFleetBudget({
          config: {
            budgetUsd: 8,
            budgetTokens: null,
            warningThreshold: 0.8,
            stopMode,
          },
          ledger,
          reservation,
        })
      ).toMatchObject({
        allowed: false,
        warning: true,
        hardLimitReached: true,
        stopAction,
        reason: "usd-budget",
      });
    }
  });

  it("enforces token budgets independently of USD", () => {
    const reservation = estimateFleetTaskReservation({
      provider: "codex",
      model: "gpt-5.4",
      taskType: "implementation",
    });
    expect(
      evaluateFleetBudget({
        config: {
          budgetUsd: null,
          budgetTokens: 100_000,
          warningThreshold: 0.8,
          stopMode: "pause-new",
        },
        ledger: {
          spentUsd: 0,
          reservedUsd: 0,
          spentTokens: 0,
          reservedTokens: 0,
        },
        reservation,
      })
    ).toMatchObject({ allowed: false, reason: "token-budget" });
  });
});
