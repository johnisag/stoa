/**
 * Smart cost alerts — budget threshold evaluation and notification generation.
 *
 * Evaluates fleet cost data against user-configured budget thresholds and
 * produces actionable alerts. Pure functions → unit-tested. The server-side
 * tick calls evaluateAlerts and dispatches via Web Push / Slack / Discord.
 */

export type AlertSeverity = "info" | "warn" | "critical";

export interface CostAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  /** The threshold that was crossed (USD), if applicable. */
  thresholdUsd: number | null;
  /** The actual value that triggered the alert. */
  actualUsd: number;
  /** ISO timestamp when the alert was generated. */
  timestamp: string;
}

export interface BudgetThresholds {
  /** Warn when fleet spend exceeds this (USD). null = disabled. */
  warnUsd: number | null;
  /** Critical when fleet spend exceeds this (USD). null = disabled. */
  criticalUsd: number | null;
  /** Warn when a single session exceeds this (USD). null = disabled. */
  perSessionWarnUsd: number | null;
  /** Daily spend alert threshold (USD). null = disabled. */
  dailyWarnUsd: number | null;
}

/** Default thresholds (all disabled — opt-in by the operator). */
export const DEFAULT_THRESHOLDS: BudgetThresholds = {
  warnUsd: null,
  criticalUsd: null,
  perSessionWarnUsd: null,
  dailyWarnUsd: null,
};

/**
 * Evaluate fleet cost data against budget thresholds. Returns alerts for every
 * crossed threshold. Pure → unit-testable.
 */
export function evaluateAlerts(input: {
  totalFleetUsd: number;
  dailySpendUsd: number;
  maxSessionCostUsd: number;
  thresholds: BudgetThresholds;
}): CostAlert[] {
  const alerts: CostAlert[] = [];
  const now = new Date().toISOString();
  const { totalFleetUsd, dailySpendUsd, maxSessionCostUsd, thresholds } = input;

  // Validate inputs defensively.
  const fleet = Number.isFinite(totalFleetUsd) ? totalFleetUsd : 0;
  const daily = Number.isFinite(dailySpendUsd) ? dailySpendUsd : 0;
  const maxSession = Number.isFinite(maxSessionCostUsd) ? maxSessionCostUsd : 0;

  // Critical fleet threshold.
  if (
    thresholds.criticalUsd != null &&
    thresholds.criticalUsd > 0 &&
    fleet >= thresholds.criticalUsd
  ) {
    alerts.push({
      id: "fleet-critical",
      severity: "critical",
      title: "Fleet spend exceeded critical threshold",
      message: `Fleet spend ($${fleet.toFixed(2)}) exceeded the critical budget threshold ($${thresholds.criticalUsd.toFixed(2)}). Consider pausing expensive sessions.`,
      thresholdUsd: thresholds.criticalUsd,
      actualUsd: fleet,
      timestamp: now,
    });
  }

  // Warning fleet threshold (only if critical hasn't already fired).
  if (
    thresholds.warnUsd != null &&
    thresholds.warnUsd > 0 &&
    fleet >= thresholds.warnUsd &&
    (thresholds.criticalUsd == null || fleet < thresholds.criticalUsd)
  ) {
    alerts.push({
      id: "fleet-warn",
      severity: "warn",
      title: "Fleet spend exceeded warning threshold",
      message: `Fleet spend ($${fleet.toFixed(2)}) crossed the warning threshold ($${thresholds.warnUsd.toFixed(2)}).`,
      thresholdUsd: thresholds.warnUsd,
      actualUsd: fleet,
      timestamp: now,
    });
  }

  // Per-session threshold.
  if (
    thresholds.perSessionWarnUsd != null &&
    thresholds.perSessionWarnUsd > 0 &&
    maxSession >= thresholds.perSessionWarnUsd
  ) {
    alerts.push({
      id: "session-warn",
      severity: "warn",
      title: "A session exceeded the per-session cost threshold",
      message: `The most expensive session ($${maxSession.toFixed(2)}) crossed the per-session threshold ($${thresholds.perSessionWarnUsd.toFixed(2)}).`,
      thresholdUsd: thresholds.perSessionWarnUsd,
      actualUsd: maxSession,
      timestamp: now,
    });
  }

  // Daily spend threshold.
  if (
    thresholds.dailyWarnUsd != null &&
    thresholds.dailyWarnUsd > 0 &&
    daily >= thresholds.dailyWarnUsd
  ) {
    alerts.push({
      id: "daily-warn",
      severity: "warn",
      title: "Daily spend exceeded threshold",
      message: `Today's spend ($${daily.toFixed(2)}) crossed the daily threshold ($${thresholds.dailyWarnUsd.toFixed(2)}).`,
      thresholdUsd: thresholds.dailyWarnUsd,
      actualUsd: daily,
      timestamp: now,
    });
  }

  return alerts;
}
