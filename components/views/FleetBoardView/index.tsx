"use client";

import { useState } from "react";
import { Columns3, HelpCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFleetBoard } from "@/data/fleet-board/useFleetBoard";
import { LANES, ATTENTION_LANES } from "@/lib/fleet-board/lanes";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [showHelp, setShowHelp] = useState(false);
  const { lanes, repoById, total, isLoading, isError } = useFleetBoard(open);
  // The lanes that want the human — surfaced in the header so "what needs me?"
  // is answered without scrolling to the right-hand columns.
  const attentionCount = lanes.verified.length + lanes.failed.length;

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

        <div className="flex items-center justify-between px-6 pb-3">
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

        <div className="flex-1 overflow-auto px-6 pb-6">
          {showHelp ? (
            <FleetBoardHelp onClose={() => setShowHelp(false)} />
          ) : isLoading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : isError ? (
            <div className="py-10 text-center text-sm text-red-500">
              Failed to load the board. Retrying…
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
                const attention =
                  ATTENTION_LANES.has(lane.id) && all.length > 0;
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
