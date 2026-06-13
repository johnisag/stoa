/**
 * Analytics engine — exhaustive unit tests of the PURE compute layer. No DB, no
 * I/O: every case builds a snapshot and asserts the report. Locks the stats
 * (medians, slopes, rate guards), the outcome correlation, and every anomaly rule.
 */
import { describe, it, expect } from "vitest";
import {
  buildReport,
  computePerformance,
  computeBehavioural,
  computeIntelligence,
  computeTrends,
  computeSessionOrigins,
  detectIssues,
  utcDay,
  ISSUE_THRESHOLDS,
} from "@/lib/analytics/engine";
import type {
  AnalyticsSnapshot,
  AnalyticsSession,
  AnalyticsEvent,
} from "@/lib/analytics/types";
import type { SessionEventType } from "@/lib/db/types";
import type { AgentType } from "@/lib/providers";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-15T12:00:00Z");

let seq = 0;
function session(over: Partial<AnalyticsSession> = {}): AnalyticsSession {
  seq++;
  return {
    id: `s${seq}`,
    key: `claude-s${seq}`,
    agent_type: "claude" as AgentType,
    model: "sonnet",
    created_at: NOW - DAY,
    updated_at: NOW,
    status: "idle",
    dispatchStatus: null,
    reviewDecision: null,
    prMerged: false,
    costUsd: null,
    totalTokens: 0,
    ...over,
  };
}

function ev(
  key: string,
  type: SessionEventType,
  at: number,
  payload: Record<string, unknown> | null = null
): AnalyticsEvent {
  return { session_key: key, event_type: type, payload, created_at: at };
}

function snap(
  sessions: AnalyticsSession[],
  events: AnalyticsEvent[],
  windowDays = 14
): AnalyticsSnapshot {
  return { sessions, events, now: NOW, windowDays };
}

describe("utcDay", () => {
  it("formats an epoch-ms instant as a UTC calendar day", () => {
    expect(utcDay(Date.parse("2026-06-15T23:30:00Z"))).toBe("2026-06-15");
    expect(utcDay(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });
});

describe("computeSessionOrigins", () => {
  it("splits dispatch (has a dispatch outcome) from standalone, total = all", () => {
    const sessions = [
      session({ dispatchStatus: "merged" }),
      session({ dispatchStatus: "pr_open" }),
      session({ dispatchStatus: null }), // hand-started / standalone
      session({ dispatchStatus: null }),
      session({ dispatchStatus: null }),
    ];
    expect(computeSessionOrigins(sessions)).toEqual({
      dispatch: 2,
      standalone: 3,
      total: 5,
    });
  });

  it("is all-standalone when nothing was dispatched, and zeroes on empty", () => {
    expect(computeSessionOrigins([session(), session()])).toEqual({
      dispatch: 0,
      standalone: 2,
      total: 2,
    });
    expect(computeSessionOrigins([])).toEqual({
      dispatch: 0,
      standalone: 0,
      total: 0,
    });
  });

  it("buildReport surfaces origins on the report", () => {
    const report = buildReport(
      snap([session({ dispatchStatus: "merged" }), session()], [])
    );
    expect(report.origins).toEqual({ dispatch: 1, standalone: 1, total: 2 });
  });
});

describe("performance", () => {
  it("counts sessions, active sessions, and sums cost/tokens", () => {
    const s1 = session({ key: "k1", costUsd: 1.5, totalTokens: 1000 });
    const s2 = session({ key: "k2", costUsd: 0.5, totalTokens: 500 });
    const s3 = session({ key: "k3" }); // no events => inactive
    const events = [
      ev("k1", "session_create", NOW - 1000),
      ev("k1", "input_text", NOW - 500, { length: 4 }),
      ev("k2", "session_create", NOW - 800),
    ];
    const r = buildReport(snap([s1, s2, s3], events));
    expect(r.performance.sessionCount).toBe(3);
    expect(r.performance.activeSessionCount).toBe(2);
    expect(r.performance.totalCostUsd).toBe(2);
    expect(r.performance.totalTokens).toBe(1500);
    expect(r.performance.totalInputEvents).toBe(1);
  });

  it("computes cost per merged PR and reviewer pass rate, guarding denominators", () => {
    const s1 = session({
      key: "k1",
      costUsd: 4,
      prMerged: true,
      reviewDecision: "APPROVED",
    });
    const s2 = session({
      key: "k2",
      costUsd: 2,
      prMerged: true,
      reviewDecision: "CHANGES_REQUESTED",
    });
    const s3 = session({ key: "k3", costUsd: 2, reviewDecision: "APPROVED" });
    const r = computePerformance(
      // deriveFacts is internal; go through buildReport for the public surface
      []
    );
    // empty => null rates, no NaN
    expect(r.costPerMergedPr).toBeNull();
    expect(r.reviewerPassRate).toBeNull();

    const full = buildReport(
      snap([s1, s2, s3], [ev("k1", "input_text", NOW)])
    ).performance;
    expect(full.mergedPrCount).toBe(2);
    expect(full.costPerMergedPr).toBe(4); // (4+2+2)/2
    expect(full.reviewedCount).toBe(3); // 2 approved + 1 changes
    expect(full.reviewerPassRate).toBe(round3(2 / 3));
  });

  it("median time-to-first-input uses the first INPUT event, not the create event", () => {
    const s = session({ key: "k", created_at: NOW - 10_000 });
    const events = [
      ev("k", "session_create", NOW - 10_000),
      ev("k", "input_text", NOW - 7_000, { length: 1 }), // 3s after create
    ];
    const r = buildReport(snap([s], events)).performance;
    expect(r.medianTimeToFirstInputSec).toBe(3);
  });

  it("median session duration is create → last recorded event, in seconds", () => {
    const s = session({ key: "k", created_at: NOW - 60_000 });
    const events = [
      ev("k", "session_create", NOW - 60_000),
      ev("k", "input_text", NOW - 30_000, { length: 1 }), // last event 30s after create
    ];
    const r = buildReport(snap([s], events)).performance;
    expect(r.medianSessionDurationSec).toBe(30);
  });
});

describe("behavioural", () => {
  it("builds the event mix histogram sorted by count desc", () => {
    const s = session({ key: "k" });
    const events = [
      ev("k", "input_text", NOW - 5000, { length: 1 }),
      ev("k", "input_text", NOW - 4000, { length: 1 }),
      ev("k", "input_enter", NOW - 3000),
      ev("k", "input_paste", NOW - 2000, { length: 50 }),
    ];
    const b = buildReport(snap([s], events)).behavioural;
    expect(b.eventMix[0]).toEqual({ type: "input_text", count: 2 });
    expect(b.eventMix.find((e) => e.type === "input_paste")?.count).toBe(1);
    expect(b.pasteRatio).toBe(0.25); // 1 paste / 4 inputs
  });

  it("computes input cadence per session (skips sessions with <2 inputs)", () => {
    const s1 = session({ key: "k1" });
    const s2 = session({ key: "k2" });
    const events = [
      // k1: inputs 10s apart => 10s cadence
      ev("k1", "input_text", NOW - 20_000, { length: 1 }),
      ev("k1", "input_text", NOW - 10_000, { length: 1 }),
      // k2: a single input => contributes no interval
      ev("k2", "input_text", NOW - 5_000, { length: 1 }),
    ];
    const b = buildReport(snap([s1, s2], events)).behavioural;
    expect(b.avgInputIntervalSec).toBe(10);
  });

  it("counts empty (abandoned) sessions and returns null rates with no inputs", () => {
    const s1 = session({ key: "k1" });
    const s2 = session({ key: "k2" });
    const b = buildReport(
      snap([s1, s2], [ev("k1", "session_create", NOW)])
    ).behavioural;
    expect(b.emptySessionCount).toBe(1); // k2 has zero events
    expect(b.pasteRatio).toBeNull(); // no inputs at all
    expect(b.avgInputIntervalSec).toBeNull();
  });
});

describe("intelligence (per-provider, outcome-correlated)", () => {
  it("groups by agent and computes merge/review rates (unsmoothed)", () => {
    const claudeMerged = session({
      key: "c1",
      agent_type: "claude" as AgentType,
      prMerged: true,
      reviewDecision: "APPROVED",
      dispatchStatus: "merged",
      costUsd: 3,
    });
    const claudeReviewed = session({
      key: "c2",
      agent_type: "claude" as AgentType,
      reviewDecision: "CHANGES_REQUESTED",
      dispatchStatus: "pr_open",
    });
    const codex = session({
      key: "x1",
      agent_type: "codex" as AgentType,
      prMerged: true,
      dispatchStatus: "merged",
      reviewDecision: "APPROVED",
      costUsd: 1,
    });
    const r = buildReport(
      snap(
        [claudeMerged, claudeReviewed, codex],
        [ev("c1", "input_text", NOW, { length: 1 })]
      )
    ).intelligence;

    const claude = r.find((p) => p.agent === "claude")!;
    expect(claude.sessionCount).toBe(2);
    expect(claude.mergedPrCount).toBe(1);
    // openedPr = 2 (one merged, one pr_open/reviewed) => raw merge rate 0.5
    expect(claude.prMergeRate).toBe(0.5);
    // reviewer: 1 approved + 1 changes => 0.5
    expect(claude.reviewerPassRate).toBe(0.5);

    const codexRow = r.find((p) => p.agent === "codex")!;
    expect(codexRow.prMergeRate).toBe(1);
  });

  it("requires a minimum sample before printing an effectiveness score (no tiny-n vanity)", () => {
    // 1 perfect session: raw rates are 1.0, but below MIN_SESSIONS_FOR_SCORE so
    // the SCORE is withheld (null) — the small-sample guard.
    const one = session({
      key: "k",
      agent_type: "codex" as AgentType,
      prMerged: true,
      dispatchStatus: "merged",
      reviewDecision: "APPROVED",
    });
    const r1 = buildReport(
      snap([one], [ev("k", "input_text", NOW, { length: 1 })])
    ).intelligence;
    expect(r1.find((p) => p.agent === "codex")!.effectivenessScore).toBeNull();
  });

  it("Laplace-smooths + volume-weights the score once the sample is large enough", () => {
    // 4 sessions, all merged+approved. Raw rates = 1.0, but smoothing pulls each
    // toward 0.5: merge (4+1)/(4+2)=0.8333, review (4+1)/(4+2)=0.8333; weighted
    // blend (weights 4 and 4) = 0.8333 → score 83.3. NOT a naive 100.
    const sessions = Array.from({ length: 4 }, (_, i) =>
      session({
        key: `k${i}`,
        agent_type: "claude" as AgentType,
        prMerged: true,
        dispatchStatus: "merged",
        reviewDecision: "APPROVED",
      })
    );
    const events = sessions.map((s) =>
      ev(s.key, "input_text", NOW, { length: 1 })
    );
    const claude = buildReport(snap(sessions, events)).intelligence.find(
      (p) => p.agent === "claude"
    )!;
    expect(claude.prMergeRate).toBe(1); // raw rate still reported honestly
    expect(claude.effectivenessScore).toBe(83.3); // smoothed, not 100
  });

  it("returns a null effectiveness score when no outcome signal exists (no vanity score)", () => {
    const sessions = Array.from({ length: 4 }, (_, i) =>
      session({ key: `h${i}`, agent_type: "hermes" as AgentType })
    );
    const events = sessions.map((s) =>
      ev(s.key, "input_text", NOW, { length: 1 })
    );
    const hermes = buildReport(snap(sessions, events)).intelligence.find(
      (p) => p.agent === "hermes"
    )!;
    expect(hermes.prMergeRate).toBeNull();
    expect(hermes.reviewerPassRate).toBeNull();
    expect(hermes.effectivenessScore).toBeNull();
  });

  it("scores on a SINGLE outcome signal when only one exists (merge, no reviews)", () => {
    // 4 merged sessions, NO review decisions: merge signal only. Smoothed merge
    // rate (4+1)/(4+2)=0.8333 → 83.3; reviewer rate null (not blended as 0).
    const sessions = Array.from({ length: 4 }, (_, i) =>
      session({
        key: `k${i}`,
        agent_type: "codex" as AgentType,
        prMerged: true,
        dispatchStatus: "merged",
        reviewDecision: null,
      })
    );
    const events = sessions.map((s) =>
      ev(s.key, "input_text", NOW, { length: 1 })
    );
    const codex = buildReport(snap(sessions, events)).intelligence.find(
      (p) => p.agent === "codex"
    )!;
    expect(codex.prMergeRate).toBe(1);
    expect(codex.reviewerPassRate).toBeNull();
    expect(codex.effectivenessScore).toBe(83.3); // single smoothed signal
  });

  it("sorts providers by session count desc", () => {
    const sessions = [
      session({ key: "a1", agent_type: "claude" as AgentType }),
      session({ key: "a2", agent_type: "claude" as AgentType }),
      session({ key: "b1", agent_type: "codex" as AgentType }),
    ];
    const events = sessions.map((s) =>
      ev(s.key, "input_text", NOW, { length: 1 })
    );
    const r = buildReport(snap(sessions, events)).intelligence;
    expect(r[0].agent).toBe("claude");
    expect(r[0].sessionCount).toBe(2);
  });
});

describe("trends", () => {
  it("produces a dense day axis with zero-filled quiet days", () => {
    const s = session({ key: "k", created_at: NOW }); // today
    const r = buildReport(
      snap([s], [ev("k", "input_text", NOW, { length: 1 })], 7)
    ).trends;
    expect(r.points).toHaveLength(7); // dense: one point per window day
    expect(r.points[r.points.length - 1].day).toBe(utcDay(NOW));
    expect(r.points[r.points.length - 1].sessions).toBe(1);
    expect(r.points[0].sessions).toBe(0); // quiet earlier day => 0, not a gap
  });

  it("computes a positive cost slope for rising daily spend", () => {
    // 3 sessions across 3 consecutive days with growing cost.
    const d = (n: number) => NOW - n * DAY;
    const sessions = [
      session({ key: "k1", created_at: d(2), costUsd: 1 }),
      session({ key: "k2", created_at: d(1), costUsd: 2 }),
      session({ key: "k3", created_at: d(0), costUsd: 3 }),
    ];
    const events = sessions.map((s) =>
      ev(s.key, "input_text", s.created_at, { length: 1 })
    );
    const r = buildReport(snap(sessions, events, 3)).trends;
    expect(r.costSlopePerDay).not.toBeNull();
    expect(r.costSlopePerDay! > 0).toBe(true);
  });

  it("computes a positive session slope and locks per-point daily values", () => {
    const d = (n: number) => NOW - n * DAY;
    const sessions = [
      session({ key: "k1", created_at: d(2) }),
      session({ key: "k2", created_at: d(1) }),
      session({ key: "k3", created_at: d(0) }),
      session({ key: "k4", created_at: d(0) }),
    ];
    const events = [
      ev("k3", "input_text", d(0), { length: 1 }),
      ev("k4", "input_text", d(0), { length: 1 }),
    ];
    const r = buildReport(snap(sessions, events, 3)).trends;
    expect(r.points).toHaveLength(3);
    // Day -2: 1 session, day -1: 1, day 0: 2 → rising.
    expect(r.points[0].sessions).toBe(1);
    expect(r.points[2].sessions).toBe(2);
    expect(r.points[2].inputs).toBe(2);
    expect(r.sessionSlopePerDay).not.toBeNull();
    expect(r.sessionSlopePerDay! > 0).toBe(true);
  });
});

describe("issue detection", () => {
  it("flags a cost spike relative to the median", () => {
    const sessions = [
      session({ key: "k1", costUsd: 1 }),
      session({ key: "k2", costUsd: 1 }),
      session({ key: "k3", costUsd: 1 }),
      session({ key: "spike", costUsd: 10 }), // 10x the $1 median
    ];
    const events = sessions.map((s) =>
      ev(s.key, "input_text", NOW, { length: 1 })
    );
    const issues = buildReport(snap(sessions, events)).issues;
    const spike = issues.find((i) => i.kind === "cost_spike");
    expect(spike).toBeDefined();
    expect(spike!.sessionKey).toBe("spike");
  });

  it("flags a stalled session (active status, long idle)", () => {
    const s = session({
      key: "stall",
      status: "running",
      updated_at: NOW - 60 * 60_000, // idle 60 min
    });
    const issues = buildReport(
      snap([s], [ev("stall", "input_text", NOW - 60 * 60_000, { length: 1 })])
    ).issues;
    expect(issues.some((i) => i.kind === "stalled_session")).toBe(true);
  });

  it("flags a runaway session past the input threshold", () => {
    const s = session({ key: "loop" });
    const events: AnalyticsEvent[] = [];
    for (let i = 0; i <= ISSUE_THRESHOLDS.runawayInputCount; i++) {
      events.push(ev("loop", "input_text", NOW - i * 100, { length: 1 }));
    }
    const issues = buildReport(snap([s], events)).issues;
    expect(issues.some((i) => i.kind === "runaway_session")).toBe(true);
  });

  it("flags a failure cluster and sorts critical issues first", () => {
    const sessions = [
      session({ key: "f1", dispatchStatus: "failed" }),
      session({ key: "f2", dispatchStatus: "failed" }),
      session({ key: "f3", dispatchStatus: "failed" }),
    ];
    const issues = buildReport(snap(sessions, [])).issues;
    expect(issues[0].kind).toBe("failure_cluster");
    expect(issues[0].severity).toBe("critical");
  });

  it("flags a low reviewer pass rate only with enough reviews", () => {
    // 1 approved, 3 changes => 25% over 4 reviews (>= minReviewsForRate).
    const sessions = [
      session({ key: "r1", reviewDecision: "APPROVED" }),
      session({ key: "r2", reviewDecision: "CHANGES_REQUESTED" }),
      session({ key: "r3", reviewDecision: "CHANGES_REQUESTED" }),
      session({ key: "r4", reviewDecision: "CHANGES_REQUESTED" }),
    ];
    const issues = buildReport(snap(sessions, [])).issues;
    expect(issues.some((i) => i.kind === "low_reviewer_pass_rate")).toBe(true);
  });

  it("flags abandoned sessions above the share threshold", () => {
    // 5 sessions, 4 empty (80% > 40%).
    const sessions = [
      session({ key: "a1" }),
      session({ key: "a2" }),
      session({ key: "a3" }),
      session({ key: "a4" }),
      session({ key: "a5" }),
    ];
    const issues = buildReport(
      snap(sessions, [ev("a1", "input_text", NOW, { length: 1 })])
    ).issues;
    expect(issues.some((i) => i.kind === "abandoned_sessions")).toBe(true);
  });

  it("reports no issues for a healthy, quiet window", () => {
    const sessions = [
      session({
        key: "h1",
        costUsd: 1,
        reviewDecision: "APPROVED",
        prMerged: true,
      }),
      session({
        key: "h2",
        costUsd: 1,
        reviewDecision: "APPROVED",
        prMerged: true,
      }),
    ];
    const events = sessions.map((s) =>
      ev(s.key, "input_text", NOW, { length: 1 })
    );
    const issues = buildReport(snap(sessions, events)).issues;
    expect(issues).toEqual([]);
  });

  it("does NOT flag a cost outlier below the minimum-USD floor", () => {
    // A 10x ratio but tiny absolute ($0.05 vs $0.005 median) — below the
    // costSpikeMinUsd floor, so it must be suppressed (no noise near $0).
    const sessions = [
      session({ key: "k1", costUsd: 0.005 }),
      session({ key: "k2", costUsd: 0.005 }),
      session({ key: "k3", costUsd: 0.005 }),
      session({ key: "tiny", costUsd: 0.05 }),
    ];
    const events = sessions.map((s) =>
      ev(s.key, "input_text", NOW, { length: 1 })
    );
    const issues = buildReport(snap(sessions, events)).issues;
    expect(issues.some((i) => i.kind === "cost_spike")).toBe(false);
  });

  it("flags a stalled session with ZERO events via the updated_at fallback (waiting status)", () => {
    const s = session({
      key: "stall0",
      status: "waiting",
      updated_at: NOW - 45 * 60_000, // idle 45 min, no events at all
    });
    const issues = buildReport(snap([s], [])).issues;
    expect(issues.some((i) => i.kind === "stalled_session")).toBe(true);
  });

  it("does NOT flag low reviewer pass rate below the minimum review count", () => {
    // 1 approved + 1 changes = 50% but only 2 reviews (< minReviewsForRate=4).
    const sessions = [
      session({ key: "r1", reviewDecision: "APPROVED" }),
      session({ key: "r2", reviewDecision: "CHANGES_REQUESTED" }),
    ];
    const issues = buildReport(snap(sessions, [])).issues;
    expect(issues.some((i) => i.kind === "low_reviewer_pass_rate")).toBe(false);
  });

  it("does NOT flag abandonment below the minimum session count", () => {
    // 2 sessions, both empty (100%) but < minSessionsForAbandon=5.
    const sessions = [session({ key: "a1" }), session({ key: "a2" })];
    const issues = buildReport(snap(sessions, [])).issues;
    expect(issues.some((i) => i.kind === "abandoned_sessions")).toBe(false);
  });

  it("emits exactly one issue of a kind and no spurious kinds for a single anomaly", () => {
    const sessions = [
      session({
        key: "k1",
        costUsd: 1,
        prMerged: true,
        reviewDecision: "APPROVED",
      }),
      session({
        key: "k2",
        costUsd: 1,
        prMerged: true,
        reviewDecision: "APPROVED",
      }),
      session({
        key: "k3",
        costUsd: 1,
        prMerged: true,
        reviewDecision: "APPROVED",
      }),
      session({
        key: "spike",
        costUsd: 12,
        prMerged: true,
        reviewDecision: "APPROVED",
      }),
    ];
    const events = sessions.map((s) =>
      ev(s.key, "input_text", NOW, { length: 1 })
    );
    const issues = buildReport(snap(sessions, events)).issues;
    expect(issues.filter((i) => i.kind === "cost_spike")).toHaveLength(1);
    // No other kind fires for this otherwise-healthy window.
    expect(issues.every((i) => i.kind === "cost_spike")).toBe(true);
  });
});

describe("buildReport (assembled)", () => {
  it("returns all lenses + echoes the window and generatedAt", () => {
    const r = buildReport(snap([session({ key: "k" })], [], 30));
    expect(r.windowDays).toBe(30);
    expect(r.generatedAt).toBe(NOW);
    expect(r.performance).toBeDefined();
    expect(r.behavioural).toBeDefined();
    expect(Array.isArray(r.intelligence)).toBe(true);
    expect(Array.isArray(r.trends.points)).toBe(true);
    expect(Array.isArray(r.issues)).toBe(true);
  });

  it("handles an entirely empty snapshot without throwing or NaN", () => {
    const r = buildReport(snap([], [], 14));
    expect(r.performance.sessionCount).toBe(0);
    expect(r.performance.costPerMergedPr).toBeNull();
    expect(r.performance.reviewerPassRate).toBeNull();
    expect(r.behavioural.avgEventsPerSession).toBeNull();
    expect(r.intelligence).toEqual([]);
    expect(r.trends.costSlopePerDay).not.toBeUndefined();
    expect(r.issues).toEqual([]);
  });

  it("is deterministic regardless of event input order (sorts by time)", () => {
    const s = session({ key: "k", created_at: NOW - 10_000 });
    const ordered = [
      ev("k", "session_create", NOW - 10_000),
      ev("k", "input_text", NOW - 8_000, { length: 1 }),
      ev("k", "input_text", NOW - 6_000, { length: 1 }),
    ];
    const shuffled = [ordered[2], ordered[0], ordered[1]];
    const a = buildReport(snap([s], ordered)).performance;
    const b = buildReport(snap([{ ...s }], shuffled)).performance;
    expect(a.medianTimeToFirstInputSec).toBe(b.medianTimeToFirstInputSec);
  });
});

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
