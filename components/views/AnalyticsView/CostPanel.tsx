"use client";

/**
 * Cost panel — a lens inside the Insight view that turns the live cost API into
 * an actionable dashboard. Shows fleet totals, per-session and per-model
 * breakdowns, budget status, and a durable spend sparkline from the history API.
 *
 * All data is read from existing hooks; this component is presentational + small
 * pure aggregators that are unit-tested.
 */

import { useMemo, useState } from "react";
import { DollarSign, AlertTriangle, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatCard, Sparkline, fmt } from "./primitives";
import { useSessionCosts } from "@/hooks/useSessionCosts";
import { useSessionCostHistory } from "@/hooks/useSessionCostHistory";
import type { SessionCost } from "@/app/api/sessions/cost/route";
import type { BudgetLevel } from "@/lib/budget";

const HISTORY_DAYS = 14;

/** Format a cost amount consistently with the rest of the UI. */
export function formatCost(n: number | null | undefined): string {
  if (n == null || n === 0) return "$0.00";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** Aggregate session costs by model. Returns entries sorted by cost descending. */
export function aggregateByModel(
  sessions: Record<string, SessionCost>
): Array<{ model: string; costUsd: number; sessions: number }> {
  const map = new Map<string, { costUsd: number; sessions: number }>();
  for (const s of Object.values(sessions)) {
    if (!s.costUsd || s.costUsd <= 0) continue;
    const model = s.model || "Unknown";
    const cur = map.get(model) ?? { costUsd: 0, sessions: 0 };
    cur.costUsd += s.costUsd;
    cur.sessions += 1;
    map.set(model, cur);
  }
  return Array.from(map.entries())
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/** Aggregate session costs by provider from the agent type embedded in the cost name. */
export function aggregateByProvider(
  sessions: Record<string, SessionCost>
): Array<{ provider: string; costUsd: number; sessions: number }> {
  const map = new Map<string, { costUsd: number; sessions: number }>();
  for (const s of Object.values(sessions)) {
    if (!s.costUsd || s.costUsd <= 0) continue;
    // Best-effort provider label: the cost name may be "agent — description";
    // if it isn't, fall back to the model, then Unknown so the UI always
    // degrades gracefully.
    const hasProviderPrefix = s.name.includes(" — ");
    const provider = hasProviderPrefix
      ? s.name.split(" — ")[0]
      : s.model || "Unknown";
    const cur = map.get(provider) ?? { costUsd: 0, sessions: 0 };
    cur.costUsd += s.costUsd;
    cur.sessions += 1;
    map.set(provider, cur);
  }
  return Array.from(map.entries())
    .map(([provider, v]) => ({ provider, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

function budgetTone(
  level: BudgetLevel | undefined
): "default" | "good" | "warn" | "bad" {
  if (level === "hard") return "bad";
  if (level === "soft") return "warn";
  return "default";
}

function BudgetRow({
  label,
  value,
  level,
}: {
  label: string;
  value: string;
  level?: BudgetLevel | "untracked";
}) {
  const tone =
    level === "hard"
      ? "text-red-400"
      : level === "soft"
        ? "text-yellow-400"
        : "text-muted-foreground";
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", tone)}>{value}</span>
    </div>
  );
}

export function CostPanel() {
  const [showModelBreakdown, setShowModelBreakdown] = useState(true);
  const { data, isLoading, isError, refetch } = useSessionCosts();
  const {
    data: history,
    isLoading: historyLoading,
    isError: historyError,
  } = useSessionCostHistory(HISTORY_DAYS);

  const sessions = data?.sessions ?? {};
  const totalUsd = data?.totalUsd ?? 0;
  const budget = data?.budget;
  const levels = data?.levels ?? {};

  const byModel = useMemo(() => aggregateByModel(sessions), [sessions]);
  const byProvider = useMemo(() => aggregateByProvider(sessions), [sessions]);
  const sortedSessions = useMemo(
    () =>
      Object.entries(sessions)
        .filter(([, s]) => (s.costUsd ?? 0) > 0)
        .sort(([, a], [, b]) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
    [sessions]
  );

  const breakdownRows = useMemo(
    () =>
      showModelBreakdown
        ? byModel.map((r) => ({
            label: r.model,
            sessions: r.sessions,
            costUsd: r.costUsd,
          }))
        : byProvider.map((r) => ({
            label: r.provider,
            sessions: r.sessions,
            costUsd: r.costUsd,
          })),
    [showModelBreakdown, byModel, byProvider]
  );

  const historyValues = useMemo(
    () => history?.fleet.map((p) => p.costUsd) ?? [],
    [history]
  );
  const historyTotal = history?.totalUsd ?? 0;
  const untrackedCount = Object.values(sessions).filter(
    (s) => s.trackable && !s.supported
  ).length;
  const anyHard = Object.values(levels).some((l) => l === "hard");
  const anySoft = Object.values(levels).some((l) => l === "soft");

  if (isLoading) return <Centered>Loading cost data…</Centered>;
  if (isError)
    return (
      <Centered>
        Failed to load costs.{" "}
        <button onClick={() => refetch()} className="text-primary underline">
          Retry
        </button>
      </Centered>
    );

  return (
    <div className="flex flex-col gap-4">
      {/* Header stats */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Live fleet spend"
          value={formatCost(totalUsd)}
          tone={anyHard ? "bad" : anySoft ? "warn" : "default"}
          hint={
            untrackedCount > 0
              ? `${untrackedCount} untracked session${untrackedCount === 1 ? "" : "s"}`
              : undefined
          }
        />
        <StatCard
          label="Last 14 days"
          value={formatCost(historyTotal)}
          hint="Durable history (survives session deletion)"
        />
        <StatCard
          label="Active sessions"
          value={sortedSessions.length.toString()}
          hint={
            Object.keys(sessions).length > 0
              ? `${Object.keys(sessions).length} total tracked`
              : "No tracked sessions"
          }
        />
        <StatCard
          label="Budget cap"
          value={budget?.hardUsd ? formatCost(budget.hardUsd) : "—"}
          tone={anyHard ? "bad" : anySoft ? "warn" : "default"}
          hint={
            budget?.softUsd
              ? `Soft warning at ${formatCost(budget.softUsd)}`
              : "No cap configured"
          }
        />
      </div>

      {/* Budget alert banner */}
      {anyHard && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>
            One or more sessions exceeded the hard budget cap. Review the
            session list below.
          </span>
        </div>
      )}
      {!anyHard && anySoft && (
        <div className="flex items-center gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-400">
          <TrendingUp className="h-4 w-4 flex-shrink-0" />
          <span>
            One or more sessions crossed the soft budget warning threshold.
          </span>
        </div>
      )}

      {/* Spend trend */}
      <div className="bg-card rounded-lg border p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium">
            <DollarSign className="h-4 w-4" />
            Spend trend (last {HISTORY_DAYS} days)
          </span>
          <span className="text-muted-foreground text-xs">
            {historyError
              ? "History unavailable"
              : `${historyValues.length} days sampled`}
          </span>
        </div>
        <Sparkline
          values={historyValues}
          height={60}
          label={`Fleet spend over the last ${HISTORY_DAYS} days`}
        />
        <div className="text-muted-foreground mt-2 text-xs">
          Total sampled: {formatCost(historyTotal)}
        </div>
      </div>

      {/* Breakdown toggles */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={showModelBreakdown}
          onClick={() => setShowModelBreakdown(true)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            showModelBreakdown
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground"
          )}
        >
          By model
        </button>
        <button
          type="button"
          aria-pressed={!showModelBreakdown}
          onClick={() => setShowModelBreakdown(false)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            !showModelBreakdown
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground"
          )}
        >
          By provider
        </button>
      </div>

      {/* Breakdown table */}
      <div className="bg-card rounded-lg border">
        <div className="text-muted-foreground grid grid-cols-3 gap-3 border-b px-3 py-2 text-xs font-medium">
          <span>{showModelBreakdown ? "Model" : "Provider"}</span>
          <span className="text-right">Sessions</span>
          <span className="text-right">Cost</span>
        </div>
        <div className="max-h-48 overflow-y-auto">
          {breakdownRows.length === 0 ? (
            <div className="text-muted-foreground px-3 py-4 text-center text-sm">
              No cost data yet. Run a tracked agent session to see breakdowns.
            </div>
          ) : (
            breakdownRows.map((row) => (
              <div
                key={row.label}
                className="hover:bg-muted/50 grid grid-cols-3 gap-3 px-3 py-2 text-sm"
              >
                <span className="truncate" title={row.label}>
                  {row.label}
                </span>
                <span className="text-right tabular-nums">{row.sessions}</span>
                <span className="text-right tabular-nums">
                  {formatCost(row.costUsd)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="bg-card rounded-lg border">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Per-session spend</span>
          <span className="text-muted-foreground text-xs">
            Top {Math.min(sortedSessions.length, 10)} of {sortedSessions.length}
          </span>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {sortedSessions.length === 0 ? (
            <div className="text-muted-foreground px-3 py-4 text-center text-sm">
              No sessions with positive cost estimates.
            </div>
          ) : (
            sortedSessions.slice(0, 10).map(([id, s]) => (
              <div
                key={id}
                className="hover:bg-muted/50 flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate" title={s.name}>
                  {levels[id] === "hard" && (
                    <span className="mr-1 text-red-400">🛑</span>
                  )}
                  {levels[id] === "soft" && (
                    <span className="mr-1 text-yellow-400">⚠️</span>
                  )}
                  {s.name}
                </span>
                <span className="text-muted-foreground text-xs">
                  {s.model || "Unknown"}
                </span>
                <span className="tabular-nums">{formatCost(s.costUsd)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
      {children}
    </div>
  );
}
