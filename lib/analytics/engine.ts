/**
 * Analytics engine — PURE computation over a normalized snapshot.
 *
 * No DB, no I/O, no Date.now() (now is injected): every function here is a pure
 * data transform, so the whole Insight layer is exhaustively unit-testable. The
 * DB layer (queries.ts) gathers the snapshot; this turns it into a report.
 *
 * Statistical choices are deliberately conservative — this is an operator's
 * glanceable cockpit, not a research instrument: medians for skewed latencies,
 * simple least-squares slopes for trend direction, rule-based thresholds for
 * anomalies (explainable beats clever). Every rate guards its denominator and
 * returns null (rendered "—") rather than a misleading 0 or NaN.
 */

import type { AgentType } from "../providers";
import type { SessionEventType } from "../db/types";
import type {
  AnalyticsSnapshot,
  AnalyticsSession,
  AnalyticsEvent,
  PerformanceMetrics,
  BehaviouralMetrics,
  ProviderIntelligence,
  TrendPoint,
  TrendSummary,
  DetectedIssue,
  EventTypeCount,
  AnalyticsReport,
} from "./types";

const MS_PER_DAY = 86_400_000;
const INPUT_EVENT_TYPES: ReadonlySet<SessionEventType> =
  new Set<SessionEventType>([
    "input_text",
    "input_paste",
    "input_enter",
    "input_escape",
  ]);

// ── small statistics helpers (pure) ──────────────────────────────────────────

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : sum(xs) / xs.length;
}

/** Median of a numeric list (null when empty). Does not mutate the input. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** A rate a/b that returns null when b===0 (never NaN / divide-by-zero). */
function safeRate(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}

/**
 * Least-squares slope of points (i, ys[i]) — the per-step trend direction.
 * Returns null for fewer than 2 points (a slope needs a line). x is the index
 * (0,1,2,…) so the unit is "per day" when ys is a daily series.
 */
function linregSlope(ys: number[]): number | null {
  const n = ys.length;
  if (n < 2) return null;
  const xMean = (n - 1) / 2;
  const yMean = sum(ys) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? null : num / den;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** UTC calendar day (YYYY-MM-DD) for an epoch-ms instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ── per-session derived facts (shared by several lenses) ─────────────────────

interface SessionFacts {
  session: AnalyticsSession;
  events: AnalyticsEvent[];
  inputEvents: AnalyticsEvent[];
  firstEventAt: number | null;
  lastEventAt: number | null;
  firstInputAt: number | null;
}

/** Group events by session key and derive the timing facts each lens reuses. */
function deriveFacts(snapshot: AnalyticsSnapshot): SessionFacts[] {
  const byKey = new Map<string, AnalyticsEvent[]>();
  for (const e of snapshot.events) {
    const list = byKey.get(e.session_key);
    if (list) list.push(e);
    else byKey.set(e.session_key, [e]);
  }
  return snapshot.sessions.map((session) => {
    // Events arrive ordered by id (insertion = chronological), but sort
    // defensively on created_at so the timing math can't be fooled by a caller
    // that gathered them out of order.
    const events = (byKey.get(session.key) ?? [])
      .slice()
      .sort((a, b) => a.created_at - b.created_at);
    const inputEvents = events.filter((e) =>
      INPUT_EVENT_TYPES.has(e.event_type)
    );
    return {
      session,
      events,
      inputEvents,
      firstEventAt: events.length ? events[0].created_at : null,
      lastEventAt: events.length ? events[events.length - 1].created_at : null,
      firstInputAt: inputEvents.length ? inputEvents[0].created_at : null,
    };
  });
}

// ── 1. Performance lens ──────────────────────────────────────────────────────

export function computePerformance(facts: SessionFacts[]): PerformanceMetrics {
  const active = facts.filter((f) => f.events.length > 0);

  const durations: number[] = [];
  for (const f of active) {
    // create → last recorded event, floored at 0 (a clock skew can't go negative).
    if (f.lastEventAt != null) {
      durations.push(Math.max(0, f.lastEventAt - f.session.created_at) / 1000);
    }
  }

  const ttfi: number[] = [];
  for (const f of active) {
    if (f.firstInputAt != null) {
      ttfi.push(Math.max(0, f.firstInputAt - f.session.created_at) / 1000);
    }
  }

  const totalCostUsd = sum(facts.map((f) => f.session.costUsd ?? 0));
  const totalTokens = sum(facts.map((f) => f.session.totalTokens));
  const totalInputEvents = sum(facts.map((f) => f.inputEvents.length));

  const mergedPrCount = facts.filter((f) => f.session.prMerged).length;
  // Cost per merged PR divides the (Claude-only) cost by merges that ACTUALLY
  // carry a cost — mixing Claude-only cost over all-provider merges would
  // systematically understate it. Falls back to mergedPrCount when no merged
  // session has a cost yet (so the headline still shows merges exist).
  const costedMerges = facts.filter(
    (f) => f.session.prMerged && f.session.costUsd != null
  ).length;
  const costPerMergedPr = safeRate(totalCostUsd, costedMerges);

  // Reviewer pass rate over sessions with a decisive verdict.
  const approved = facts.filter(
    (f) => f.session.reviewDecision === "APPROVED"
  ).length;
  const changes = facts.filter(
    (f) => f.session.reviewDecision === "CHANGES_REQUESTED"
  ).length;
  const reviewedCount = approved + changes;

  // Median (not mean) for duration: session lengths are right-skewed — one
  // forgotten 6-hour session shouldn't blow up the "typical session" stat.
  const medDur = median(durations);
  const medTtfi = median(ttfi);

  return {
    sessionCount: facts.length,
    activeSessionCount: active.length,
    totalCostUsd: round(totalCostUsd, 4),
    totalTokens,
    totalInputEvents,
    medianSessionDurationSec: medDur == null ? null : round(medDur, 1),
    medianTimeToFirstInputSec: medTtfi == null ? null : round(medTtfi, 1),
    costPerMergedPr: costPerMergedPr == null ? null : round(costPerMergedPr, 4),
    mergedPrCount,
    reviewerPassRate:
      safeRate(approved, reviewedCount) == null
        ? null
        : round(approved / reviewedCount, 3),
    reviewedCount,
  };
}

// ── 2. Behavioural lens ──────────────────────────────────────────────────────

export function computeBehavioural(facts: SessionFacts[]): BehaviouralMetrics {
  const active = facts.filter((f) => f.events.length > 0);

  const mixMap = new Map<SessionEventType, number>();
  for (const f of facts) {
    for (const e of f.events) {
      mixMap.set(e.event_type, (mixMap.get(e.event_type) ?? 0) + 1);
    }
  }
  const eventMix: EventTypeCount[] = [...mixMap.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  const totalEvents = sum(facts.map((f) => f.events.length));
  const totalInputs = sum(facts.map((f) => f.inputEvents.length));
  const pasteCount = sum(
    facts.map(
      (f) => f.inputEvents.filter((e) => e.event_type === "input_paste").length
    )
  );

  // Mean seconds between consecutive inputs, averaged per session (sessions with
  // <2 inputs contribute no interval), then over sessions. Captures cadence
  // without letting one chatty session dominate a global gap list.
  const perSessionIntervals: number[] = [];
  for (const f of active) {
    const ins = f.inputEvents;
    if (ins.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < ins.length; i++) {
      gaps.push((ins[i].created_at - ins[i - 1].created_at) / 1000);
    }
    const m = mean(gaps);
    if (m != null) perSessionIntervals.push(m);
  }

  return {
    eventMix,
    avgEventsPerSession:
      active.length === 0 ? null : round(totalEvents / active.length, 1),
    avgInputsPerSession:
      active.length === 0 ? null : round(totalInputs / active.length, 1),
    avgInputIntervalSec: (() => {
      const m = mean(perSessionIntervals);
      return m == null ? null : round(m, 1);
    })(),
    emptySessionCount: facts.length - active.length,
    pasteRatio:
      safeRate(pasteCount, totalInputs) == null
        ? null
        : round(pasteCount / totalInputs, 3),
  };
}

// ── 3. Intelligence lens (per-provider, outcome-correlated) ──────────────────

export function computeIntelligence(
  facts: SessionFacts[]
): ProviderIntelligence[] {
  const byAgent = new Map<AgentType, SessionFacts[]>();
  for (const f of facts) {
    const list = byAgent.get(f.session.agent_type);
    if (list) list.push(f);
    else byAgent.set(f.session.agent_type, [f]);
  }

  const out: ProviderIntelligence[] = [];
  for (const [agent, group] of byAgent.entries()) {
    const totalCostUsd = sum(group.map((f) => f.session.costUsd ?? 0));
    const totalTokens = sum(group.map((f) => f.session.totalTokens));
    const mergedPrCount = group.filter((f) => f.session.prMerged).length;

    // PR merge rate: merged / (sessions that opened a PR — merged or reviewed).
    const openedPr = group.filter(
      (f) =>
        f.session.prMerged ||
        f.session.reviewDecision != null ||
        f.session.dispatchStatus === "pr_open" ||
        f.session.dispatchStatus === "merged"
    ).length;
    const prMergeRate = safeRate(mergedPrCount, openedPr);

    const approved = group.filter(
      (f) => f.session.reviewDecision === "APPROVED"
    ).length;
    const changes = group.filter(
      (f) => f.session.reviewDecision === "CHANGES_REQUESTED"
    ).length;
    const reviewed = approved + changes;
    const reviewerPassRate = safeRate(approved, reviewed);

    const costedMerges = group.filter(
      (f) => f.session.prMerged && f.session.costUsd != null
    ).length;
    const costPerMergedPr = safeRate(totalCostUsd, costedMerges);

    const inputsPer = mean(group.map((f) => f.inputEvents.length));

    out.push({
      agent,
      sessionCount: group.length,
      totalCostUsd: round(totalCostUsd, 4),
      totalTokens,
      mergedPrCount,
      prMergeRate: prMergeRate == null ? null : round(prMergeRate, 3),
      reviewerPassRate:
        reviewerPassRate == null ? null : round(reviewerPassRate, 3),
      costPerMergedPr:
        costPerMergedPr == null ? null : round(costPerMergedPr, 4),
      avgInputsPerSession: inputsPer == null ? null : round(inputsPer, 1),
      effectivenessScore: effectiveness(
        { merged: mergedPrCount, opened: openedPr },
        { approved, reviewed },
        group.length
      ),
    });
  }

  // Most sessions first — the providers you actually lean on lead the table.
  return out.sort((a, b) => b.sessionCount - a.sessionCount);
}

/** Minimum sessions before we print an effectiveness score (small-sample guard). */
export const MIN_SESSIONS_FOR_SCORE = 4;

/**
 * Blended 0..100 effectiveness score — explainable but NOT fooled by tiny n.
 *
 * Three guards against the small-sample vanity trap (1 merged / 1 opened = 100%
 * outranking 50/100):
 *   1. Returns null below MIN_SESSIONS_FOR_SCORE sessions — no score with too
 *      little evidence (the roadmap's "resist a vanity score" note).
 *   2. Each outcome rate is Laplace-smoothed ((x+1)/(n+2)) so a 1/1 pulls toward
 *      0.5, not 1.0 — confidence grows with volume.
 *   3. The two signals are blended WEIGHTED by their own denominators, so a
 *      provider judged on 100 reviews counts more than one judged on 2.
 * Returns null when no outcome signal exists at all.
 */
function effectiveness(
  merge: { merged: number; opened: number },
  review: { approved: number; reviewed: number },
  sessionCount: number
): number | null {
  if (sessionCount < MIN_SESSIONS_FOR_SCORE) return null;
  const parts: Array<{ rate: number; w: number }> = [];
  if (merge.opened > 0) {
    parts.push({
      rate: (merge.merged + 1) / (merge.opened + 2),
      w: merge.opened,
    });
  }
  if (review.reviewed > 0) {
    parts.push({
      rate: (review.approved + 1) / (review.reviewed + 2),
      w: review.reviewed,
    });
  }
  if (parts.length === 0) return null;
  const wsum = sum(parts.map((p) => p.w));
  const blended = sum(parts.map((p) => p.rate * p.w)) / wsum;
  return round(blended * 100, 1);
}

// ── 4. Trends (daily time-series + slope) ────────────────────────────────────

export function computeTrends(
  facts: SessionFacts[],
  snapshot: AnalyticsSnapshot
): TrendSummary {
  // Seed a dense day axis (every day in the window) so a quiet day reads as 0,
  // not a gap — the slope and the chart both need an even grid.
  const days: string[] = [];
  const startMs = snapshot.now - (snapshot.windowDays - 1) * MS_PER_DAY;
  for (let i = 0; i < snapshot.windowDays; i++) {
    days.push(utcDay(startMs + i * MS_PER_DAY));
  }
  const idx = new Map<string, TrendPoint>();
  for (const day of days) {
    idx.set(day, { day, sessions: 0, inputs: 0, costUsd: 0, mergedPrs: 0 });
  }

  for (const f of facts) {
    const day = utcDay(f.session.created_at);
    const p = idx.get(day);
    // A session CREATED before the window (but kept because it was active in it)
    // has no creation-day on this axis — it's intentionally absent from the
    // creation-keyed trend, though it still counts in the other lenses.
    if (!p) continue;
    p.sessions += 1;
    p.inputs += f.inputEvents.length;
    p.costUsd += f.session.costUsd ?? 0;
    if (f.session.prMerged) p.mergedPrs += 1;
  }

  const points = days.map((d) => {
    const p = idx.get(d)!;
    return { ...p, costUsd: round(p.costUsd, 4) };
  });

  const costSlope = linregSlope(points.map((p) => p.costUsd));
  const sessionSlope = linregSlope(points.map((p) => p.sessions));

  return {
    points,
    costSlopePerDay: costSlope == null ? null : round(costSlope, 4),
    sessionSlopePerDay: sessionSlope == null ? null : round(sessionSlope, 3),
  };
}

// ── 5. Issue / anomaly detection (rule-based, explainable) ───────────────────

/** Tunables — conservative defaults; explainable beats clever. */
export const ISSUE_THRESHOLDS = {
  /** A session costs more than this multiple of the median → cost spike. */
  costSpikeMultiple: 4,
  /** Minimum USD before a spike is worth flagging (ignore noise near $0). */
  costSpikeMinUsd: 0.5,
  /** Active session idle longer than this → stalled. */
  stallMinutes: 30,
  /** A session with more inputs than this → runaway (likely a loop). */
  runawayInputCount: 200,
  /** This many+ failed dispatches in the window → failure cluster. */
  failureClusterCount: 3,
  /** Reviewer pass rate below this (with enough reviews) → quality concern. */
  lowReviewerPassRate: 0.5,
  minReviewsForRate: 4,
  /** Share of empty (abandoned) sessions above this → abandonment warning. */
  abandonedShare: 0.4,
  minSessionsForAbandon: 5,
};

export function detectIssues(
  facts: SessionFacts[],
  snapshot: AnalyticsSnapshot
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const T = ISSUE_THRESHOLDS;

  // Cost spikes — relative to the median session cost (robust to outliers).
  const costs = facts.map((f) => f.session.costUsd ?? 0).filter((c) => c > 0);
  const medCost = median(costs);
  if (medCost != null && medCost > 0) {
    for (const f of facts) {
      const c = f.session.costUsd ?? 0;
      if (c >= T.costSpikeMinUsd && c > medCost * T.costSpikeMultiple) {
        issues.push({
          kind: "cost_spike",
          severity: "warning",
          message: `Session ${f.session.key} cost $${round(c, 2)} — ${round(
            c / medCost,
            1
          )}× the median ($${round(medCost, 2)}).`,
          sessionKey: f.session.key,
          value: round(c / medCost, 1),
        });
      }
    }
  }

  // Stalled sessions — still marked active/running but idle a long time.
  const stallMs = T.stallMinutes * 60_000;
  for (const f of facts) {
    const isActiveStatus =
      f.session.status === "running" || f.session.status === "waiting";
    const last = f.lastEventAt ?? f.session.updated_at;
    if (isActiveStatus && snapshot.now - last > stallMs) {
      issues.push({
        kind: "stalled_session",
        severity: "warning",
        message: `Session ${f.session.key} is '${f.session.status}' but idle for ${Math.round(
          (snapshot.now - last) / 60_000
        )} min.`,
        sessionKey: f.session.key,
        value: Math.round((snapshot.now - last) / 60_000),
      });
    }
  }

  // Runaway sessions — an input count far past normal (loop / stuck retry).
  for (const f of facts) {
    if (f.inputEvents.length > T.runawayInputCount) {
      issues.push({
        kind: "runaway_session",
        severity: "warning",
        message: `Session ${f.session.key} has ${f.inputEvents.length} input events — possible loop.`,
        sessionKey: f.session.key,
        value: f.inputEvents.length,
      });
    }
  }

  // Failure cluster — many dispatch workers failed in the window.
  const failed = facts.filter(
    (f) => f.session.dispatchStatus === "failed"
  ).length;
  if (failed >= T.failureClusterCount) {
    issues.push({
      kind: "failure_cluster",
      severity: "critical",
      message: `${failed} dispatch workers failed in the last ${snapshot.windowDays}d.`,
      value: failed,
    });
  }

  // Low reviewer pass rate — quality signal (only with enough reviews).
  const approved = facts.filter(
    (f) => f.session.reviewDecision === "APPROVED"
  ).length;
  const changes = facts.filter(
    (f) => f.session.reviewDecision === "CHANGES_REQUESTED"
  ).length;
  const reviewed = approved + changes;
  if (reviewed >= T.minReviewsForRate) {
    const rate = approved / reviewed;
    if (rate < T.lowReviewerPassRate) {
      issues.push({
        kind: "low_reviewer_pass_rate",
        severity: "warning",
        message: `Reviewer pass rate is ${round(rate * 100, 0)}% over ${reviewed} reviews.`,
        value: round(rate, 3),
      });
    }
  }

  // Abandoned sessions — a high share created with zero events.
  const empty = facts.filter((f) => f.events.length === 0).length;
  if (
    facts.length >= T.minSessionsForAbandon &&
    empty / facts.length > T.abandonedShare
  ) {
    issues.push({
      kind: "abandoned_sessions",
      severity: "info",
      message: `${empty} of ${facts.length} sessions had no recorded activity.`,
      value: round(empty / facts.length, 2),
    });
  }

  // Critical first, then warning, then info — the cockpit shows worst on top.
  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ── The assembled report ─────────────────────────────────────────────────────

export function buildReport(snapshot: AnalyticsSnapshot): AnalyticsReport {
  const facts = deriveFacts(snapshot);
  return {
    windowDays: snapshot.windowDays,
    generatedAt: snapshot.now,
    performance: computePerformance(facts),
    behavioural: computeBehavioural(facts),
    intelligence: computeIntelligence(facts),
    trends: computeTrends(facts, snapshot),
    issues: detectIssues(facts, snapshot),
  };
}
