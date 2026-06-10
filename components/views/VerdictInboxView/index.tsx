"use client";

import { useState } from "react";
import { Inbox, HelpCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useInbox, type InboxItem } from "@/data/verdict-inbox/queries";
import { InboxCard } from "./InboxCard";
import { VerdictInboxHelp } from "./VerdictInboxHelp";

type Filter = "all" | "needs-me" | "in-review" | "approved";

/** A row needs the human now: changes requested, failed, stuck, or approved+green
 * and waiting on a (non-auto) merge. */
function needsMe(i: InboxItem): boolean {
  return (
    i.reviewDecision === "CHANGES_REQUESTED" ||
    i.state === "failed" ||
    i.state === "stuck" ||
    i.state === "awaiting_merge"
  );
}

/**
 * Verdict Inbox — a fleet-wide review queue (dispatch PRs + auto-mode sessions),
 * self-contained dialog opened from the nav. Each card carries the critic verdict;
 * expand for per-lens findings; merge / dismiss / retry in place.
 */
export function VerdictInboxView({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [showHelp, setShowHelp] = useState(false);
  const { data: items = [], isLoading, isError } = useInbox(open);

  const filtered = items.filter((i) => {
    if (filter === "needs-me") return needsMe(i);
    if (filter === "in-review")
      return !i.reviewDecision && i.state !== "failed";
    if (filter === "approved") return i.reviewDecision === "APPROVED";
    return true;
  });

  const tabs: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: items.length },
    { key: "needs-me", label: "Needs me", count: items.filter(needsMe).length },
    { key: "in-review", label: "In review" },
    { key: "approved", label: "Approved" },
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

        <div className="flex items-center justify-between px-6 pb-3">
          <div className="bg-muted inline-flex rounded-md p-0.5 text-sm">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={filter === t.key}
                onClick={() => {
                  setFilter(t.key);
                  setShowHelp(false);
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded px-3 py-1 transition-colors",
                  filter === t.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className="bg-foreground/10 rounded-full px-1.5 text-xs">
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>
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

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {showHelp ? (
            <VerdictInboxHelp onClose={() => setShowHelp(false)} />
          ) : isLoading ? (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : isError ? (
            <div className="py-10 text-center text-sm text-red-500">
              Failed to load the queue. Retrying…
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-muted-foreground py-10 text-center text-sm">
              Nothing here — no PRs awaiting review.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((i) => (
                <InboxCard key={`${i.type}:${i.id}`} item={i} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
