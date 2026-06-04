"use client";

import { DollarSign } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSessionCosts } from "@/hooks/useSessionCosts";

// Only ever called with positive amounts (rows are filtered, total is gated).
const fmt = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/**
 * Fleet cost badge for the sidebar header: estimated total spend across sessions,
 * with a per-session breakdown on hover. Tints amber/red when a session crosses
 * the soft/hard budget cap (if configured). Self-contained (reads useSessionCosts),
 * so it doesn't thread cost through every view + preserves the SessionCard memo.
 * Claude-only today; hidden until there's a non-zero estimate.
 */
export function CostIndicator() {
  const { data } = useSessionCosts();
  if (!data || data.totalUsd <= 0) return null;

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
      : worst === "soft"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";

  const rows = Object.entries(data.sessions)
    .filter(([, s]) => s.costUsd && s.costUsd > 0)
    .sort(([, a], [, b]) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, 8);

  const { softUsd, hardUsd } = data.budget ?? { softUsd: null, hardUsd: null };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Estimated spend across sessions: ${fmt(data.totalUsd)}`}
          className={`focus-visible:ring-ring/60 flex cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium outline-none focus-visible:ring-2 ${tint}`}
        >
          <DollarSign className="h-3 w-3" />
          {fmt(data.totalUsd)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <p className="mb-1 font-medium">Estimated spend · Claude sessions</p>
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
        {(softUsd || hardUsd) && (
          <p className="text-muted-foreground mt-1 text-[10px]">
            Cap/session: soft {softUsd ? `$${softUsd}` : "—"} · hard{" "}
            {hardUsd ? `$${hardUsd}` : "—"}
          </p>
        )}
        <p className="text-muted-foreground mt-0.5 text-[10px]">
          Rough estimate: transcript tokens × model price.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
