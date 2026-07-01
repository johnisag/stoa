"use client";

/**
 * Fleet bar (#15) — an always-visible strip that ranks live sessions by WHO NEEDS
 * YOU NOW. Actionable sessions (blocked on your input, or errored) render as ranked
 * clickable chips; the rest (idle-done, running) are summarized as trailing counts
 * so the bar stays focused on attention, not a full session dump. Clicking a chip
 * focuses that session. Reads the SAME live `sessionStatuses` the sidebar does (no
 * new polling), and reuses `countNeedsAttention` for the "N need you" count so it
 * can never drift from the sidebar badge.
 */

import { memo, useMemo } from "react";
import { AlertCircle, Circle } from "lucide-react";
import type { Session } from "@/lib/db";
import type { SessionStatus } from "@/components/views/types";
import {
  attentionTier,
  rankSessionsByAttention,
  countNeedsAttention,
} from "@/lib/session-attention";
import { cn } from "@/lib/utils";

/** Tiers surfaced as clickable chips — only the ones that actually need you now. */
type ChipTier = "blocked" | "errored";

const CHIP_STYLE: Record<
  ChipTier,
  { dot: string; icon: React.ReactNode; label: string }
> = {
  blocked: {
    dot: "text-yellow-500",
    icon: <AlertCircle className="h-3 w-3 animate-pulse" />,
    label: "needs input",
  },
  errored: {
    dot: "text-red-500",
    icon: <Circle className="h-2 w-2 fill-current" />,
    label: "errored",
  },
};

interface FleetBarProps {
  sessions: Session[];
  sessionStatuses: Record<string, SessionStatus>;
  /** The currently-focused session id — its chip gets a ring. */
  activeSessionId?: string;
  onSelect: (id: string) => void;
}

function FleetBarComponent({
  sessions,
  sessionStatuses,
  activeSessionId,
  onSelect,
}: FleetBarProps) {
  const { chips, needsYou, idleCount, runningCount } = useMemo(() => {
    const ranked = rankSessionsByAttention(sessions, sessionStatuses);
    const chips = ranked
      .map((session) => ({
        session,
        tier: attentionTier(sessionStatuses[session.id]?.status),
      }))
      // Only the actionable tiers become chips; idle-done + running don't need
      // you, so they're surfaced as trailing counts instead (see below).
      .filter(
        (x): x is { session: Session; tier: ChipTier } =>
          x.tier === "blocked" || x.tier === "errored"
      );
    return {
      chips,
      needsYou: countNeedsAttention(sessions, sessionStatuses),
      idleCount: sessions.filter(
        (s) => sessionStatuses[s.id]?.status === "idle"
      ).length,
      runningCount: sessions.filter(
        (s) => sessionStatuses[s.id]?.status === "running"
      ).length,
    };
  }, [sessions, sessionStatuses]);

  // Nothing live worth surfacing → render nothing (no empty bar, no layout cost).
  if (chips.length === 0 && idleCount === 0 && runningCount === 0) return null;

  // One grammatical phrasing for the aria-label + tooltip; the pill shows a
  // compact form. Both agree on singular/plural (no "1 need you").
  const summary =
    needsYou > 0
      ? `${needsYou} ${needsYou === 1 ? "session needs" : "sessions need"} you`
      : "All caught up";

  return (
    <div
      role="toolbar"
      aria-label={`Fleet: ${summary}`}
      className="border-border/60 bg-background/60 flex h-8 flex-shrink-0 items-center gap-1.5 overflow-x-auto border-b px-2 text-xs"
    >
      {/* Leading summary — amber when something needs you, muted when all clear. */}
      <span
        className={cn(
          "flex-shrink-0 rounded-full px-1.5 py-0.5 font-medium",
          needsYou > 0
            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
            : "text-muted-foreground"
        )}
        title={`Live sessions ranked by who needs you now — ${summary}`}
      >
        {needsYou > 0
          ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you`
          : "All caught up"}
      </span>

      {/* Ranked attention chips (blocked first, then errored). */}
      {chips.map(({ session, tier }) => {
        const style = CHIP_STYLE[tier];
        const isActive = session.id === activeSessionId;
        return (
          <button
            key={session.id}
            type="button"
            onClick={() => onSelect(session.id)}
            title={`${session.name} — ${style.label}`}
            aria-label={`${session.name}, ${style.label}`}
            className={cn(
              "flex max-w-[16ch] flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
              "hover:bg-muted",
              isActive && "bg-muted ring-primary/40 ring-1"
            )}
          >
            <span className={cn("flex-shrink-0", style.dot)}>{style.icon}</span>
            <span className="truncate">{session.name}</span>
          </button>
        );
      })}

      {/* Trailing muted counts — idle before running, honoring the rank. These
          don't need you, so they're a count, not chips. */}
      {(idleCount > 0 || runningCount > 0) && (
        <span className="text-muted-foreground flex-shrink-0 pl-1 whitespace-nowrap">
          {[
            idleCount > 0 ? `${idleCount} idle` : null,
            runningCount > 0 ? `${runningCount} running` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </div>
  );
}

export const FleetBar = memo(FleetBarComponent);
