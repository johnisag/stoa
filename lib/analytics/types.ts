/**
 * Analytics / Insight layer — type surface.
 *
 * ROADMAP active-plan item 4 + the "Insight" strategic pillar, built on the
 * append-only audit/event ledger (item 3, #133). Three lenses on one substrate:
 *
 *   1. PERFORMANCE  — throughput, cost, token, duration, time-to-first-output,
 *                     time-to-PR, reviewer-gate pass rate.
 *   2. BEHAVIOURAL  — what each agent actually DOES: event-type mix, input
 *                     cadence, session shape, where sessions stall.
 *   3. INTELLIGENCE — per-provider effectiveness correlated with OUTCOMES
 *                     (PR merged? reviewer verdict? still alive?).
 *
 * Plus TRENDS (daily time-series) and ISSUE DETECTION (rule-based anomalies:
 * cost spikes, stalls, failure clusters, runaway sessions).
 *
 * Everything is computed by a PURE function (engine.ts::buildReport) over a
 * normalized snapshot, so the whole layer is exhaustively unit-testable with no
 * I/O. The DB layer (queries.ts) only gathers that snapshot; the API route
 * (app/api/analytics) only serializes it.
 */

import type { AgentType } from "../providers";
import type { SessionEventType } from "../db/types";

// ── Snapshot (the engine's input) ──────────────────────────────────────────

/** One ledger row, narrowed to what the engine needs (created_at = epoch ms). */
export interface AnalyticsEvent {
  session_key: string;
  event_type: SessionEventType;
  /** Parsed payload metadata (length, enter, from, command, …) or null. */
  payload: Record<string, unknown> | null;
  created_at: number;
}

/** One session, narrowed + joined to its outcome signals. */
export interface AnalyticsSession {
  id: string;
  /** Backend key — the join key to AnalyticsEvent.session_key. */
  key: string;
  agent_type: AgentType;
  model: string | null;
  /** Epoch ms of session row creation. */
  created_at: number;
  /** Epoch ms of last update (proxy for last activity). */
  updated_at: number;
  status: string;
  /** Outcome: a dispatch worker's terminal state, if this session is one. */
  dispatchStatus: string | null;
  /** Outcome: GitHub reviewDecision for this session's PR, if any. */
  reviewDecision: string | null;
  /** Outcome: whether this session's PR merged. */
  prMerged: boolean;
  /** Estimated USD (Claude-only; null when unsupported/unknown). */
  costUsd: number | null;
  /** Total tokens (0 when unsupported). */
  totalTokens: number;
}

/** The full normalized input to buildReport — pure data, no DB handles. */
export interface AnalyticsSnapshot {
  sessions: AnalyticsSession[];
  events: AnalyticsEvent[];
  /** "Now" as epoch ms — injected so the engine is deterministic/testable. */
  now: number;
  /** Window in days the snapshot was gathered for (for labelling). */
  windowDays: number;
}

// ── Session origins (where the work came from) ───────────────────────────────

/**
 * How the window's sessions were started. Insight already counts EVERY session —
 * this split makes that visible so a user can confirm their own hand-started
 * ("standalone") sessions are tracked, not just Dispatch's autonomous workers.
 * A session is `dispatch` when it carries a dispatch outcome; everything else
 * (interactive sessions you open yourself, workflow workers) is `standalone`.
 */
export interface SessionOriginCounts {
  dispatch: number;
  standalone: number;
  total: number;
}

// ── Performance lens ────────────────────────────────────────────────────────

export interface PerformanceMetrics {
  sessionCount: number;
  /** Sessions with at least one recorded event. */
  activeSessionCount: number;
  totalCostUsd: number;
  totalTokens: number;
  totalInputEvents: number;
  /** Median wall-clock seconds from session create → last event (active only). */
  medianSessionDurationSec: number | null;
  /** Median seconds create → first input event (proxy for time-to-first-output). */
  medianTimeToFirstInputSec: number | null;
  /** Cost per merged PR (totalCost / mergedPRs), null when no merges. */
  costPerMergedPr: number | null;
  mergedPrCount: number;
  /** Reviewer-gate pass rate: APPROVED / (APPROVED + CHANGES_REQUESTED). */
  reviewerPassRate: number | null;
  reviewedCount: number;
}

// ── Behavioural lens ────────────────────────────────────────────────────────

export interface EventTypeCount {
  type: SessionEventType;
  count: number;
}

export interface BehaviouralMetrics {
  /** Event-type histogram across all sessions in the window. */
  eventMix: EventTypeCount[];
  /** Mean recorded events per active session. */
  avgEventsPerSession: number | null;
  /** Mean input events per active session (the "interaction load"). */
  avgInputsPerSession: number | null;
  /** Mean seconds between consecutive input events (cadence), null if <2 inputs. */
  avgInputIntervalSec: number | null;
  /** Sessions created but with zero recorded events (immediately abandoned). */
  emptySessionCount: number;
  /** Share of input that is paste vs typed (paste / total input), 0..1. */
  pasteRatio: number | null;
}

// ── Intelligence lens (per-provider, outcome-correlated) ─────────────────────

export interface ProviderIntelligence {
  agent: AgentType;
  sessionCount: number;
  totalCostUsd: number;
  totalTokens: number;
  mergedPrCount: number;
  /** PR merge rate among this provider's sessions that opened a PR. */
  prMergeRate: number | null;
  /** Reviewer pass rate for this provider (APPROVED / reviewed). */
  reviewerPassRate: number | null;
  /** Mean cost per merged PR for this provider, null when no merges. */
  costPerMergedPr: number | null;
  avgInputsPerSession: number | null;
  /** A 0..100 blended effectiveness score (see engine for the formula). */
  effectivenessScore: number | null;
}

// ── Trends (daily time-series) ───────────────────────────────────────────────

export interface TrendPoint {
  /** Calendar day, YYYY-MM-DD (UTC). */
  day: string;
  sessions: number;
  inputs: number;
  costUsd: number;
  mergedPrs: number;
}

export interface TrendSummary {
  points: TrendPoint[];
  /** Linear-fit slope of daily cost (USD/day); >0 = rising spend. */
  costSlopePerDay: number | null;
  /** Linear-fit slope of daily sessions; >0 = rising activity. */
  sessionSlopePerDay: number | null;
}

// ── Issue / anomaly detection ────────────────────────────────────────────────

export type IssueSeverity = "info" | "warning" | "critical";

export type IssueKind =
  | "cost_spike"
  | "stalled_session"
  | "failure_cluster"
  | "runaway_session"
  | "low_reviewer_pass_rate"
  | "abandoned_sessions";

export interface DetectedIssue {
  kind: IssueKind;
  severity: IssueSeverity;
  /** Human-readable one-liner for the cockpit. */
  message: string;
  /** Optional session key the issue points at (for drill-in). */
  sessionKey?: string;
  /** Optional numeric the UI can render (e.g. the spike multiple). */
  value?: number;
}

// ── The full report (engine output / API payload) ────────────────────────────

export interface AnalyticsReport {
  windowDays: number;
  generatedAt: number;
  origins: SessionOriginCounts;
  performance: PerformanceMetrics;
  behavioural: BehaviouralMetrics;
  intelligence: ProviderIntelligence[];
  trends: TrendSummary;
  issues: DetectedIssue[];
}
