"use client";

import { useState } from "react";
import { HelpCircle, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useListRuns } from "@/data/pipelines/queries";
import type { Session } from "@/lib/db";
import { TemplatePicker } from "./TemplatePicker";
import { ParamForm } from "./ParamForm";
import { RunsList } from "./RunsList";
import { RunDetail } from "./RunDetail";
import { WorkflowsHelp } from "./WorkflowsHelp";

type Tab = "templates" | "runs";

/**
 * Workflows control plane — a self-contained dialog (opened from the Desktop/
 * Mobile nav via setShowWorkflows). Two tabs: pick a template → fill params →
 * start a run; and watch recent runs' live step states. Renders the catalog
 * shipped in lib/pipeline/templates.ts over the existing /api/pipelines backend.
 */
export function WorkflowsView({
  open,
  onOpenChange,
  sessions,
  activeSessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: Session[];
  activeSessionId?: string;
}) {
  const [tab, setTab] = useState<Tab>("templates");
  const [pickedTemplate, setPickedTemplate] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  // Drives the "Runs" tab's active-count badge (deduped with RunsList's query).
  const { data: runs = [] } = useListRuns(open);
  const active = runs.filter(
    (r) => r.status === "running" || r.status === "pending"
  ).length;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "templates", label: "Templates" },
    { key: "runs", label: "Runs", count: active },
  ];

  // A freshly started run jumps straight to its detail on the Runs tab.
  function goToRun(id: string) {
    setOpenRunId(id);
    setPickedTemplate(null);
    setShowHelp(false);
    setTab("runs");
  }

  // Reset the drill-down on close so reopening lands on a clean Templates tab —
  // not a half-filled ParamForm (whose field state is gone) the user forgot
  // they'd opened, nor a stale run detail.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setPickedTemplate(null);
      setOpenRunId(null);
      setShowHelp(false);
      setTab("templates");
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[85vh] w-[calc(100%-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="space-y-1 px-6 pt-6 pb-3 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Workflow className="h-5 w-5" />
            Workflows
          </DialogTitle>
          <DialogDescription>
            Run a multi-step agent pipeline from a template — each step spawns a
            worker (Claude, Codex, or Hermes) in its own git worktree. Tap{" "}
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
            aria-label="How Workflows work"
            title="How Workflows work"
            aria-pressed={showHelp}
            onClick={() => setShowHelp((v) => !v)}
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {showHelp ? (
            <WorkflowsHelp onClose={() => setShowHelp(false)} />
          ) : tab === "templates" ? (
            pickedTemplate ? (
              <ParamForm
                templateId={pickedTemplate}
                sessions={sessions}
                defaultConductorId={activeSessionId}
                onBack={() => setPickedTemplate(null)}
                onStarted={goToRun}
              />
            ) : (
              <TemplatePicker onPick={setPickedTemplate} />
            )
          ) : openRunId ? (
            <RunDetail
              runId={openRunId}
              open={open}
              onBack={() => setOpenRunId(null)}
            />
          ) : (
            <RunsList open={open} onOpen={setOpenRunId} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
