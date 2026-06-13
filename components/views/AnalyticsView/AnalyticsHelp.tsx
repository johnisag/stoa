"use client";

import {
  BarChart3,
  Gauge,
  Activity,
  Brain,
  TrendingUp,
  AlertTriangle,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Plain-language "How Insight works" guide. Shown in the Analytics dialog's content
 * area (toggled by the header "?"), mirroring DispatchHelp / FleetBoardHelp /
 * WorkflowsHelp. Jargon-light on purpose.
 */
export function AnalyticsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label="How Insight works"
      className="mx-auto max-w-2xl space-y-5 text-sm"
    >
      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <BarChart3 className="h-4 w-4" aria-hidden="true" /> What is Insight?
        </h3>
        <p className="text-muted-foreground">
          A cockpit over everything your agents did — built entirely from an
          on-box activity ledger, so nothing leaves your machine. Pick a window
          (7, 14, or 30 days) and read it across a few lenses.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Users className="h-4 w-4" aria-hidden="true" /> Every session counts
        </h3>
        <p className="text-muted-foreground">
          Insight tracks <em>all</em> your sessions — not only the ones Dispatch
          starts on its own. The Overview shows the split:{" "}
          <span className="text-foreground font-medium">from Dispatch</span>{" "}
          (autonomous workers) vs{" "}
          <span className="text-foreground font-medium">standalone</span> (the
          ones you open yourself, plus workflow runs). So a quick terminal
          session you start by hand shows up here too.
        </p>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-base font-semibold">The lenses</h3>
        <ul className="text-muted-foreground space-y-1">
          <li>
            <span className="text-foreground inline-flex items-center gap-1 font-medium">
              <Gauge className="h-3.5 w-3.5" aria-hidden="true" /> Performance
            </span>{" "}
            — throughput, cost, tokens, how long sessions run, time to first
            input, and the reviewer pass rate.
          </li>
          <li>
            <span className="text-foreground inline-flex items-center gap-1 font-medium">
              <Activity className="h-3.5 w-3.5" aria-hidden="true" /> Behaviour
            </span>{" "}
            — what sessions actually do: the mix of events, how much you type vs
            paste, and where work stalls.
          </li>
          <li>
            <span className="text-foreground inline-flex items-center gap-1 font-medium">
              <Brain className="h-3.5 w-3.5" aria-hidden="true" /> Intelligence
            </span>{" "}
            — each provider scored against real outcomes (PRs merged, reviewer
            verdicts). Scores show only when there&apos;s real signal — no
            vanity numbers.
          </li>
          <li>
            <span className="text-foreground inline-flex items-center gap-1 font-medium">
              <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" /> Trends
            </span>{" "}
            — daily time-series for sessions, cost, inputs, and merged PRs, each
            with its direction of travel.
          </li>
          <li>
            <span className="text-foreground inline-flex items-center gap-1 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />{" "}
              Issues
            </span>{" "}
            — plain-language anomalies (cost spikes, stalled or runaway
            sessions, failure clusters, a low reviewer pass rate).
          </li>
        </ul>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-base font-semibold">A note on cost</h3>
        <p className="text-muted-foreground">
          Cost and token figures are estimated for{" "}
          <span className="text-foreground">Claude</span> sessions (read from
          their local transcripts). Other providers show{" "}
          <span className="text-foreground">n/a</span> — they don&apos;t expose
          the same data on-box, so Insight won&apos;t guess.
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
