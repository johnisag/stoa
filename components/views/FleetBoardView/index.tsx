"use client";

import { useState } from "react";
import { Columns3, HelpCircle, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fleetNavEntry, NavIconButton } from "@/components/nav/fleet-nav";
import { useFleetBoard } from "@/data/fleet-board/useFleetBoard";
import { LANES, cardNeedsMe } from "@/lib/fleet-board/lanes";
import { FleetCard } from "./FleetCard";
import { FleetBoardHelp } from "./FleetBoardHelp";

/**
 * Fleet Board — a kanban of the autonomous fleet (dispatch tasks + auto-mode
 * sessions) across lifecycle lanes, so "what needs me?" is one glance. A
 * self-contained dialog opened from the nav, mirroring the Verdict Inbox (whose
 * read model + cards it reuses). Mobile: lanes stack vertically; desktop: columns.
 */
export function FleetBoardView({
  open,
  onOpenChange,
  onOpenSession,
  onOpenDispatch,
  onOpenWorkflows,
  onOpenVerdictInbox,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Jump into a card's live worker session (ceremony rows carry a session id).
   * Threaded through FleetCard -> InboxCard; wired in page.tsx like WorkflowsView. */
  onOpenSession?: (sessionId: string) => void;
  /** Jump to a sibling fleet dialog (closes this one, opens the target).
   * Optional — each renders an icon in the header; wired in app/page.tsx. */
  onOpenDispatch?: () => void;
  onOpenWorkflows?: () => void;
  onOpenVerdictInbox?: () => void;
}) {
  const [showHelp, setShowHelp] = useState(false);
  const {
    lanes,
    repoById,
    total,
    needsMeCount,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useFleetBoard(open);
  // Surfaced in the header so "what needs me?" is answered without scrolling. Same
  // count as the nav badge (countNeedsMe over the shared inbox) — no drift.
  const attentionCount = needsMeCount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[calc(100%-2rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="space-y-1 px-6 pt-6 pb-3 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Columns3 className="h-5 w-5" />
            Fleet Board
          </DialogTitle>
          <DialogDescription>
            The autonomous fleet by stage — dispatched tasks and auto-mode
            sessions, queued through merged. Tap{" "}
            <span className="font-medium">?</span> for a guide.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2 px-6 pb-3">
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            {isLoading ? (
              "…"
            ) : (
              <>
                {total} on the board
                {attentionCount > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 text-amber-600 dark:text-amber-400">
                    {attentionCount} need you
                  </span>
                )}
              </>
            )}
          </span>
          <div className="flex items-center gap-0.5">
            {/* Jump to a sibling fleet view without closing + reopening. */}
            {onOpenDispatch && (
              <NavIconButton
                entry={fleetNavEntry("dispatch")}
                onClick={onOpenDispatch}
                variant="header"
                tooltipSide="bottom"
              />
            )}
            {onOpenWorkflows && (
              <NavIconButton
                entry={fleetNavEntry("workflows")}
                onClick={onOpenWorkflows}
                variant="header"
                tooltipSide="bottom"
              />
            )}
            {onOpenVerdictInbox && (
              <NavIconButton
                entry={fleetNavEntry("verdict-inbox")}
                onClick={onOpenVerdictInbox}
                variant="header"
                tooltipSide="bottom"
              />
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="How the Fleet Board works"
              title="How the Fleet Board works"
              aria-pressed={showHelp}
              onClick={() => setShowHelp((v) => !v)}
            >
              <HelpCircle className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-6 pb-6">
          {showHelp ? (
            <FleetBoardHelp onClose={() => setShowHelp(false)} />
          ) : isLoading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center px-4 py-12">
              <AlertCircle className="text-destructive/50 mb-3 h-10 w-10" />
              <p className="text-destructive mb-2 text-sm">
                Failed to load the board
              </p>
              <p className="text-muted-foreground mb-4 text-xs">
                {isFetching ? "Retrying…" : "Tap retry to try again."}
              </p>
              <Button
                variant="outline"
                onClick={() => refetch()}
                disabled={isFetching}
                className="gap-2"
              >
                {isFetching && <Loader2 className="h-4 w-4 animate-spin" />}
                Retry
              </Button>
            </div>
          ) : total === 0 ? (
            <div className="text-muted-foreground py-10 text-center text-sm">
              Fleet idle — dispatch a task, or flip a session to auto mode.
            </div>
          ) : (
            // Mobile: lanes stack vertically (each full-width), no horizontal scroll
            // (it fights the swipe-to-open sidebar). Desktop: sm:w-max makes the row
            // wider than the dialog so the OUTER overflow-auto scrolls both axes —
            // which keeps the sticky lane headers pinned (an inner overflow-x-auto
            // would break them).
            <div className="flex flex-col gap-4 sm:w-max sm:flex-row sm:gap-3">
              {LANES.map((lane) => {
                const all = lanes[lane.id];
                // The merged lane is the full (unbounded) history — cap it.
                const cards = lane.id === "merged" ? all.slice(0, 12) : all;
                const hidden = all.length - cards.length;
                // Highlight a lane iff it actually holds cards that need the human
                // (the same predicate behind the header pill), so the amber lanes
                // and the pill add up — a CHANGES_REQUESTED card in "In review"
                // now highlights, instead of only the verified/failed columns.
                const attention = all.some(cardNeedsMe);
                return (
                  <div
                    key={lane.id}
                    className="flex shrink-0 flex-col gap-2 sm:w-80"
                  >
                    <div className="bg-background/95 sticky top-0 z-10 flex items-center gap-2 py-1 text-xs font-medium">
                      <span
                        className={cn(
                          attention
                            ? "text-foreground"
                            : "text-muted-foreground"
                        )}
                      >
                        {lane.label}
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-1.5 text-[11px]",
                          attention
                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                            : "bg-foreground/10 text-muted-foreground"
                        )}
                      >
                        {all.length}
                      </span>
                    </div>
                    {all.length === 0 ? (
                      <p className="text-muted-foreground/60 px-1 text-xs">—</p>
                    ) : (
                      <>
                        {cards.map((card) => (
                          <FleetCard
                            key={card.key}
                            card={card}
                            repoById={repoById}
                            onOpenSession={onOpenSession}
                          />
                        ))}
                        {hidden > 0 && (
                          <p className="text-muted-foreground/60 px-1 text-xs">
                            +{hidden} more
                          </p>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
