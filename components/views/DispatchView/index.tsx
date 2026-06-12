"use client";

import { useState } from "react";
import { Rocket, HelpCircle } from "lucide-react";
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
import { useBoardQuery, usePendingQuery } from "@/data/dispatch/queries";
import { AllocationConsole } from "./AllocationConsole";
import { Backlog } from "./Backlog";
import { InFlightBoard } from "./InFlightBoard";
import { PlanConsole } from "./PlanConsole";
import { DispatchHelp } from "./DispatchHelp";

type Tab = "allocation" | "plan" | "backlog" | "board";

export function DispatchView({
  open,
  onOpenChange,
  onOpenWorkflows,
  onOpenVerdictInbox,
  onOpenFleetBoard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Jump to a sibling fleet dialog (closes this one, opens the target).
   * Optional — each renders an icon in the header; wired in app/page.tsx. */
  onOpenWorkflows?: () => void;
  onOpenVerdictInbox?: () => void;
  onOpenFleetBoard?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("allocation");
  const [showHelp, setShowHelp] = useState(false);
  // Drive the segmented-control counts (deduped with the panels' own queries).
  const { data: pending = [] } = usePendingQuery(open);
  const { data: board = [] } = useBoardQuery(open);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[calc(100%-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="space-y-1 px-6 pt-6 pb-3 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5" />
            Dispatch
          </DialogTitle>
          <DialogDescription>
            Connect a GitHub repo and let an AI agent work on each issue — then
            review and accept the changes. Tap{" "}
            <span className="font-medium">?</span> for a quick guide.
          </DialogDescription>
        </DialogHeader>

        {/* segmented control + help */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 pb-3">
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
          <div className="flex items-center gap-0.5">
            {/* Jump to a sibling fleet view without closing + reopening. */}
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
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {showHelp ? (
            <DispatchHelp onClose={() => setShowHelp(false)} />
          ) : (
            <>
              {tab === "allocation" && <AllocationConsole open={open} />}
              {tab === "plan" && <PlanConsole open={open} />}
              {tab === "backlog" && <Backlog open={open} />}
              {tab === "board" && <InFlightBoard open={open} />}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
