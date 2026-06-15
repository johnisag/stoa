"use client";

import { useEffect, useState } from "react";
import { HelpCircle, X } from "lucide-react";
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
import {
  loadWorkflowsViewState,
  saveWorkflowsViewState,
  type WorkflowsTab as Tab,
} from "@/lib/workflows-view-state";

/**
 * Workflows control plane — now a pane tab rather than a dialog. Four tabs:
 * Templates (pick → fill params → start a run), Build (visual builder),
 * Custom (hand-author + validate a PipelineSpec), Examples (browse the pattern
 * catalog), and Runs (recent runs' live step states). Renders the
 * templates/examples from lib/pipeline over the existing /api/pipelines backend.
 */
export function WorkflowsView({
  tabId,
  sessions,
  activeSessionId,
  onOpenSession,
  onOpenSessionInNewTab,
  onOpenDispatch,
  onOpenVerdictInbox,
  onOpenFleetBoard,
  onClose,
}: {
  /**
   * The pane tab id this view lives in. Used to persist the view (sub-tab,
   * picked template, open run) per tab so it survives a reload — the way a
   * session tab re-attaches to its backend. Optional for callers that don't
   * have one (persistence is simply skipped).
   */
  tabId?: string;
  sessions: Session[];
  activeSessionId?: string;
  /**
   * Jump to a finished step's spawned worker by its Stoa session id. Optional —
   * threaded down to RunDetail; supplied from the pane (attach machinery).
   */
  onOpenSession?: (sessionId: string) => void;
  /**
   * Open a finished step's worker in a NEW pane tab (side-by-side with this
   * workflows tab) instead of replacing it. Preferred over onOpenSession when
   * supplied — it's the "workflows sit next to sessions" promise.
   */
  onOpenSessionInNewTab?: (sessionId: string) => void;
  /** Jump to a sibling fleet dialog (opens the target while this tab stays open).
   * Optional — each renders an icon in the header; wired in the pane. */
  onOpenDispatch?: () => void;
  onOpenVerdictInbox?: () => void;
  onOpenFleetBoard?: () => void;
  /** Optional close affordance, used on mobile where the tab strip is hidden. */
  onClose?: () => void;
}) {
  // Seed from any persisted per-tab state (restored on reload). Read once on
  // mount — the component is keyed by tab id, so a fresh mount per tab.
  const [restored] = useState(() => loadWorkflowsViewState(tabId));
  const [tab, setTab] = useState<Tab>(restored.tab);
  const [pickedTemplate, setPickedTemplate] = useState<string | null>(
    restored.pickedTemplate
  );
  const [openRunId, setOpenRunId] = useState<string | null>(restored.openRunId);
  const [showHelp, setShowHelp] = useState(restored.showHelp);

  // Persist the view whenever it changes so a reload lands back where we were.
  useEffect(() => {
    saveWorkflowsViewState(tabId, { tab, pickedTemplate, openRunId, showHelp });
  }, [tabId, tab, pickedTemplate, openRunId, showHelp]);

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
    <div className="bg-background flex h-full min-h-0 w-full flex-col gap-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
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
        <div className="flex items-center gap-0.5">
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
            onOpenSession={onOpenSessionInNewTab ?? onOpenSession}
          />
        ) : (
          <RunsList open={true} onOpen={setOpenRunId} />
        )}
      </div>
    </div>
  );
}
