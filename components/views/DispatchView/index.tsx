"use client";

import { useState } from "react";
import { Rocket, HelpCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { fleetNavEntry, NavIconButton } from "@/components/nav/fleet-nav";
import { useBoardQuery, usePendingQuery } from "@/data/dispatch/queries";
import { AllocationConsole } from "./AllocationConsole";
import { Backlog } from "./Backlog";
import { InFlightBoard } from "./InFlightBoard";
import { PlanConsole } from "./PlanConsole";
import { DispatchHelp } from "./DispatchHelp";

type Tab = "allocation" | "plan" | "backlog" | "board";

export function DispatchView({
  onOpenWorkflows,
  onOpenVerdictInbox,
  onOpenFleetBoard,
  onClose,
}: {
  /** Jump to a sibling fleet view — each renders an icon in the header; wired in
   * the pane (opens that view's tab). Optional. */
  onOpenWorkflows?: () => void;
  onOpenVerdictInbox?: () => void;
  onOpenFleetBoard?: () => void;
  /** Optional close affordance, used on mobile where the tab strip is hidden. */
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("allocation");
  const [showHelp, setShowHelp] = useState(false);
  // Drive the segmented-control counts (deduped with the panels' own queries).
  const { data: pending = [] } = usePendingQuery(true);
  const { data: board = [] } = useBoardQuery(true);
  const inFlight = board.filter(
    (d) => d.status === "dispatched" || d.status === "pr_open"
  ).length;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "allocation", label: "Allocation" },
    { key: "plan", label: "Plan" },
    { key: "backlog", label: "Backlog", count: pending.length },
    { key: "board", label: "In flight", count: inFlight },
  ];

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col gap-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <Rocket className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">Dispatch</span>
        </span>
        <div className="flex items-center gap-0.5">
          {/* Jump to a sibling fleet view (opens its tab). */}
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
            aria-label="How Dispatch works"
            title="How Dispatch works"
            aria-pressed={showHelp}
            onClick={() => setShowHelp((v) => !v)}
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close Dispatch"
              title="Close Dispatch"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="px-4 pb-2">
        <SegmentedTabs
          ariaLabel="Dispatch sections"
          value={tab}
          onChange={(key) => {
            setTab(key);
            setShowHelp(false);
          }}
          tabs={tabs.map((t) => ({
            key: t.key,
            label: t.label,
            badge: t.count != null ? { count: t.count } : undefined,
          }))}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {showHelp ? (
          <DispatchHelp onClose={() => setShowHelp(false)} />
        ) : (
          <>
            {tab === "allocation" && <AllocationConsole open={true} />}
            {tab === "plan" && <PlanConsole open={true} />}
            {tab === "backlog" && <Backlog open={true} />}
            {tab === "board" && <InFlightBoard open={true} />}
          </>
        )}
      </div>
    </div>
  );
}
