"use client";

import { useMemo, useState } from "react";
import { Inbox, HelpCircle, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fleetNavEntry, NavIconButton } from "@/components/nav/fleet-nav";
import { useInbox, type InboxItem } from "@/data/verdict-inbox/queries";
import { needsMe } from "@/lib/verdict-inbox-selectors";
import { InboxCard } from "./InboxCard";
import { VerdictInboxHelp } from "./VerdictInboxHelp";

type Filter = "all" | "needs-me" | "in-review" | "approved";

/**
 * Verdict Inbox — a fleet-wide review queue (dispatch PRs + auto-mode sessions),
 * self-contained dialog opened from the nav. Each card carries the critic verdict;
 * expand for per-lens findings; merge / dismiss / retry in place.
 */
export function VerdictInboxView({
  open,
  onOpenChange,
  onOpenSession,
  onOpenDispatch,
  onOpenWorkflows,
  onOpenFleetBoard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Jump into a row's live worker session (ceremony items carry a session id).
   * Wired in page.tsx like WorkflowsView: look it up, close the dialog, attach. */
  onOpenSession?: (sessionId: string) => void;
  /** Jump to a sibling fleet dialog (closes this one, opens the target).
   * Optional — each renders an icon in the header; wired in app/page.tsx. */
  onOpenDispatch?: () => void;
  onOpenWorkflows?: () => void;
  onOpenFleetBoard?: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [showHelp, setShowHelp] = useState(false);
  const {
    data: items = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useInbox(open);

  const inReview = (i: InboxItem) =>
    i.reviewGate && !i.reviewDecision && i.state !== "failed";
  const approved = (i: InboxItem) => i.reviewDecision === "APPROVED";

  const {
    filtered,
    counts: { allCount, needsMeCount, inReviewCount, approvedCount },
  } = useMemo(() => {
    const match = (i: InboxItem) =>
      filter === "needs-me"
        ? needsMe(i)
        : filter === "in-review"
          ? inReview(i)
          : filter === "approved"
            ? approved(i)
            : true;
    return {
      filtered: items.filter(match),
      counts: {
        allCount: items.length,
        needsMeCount: items.filter(needsMe).length,
        inReviewCount: items.filter(inReview).length,
        approvedCount: items.filter(approved).length,
      },
    };
  }, [items, filter]);

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: allCount },
    { key: "needs-me", label: "Needs me", count: needsMeCount },
    {
      key: "in-review",
      label: "In review",
      count: inReviewCount,
    },
    {
      key: "approved",
      label: "Approved",
      count: approvedCount,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="space-y-1 px-6 pt-6 pb-3 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Inbox className="h-5 w-5" />
            Verdict Inbox
          </DialogTitle>
          <DialogDescription>
            Every PR awaiting your review — Dispatch workers and auto-mode
            sessions in one queue, with the critic’s per-lens verdict. Tap{" "}
            <span className="font-medium">?</span> for a guide.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2 px-6 pb-3">
          <SegmentedTabs
            ariaLabel="Verdict inbox filters"
            value={filter}
            onChange={(key) => {
              setFilter(key);
              setShowHelp(false);
            }}
            tabs={tabs.map((t) => ({
              key: t.key,
              label: t.label,
              badge: { count: t.count },
            }))}
          />
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
            {onOpenFleetBoard && (
              <NavIconButton
                entry={fleetNavEntry("fleet-board")}
                onClick={onOpenFleetBoard}
                variant="header"
                tooltipSide="bottom"
              />
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="How the Verdict Inbox works"
              title="How the Verdict Inbox works"
              aria-pressed={showHelp}
              onClick={() => setShowHelp((v) => !v)}
            >
              <HelpCircle className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {showHelp ? (
            <VerdictInboxHelp onClose={() => setShowHelp(false)} />
          ) : isLoading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center px-4 py-12">
              <AlertCircle className="text-destructive/50 mb-3 h-10 w-10" />
              <p className="text-destructive mb-2 text-sm">
                Failed to load the queue
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
          ) : filtered.length === 0 ? (
            <div className="text-muted-foreground py-10 text-center text-sm">
              {filter === "needs-me"
                ? "Nothing needs you right now."
                : filter === "in-review"
                  ? "Nothing in review."
                  : filter === "approved"
                    ? "Nothing approved yet."
                    : "Nothing here — no PRs awaiting review."}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((i) => (
                <InboxCard
                  key={`${i.type}:${i.id}`}
                  item={i}
                  onOpenSession={onOpenSession}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
