"use client";

import { DollarSign } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSessionCosts } from "@/hooks/useSessionCosts";

const fmt = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/**
 * Fleet cost badge for the sidebar header: estimated total spend across sessions,
 * with a per-session breakdown on hover. Self-contained (reads useSessionCosts),
 * so it doesn't thread cost through every view + preserves the SessionCard memo.
 * Claude-only today; hidden until there's a non-zero estimate.
 */
export function CostIndicator() {
  const { data } = useSessionCosts();
  if (!data || data.totalUsd <= 0) return null;

  const rows = Object.entries(data.sessions)
    .filter(([, s]) => s.costUsd && s.costUsd > 0)
    .sort(([, a], [, b]) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, 8);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Estimated spend across sessions: ${fmt(data.totalUsd)}`}
          className="focus-visible:ring-ring/60 flex cursor-default items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 outline-none focus-visible:ring-2 dark:text-emerald-400"
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
              <span className="max-w-[12rem] truncate">{s.name}</span>
              <span>{fmt(s.costUsd ?? 0)}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-1 text-[10px]">
          Rough estimate: transcript tokens × model price.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
