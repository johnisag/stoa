import { computeCostUsd, type TokenUsage } from "../pricing";

export type FleetCostConfidence = "high" | "medium" | "low" | "unknown";
export type FleetBudgetStopMode = "pause-new" | "hard-stop" | "ask-operator";

export type FleetBudgetStopAction =
  "none" | "pause-new" | "interrupt-active" | "ask-operator";

export interface FleetBudgetConfig {
  budgetUsd: number | null;
  budgetTokens: number | null;
  warningThreshold: number;
  stopMode: FleetBudgetStopMode;
}

export interface FleetBudgetLedger {
  spentUsd: number;
  reservedUsd: number;
  spentTokens: number;
  reservedTokens: number;
}

export interface FleetReservationHistorySample {
  provider: string;
  model: string | null;
  taskType: string;
  actualUsd: number | null;
  actualTokens: number | null;
}

export interface FleetTaskReservation {
  usd: number;
  tokens: number;
  confidence: FleetCostConfidence;
  basis:
    | "exact-history"
    | "provider-task-history"
    | "provider-history"
    | "priced-model"
    | "provider-default"
    | "unknown-provider";
  sampleCount: number;
}

export interface FleetPlanReservationSession {
  provider: string;
  model: string | null;
  taskType: string;
  count: number;
}

export interface FleetPlanReservationEstimate {
  usd: number | null;
  tokens: number | null;
  confidence: FleetCostConfidence;
  sessionCount: number;
  capped: boolean;
}

export interface FleetSessionCostSample {
  session_key: string;
  session_id: string;
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  updated_at?: string;
}

export interface FleetWorkerActualCost {
  costUsd: number | null;
  tokens: number | null;
  confidence: FleetCostConfidence;
  sampleCount: number;
}

export interface FleetCostWatermark {
  peakInputTokens: number;
  peakOutputTokens: number;
  peakCacheReadTokens: number;
  peakCacheWriteTokens: number;
  observedCostUsd: number | null;
  fallbackCostUsd: number;
  chargedCostUsd: number;
  fallbackTokens: number;
  chargedTokens: number;
  confidence: FleetCostConfidence;
}

export interface FleetCostWatermarkAdvance {
  watermark: FleetCostWatermark;
  chargedUsdDelta: number;
  chargedTokensDelta: number;
}

export interface FleetBudgetDecision {
  allowed: boolean;
  warning: boolean;
  hardLimitReached: boolean;
  stopAction: FleetBudgetStopAction;
  reason: "ok" | "low-confidence" | "usd-budget" | "token-budget";
  projectedUsd: number;
  projectedTokens: number;
}

const MAX_HISTORY_SAMPLES = 256;
const MAX_RESERVATION_USD = 10_000;
const MAX_RESERVATION_TOKENS = 1_000_000_000;
const MAX_PLAN_RESERVATION_SESSIONS = 1_024;
const MAX_PLAN_RESERVATION_USD = 1_000_000_000;
const MAX_PLAN_RESERVATION_TOKENS = 1_000_000_000_000;
const HISTORY_PADDING = 1.2;

const TRACKABLE_PROVIDERS = new Set(["claude", "codex"]);

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function bounded(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, value));
}

function taskTokenBaseline(taskType: string): number {
  switch (taskType.trim().toLowerCase()) {
    case "review":
    case "explore":
    case "planning":
    case "scope":
      return 80_000;
    case "verification":
    case "verify":
      return 60_000;
    case "fix":
      return 180_000;
    default:
      return 240_000;
  }
}

function conservativeTokenUsage(total: number): TokenUsage {
  return {
    input: Math.ceil(total * 0.35),
    output: Math.ceil(total * 0.2),
    cacheRead: Math.ceil(total * 0.35),
    cacheWrite: Math.ceil(total * 0.1),
  };
}

function percentile90(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)] ?? null;
}

function normalizedModel(model: string | null): string | null {
  const value = model?.trim().toLowerCase();
  return value ? value : null;
}

function matchingHistory(
  history: readonly FleetReservationHistorySample[],
  predicate: (sample: FleetReservationHistorySample) => boolean
): FleetReservationHistorySample[] {
  return history.slice(-MAX_HISTORY_SAMPLES).filter((sample) => {
    if (!predicate(sample)) return false;
    return (
      finiteNonNegative(sample.actualUsd) != null ||
      finiteNonNegative(sample.actualTokens) != null
    );
  });
}

/**
 * Produce a conservative, explicit-confidence reservation. History is preferred
 * in decreasing specificity; the fallback uses a task token envelope and the
 * shared pricing table when the model is priced.
 */
export function estimateFleetTaskReservation(input: {
  provider: string;
  model: string | null;
  taskType: string;
  history?: readonly FleetReservationHistorySample[];
}): FleetTaskReservation {
  const provider = input.provider.trim().toLowerCase();
  const model = normalizedModel(input.model);
  const taskType = input.taskType.trim().toLowerCase();
  const history = input.history ?? [];
  const exact = matchingHistory(
    history,
    (sample) =>
      sample.provider.trim().toLowerCase() === provider &&
      normalizedModel(sample.model) === model &&
      sample.taskType.trim().toLowerCase() === taskType
  );
  const providerTask = matchingHistory(
    history,
    (sample) =>
      sample.provider.trim().toLowerCase() === provider &&
      sample.taskType.trim().toLowerCase() === taskType
  );
  const providerHistory = matchingHistory(
    history,
    (sample) => sample.provider.trim().toLowerCase() === provider
  );

  let samples: FleetReservationHistorySample[] = [];
  let basis: FleetTaskReservation["basis"];
  let confidence: FleetCostConfidence;
  if (exact.length >= 2) {
    samples = exact;
    basis = "exact-history";
    confidence = exact.length >= 5 ? "high" : "medium";
  } else if (providerTask.length >= 3) {
    samples = providerTask;
    basis = "provider-task-history";
    confidence = "medium";
  } else if (providerHistory.length > 0) {
    samples = providerHistory;
    basis = "provider-history";
    confidence = "low";
  } else {
    basis = TRACKABLE_PROVIDERS.has(provider)
      ? "provider-default"
      : "unknown-provider";
    confidence = TRACKABLE_PROVIDERS.has(provider) ? "low" : "unknown";
  }

  const baselineTokens = taskTokenBaseline(taskType);
  const historyTokens = percentile90(
    samples
      .map((sample) => finiteNonNegative(sample.actualTokens))
      .filter((value): value is number => value != null)
  );
  const tokens = Math.ceil(
    bounded(
      Math.max(
        baselineTokens,
        historyTokens == null ? 0 : historyTokens * HISTORY_PADDING
      ),
      MAX_RESERVATION_TOKENS
    )
  );

  const pricedUsd = computeCostUsd(conservativeTokenUsage(tokens), model);
  if (samples.length === 0 && pricedUsd != null) {
    basis = "priced-model";
    confidence = "medium";
  }
  const historyUsd = percentile90(
    samples
      .map((sample) => finiteNonNegative(sample.actualUsd))
      .filter((value): value is number => value != null)
  );
  const providerFallback =
    provider === "claude" ? 0.5 : provider === "codex" ? 0.25 : 0.35;
  const usd = bounded(
    Math.max(
      pricedUsd == null ? providerFallback : pricedUsd * HISTORY_PADDING,
      historyUsd == null ? 0 : historyUsd * HISTORY_PADDING
    ),
    MAX_RESERVATION_USD
  );

  return {
    usd: Math.ceil(usd * 1_000_000) / 1_000_000,
    tokens,
    confidence,
    basis,
    sampleCount: samples.length,
  };
}

/**
 * Sum a bounded set of future Fleet sessions using the same conservative
 * reservation used at launch time. `null`, rather than a precise-looking zero,
 * represents a plan with no estimable future paid session yet.
 */
export function estimateFleetPlanReservation(input: {
  sessions: readonly FleetPlanReservationSession[];
  history?: readonly FleetReservationHistorySample[];
}): FleetPlanReservationEstimate {
  const confidenceRank: Record<FleetCostConfidence, number> = {
    unknown: 0,
    low: 1,
    medium: 2,
    high: 3,
  };
  let sessionCount = 0;
  let usd = 0;
  let tokens = 0;
  let confidence: FleetCostConfidence = "high";
  let capped = false;
  for (const session of input.sessions) {
    if (
      !Number.isSafeInteger(session.count) ||
      session.count <= 0 ||
      sessionCount >= MAX_PLAN_RESERVATION_SESSIONS
    ) {
      if (session.count > 0) capped = true;
      continue;
    }
    const count = Math.min(
      session.count,
      MAX_PLAN_RESERVATION_SESSIONS - sessionCount
    );
    if (count < session.count) capped = true;
    const reservation = estimateFleetTaskReservation({
      provider: session.provider,
      model: session.model,
      taskType: session.taskType,
      history: input.history,
    });
    sessionCount += count;
    usd += reservation.usd * count;
    tokens += reservation.tokens * count;
    if (confidenceRank[reservation.confidence] < confidenceRank[confidence]) {
      confidence = reservation.confidence;
    }
  }
  if (sessionCount === 0) {
    return {
      usd: null,
      tokens: null,
      confidence: "unknown",
      sessionCount: 0,
      capped,
    };
  }
  if (usd > MAX_PLAN_RESERVATION_USD) capped = true;
  if (tokens > MAX_PLAN_RESERVATION_TOKENS) capped = true;
  return {
    usd:
      Math.ceil(Math.min(usd, MAX_PLAN_RESERVATION_USD) * 1_000_000) /
      1_000_000,
    tokens: Math.ceil(Math.min(tokens, MAX_PLAN_RESERVATION_TOKENS)),
    confidence,
    sessionCount,
    capped,
  };
}

/**
 * Collapse cumulative daily samples into one worker total. Peaks are tracked per
 * token bucket and for USD, so multiple days or transient counter regressions
 * never double-count cumulative readings.
 */
export function reconcileFleetWorkerActualCost(
  rows: readonly FleetSessionCostSample[]
): FleetWorkerActualCost {
  if (rows.length === 0) {
    return {
      costUsd: null,
      tokens: null,
      confidence: "unknown",
      sampleCount: 0,
    };
  }
  const bySession = new Map<
    string,
    {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      costUsd: number | null;
    }
  >();
  for (const row of rows) {
    const key = row.session_id || row.session_key;
    const current = bySession.get(key) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
    };
    current.input = Math.max(
      current.input,
      finiteNonNegative(row.input_tokens) ?? 0
    );
    current.output = Math.max(
      current.output,
      finiteNonNegative(row.output_tokens) ?? 0
    );
    current.cacheRead = Math.max(
      current.cacheRead,
      finiteNonNegative(row.cache_read_tokens) ?? 0
    );
    current.cacheWrite = Math.max(
      current.cacheWrite,
      finiteNonNegative(row.cache_write_tokens) ?? 0
    );
    const cost = finiteNonNegative(row.cost_usd);
    if (cost != null) current.costUsd = Math.max(current.costUsd ?? 0, cost);
    bySession.set(key, current);
  }

  let tokens = 0;
  let costUsd = 0;
  let hasCost = false;
  for (const reading of bySession.values()) {
    tokens +=
      reading.input + reading.output + reading.cacheRead + reading.cacheWrite;
    if (reading.costUsd != null) {
      costUsd += reading.costUsd;
      hasCost = true;
    }
  }
  const hasTokens = tokens > 0;
  return {
    costUsd: hasCost ? costUsd : null,
    tokens: hasTokens ? tokens : null,
    confidence:
      hasCost && hasTokens ? "high" : hasCost || hasTokens ? "medium" : "low",
    sampleCount: rows.length,
  };
}

/**
 * Advance one durable cumulative watermark monotonically. Replays and transient
 * lower samples produce zero deltas; a terminal fallback is charged only once,
 * and a later observed peak adds only the amount above that fallback.
 */
export function advanceFleetCostWatermark(input: {
  previous?: Partial<FleetCostWatermark> | null;
  sample?: FleetSessionCostSample | null;
  terminalFallbackUsd?: number | null;
  terminalFallbackTokens?: number | null;
}): FleetCostWatermarkAdvance {
  const previous = input.previous ?? {};
  const previousChargedUsd = finiteNonNegative(previous.chargedCostUsd) ?? 0;
  const previousChargedTokens = finiteNonNegative(previous.chargedTokens) ?? 0;
  const sample = input.sample;
  const peakInputTokens = Math.max(
    finiteNonNegative(previous.peakInputTokens) ?? 0,
    finiteNonNegative(sample?.input_tokens) ?? 0
  );
  const peakOutputTokens = Math.max(
    finiteNonNegative(previous.peakOutputTokens) ?? 0,
    finiteNonNegative(sample?.output_tokens) ?? 0
  );
  const peakCacheReadTokens = Math.max(
    finiteNonNegative(previous.peakCacheReadTokens) ?? 0,
    finiteNonNegative(sample?.cache_read_tokens) ?? 0
  );
  const peakCacheWriteTokens = Math.max(
    finiteNonNegative(previous.peakCacheWriteTokens) ?? 0,
    finiteNonNegative(sample?.cache_write_tokens) ?? 0
  );
  const previousObserved = finiteNonNegative(previous.observedCostUsd);
  const sampleCost = finiteNonNegative(sample?.cost_usd);
  const observedCostUsd =
    previousObserved == null && sampleCost == null
      ? null
      : Math.max(previousObserved ?? 0, sampleCost ?? 0);
  const fallbackCostUsd = Math.max(
    finiteNonNegative(previous.fallbackCostUsd) ?? 0,
    finiteNonNegative(input.terminalFallbackUsd) ?? 0
  );
  const fallbackTokens = Math.max(
    finiteNonNegative(previous.fallbackTokens) ?? 0,
    finiteNonNegative(input.terminalFallbackTokens) ?? 0
  );
  const observedTokens =
    peakInputTokens +
    peakOutputTokens +
    peakCacheReadTokens +
    peakCacheWriteTokens;
  const chargedCostUsd = Math.max(
    previousChargedUsd,
    fallbackCostUsd,
    observedCostUsd ?? 0
  );
  const chargedTokens = Math.max(
    previousChargedTokens,
    fallbackTokens,
    observedTokens
  );
  const hasObservedCost = observedCostUsd != null;
  const hasObservedTokens = observedTokens > 0;
  const confidence: FleetCostConfidence =
    hasObservedCost && hasObservedTokens
      ? "high"
      : hasObservedCost || hasObservedTokens
        ? "medium"
        : fallbackCostUsd > 0 || fallbackTokens > 0
          ? "low"
          : "unknown";
  return {
    watermark: {
      peakInputTokens,
      peakOutputTokens,
      peakCacheReadTokens,
      peakCacheWriteTokens,
      observedCostUsd,
      fallbackCostUsd,
      chargedCostUsd,
      fallbackTokens,
      chargedTokens,
      confidence,
    },
    chargedUsdDelta: Math.max(0, chargedCostUsd - previousChargedUsd),
    chargedTokensDelta: Math.max(0, chargedTokens - previousChargedTokens),
  };
}

function stopAction(mode: FleetBudgetStopMode): FleetBudgetStopAction {
  if (mode === "hard-stop") return "interrupt-active";
  if (mode === "ask-operator") return "ask-operator";
  return "pause-new";
}

function confidenceIsSufficient(confidence: FleetCostConfidence): boolean {
  return confidence === "high" || confidence === "medium";
}

/** Evaluate a launch reservation or the current run ledger without side effects. */
export function evaluateFleetBudget(input: {
  config: FleetBudgetConfig;
  ledger: FleetBudgetLedger;
  reservation?: FleetTaskReservation;
}): FleetBudgetDecision {
  const reservation = input.reservation;
  const projectedUsd =
    input.ledger.spentUsd + input.ledger.reservedUsd + (reservation?.usd ?? 0);
  const projectedTokens =
    input.ledger.spentTokens +
    input.ledger.reservedTokens +
    (reservation?.tokens ?? 0);
  const hasBudget =
    input.config.budgetUsd != null || input.config.budgetTokens != null;
  if (
    reservation &&
    hasBudget &&
    input.config.stopMode === "hard-stop" &&
    !confidenceIsSufficient(reservation.confidence)
  ) {
    return {
      allowed: false,
      warning: true,
      hardLimitReached: false,
      stopAction: "pause-new",
      reason: "low-confidence",
      projectedUsd,
      projectedTokens,
    };
  }

  const usdExceeded =
    input.config.budgetUsd != null && projectedUsd > input.config.budgetUsd;
  const tokensExceeded =
    input.config.budgetTokens != null &&
    projectedTokens > input.config.budgetTokens;
  const hardLimitReached = usdExceeded || tokensExceeded;
  const warningAt = Math.min(1, Math.max(0.01, input.config.warningThreshold));
  const warning =
    hardLimitReached ||
    (input.config.budgetUsd != null &&
      projectedUsd >= input.config.budgetUsd * warningAt) ||
    (input.config.budgetTokens != null &&
      projectedTokens >= input.config.budgetTokens * warningAt);
  return {
    allowed: !hardLimitReached,
    warning,
    hardLimitReached,
    stopAction: hardLimitReached ? stopAction(input.config.stopMode) : "none",
    reason: usdExceeded ? "usd-budget" : tokensExceeded ? "token-budget" : "ok",
    projectedUsd,
    projectedTokens,
  };
}

/**
 * Settle one reservation exactly once at the persistence layer. Missing telemetry
 * charges the full conservative reservation; present telemetry charges the
 * observed cumulative peak and releases the unused portion.
 */
export function settleFleetReservation(input: {
  reservedUsd: number;
  reservedTokens: number;
  actual: FleetWorkerActualCost;
}): {
  chargedUsd: number;
  chargedTokens: number;
  releasedUsd: number;
  releasedTokens: number;
  confidence: FleetCostConfidence;
} {
  const reservedUsd = finiteNonNegative(input.reservedUsd) ?? 0;
  const reservedTokens = finiteNonNegative(input.reservedTokens) ?? 0;
  const chargedUsd = input.actual.costUsd ?? reservedUsd;
  const chargedTokens = input.actual.tokens ?? reservedTokens;
  return {
    chargedUsd,
    chargedTokens,
    releasedUsd: Math.max(0, reservedUsd - chargedUsd),
    releasedTokens: Math.max(0, reservedTokens - chargedTokens),
    confidence: input.actual.confidence,
  };
}
