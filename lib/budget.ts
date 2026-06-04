/**
 * Budget caps over the per-session cost estimate (lib/pricing + session-cost).
 * OPT-IN via env (default OFF → zero behavior change): a per-session soft cap
 * (alert) and hard cap (notify + stop the session before it keeps burning).
 * The decision logic is pure so it's unit-testable; server.ts gathers costs and
 * applies the actions (Web Push + the authoritative kill).
 */

export interface BudgetConfig {
  /** Per-session USD threshold for an alert, or null if unset. */
  softUsd: number | null;
  /** Per-session USD threshold to stop (kill) the session, or null if unset. */
  hardUsd: number | null;
}

export type BudgetLevel = "ok" | "soft" | "hard";

function parsePositive(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Read the caps from STOA_BUDGET_SOFT_USD / STOA_BUDGET_HARD_USD. */
export function getBudgetConfig(): BudgetConfig {
  return {
    softUsd: parsePositive(process.env.STOA_BUDGET_SOFT_USD),
    hardUsd: parsePositive(process.env.STOA_BUDGET_HARD_USD),
  };
}

/** Is any cap configured? (When false, the server arms no enforcement loop.) */
export function budgetEnabled(cfg: BudgetConfig): boolean {
  return cfg.softUsd !== null || cfg.hardUsd !== null;
}

/** A session's level vs the caps. Unpriced (null) cost → "ok" (can't enforce). */
export function evaluateBudget(
  costUsd: number | null,
  cfg: BudgetConfig
): BudgetLevel {
  if (costUsd === null) return "ok";
  if (cfg.hardUsd !== null && costUsd >= cfg.hardUsd) return "hard";
  if (cfg.softUsd !== null && costUsd >= cfg.softUsd) return "soft";
  return "ok";
}

export interface SessionCostLite {
  id: string;
  costUsd: number | null;
}

export interface BudgetBreach {
  id: string;
  level: "soft" | "hard";
  costUsd: number;
}

/**
 * Given the previously-acted level per session, decide what to do THIS pass:
 * notify only on a NEW escalation (ok→soft, ok→hard, soft→hard) so a sitting
 * over-budget session isn't re-pinged every tick; kill on a new hard breach.
 * Pure → unit-testable.
 */
export function detectBudgetBreaches(
  prevLevels: Map<string, BudgetLevel>,
  costs: SessionCostLite[],
  cfg: BudgetConfig
): { notify: BudgetBreach[]; kill: string[] } {
  const notify: BudgetBreach[] = [];
  const kill: string[] = [];
  for (const { id, costUsd } of costs) {
    const level = evaluateBudget(costUsd, cfg);
    const prev = prevLevels.get(id) ?? "ok";
    if (level === "hard" && prev !== "hard") {
      notify.push({ id, level: "hard", costUsd: costUsd as number });
      kill.push(id);
    } else if (level === "soft" && prev === "ok") {
      notify.push({ id, level: "soft", costUsd: costUsd as number });
    }
  }
  return { notify, kill };
}

/** Snapshot the current level per session (for the next pass's dedup). */
export function snapshotBudgetLevels(
  costs: SessionCostLite[],
  cfg: BudgetConfig
): Map<string, BudgetLevel> {
  return new Map(costs.map((c) => [c.id, evaluateBudget(c.costUsd, cfg)]));
}
