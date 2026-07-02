"use client";

import { useState } from "react";
import {
  AlertTriangle,
  GitBranch,
  HelpCircle,
  Loader2,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { DiffFileList } from "@/components/DiffViewer/DiffFileList";
import { cn } from "@/lib/utils";
import {
  usePollBonRun,
  usePickWinner,
  useCancelBonRun,
  type BestOfNCandidateWithStatus,
} from "@/data/best-of-n/queries";
import { BestOfNHelp } from "./BestOfNHelp";

// ── status display helpers (mirrors STEP_STATUS_META from WorkflowsView/shared) ──

const WORKER_STATUS_META: Record<
  string,
  { label: string; badge: string; dot: string }
> = {
  pending: {
    label: "Pending",
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/40",
  },
  running: {
    label: "Running",
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    dot: "bg-blue-500",
  },
  completed: {
    label: "Completed",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  failed: {
    label: "Failed",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
    dot: "bg-red-500",
  },
};

function workerStatusMeta(workerStatus: string | null) {
  return (
    WORKER_STATUS_META[workerStatus ?? "pending"] ?? WORKER_STATUS_META.pending
  );
}

// ── diff stat summary ──

function parseDiffStat(diff: string | null): {
  files: number;
  additions: number;
  deletions: number;
} {
  if (!diff) return { files: 0, additions: 0, deletions: 0 };
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { files, additions, deletions };
}

// ── candidate panel ──

function CandidatePanel({
  candidate,
  runId,
  runStatus,
  totalCandidates,
  onPickWinner,
  onOpenSession,
  isPicking,
}: {
  candidate: BestOfNCandidateWithStatus;
  runId: string;
  runStatus: string;
  /** Total number of candidates in this run — used in the discard warning. */
  totalCandidates: number;
  onPickWinner: (candidateId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  isPicking: boolean;
}) {
  const [confirmPick, setConfirmPick] = useState(false);

  const sm = workerStatusMeta(candidate.worker_status);
  const stat = parseDiffStat(candidate.diff);
  const isFailed = candidate.worker_status === "failed";
  const isCompleted = candidate.worker_status === "completed";
  const hasDiff = candidate.diff !== null;
  const isWinner = candidate.is_winner === 1;
  const canPick = runStatus !== "done" && runStatus !== "failed";
  const losersCount = totalCandidates - 1;

  return (
    <div className="flex flex-col gap-3">
      {/* status row */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 flex-shrink-0 rounded-full",
            sm.dot,
            candidate.worker_status === "running" && "animate-pulse"
          )}
        />
        <span className={cn("rounded px-1.5 py-0.5 text-[11px]", sm.badge)}>
          {isWinner ? "Winner" : sm.label}
        </span>
        {candidate.branch_name && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
            <GitBranch className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{candidate.branch_name}</span>
          </span>
        )}
      </div>

      {/* diff stat summary */}
      {isCompleted && hasDiff && stat.files > 0 && (
        <div className="text-muted-foreground flex gap-3 text-xs">
          <span>
            {stat.files} file{stat.files !== 1 ? "s" : ""} changed
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">
            +{stat.additions}
          </span>
          <span className="text-red-600 dark:text-red-400">
            -{stat.deletions}
          </span>
        </div>
      )}

      {/* diff view */}
      {isCompleted && hasDiff ? (
        <DiffFileList
          diff={candidate.diff ?? ""}
          emptyLabel="No file changes in this candidate."
        />
      ) : candidate.worker_status === "running" ||
        candidate.worker_status === "pending" ? (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Agent is working — diff will appear when it finishes.
        </div>
      ) : isFailed ? (
        <div className="text-muted-foreground py-6 text-sm">
          This agent did not complete successfully. No diff available.
        </div>
      ) : isCompleted && !hasDiff ? (
        <div className="text-muted-foreground py-6 text-sm">
          Diff not captured — the server may have restarted while the run was
          active.
        </div>
      ) : (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Waiting for diff…
        </div>
      )}

      {/* actions */}
      <div className="flex flex-wrap gap-2 pt-1">
        {canPick && !confirmPick && (
          <Button
            variant="default"
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={isPicking || !isCompleted}
            onClick={() => setConfirmPick(true)}
          >
            Pick this winner
          </Button>
        )}
        {canPick && confirmPick && (
          <div className="flex flex-col gap-2">
            <div className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
              <span>
                This will permanently delete the other{" "}
                {losersCount === 1 ? "worktree" : `${losersCount} worktrees`}.
                This cannot be undone.
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="default"
                size="sm"
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                disabled={isPicking}
                onClick={() => {
                  setConfirmPick(false);
                  onPickWinner(candidate.id);
                }}
              >
                {isPicking ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : null}
                Confirm
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isPicking}
                onClick={() => setConfirmPick(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {isWinner && (
          <span className="self-center text-xs text-emerald-600 dark:text-emerald-400">
            Winner selected
          </span>
        )}
        {onOpenSession && candidate.session_id && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenSession(candidate.session_id!)}
          >
            <Terminal className="mr-1.5 h-3 w-3" />
            Open session
          </Button>
        )}
      </div>
    </div>
  );
}

// ── main view ──

/**
 * BestOfNView — a pane tab that shows the live status and diff comparison for a
 * Best-of-N run. Polls the run status while it is active, switches between
 * candidates via SegmentedTabs, and lets the user pick a winner.
 */
export function BestOfNView({
  runId,
  onOpenSession,
  onClose,
}: {
  runId: string;
  /** Jump to the winner's terminal session. Wired from the pane. */
  onOpenSession?: (sessionId: string) => void;
  onClose?: () => void;
}) {
  const [showHelp, setShowHelp] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const { data, isError } = usePollBonRun(runId, true);
  const pickWinner = usePickWinner();
  const cancelRun = useCancelBonRun();

  const run = data?.run;
  const candidates = data?.candidates ?? [];

  // Build SegmentedTabs entries.
  type TabKey = `${number}`;
  const tabs = candidates.map((c, i) => {
    const isFailed = c.worker_status === "failed";
    const branchSuffix = c.branch_name ? ` · ${c.branch_name}` : "";
    return {
      key: String(i) as TabKey,
      label: (
        <span className={isFailed ? "text-red-400" : undefined}>
          Agent {i + 1}
          {isFailed ? " (failed)" : ""}
          {branchSuffix && (
            <span className="text-muted-foreground ml-1 font-normal opacity-70">
              {branchSuffix}
            </span>
          )}
        </span>
      ),
    };
  });

  const activeCandidate = candidates[activeIdx] ?? null;

  async function handlePickWinner(candidateId: string) {
    const result = await pickWinner.mutateAsync({
      runId,
      candidateId,
    });
    // Open the winner's session if wired.
    if (result.winnerSessionId && onOpenSession) {
      onOpenSession(result.winnerSessionId);
    }
  }

  async function handleCancel() {
    await cancelRun.mutateAsync(runId);
  }

  const runStatus = run?.status ?? "running";
  const isRunning = runStatus === "running";
  const isFailed = runStatus === "failed";

  // Status badge for the run.
  const RUN_BADGE: Record<string, string> = {
    running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  };
  const runBadgeClass = RUN_BADGE[runStatus] ?? RUN_BADGE.running;

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "flex-shrink-0 rounded px-1.5 py-0.5 text-[11px]",
              runBadgeClass
            )}
          >
            {runStatus === "running"
              ? "Running"
              : runStatus === "done"
                ? "Done"
                : "Failed"}
          </span>
          {run && (
            <span className="text-muted-foreground truncate text-xs">
              Best of {run.n} — {run.task}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {isRunning && (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={cancelRun.isPending}
              onClick={handleCancel}
            >
              Cancel
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="How Best of N works"
            title="How Best of N works"
            aria-pressed={showHelp}
            onClick={() => setShowHelp((v) => !v)}
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close Best of N"
              title="Close Best of N"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {showHelp ? (
          <BestOfNHelp onClose={() => setShowHelp(false)} />
        ) : !run ? (
          isError ? (
            <div className="text-muted-foreground flex items-center justify-center py-10 text-sm text-red-500">
              Run not found — it may have been lost on a server restart.
            </div>
          ) : (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          )
        ) : isFailed && candidates.length === 0 ? (
          <div className="text-muted-foreground flex items-center justify-center py-10 text-sm text-red-500">
            Run failed before any candidates were created.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* candidate switcher */}
            {tabs.length > 0 && (
              <SegmentedTabs
                ariaLabel="Best-of-N candidates"
                value={String(activeIdx) as TabKey}
                onChange={(key) => setActiveIdx(Number(key))}
                tabs={tabs}
              />
            )}

            {/* candidate content */}
            {activeCandidate && (
              <CandidatePanel
                key={activeCandidate.id}
                candidate={activeCandidate}
                runId={runId}
                runStatus={runStatus}
                totalCandidates={candidates.length}
                onPickWinner={handlePickWinner}
                onOpenSession={onOpenSession}
                isPicking={pickWinner.isPending}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
