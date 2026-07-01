"use client";

import { History, ListFilter, Download, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Plain-language "How Activity works" guide, shown in the Activity view's content
 * area (toggled by the header "?"), mirroring AnalyticsHelp / DispatchHelp.
 */
export function ActivityHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label="How Activity works"
      className="mx-auto max-w-2xl space-y-5 text-sm"
    >
      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <History className="h-4 w-4" aria-hidden="true" /> What is Activity?
        </h3>
        <p className="text-muted-foreground">
          The raw, time-ordered audit trail of what your fleet did — every
          session created or stopped, every keystroke/paste sent through Stoa,
          and every command or workflow the chatbox proposed. It&apos;s built
          from the same on-box ledger that powers Insight, so nothing leaves
          your machine. Insight <em>summarizes</em>; Activity shows the
          individual events.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <ListFilter className="h-4 w-4" aria-hidden="true" /> Filtering
        </h3>
        <p className="text-muted-foreground">
          Narrow by <span className="text-foreground">time window</span> (last
          24 hours, 7 or 30 days, or everything) and by{" "}
          <span className="text-foreground">category</span> — lifecycle, input,
          commands, or workflows. The newest events are listed first.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Download className="h-4 w-4" aria-hidden="true" /> Export
        </h3>
        <p className="text-muted-foreground">
          Download the filtered trail as{" "}
          <span className="text-foreground">CSV</span> (for a spreadsheet) or{" "}
          <span className="text-foreground">JSON</span> (for tooling). The
          export covers the filtered set (up to the newest 10,000 events), not
          just the page on screen.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Privacy
        </h3>
        <p className="text-muted-foreground">
          Typed/pasted text is recorded only as a length by default; the full
          text is captured only if you set <code>STOA_AUDIT_INPUT_TEXT=1</code>.
          Auditing itself can be turned off with <code>STOA_AUDIT=0</code>.
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
