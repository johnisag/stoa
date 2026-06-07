"use client";

/**
 * Analytics / Insight view — the cockpit lens over the audit-event ledger.
 *
 * A self-contained dialog (like DispatchView) with a segmented control across
 * the lenses: Overview · Performance · Behaviour · Intelligence · Trends ·
 * Issues. All data comes from one /api/analytics report (react-query); charts
 * are dependency-free inline SVG (see primitives.tsx).
 */

import { useState } from "react";
import { BarChart3, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAnalyticsQuery } from "@/data/analytics/queries";
import type { AnalyticsReport } from "@/lib/analytics/types";
import { StatCard, BarRow, Sparkline, fmt, fmtDuration } from "./primitives";

type Tab =
  | "overview"
  | "performance"
  | "behaviour"
  | "intelligence"
  | "trends"
  | "issues";

const WINDOWS = [7, 14, 30] as const;

/** Shared tone for reviewer pass rate: good ≥70%, warn <50%, neutral between. */
function reviewerTone(rate: number | null): "good" | "warn" | "default" {
  if (rate == null) return "default";
  if (rate >= 0.7) return "good";
  if (rate < 0.5) return "warn";
  return "default";
}

const EVENT_LABELS: Record<string, string> = {
  session_create: "Sessions created",
  session_kill: "Sessions killed",
  session_rename: "Renames",
  input_text: "Text input",
  input_paste: "Pastes",
  input_enter: "Enter",
  input_escape: "Escape",
};

export function AnalyticsView({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [windowDays, setWindowDays] = useState<number>(14);
  const { data, isLoading, isError, refetch, isFetching } = useAnalyticsQuery(
    windowDays,
    open
  );

  const issueCount = data?.issues.length ?? 0;
  const hasCritical =
    data?.issues.some((i) => i.severity === "critical") ?? false;
  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "performance", label: "Performance" },
    { key: "behaviour", label: "Behaviour" },
    { key: "intelligence", label: "Intelligence" },
    { key: "trends", label: "Trends" },
    { key: "issues", label: "Issues", badge: issueCount },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[calc(100%-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="space-y-1 px-6 pt-6 pb-3 text-left">
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Insight
          </DialogTitle>
          <DialogDescription>
            Performance, behaviour, and per-provider intelligence over the audit
            ledger — fully on-box. Last {windowDays} days.
          </DialogDescription>
        </DialogHeader>

        {/* segmented control + window picker + refresh */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 pb-3">
          <div
            role="tablist"
            aria-label="Insight lenses"
            className="bg-muted inline-flex max-w-full flex-nowrap overflow-x-auto rounded-md p-0.5 text-sm [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "inline-flex min-h-[40px] items-center gap-1.5 rounded px-3 py-1.5 whitespace-nowrap transition-colors",
                  tab === t.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
                {t.badge != null && t.badge > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-xs",
                      t.key === "issues"
                        ? hasCritical
                          ? "bg-red-500/20 text-red-400"
                          : "bg-yellow-500/20 text-yellow-400"
                        : "bg-foreground/10"
                    )}
                  >
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="bg-muted inline-flex rounded-md p-0.5 text-xs">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={windowDays === w}
                  onClick={() => setWindowDays(w)}
                  className={cn(
                    "min-h-[40px] rounded px-2.5 py-1.5 transition-colors",
                    windowDays === w
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {w}d
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh"
              title="Refresh"
              onClick={() => refetch()}
            >
              <RefreshCw
                className={cn("h-4 w-4", isFetching && "animate-spin")}
              />
            </Button>
          </div>
        </div>

        <div
          className="flex-1 overflow-y-auto px-6 pb-6"
          role="tabpanel"
          aria-label={`${tab} insights`}
        >
          {isLoading ? (
            <Centered>Computing insight…</Centered>
          ) : isError ? (
            <Centered>Failed to load analytics. Try refresh.</Centered>
          ) : !data ? (
            <Centered>No data yet.</Centered>
          ) : data.performance.sessionCount === 0 ? (
            <Centered>
              No sessions in the last {windowDays} days. Run an agent — the
              ledger fills as you work.
            </Centered>
          ) : (
            <>
              {tab === "overview" && <Overview report={data} />}
              {tab === "performance" && <Performance report={data} />}
              {tab === "behaviour" && <Behaviour report={data} />}
              {tab === "intelligence" && <Intelligence report={data} />}
              {tab === "trends" && <Trends report={data} />}
              {tab === "issues" && <Issues report={data} />}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center text-center text-sm">
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground mt-6 mb-2 text-xs font-semibold tracking-wide uppercase first:mt-0">
      {children}
    </h3>
  );
}

// ── Overview: the headline numbers + a cost sparkline + top issues ──────────
function Overview({ report }: { report: AnalyticsReport }) {
  const p = report.performance;
  const t = report.trends;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Sessions"
          value={fmt(p.sessionCount)}
          hint={`${p.activeSessionCount} active`}
        />
        <StatCard
          label="Est. cost"
          value={fmt(p.totalCostUsd, { prefix: "$", dp: 2 })}
          hint="Claude only (others n/a)"
        />
        <StatCard
          label="Merged PRs"
          value={fmt(p.mergedPrCount)}
          hint={
            p.costPerMergedPr != null
              ? `$${p.costPerMergedPr.toFixed(2)}/PR amortized`
              : undefined
          }
        />
        <StatCard
          label="Reviewer pass"
          value={
            p.reviewerPassRate == null
              ? "—"
              : `${Math.round(p.reviewerPassRate * 100)}%`
          }
          hint={`${p.reviewedCount} reviewed`}
          tone={reviewerTone(p.reviewerPassRate)}
        />
      </div>

      <SectionTitle>Daily cost</SectionTitle>
      <div className="bg-card rounded-lg border p-3">
        <Sparkline
          values={t.points.map((pt) => pt.costUsd)}
          height={56}
          label={`Daily cost over ${t.points.length} days, latest $${
            t.points[t.points.length - 1]?.costUsd?.toFixed(2) ?? "0"
          }`}
        />
        <div className="text-muted-foreground mt-1 flex justify-between text-xs">
          <span>{t.points[0]?.day}</span>
          {t.costSlopePerDay != null && (
            <span
              className={
                t.costSlopePerDay > 0
                  ? "text-yellow-400"
                  : t.costSlopePerDay < 0
                    ? "text-emerald-400"
                    : ""
              }
            >
              trend {t.costSlopePerDay >= 0 ? "↑" : "↓"} $
              {Math.abs(t.costSlopePerDay).toFixed(2)}/day
            </span>
          )}
          <span>{t.points[t.points.length - 1]?.day}</span>
        </div>
      </div>

      {report.issues.length > 0 && (
        <>
          <SectionTitle>Top issues</SectionTitle>
          <div className="flex flex-col gap-2">
            {report.issues.slice(0, 3).map((iss, i) => (
              <IssueRow key={i} severity={iss.severity} message={iss.message} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Performance ──────────────────────────────────────────────────────────────
function Performance({ report }: { report: AnalyticsReport }) {
  const p = report.performance;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <StatCard label="Total tokens" value={fmt(p.totalTokens)} />
      <StatCard label="Input events" value={fmt(p.totalInputEvents)} />
      <StatCard
        label="Median session"
        value={fmtDuration(p.medianSessionDurationSec)}
        hint="create → last event"
      />
      <StatCard
        label="Time to first input"
        value={fmtDuration(p.medianTimeToFirstInputSec)}
        hint="median"
      />
      <StatCard
        label="Cost / merged PR"
        value={fmt(p.costPerMergedPr, { prefix: "$", dp: 2 })}
      />
      <StatCard
        label="Reviewer pass rate"
        value={
          p.reviewerPassRate == null
            ? "—"
            : `${Math.round(p.reviewerPassRate * 100)}%`
        }
        hint={`${p.reviewedCount} reviewed`}
        tone={reviewerTone(p.reviewerPassRate)}
      />
    </div>
  );
}

// ── Behaviour ────────────────────────────────────────────────────────────────
function Behaviour({ report }: { report: AnalyticsReport }) {
  const b = report.behavioural;
  const maxMix = Math.max(1, ...b.eventMix.map((e) => e.count));
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Events / session"
          value={fmt(b.avgEventsPerSession, { dp: 1 })}
        />
        <StatCard
          label="Inputs / session"
          value={fmt(b.avgInputsPerSession, { dp: 1 })}
        />
        <StatCard
          label="Input cadence"
          value={fmtDuration(b.avgInputIntervalSec)}
          hint="between inputs"
        />
        <StatCard
          label="Paste ratio"
          value={
            b.pasteRatio == null ? "—" : `${Math.round(b.pasteRatio * 100)}%`
          }
          hint="of input"
        />
      </div>

      <SectionTitle>Event mix</SectionTitle>
      {b.eventMix.length === 0 ? (
        <p className="text-muted-foreground text-sm">No events recorded.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {b.eventMix.map((e) => (
            <BarRow
              key={e.type}
              label={EVENT_LABELS[e.type] ?? e.type}
              value={e.count}
              max={maxMix}
            />
          ))}
        </div>
      )}

      {b.emptySessionCount > 0 && (
        <p className="text-muted-foreground mt-4 text-xs">
          {b.emptySessionCount} session(s) had no recorded activity.
        </p>
      )}
    </div>
  );
}

// ── Intelligence (per-provider, outcome-correlated) ──────────────────────────
function Intelligence({ report }: { report: AnalyticsReport }) {
  if (report.intelligence.length === 0) {
    return <p className="text-muted-foreground text-sm">No provider data.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs">
            <th className="bg-background sticky left-0 py-2 pr-3 font-medium">
              Provider
            </th>
            <th className="px-3 py-2 text-right font-medium">Sessions</th>
            <th className="px-3 py-2 text-right font-medium">Merged</th>
            <th className="px-3 py-2 text-right font-medium">Merge rate</th>
            <th className="px-3 py-2 text-right font-medium">Reviewer pass</th>
            <th className="px-3 py-2 text-right font-medium">$/PR</th>
            <th className="py-2 pl-3 text-right font-medium">Score</th>
          </tr>
        </thead>
        <tbody>
          {report.intelligence.map((p) => (
            <tr key={p.agent} className="border-b last:border-0">
              <td className="bg-card sticky left-0 py-2 pr-3 font-medium capitalize">
                {p.agent}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.sessionCount}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.mergedPrCount}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.prMergeRate == null
                  ? "—"
                  : `${Math.round(p.prMergeRate * 100)}%`}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.reviewerPassRate == null
                  ? "—"
                  : `${Math.round(p.reviewerPassRate * 100)}%`}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.costPerMergedPr == null
                  ? "—"
                  : `$${p.costPerMergedPr.toFixed(2)}`}
              </td>
              <td className="py-2 pl-3 text-right font-semibold tabular-nums">
                {p.effectivenessScore == null
                  ? "—"
                  : p.effectivenessScore.toFixed(0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted-foreground mt-3 text-xs">
        Score blends PR merge rate + reviewer pass rate (0–100). Shown only when
        outcome signals exist — no vanity scores.
      </p>
    </div>
  );
}

// ── Trends ───────────────────────────────────────────────────────────────────
function Trends({ report }: { report: AnalyticsReport }) {
  const t = report.trends;
  return (
    <div className="flex flex-col gap-5">
      <TrendChart
        label="Sessions / day"
        values={t.points.map((p) => p.sessions)}
        days={t.points.map((p) => p.day)}
        slope={t.sessionSlopePerDay}
        slopeSuffix="/day"
        slopeTone="up-good"
      />
      <TrendChart
        label="Cost / day (USD)"
        values={t.points.map((p) => p.costUsd)}
        days={t.points.map((p) => p.day)}
        slope={t.costSlopePerDay}
        prefix="$"
        slopePrefix="$"
        slopeSuffix="/day"
        slopeTone="up-bad"
      />
      <TrendChart
        label="Inputs / day"
        values={t.points.map((p) => p.inputs)}
        days={t.points.map((p) => p.day)}
      />
      <TrendChart
        label="Merged PRs / day"
        values={t.points.map((p) => p.mergedPrs)}
        days={t.points.map((p) => p.day)}
      />
    </div>
  );
}

function TrendChart({
  label,
  values,
  days,
  slope,
  prefix = "",
  slopePrefix = "",
  slopeSuffix = "",
  slopeTone = "neutral",
}: {
  label: string;
  values: number[];
  days: string[];
  slope?: number | null;
  prefix?: string;
  slopePrefix?: string;
  slopeSuffix?: string;
  slopeTone?: "up-good" | "up-bad" | "neutral";
}) {
  const total = values.reduce((a, b) => a + b, 0);
  // Color the slope by metric intent: rising sessions/PRs is good (green),
  // rising cost is bad (red); neutral metrics stay muted.
  const slopeColor =
    slope == null || slope === 0 || slopeTone === "neutral"
      ? "text-muted-foreground"
      : slope > 0 === (slopeTone === "up-good")
        ? "text-emerald-400"
        : "text-yellow-400";
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className={cn("text-xs tabular-nums", slopeColor)}>
          Σ {prefix}
          {total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          {slope != null && (
            <>
              {" · "}
              {slope >= 0 ? "↑" : "↓"} {slopePrefix}
              {Math.abs(slope).toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}
              {slopeSuffix}
            </>
          )}
        </span>
      </div>
      <Sparkline
        values={values}
        height={48}
        label={`${label}: ${days[0]} to ${days[days.length - 1]}, total ${prefix}${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
      />
      <div className="text-muted-foreground mt-1 flex justify-between text-xs">
        <span>{days[0]}</span>
        <span>{days[days.length - 1]}</span>
      </div>
    </div>
  );
}

// ── Issues ───────────────────────────────────────────────────────────────────
function Issues({ report }: { report: AnalyticsReport }) {
  if (report.issues.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center text-sm">
        <AlertTriangle className="h-6 w-6 opacity-40" />
        No issues detected in this window. All clear.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {report.issues.map((iss, i) => (
        <IssueRow key={i} severity={iss.severity} message={iss.message} />
      ))}
    </div>
  );
}

function IssueRow({
  severity,
  message,
}: {
  severity: "info" | "warning" | "critical";
  message: string;
}) {
  const tone =
    severity === "critical"
      ? "border-red-500/40 bg-red-500/10 text-red-300"
      : severity === "warning"
        ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-200"
        : "border-border bg-muted/40 text-muted-foreground";
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-sm",
        tone
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
