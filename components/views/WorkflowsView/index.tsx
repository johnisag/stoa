"use client";

import { useState } from "react";
import { HelpCircle, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { fleetNavEntry, NavIconButton } from "@/components/nav/fleet-nav";
import { useListRuns } from "@/data/pipelines/queries";
import type { Session } from "@/lib/db";
import { TemplatePicker } from "./TemplatePicker";
import { ParamForm } from "./ParamForm";
import { CustomSpecForm } from "./CustomSpecForm";
import { ExamplesTab } from "./ExamplesTab";
import { RunsList } from "./RunsList";
import { RunDetail } from "./RunDetail";
import { WorkflowsHelp } from "./WorkflowsHelp";
import { WorkflowBuilder } from "./WorkflowBuilder";

type Tab = "templates" | "build" | "custom" | "examples" | "runs";

/**
 * Workflows control plane — now a pane tab rather than a dialog. Four tabs:
 * Templates (pick → fill params → start a run), Build (visual builder),
 * Custom (hand-author + validate a PipelineSpec), Examples (browse the pattern
 * catalog), and Runs (recent runs' live step states). Renders the
 * templates/examples from lib/pipeline over the existing /api/pipelines backend.
 */
export function WorkflowsView({
  sessions,
  activeSessionId,
  onOpenSession,
  onOpenDispatch,
  onOpenVerdictInbox,
  onOpenFleetBoard,
  onClose,
}: {
  sessions: Session[];
  activeSessionId?: string;
  /**
   * Jump to a finished step's spawned worker by its Stoa session id. Optional —
   * threaded down to RunDetail; supplied from the pane (attach machinery).
   */
  onOpenSession?: (sessionId: string) => void;
  /** Jump to a sibling fleet dialog (opens the target while this tab stays open).
   * Optional — each renders an icon in the header; wired in the pane. */
  onOpenDispatch?: () => void;
  onOpenVerdictInbox?: () => void;
  onOpenFleetBoard?: () => void;
  /** Optional close affordance, used on mobile where the tab strip is hidden. */
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("templates");
  const [pickedTemplate, setPickedTemplate] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  // Drives the "Runs" tab's active-count badge (deduped with RunsList's query).
  const { data: runs = [] } = useListRuns(true);
  const active = runs.filter(
    (r) => r.status === "running" || r.status === "pending"
  ).length;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "templates", label: "Templates" },
    { key: "build", label: "Build" },
    { key: "custom", label: "Custom" },
    { key: "examples", label: "Examples" },
    { key: "runs", label: "Runs", count: active },
  ];

  // A freshly started run jumps straight to its detail on the Runs tab.
  function goToRun(id: string) {
    setOpenRunId(id);
    setPickedTemplate(null);
    setShowHelp(false);
    setTab("runs");
  }

  // "Run this" on an example pattern jumps to the Templates tab with that
  // template picked, ready to fill its slots.
  function runFromExample(templateId: string) {
    setPickedTemplate(templateId);
    setShowHelp(false);
    setTab("templates");
  }

  return (
    <div className="bg-background flex h-full w-full flex-col gap-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <Workflow className="h-5 w-5" />
          <div>
            <h2 className="text-base font-semibold">Workflows</h2>
            <p className="text-muted-foreground text-xs">
              Run a multi-step agent pipeline from a template — or author your
              own in <span className="font-medium">Custom</span>.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-0.5">
          {/* Jump to a sibling fleet view. */}
          {onOpenDispatch && (
            <NavIconButton
              entry={fleetNavEntry("dispatch")}
              onClick={onOpenDispatch}
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
            aria-label="How Workflows work"
            title="How Workflows work"
            aria-pressed={showHelp}
            onClick={() => setShowHelp((v) => !v)}
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close workflows"
              title="Close workflows"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* segmented control */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3">
        <SegmentedTabs
          ariaLabel="Workflows sections"
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
        ) : tab === "build" ? (
          <WorkflowBuilder
            sessions={sessions}
            defaultConductorId={activeSessionId}
            onStarted={goToRun}
          />
        ) : tab === "custom" ? (
          <CustomSpecForm
            sessions={sessions}
            defaultConductorId={activeSessionId}
            onStarted={goToRun}
          />
        ) : tab === "examples" ? (
          <ExamplesTab onRunTemplate={runFromExample} />
        ) : openRunId ? (
          <RunDetail
            runId={openRunId}
            open={true}
            onBack={() => setOpenRunId(null)}
            onOpenSession={onOpenSession}
          />
        ) : (
          <RunsList open={true} onOpen={setOpenRunId} />
        )}
      </div>
    </div>
  );
}
