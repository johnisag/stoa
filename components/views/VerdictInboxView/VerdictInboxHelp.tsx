"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A short primer on the review queue. */
export function VerdictInboxHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label="How the Verdict Inbox works"
      className="flex flex-col gap-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium">The review queue</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close help"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <p className="text-muted-foreground text-xs leading-relaxed">
        One place for every PR awaiting your attention — both Dispatch workers
        and sessions you sent to{" "}
        <span className="text-foreground">Auto mode</span>. Review the fleet
        here instead of opening a GitHub tab per PR.
      </p>

      <ol className="text-muted-foreground flex flex-col gap-3 leading-relaxed">
        <li>
          <span className="text-foreground font-medium">Each row</span> shows
          the item’s aggregate verdict —{" "}
          <span className="text-foreground">in review</span>,{" "}
          <span className="text-foreground">approved</span>, or{" "}
          <span className="text-foreground">changes requested</span> — plus its
          branch, PR, and state.
        </li>
        <li>
          <span className="text-foreground font-medium">Expand a row</span> to
          read the 3-critic panel’s per-lens findings (correctness · conventions
          · simplicity), pulled live from the PR.
        </li>
        <li>
          <span className="text-foreground font-medium">Act in place</span> —
          Merge shows only when the PR is actually mergeable (approved, or an
          ungated repo); Retry a failed worker; Dismiss a failed item or Stop
          auto on a session. To overrule a{" "}
          <span className="text-foreground">changes requested</span> verdict,
          Stop auto (or open the PR) and merge it yourself.
        </li>
      </ol>

      <p className="text-muted-foreground text-xs leading-relaxed">
        The <span className="text-foreground">Dispatch</span> board runs the
        fleet; this inbox is just what’s waiting on{" "}
        <span className="text-foreground">you</span>. Coming next: risk-ranking
        (auth/db/payments paths and big deltas float to the top), a “needs me”
        push when a review stalls, and the diff inline.
      </p>
    </div>
  );
}
