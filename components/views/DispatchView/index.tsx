"use client";

import { useState } from "react";
import { Rocket, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBoardQuery, usePendingQuery } from "@/data/dispatch/queries";
import { AllocationConsole } from "./AllocationConsole";
import { Backlog } from "./Backlog";
import { InFlightBoard } from "./InFlightBoard";
import { DispatchHelp } from "./DispatchHelp";

type Tab = "allocation" | "backlog" | "board";

export function DispatchView({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
        <div className="flex items-center justify-between px-6 pb-3">
          <div className="bg-muted inline-flex rounded-md p-0.5 text-sm">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-pressed={tab === t.key}
                onClick={() => {
                  setTab(t.key);
                  setShowHelp(false);
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded px-3 py-1 transition-colors",
                  tab === t.key
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
            aria-label="How Dispatch works"
            title="How Dispatch works"
            aria-pressed={showHelp}
            onClick={() => setShowHelp((v) => !v)}
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {showHelp ? (
            <DispatchHelp onClose={() => setShowHelp(false)} />
          ) : (
            <>
              {tab === "allocation" && <AllocationConsole open={open} />}
              {tab === "backlog" && <Backlog open={open} />}
              {tab === "board" && <InFlightBoard open={open} />}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
