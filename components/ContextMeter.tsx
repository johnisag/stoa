"use client";

import { AlertTriangle, Gauge } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSessionCosts } from "@/hooks/useSessionCosts";
import { contextWindowFor, tokenMeter } from "@/lib/context-window";

const fmt = (n: number) => n.toLocaleString();
const pctLabel = (pct: number) => `${Math.round(pct * 100)}%`;

/**
 * Per-session context-window meter for the pane header: how full the agent's
 * context is (live occupancy ÷ the model's approximate window), tinted
 * muted → amber → red as it fills so silent context exhaustion is visible.
 * Self-contained (reads useSessionCosts, the same transcript-token signal
 * CostIndicator uses) so it doesn't thread token counts through every view.
 * Hidden until a tracked provider has a non-zero reading. NOT the fleet
 * $-spend badge (that's CostIndicator).
 */
export function ContextMeter({ sessionId }: { sessionId: string }) {
  const { data } = useSessionCosts();
  const cost = data?.sessions[sessionId];
  if (!cost) return null;

  if (cost.trackable && !cost.supported) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label="Context window tracking unavailable"
            className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 tabular-nums dark:text-amber-400"
          >
            <AlertTriangle className="h-3 w-3" />?
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <p className="font-medium">Context window unavailable</p>
          <p className="text-muted-foreground mt-1 text-[10px]">
            Tracking is paused until Stoa can verify this provider session.
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Hide for untracked agents / before the first reading lands.
  if (!cost.supported || cost.contextTokens <= 0) return null;

  const window =
    cost.contextWindow && cost.contextWindow > 0
      ? cost.contextWindow
      : contextWindowFor(cost.model);
  const { pct, tone } = tokenMeter(cost.contextTokens, window);

  const tint =
    tone === "full"
      ? "bg-red-500/15 text-red-600 dark:text-red-400"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Context window ${pctLabel(pct)} full`}
          className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ${tint}`}
        >
          <Gauge className="h-3 w-3" />
          {pctLabel(pct)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <p className="font-medium">Context window · {pctLabel(pct)} full</p>
        <p className="tabular-nums">
          ~{fmt(cost.contextTokens)} / {fmt(window)} tokens
        </p>
        {tone !== "ok" && (
          <p className="text-muted-foreground mt-1 text-[10px]">
            Near the limit — use “Fresh start” to summarize into a new session.
          </p>
        )}
        <p className="text-muted-foreground mt-1 text-[10px]">
          Estimate from the last turn’s input vs an approximate model cap.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
