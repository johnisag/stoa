"use client";

import { AlertTriangle, DollarSign } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSessionCosts } from "@/hooks/useSessionCosts";
import { useSessionCostHistory } from "@/hooks/useSessionCostHistory";

// Only ever called with positive amounts (rows are filtered, total is gated).
const fmt = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

const HISTORY_DAYS = 14;

/**
 * Tiny dependency-free spend sparkline — one bar per UTC day, height ∝ that day's
 * persisted fleet cost (#15). Durable history (survives session deletion), so it
 * shows even days whose sessions are long gone. Hidden until there are ≥2 points
 * with a non-zero total (a single bar isn't a trend).
 */
function SpendSparkline() {
  const { data } = useSessionCostHistory(HISTORY_DAYS);
  const fleet = data?.fleet ?? [];
  const total = data?.totalUsd ?? 0;
  const windowDays = data?.days ?? HISTORY_DAYS;
  if (fleet.length < 2 || total <= 0) return null;
  const max = Math.max(...fleet.map((p) => p.costUsd), 0);
  return (
    <div className="mt-1.5 border-t pt-1.5">
      <div className="text-muted-foreground mb-1 flex justify-between text-[10px]">
        <span>Last {windowDays}d spend</span>
        <span className="tabular-nums">{fmt(total)}</span>
      </div>
      <div
        className="flex h-6 items-end gap-px"
        aria-label={`Spend over the last ${windowDays} days: ${fmt(total)} total (one bar per active day)`}
      >
        {fleet.map((p) => (
          <div
            key={p.day}
            title={`${p.day}: ${fmt(p.costUsd)}`}
            className="flex-1 rounded-sm bg-emerald-500/40"
            style={{
              height: `${max > 0 ? Math.max(8, (p.costUsd / max) * 100) : 8}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Fleet cost badge for the sidebar header: estimated total spend across sessions,
 * with a per-session breakdown on hover. Tints amber/red when a session crosses
 * the soft/hard budget cap (if configured). Self-contained (reads useSessionCosts),
 * so it doesn't thread cost through every view + preserves the SessionCard memo.
 * Hidden until tracked providers have a non-zero estimate.
 */
export function CostIndicator() {
  const { data } = useSessionCosts();
  const unavailableCount = data
    ? Object.values(data.sessions).filter((s) => s.trackable && !s.supported)
        .length
    : 0;
  if (!data || (data.totalUsd <= 0 && unavailableCount === 0)) return null;

  const levels = data.levels ?? {};
  const levelValues = Object.values(levels);
  const worst = levelValues.includes("hard")
    ? "hard"
    : levelValues.includes("soft")
      ? "soft"
      : "ok";

  const tint =
    worst === "hard"
      ? "bg-red-500/15 text-red-600 dark:text-red-400"
      : worst === "soft" || unavailableCount > 0
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";

  const rows = Object.entries(data.sessions)
    .filter(([, s]) => s.costUsd && s.costUsd > 0)
    .sort(([, a], [, b]) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, 8);
  const unavailableRows = Object.entries(data.sessions)
    .filter(([, s]) => s.trackable && !s.supported)
    .slice(0, 8);

  const { softUsd, hardUsd } = data.budget ?? { softUsd: null, hardUsd: null };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Estimated spend across sessions: ${fmt(data.totalUsd)}${
            unavailableCount > 0
              ? `; ${unavailableCount} session${unavailableCount === 1 ? "" : "s"} not tracked`
              : ""
          }`}
          className={`focus-visible:ring-ring/60 flex cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium outline-none focus-visible:ring-2 ${tint}`}
        >
          <DollarSign className="h-3 w-3" />
          {fmt(data.totalUsd)}
          {unavailableCount > 0 && (
            <>
              <AlertTriangle className="ml-0.5 h-3 w-3" />
              <span>{unavailableCount} untracked</span>
            </>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <p className="mb-1 font-medium">Estimated spend · tracked sessions</p>
        {unavailableCount > 0 && (
          <p className="text-muted-foreground mb-1 text-[10px]">
            {unavailableCount} trackable session
            {unavailableCount === 1 ? "" : "s"} unavailable
          </p>
        )}
        <ul className="space-y-0.5">
          {rows.map(([id, s]) => (
            <li key={id} className="flex justify-between gap-3 tabular-nums">
              <span className="max-w-[12rem] truncate">
                {levels[id] === "hard"
                  ? "🛑 "
                  : levels[id] === "soft"
                    ? "⚠️ "
                    : ""}
                {s.name}
              </span>
              <span>{fmt(s.costUsd ?? 0)}</span>
            </li>
          ))}
        </ul>
        {unavailableRows.length > 0 && (
          <ul className="mt-1 space-y-0.5 border-t pt-1">
            {unavailableRows.map(([id, s]) => (
              <li key={id} className="flex justify-between gap-3">
                <span className="max-w-[12rem] truncate">{s.name}</span>
                <span className="text-amber-600 dark:text-amber-400">
                  untracked
                </span>
              </li>
            ))}
          </ul>
        )}
        {(softUsd || hardUsd) && (
          <p className="text-muted-foreground mt-1 text-[10px]">
            Cap/session: soft {softUsd ? `$${softUsd}` : "—"} · hard{" "}
            {hardUsd ? `$${hardUsd}` : "—"}
          </p>
        )}
        <SpendSparkline />
        <p className="text-muted-foreground mt-0.5 text-[10px]">
          Rough estimate from provider token telemetry and model pricing.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
