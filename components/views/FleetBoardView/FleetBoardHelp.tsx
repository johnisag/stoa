"use client";

import { Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Plain-language guide for the fleet board, shown in the dialog (toggled by ?). */
export function FleetBoardHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label="How the Fleet Board works"
      className="mx-auto max-w-2xl space-y-5 text-sm"
    >
      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Columns3 className="h-4 w-4" aria-hidden="true" /> What is the Fleet
          Board?
        </h3>
        <p className="text-muted-foreground">
          One spatial view of everything the autonomous fleet is doing right now
          — every dispatched task and auto-mode session — laid out by the stage
          it&apos;s in. It answers &quot;what needs me?&quot; at a glance.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-base font-semibold">The lanes</h3>
        <ul className="text-muted-foreground space-y-1">
          <li>
            <span className="text-foreground font-medium">Queued</span> —
            waiting for a worker (backlog + due scheduled tasks), or for your
            approval in the Dispatch backlog on review-mode repos.
          </li>
          <li>
            <span className="text-foreground font-medium">Working</span> — a
            worker is implementing or fixing.
          </li>
          <li>
            <span className="text-foreground font-medium">In review</span> — the
            critic panel is reviewing, or a fix round is in flight; no verdict
            yet.
          </li>
          <li>
            <span className="text-foreground font-medium">Ready</span> —
            approved (or no critic configured) and waiting on a merge.{" "}
            <span className="text-foreground">
              This is the lane that wants you
            </span>{" "}
            when auto-merge is off.
          </li>
          <li>
            <span className="text-foreground font-medium">Merged</span> —
            recently landed dispatched tasks (an auto-mode session leaves the
            board once it merges).
          </li>
          <li>
            <span className="text-foreground font-medium">Failed</span> — a
            worker gave up or got stuck; needs a human.
          </li>
        </ul>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-base font-semibold">Acting on a card</h3>
        <p className="text-muted-foreground">
          Cards in the review/verified/failed lanes are the same cards as the
          Verdict Inbox — expand for the critic&apos;s per-lens findings, and{" "}
          <span className="text-foreground">merge, dismiss, or retry</span>{" "}
          right here. The board refreshes itself every few seconds while
          it&apos;s open. Plain interactive sessions aren&apos;t shown — they
          live in the sidebar.
        </p>
      </section>

      <div className="pt-1">
        <Button size="sm" onClick={onClose}>
          Got it
        </Button>
      </div>
    </div>
  );
}
