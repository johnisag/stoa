"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  ClipboardList,
  FileText,
  GitBranch,
  Loader2,
  Network,
  Paperclip,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDispatchReposQuery } from "@/data/dispatch/queries";
import {
  useApproveFleetPlan,
  useAttachFleetArtifact,
  useCreateFleetRun,
  useFleetRunQuery,
  useFleetRunsQuery,
  useIngestFleetPlan,
  useStartFleetPlan,
  useFleetPlanPoll,
  useCancelFleetPlan,
  useResumeFleetRun,
  usePauseFleetRun,
  useCancelFleetRun,
  useCompleteFleetWorker,
  useImportFleetRun,
  useArchiveFleetRun,
  useFleetAnalyticsQuery,
  useFleetCleanupPreview,
  useRequestFleetCleanup,
  useFleetMergeStatus,
  useRequestFleetMerge,
  useFleetSupervisorSnapshot,
  useRetryFleetTask,
  useReconcileFleetTaskVerification,
  useReconcileFleetTaskReview,
  useMessageFleetWorker,
  useKillFleetWorker,
} from "@/data/fleet/queries";
import { useProjectsQuery } from "@/data/projects/queries";
import type {
  FleetArtifactSeverity,
  FleetReviewPolicy,
  FleetRunDetailDto,
  FleetRunDto,
  FleetTaskDto,
  FleetVerificationDto,
  FleetWorkerDto,
} from "@/lib/fleet/types";
import {
  FLEET_MODEL_MAX,
  FLEET_PROVIDER_MAX,
  FLEET_RUN_GOAL_MAX,
  FLEET_RUN_NAME_MAX,
} from "@/lib/fleet/engine";
import { cn } from "@/lib/utils";

const NONE = "__none__";

function operatorRequestId(action: string) {
  return `${action}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function TaskOperatorActions({
  runId,
  planHash,
  task,
  verification,
}: {
  runId: string;
  planHash: string | null;
  task: FleetTaskDto;
  verification: FleetVerificationDto | undefined;
}) {
  const retryTask = useRetryFleetTask(runId, task.id);
  const verifyTask = useReconcileFleetTaskVerification(runId, task.id);
  const reviewTask = useReconcileFleetTaskReview(runId, task.id);
  const pending =
    retryTask.isPending || verifyTask.isPending || reviewTask.isPending;
  const retryable = [
    "failed",
    "blocked",
    "needs_inspection",
    "needs_followup",
  ].includes(task.status);
  const headSha = task.headSha;
  const verificationEvidenceHash = verification?.outputHash ?? null;
  const canVerify = task.status === "verifying" && !!headSha;
  const canReview =
    task.status === "reviewing" && !!headSha && !!verificationEvidenceHash;
  const error =
    retryTask.error?.message ??
    verifyTask.error?.message ??
    reviewTask.error?.message;

  if (!planHash || (!retryable && !canVerify && !canReview && !error)) {
    return null;
  }

  return (
    <div className="flex max-w-72 flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1">
        {retryable && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending || task.currentAttempt >= task.maxAttempts}
            onClick={() => {
              if (
                !window.confirm(
                  "Queue a new exact-plan-bound attempt? Existing evidence and worktrees remain preserved for audit."
                )
              )
                return;
              void retryTask
                .mutateAsync({
                  requestId: operatorRequestId("task-retry"),
                  expectedPlanHash: planHash,
                  expectedAttempt: task.currentAttempt,
                  expectedHeadSha: task.headSha,
                })
                .catch(() => undefined);
            }}
          >
            Retry
          </Button>
        )}
        {canVerify && headSha && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              void verifyTask
                .mutateAsync({
                  requestId: operatorRequestId("task-verification"),
                  expectedPlanHash: planHash,
                  expectedAttempt: task.currentAttempt,
                  expectedHeadSha: headSha,
                })
                .catch(() => undefined);
            }}
          >
            Reconcile verify
          </Button>
        )}
        {canReview && headSha && verificationEvidenceHash && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              void reviewTask
                .mutateAsync({
                  requestId: operatorRequestId("task-review"),
                  expectedPlanHash: planHash,
                  expectedAttempt: task.currentAttempt,
                  expectedHeadSha: headSha,
                  expectedVerificationEvidenceHash: verificationEvidenceHash,
                })
                .catch(() => undefined);
            }}
          >
            Reconcile review
          </Button>
        )}
      </div>
      {error && (
        <span className="text-destructive text-right text-[10px] break-words">
          {error}
        </span>
      )}
    </div>
  );
}

function WorkerOperatorActions({
  runId,
  worker,
}: {
  runId: string;
  worker: FleetWorkerDto;
}) {
  const messageWorker = useMessageFleetWorker(runId, worker.id);
  const killWorker = useKillFleetWorker(runId, worker.id);
  const active =
    !!worker.sessionId &&
    ["running", "waiting_for_operator"].includes(worker.status);
  const sessionId = worker.sessionId;
  const error = messageWorker.error?.message ?? killWorker.error?.message;
  if (!active && !error) return null;

  return (
    <div className="mt-2 grid gap-1">
      {active && sessionId && (
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={messageWorker.isPending || killWorker.isPending}
            onClick={() => {
              const message = window.prompt(
                "Message this exact Fleet worker attempt:"
              );
              if (!message?.trim()) return;
              void messageWorker
                .mutateAsync({
                  requestId: operatorRequestId("worker-message"),
                  expectedAttempt: worker.attempt,
                  expectedSessionId: sessionId,
                  message: message.trim(),
                })
                .catch(() => undefined);
            }}
          >
            Message
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={messageWorker.isPending || killWorker.isPending}
            onClick={() => {
              if (
                !window.confirm(
                  "Stop this exact worker attempt? Its worktree and evidence will be preserved for inspection."
                )
              )
                return;
              void killWorker
                .mutateAsync({
                  requestId: operatorRequestId("worker-kill"),
                  expectedAttempt: worker.attempt,
                  expectedSessionId: sessionId,
                  preserveWorktree: true,
                })
                .catch(() => undefined);
            }}
          >
            Stop worker
          </Button>
        </div>
      )}
      {error && (
        <span className="text-destructive text-[10px] break-words">
          {error}
        </span>
      )}
    </div>
  );
}

function labelDate(value: string) {
  return value.replace("T", " ").replace("Z", "");
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: FleetRunDto;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "hover:bg-accent/60 flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-border bg-background"
      )}
    >
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{run.name}</span>
        <span className="text-muted-foreground bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
          {run.status}
        </span>
      </span>
      <span className="text-muted-foreground line-clamp-2 text-xs">
        {run.goal}
      </span>
      <span className="text-muted-foreground flex items-center gap-2 text-[11px]">
        <span>{run.taskCount} tasks</span>
        <span>{run.workerCount} workers</span>
        {!["idle", "ready", "failed"].includes(run.plannerState) && (
          <span className="text-primary flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            planner {run.plannerState.replaceAll("_", " ")}
          </span>
        )}
      </span>
    </button>
  );
}

function ApprovalPreview({ detail }: { detail: FleetRunDetailDto }) {
  const preview = detail.run.approvalPreview;
  return (
    <section className="rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" />
        <h3 className="text-sm font-medium">Approval preview</h3>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase">
            Required gates
          </div>
          <div className="flex flex-wrap gap-1.5">
            {preview.requiredGates.map((gate) => (
              <span
                key={gate}
                className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
              >
                {gate}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase">
            Blocked actions
          </div>
          <div className="flex flex-wrap gap-1.5">
            {preview.blockedActions.map((action) => (
              <span
                key={action}
                className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300"
              >
                {action}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function RunDetail({
  detail,
  onBack,
}: {
  detail: FleetRunDetailDto;
  onBack: () => void;
}) {
  const ingestPlan = useIngestFleetPlan(detail.run.id);
  const startPlanner = useStartFleetPlan();
  const plannerActive = [
    "starting",
    "running",
    "finalizing",
    "cleanup_pending",
  ].includes(detail.run.plannerState);
  const plannerCancelable = ["starting", "running", "finalizing"].includes(
    detail.run.plannerState
  );
  const plannerCleaning = detail.run.plannerState === "cleanup_pending";
  const plannerPoll = useFleetPlanPoll(detail.run.id, plannerActive);
  const cancelPlanner = useCancelFleetPlan(detail.run.id);
  const approvePlan = useApproveFleetPlan(detail.run.id);
  const attachArtifact = useAttachFleetArtifact(detail.run.id);
  const resumeRun = useResumeFleetRun(detail.run.id);
  const pauseRun = usePauseFleetRun(detail.run.id);
  const cancelRun = useCancelFleetRun(detail.run.id);
  const completeWorker = useCompleteFleetWorker(detail.run.id);
  const archiveRun = useArchiveFleetRun(detail.run.id);
  const cleanupRun = useRequestFleetCleanup(detail.run.id);
  const cleanupPreview = useFleetCleanupPreview(
    detail.run.id,
    detail.run.archivedAt != null
  );
  const mergeStatus = useFleetMergeStatus(
    detail.run.id,
    detail.tasks.length > 0 && detail.run.approvalState === "approved"
  );
  const requestMerge = useRequestFleetMerge(detail.run.id);
  const supervisor = useFleetSupervisorSnapshot(
    detail.run.id,
    detail.tasks.length > 0
  );
  const reviewedPlanText = detail.run.planText ?? "";
  const [planText, setPlanText] = useState(
    detail.run.planText ?? detail.run.goal
  );
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactBody, setArtifactBody] = useState("");
  const [artifactTaskId, setArtifactTaskId] = useState(NONE);
  const [artifactSeverity, setArtifactSeverity] =
    useState<FleetArtifactSeverity>("warning");

  useEffect(() => {
    setPlanText(detail.run.planText ?? detail.run.goal);
    setArtifactTitle("");
    setArtifactBody("");
    setArtifactTaskId(NONE);
    setArtifactSeverity("warning");
  }, [detail.run.id, detail.run.goal, detail.run.planText]);

  async function handleIngestPlan() {
    if (!canReplacePlan) return;
    try {
      await ingestPlan.mutateAsync({
        planText,
        actor: "operator",
      });
    } catch {
      // React Query owns the rendered error state.
    }
  }

  async function handleApprovePlan() {
    if (!detail.run.planHash) return;
    try {
      await approvePlan.mutateAsync({
        expectedPlanHash: detail.run.planHash,
      });
    } catch {
      // React Query owns the rendered error state.
    }
  }

  async function handleAttachArtifact() {
    const planHash = detail.run.planHash;
    if (!canAttachArtifact || !planHash) return;
    try {
      await attachArtifact.mutateAsync({
        taskId: artifactTaskId === NONE ? null : artifactTaskId,
        expectedPlanHash: planHash,
        title: artifactTitle,
        body: artifactBody,
        severity: artifactSeverity,
        actor: "critic",
      });
      setArtifactTitle("");
      setArtifactBody("");
      setArtifactTaskId(NONE);
      setArtifactSeverity("warning");
    } catch {
      // React Query owns the rendered error state.
    }
  }

  const canApprove =
    !plannerActive &&
    detail.run.approvalState === "needs_approval" &&
    !!detail.run.planHash &&
    !!reviewedPlanText &&
    planText === reviewedPlanText &&
    !detail.artifacts.some(
      (artifact) =>
        artifact.severity === "blocker" &&
        (artifact.planHash === detail.run.planHash || artifact.planHash == null)
    );
  const canReplacePlan =
    detail.run.status === "draft" &&
    (detail.run.approvalState === "draft" ||
      detail.run.approvalState === "needs_approval");
  const canAttachArtifact =
    !plannerActive &&
    detail.run.status === "draft" &&
    detail.run.approvalState === "needs_approval" &&
    !!detail.run.planHash &&
    !!reviewedPlanText &&
    planText === reviewedPlanText;
  const taskTitleById = useMemo(
    () => new Map(detail.tasks.map((task) => [task.id, task.title])),
    [detail.tasks]
  );
  const lifecycleError =
    resumeRun.error?.message ??
    pauseRun.error?.message ??
    cancelRun.error?.message ??
    archiveRun.error?.message ??
    cleanupRun.error?.message ??
    cleanupPreview.error?.message ??
    mergeStatus.error?.message ??
    requestMerge.error?.message;
  const resetLifecycleErrors = () => {
    resumeRun.reset();
    pauseRun.reset();
    cancelRun.reset();
    completeWorker.reset();
    archiveRun.reset();
    cleanupRun.reset();
    requestMerge.reset();
  };
  const attentionWorkers = detail.workers.filter((worker) =>
    ["failed", "dead", "waiting_for_operator", "cleanup_pending"].includes(
      worker.status
    )
  );
  const attentionTasks = detail.tasks.filter((task) =>
    ["blocked", "failed", "needs_inspection", "waiting_for_operator"].includes(
      task.status
    )
  );
  const attentionTaskIds = new Set(attentionTasks.map((task) => task.id));
  const sortedTasks = [...detail.tasks].sort(
    (a, b) =>
      Number(attentionTaskIds.has(b.id)) - Number(attentionTaskIds.has(a.id))
  );
  const attentionWorkerIds = new Set(
    attentionWorkers.map((worker) => worker.id)
  );
  const sortedWorkers = [...detail.workers].sort(
    (a, b) =>
      Number(attentionWorkerIds.has(b.id)) -
      Number(attentionWorkerIds.has(a.id))
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-4">
      <section className="grid gap-3 rounded-md border p-3 md:grid-cols-5">
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Status
          </div>
          <div className="text-sm font-medium">{detail.run.status}</div>
          <div className="text-muted-foreground mt-1 font-mono text-[10px] break-all">
            ID {detail.run.id}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Planner
          </div>
          <div className="flex items-center gap-1 text-sm">
            {plannerActive && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {detail.run.plannerState.replaceAll("_", " ")}
            {detail.run.plannerProvider
              ? ` / ${detail.run.plannerProvider}`
              : ""}
          </div>
          {detail.run.plannerSessionId && plannerActive && (
            <div className="text-muted-foreground mt-1 text-[10px] break-all">
              Session {detail.run.plannerSessionId}. Open it from Sessions if
              the provider requests permission to write PLAN.md.
            </div>
          )}
        </div>
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Provider
          </div>
          <div className="text-sm">
            {detail.run.provider}
            {detail.run.model ? ` / ${detail.run.model}` : ""}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Concurrency
          </div>
          <div className="text-sm">{detail.run.maxConcurrency}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Budget
          </div>
          <div className="text-sm">
            {detail.run.budgetUsd == null
              ? "Unset"
              : `$${detail.run.spentBudgetUsd.toFixed(2)} spent + $${detail.run.reservedBudgetUsd.toFixed(2)} reserved of $${detail.run.budgetUsd.toFixed(2)}`}
          </div>
        </div>
      </section>

      <section className="bg-background sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border p-3 shadow-sm">
        <Button className="gap-2 lg:hidden" variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back to runs
        </Button>
        <Button
          className="gap-2"
          disabled={
            !["planned", "paused"].includes(detail.run.status) ||
            detail.run.pauseReason === "budget_exhausted" ||
            resumeRun.isPending
          }
          onClick={() => {
            resetLifecycleErrors();
            void resumeRun
              .mutateAsync({ actor: "operator" })
              .catch(() => undefined);
          }}
        >
          {resumeRun.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {detail.run.status === "planned"
            ? "Start"
            : detail.run.recoveryRequired
              ? "Retry recovery"
              : "Resume"}
        </Button>
        <Button
          className="gap-2"
          variant="outline"
          disabled={detail.run.status !== "running" || pauseRun.isPending}
          onClick={() => {
            resetLifecycleErrors();
            void pauseRun
              .mutateAsync({ actor: "operator", mode: "pause-new" })
              .catch(() => undefined);
          }}
        >
          <Pause className="h-4 w-4" /> Pause new work
        </Button>
        <Button
          className="gap-2"
          variant="destructive"
          disabled={
            ["completed", "failed", "canceled"].includes(detail.run.status) ||
            plannerActive ||
            cancelRun.isPending
          }
          onClick={() => {
            resetLifecycleErrors();
            if (
              !window.confirm(
                "Cancel this fleet and request all active workers to stop? Worktrees will be preserved, and any stop failure will remain cleanup-pending."
              )
            )
              return;
            void cancelRun
              .mutateAsync({
                actor: "operator",
                mode: "cancel-preserve-worktrees",
              })
              .catch(() => undefined);
          }}
        >
          <Square className="h-4 w-4" /> Cancel
        </Button>
        {["completed", "failed", "canceled"].includes(detail.run.status) &&
          !detail.run.archivedAt && (
            <Button
              className="gap-2"
              variant="outline"
              disabled={archiveRun.isPending}
              onClick={() => {
                resetLifecycleErrors();
                const retentionDays =
                  detail.run.automationPolicy.retentionDays ?? 30;
                if (
                  !window.confirm(
                    `Archive this run and retain its audit artifact bodies for ${retentionDays} days? The audit trail remains durable.`
                  )
                )
                  return;
                void archiveRun
                  .mutateAsync({ retentionDays })
                  .catch(() => undefined);
              }}
            >
              {archiveRun.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
              Archive
            </Button>
          )}
        {detail.run.archivedAt &&
          cleanupPreview.data &&
          cleanupPreview.data.eligible.length > 0 && (
            <Button
              className="gap-2"
              variant="destructive"
              disabled={cleanupRun.isPending}
              onClick={() => {
                resetLifecycleErrors();
                const count = cleanupPreview.data?.eligible.length ?? 0;
                if (
                  !window.confirm(
                    `Permanently remove ${count} verified Fleet-owned worktree${count === 1 ? "" : "s"}? Branches and the archived audit trail are preserved.`
                  )
                )
                  return;
                void cleanupRun.mutateAsync().catch(() => undefined);
              }}
            >
              {cleanupRun.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Clean {cleanupPreview.data.eligible.length} worktree
              {cleanupPreview.data.eligible.length === 1 ? "" : "s"}
            </Button>
          )}
        {plannerActive && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Cancel the planner and wait for cleanup before canceling the run.
          </span>
        )}
        {detail.run.recoveryRequired && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Recovery must finish before new workers launch.
          </span>
        )}
        {detail.run.pauseReason === "budget_exhausted" && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Budget exhausted. Create a new run; editing an approved run budget
            is not available yet.
          </span>
        )}
        {attentionWorkers.length > 0 && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            {attentionWorkers.length} worker
            {attentionWorkers.length === 1 ? "" : "s"} need attention.
          </span>
        )}
        {attentionTasks.length > 0 && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            {attentionTasks.length} task{attentionTasks.length === 1 ? "" : "s"}{" "}
            need attention.
          </span>
        )}
        {detail.run.automationLastError && (
          <div className="border-destructive/40 bg-destructive/5 text-destructive rounded border px-3 py-2 text-xs break-words">
            Automation paused: {detail.run.automationLastError}
          </div>
        )}
        {lifecycleError && (
          <span className="text-destructive flex items-center gap-1 text-xs">
            <AlertCircle className="h-3.5 w-3.5" />
            {lifecycleError}
          </span>
        )}
      </section>

      <ApprovalPreview detail={detail} />

      <section className="rounded-md border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <span className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4" />
            <h3 className="text-sm font-medium">Plan review</h3>
          </span>
          <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
            {detail.run.approvalState}
          </span>
        </div>
        <div className="grid gap-3 p-3">
          <Textarea
            aria-label="Fleet plan input"
            className="min-h-32"
            value={planText}
            onChange={(event) => setPlanText(event.target.value)}
          />
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
            <div className="min-w-0">
              <div className="text-muted-foreground text-[10px] font-medium uppercase">
                Current hash
              </div>
              <div className="font-mono text-[11px] break-all">
                {detail.run.planHash ?? "No plan ingested"}
              </div>
              {detail.run.approvedPlanHash && (
                <div className="text-muted-foreground mt-1 text-[11px]">
                  Approved by {detail.run.approvedBy ?? "operator"} at{" "}
                  {detail.run.approvedAt
                    ? labelDate(detail.run.approvedAt)
                    : "unknown time"}
                </div>
              )}
              {!!detail.run.planHash &&
                reviewedPlanText &&
                planText !== reviewedPlanText && (
                  <div className="text-muted-foreground mt-1 text-[11px]">
                    Editor differs from reviewed plan
                  </div>
                )}
            </div>
            <Button
              className="gap-2"
              variant="outline"
              disabled={
                !canReplacePlan ||
                plannerCleaning ||
                startPlanner.isPending ||
                cancelPlanner.isPending
              }
              onClick={() => {
                if (plannerCancelable) {
                  void cancelPlanner
                    .mutateAsync(undefined)
                    .catch(() => undefined);
                } else {
                  void startPlanner
                    .mutateAsync({ runId: detail.run.id })
                    .catch(() => undefined);
                }
              }}
            >
              {startPlanner.isPending || cancelPlanner.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Network className="h-4 w-4" />
              )}
              {plannerCleaning
                ? "Cleaning up planner"
                : plannerCancelable
                  ? "Cancel planner"
                  : "Plan automatically"}
            </Button>
            <Button
              className="gap-2"
              variant="outline"
              disabled={
                !canReplacePlan ||
                plannerActive ||
                !planText.trim() ||
                ingestPlan.isPending
              }
              onClick={() => void handleIngestPlan()}
            >
              {ingestPlan.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              Ingest plan
            </Button>
            <Button
              className="gap-2"
              disabled={!canApprove || approvePlan.isPending}
              onClick={() => void handleApprovePlan()}
            >
              {approvePlan.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <BadgeCheck className="h-4 w-4" />
              )}
              Approve
            </Button>
          </div>
          {(ingestPlan.isError ||
            approvePlan.isError ||
            startPlanner.isError ||
            cancelPlanner.isError ||
            plannerPoll.isError ||
            detail.run.plannerState === "failed") && (
            <div className="text-destructive flex items-center gap-2 text-xs">
              <AlertCircle className="h-3.5 w-3.5" />
              {ingestPlan.error?.message ??
                approvePlan.error?.message ??
                startPlanner.error?.message ??
                cancelPlanner.error?.message ??
                plannerPoll.error?.message ??
                detail.run.plannerError}
            </div>
          )}
          {!canApprove &&
            detail.run.approvalState === "needs_approval" &&
            detail.artifacts.some(
              (artifact) =>
                artifact.severity === "blocker" &&
                (artifact.planHash === detail.run.planHash ||
                  artifact.planHash == null)
            ) && (
              <div className="text-muted-foreground text-xs">
                Blocker findings must be addressed before approval
              </div>
            )}
        </div>
      </section>

      <section className="rounded-md border">
        <div className="border-b px-3 py-2">
          <h3 className="text-sm font-medium">Task graph</h3>
        </div>
        <div className="grid gap-2 p-3">
          {detail.tasks.length === 0 ? (
            <p className="text-muted-foreground text-sm">No tasks</p>
          ) : (
            sortedTasks.map((task) => (
              <div
                key={task.id}
                className="grid gap-2 rounded border px-3 py-2 md:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {task.title}
                  </div>
                  {task.description && (
                    <div className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                      {task.description}
                    </div>
                  )}
                  {task.fileClaims.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {task.fileClaims.map((claim) => (
                        <span
                          key={claim}
                          className="bg-foreground/10 max-w-full rounded px-1.5 py-0.5 font-mono text-[10px] break-all"
                        >
                          {claim}
                        </span>
                      ))}
                    </div>
                  )}
                  {task.dependsOnTaskIds.length > 0 && (
                    <div className="text-muted-foreground mt-1 text-[11px]">
                      Depends on:{" "}
                      {task.dependsOnTaskIds
                        .map((id) => taskTitleById.get(id) ?? id)
                        .join(", ")}
                    </div>
                  )}
                  {task.acceptanceCriteria && (
                    <div className="text-muted-foreground mt-1 text-[11px] break-words">
                      Acceptance: {task.acceptanceCriteria}
                    </div>
                  )}
                  {task.verifyCommand && (
                    <div className="text-muted-foreground mt-1 font-mono text-[11px] break-all">
                      Verify: {task.verifyCommand}
                    </div>
                  )}
                  {task.failureCode && (
                    <div className="text-destructive mt-1 text-xs break-words">
                      {task.failureCode}
                    </div>
                  )}
                  <div className="text-muted-foreground mt-2 flex flex-wrap gap-1 text-[10px] uppercase">
                    <span className="bg-foreground/10 rounded px-1.5 py-0.5">
                      verify {task.verificationStatus ?? "pending"}
                    </span>
                    <span className="bg-foreground/10 rounded px-1.5 py-0.5">
                      review {task.reviewStatus ?? "pending"}
                    </span>
                    <span className="bg-foreground/10 rounded px-1.5 py-0.5">
                      merge {task.integrationState}
                    </span>
                    {task.fixRounds > 0 && (
                      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                        {task.fixRounds} fix round
                        {task.fixRounds === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="flex flex-wrap justify-end gap-1">
                    <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
                      {task.status}
                    </span>
                    <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
                      {task.taskType}
                    </span>
                    {task.agentType && (
                      <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] uppercase">
                        {task.agentType}
                        {task.model ? ` / ${task.model}` : ""}
                      </span>
                    )}
                  </div>
                  <TaskOperatorActions
                    runId={detail.run.id}
                    planHash={detail.run.planHash}
                    task={task}
                    verification={detail.verifications.find(
                      (verification) => verification.id === task.verificationId
                    )}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {supervisor.data && (
        <section className="rounded-md border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              <h3 className="text-sm font-medium">Advisory supervisor</h3>
            </span>
            <span className="text-muted-foreground max-w-48 truncate font-mono text-[10px]">
              {supervisor.data.snapshotHash}
            </span>
          </div>
          <div className="grid gap-3 p-3 md:grid-cols-2">
            <div>
              <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase">
                Attention
              </div>
              {supervisor.data.attention.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No advisory attention items.
                </p>
              ) : (
                <ul className="grid gap-1 text-xs">
                  {supervisor.data.attention.map((item) => (
                    <li
                      key={`${item.rank}:${item.code}:${item.taskId ?? "run"}:${item.workerId ?? "none"}`}
                      className="rounded border px-2 py-1"
                    >
                      <span className="font-medium uppercase">
                        {item.severity}
                      </span>{" "}
                      {item.code.replaceAll("_", " ")}
                      {item.taskId
                        ? ` · ${taskTitleById.get(item.taskId) ?? item.taskId}`
                        : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase">
                Recommended next actions
              </div>
              {supervisor.data.recommendations.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No action recommended.
                </p>
              ) : (
                <ul className="grid gap-1 text-xs">
                  {supervisor.data.recommendations.map((recommendation) => (
                    <li
                      key={recommendation.id}
                      className="rounded border px-2 py-1"
                    >
                      <span className="font-medium">
                        {recommendation.kind.replaceAll("_", " ")}
                      </span>{" "}
                      · {recommendation.reasonCode.replaceAll("_", " ")}
                      {recommendation.taskId
                        ? ` · ${taskTitleById.get(recommendation.taskId) ?? recommendation.taskId}`
                        : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-muted-foreground text-[11px] md:col-span-2">
              Recommendations are hash-bound evidence only. They cannot execute
              work, approve a plan, or authorize a merge.
            </p>
          </div>
        </section>
      )}
      {supervisor.error && (
        <div className="text-destructive rounded-md border px-3 py-2 text-xs">
          {supervisor.error.message}
        </div>
      )}

      {detail.tasks.length > 0 && detail.run.approvalState === "approved" && (
        <section className="rounded-md border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <span className="flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              <h3 className="text-sm font-medium">Merge queue</h3>
            </span>
            <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
              {detail.run.integrationState.replaceAll("_", " ")}
            </span>
          </div>
          <div className="grid gap-3 p-3">
            <div className="grid gap-2 text-xs md:grid-cols-3">
              <div>
                <span className="text-muted-foreground block text-[10px] uppercase">
                  Target
                </span>
                {detail.run.mergeTarget ??
                  (detail.run.automationPolicy.automaticMerge
                    ? detail.run.automationPolicy.mergeTarget
                    : "Not requested")}
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px] uppercase">
                  Integrated head
                </span>
                <span className="font-mono break-all">
                  {detail.run.integrationHeadSha ?? "Pending"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground block text-[10px] uppercase">
                  Tasks
                </span>
                {mergeStatus.data
                  ? `${mergeStatus.data.readiness.mergedTaskIds.length} merged · ${mergeStatus.data.readiness.readyTaskIds.length} ready · ${mergeStatus.data.readiness.waitingTaskIds.length} waiting`
                  : "Loading readiness"}
              </div>
            </div>
            {detail.run.integrationPrUrl && (
              <a
                className="text-primary w-fit text-xs underline underline-offset-2"
                href={detail.run.integrationPrUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open PR #{detail.run.integrationPrNumber ?? ""}
              </a>
            )}
            {(detail.run.integrationError ||
              mergeStatus.data?.integration.error) && (
              <div className="text-destructive text-xs break-words">
                {detail.run.integrationError ??
                  mergeStatus.data?.integration.error}
              </div>
            )}
            {(mergeStatus.data?.readiness.blockers.length ?? 0) > 0 && (
              <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
                <div className="font-medium">Waiting on exact-head gates</div>
                <ul className="text-muted-foreground mt-1 list-inside list-disc">
                  {mergeStatus.data?.readiness.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </div>
            )}
            {!detail.run.mergeRequestedAt && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={requestMerge.isPending}
                  onClick={() => {
                    resetLifecycleErrors();
                    if (
                      !window.confirm(
                        "Queue a GitHub PR merge? Fleet will pin the exact reviewed head, wait for required CI, and refuse stale results."
                      )
                    )
                      return;
                    void requestMerge
                      .mutateAsync("github_pr")
                      .catch(() => undefined);
                  }}
                >
                  Queue GitHub PR
                </Button>
                <Button
                  variant="outline"
                  disabled={requestMerge.isPending}
                  onClick={() => {
                    resetLifecycleErrors();
                    if (
                      !window.confirm(
                        "Queue a local fast-forward merge? Fleet will refuse a dirty or moved checkout and will run final verification first."
                      )
                    )
                      return;
                    void requestMerge
                      .mutateAsync("local")
                      .catch(() => undefined);
                  }}
                >
                  Queue local fast-forward
                </Button>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="rounded-md border">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Paperclip className="h-4 w-4" />
          <h3 className="text-sm font-medium">Critic artifacts</h3>
        </div>
        <div className="grid gap-3 p-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_9rem_12rem]">
            <Input
              aria-label="Critic finding title"
              placeholder="Finding title"
              value={artifactTitle}
              onChange={(event) => setArtifactTitle(event.target.value)}
            />
            <Select
              value={artifactSeverity}
              onValueChange={(value) =>
                setArtifactSeverity(value as FleetArtifactSeverity)
              }
            >
              <SelectTrigger aria-label="Finding severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="blocker">Blocker</SelectItem>
              </SelectContent>
            </Select>
            <Select value={artifactTaskId} onValueChange={setArtifactTaskId}>
              <SelectTrigger aria-label="Finding task">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Run-level</SelectItem>
                {detail.tasks.map((task) => (
                  <SelectItem key={task.id} value={task.id}>
                    {task.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            aria-label="Critic finding body"
            value={artifactBody}
            onChange={(event) => setArtifactBody(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {attachArtifact.isError ? (
              <div className="text-destructive flex items-center gap-2 text-xs">
                <AlertCircle className="h-3.5 w-3.5" />
                {attachArtifact.error.message}
              </div>
            ) : (
              <span className="text-muted-foreground text-xs">
                {detail.artifacts.length} findings
              </span>
            )}
            <Button
              className="gap-2"
              variant="outline"
              disabled={
                !artifactTitle.trim() ||
                !artifactBody.trim() ||
                !canAttachArtifact ||
                attachArtifact.isPending
              }
              onClick={() => void handleAttachArtifact()}
            >
              {attachArtifact.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
              Attach
            </Button>
          </div>
          {detail.artifacts.length > 0 && (
            <div className="grid gap-2">
              {detail.artifacts.map((artifact) => (
                <div key={artifact.id} className="rounded border px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="max-w-full min-w-0 text-sm font-medium break-words">
                      {artifact.title}
                    </span>
                    <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
                      {artifact.severity}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-1 flex flex-wrap gap-2 text-[11px]">
                    <span className="max-w-full min-w-0 break-words">
                      {artifact.taskId
                        ? (taskTitleById.get(artifact.taskId) ??
                          artifact.taskId)
                        : "Run-level"}
                    </span>
                    <span>
                      {artifact.planHash &&
                      artifact.planHash !== detail.run.planHash
                        ? "Previous plan"
                        : "Current plan"}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-2 text-xs break-words whitespace-pre-wrap">
                    {artifact.body}
                  </div>
                  <div className="text-muted-foreground mt-2 text-[11px]">
                    {artifact.actor} - {labelDate(artifact.createdAt)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border">
          <div className="border-b px-3 py-2">
            <h3 className="text-sm font-medium">Workers</h3>
          </div>
          <div className="p-3">
            {detail.workers.length === 0 ? (
              <p className="text-muted-foreground text-sm">No workers</p>
            ) : (
              <>
                <div className="grid gap-2">
                  {sortedWorkers.map((worker) => (
                    <div key={worker.id} className="rounded border px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-medium">
                          {worker.taskId
                            ? (taskTitleById.get(worker.taskId) ??
                              worker.taskId)
                            : "Unlinked worker"}
                        </div>
                        <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
                          {worker.status}
                        </span>
                      </div>
                      <div className="text-muted-foreground mt-1 text-xs">
                        {worker.provider ?? "unknown provider"}
                        {worker.model ? ` / ${worker.model}` : ""} · attempt{" "}
                        {worker.attempt}
                      </div>
                      {worker.sessionId && (
                        <div className="text-muted-foreground mt-1 font-mono text-[10px] break-all">
                          session {worker.sessionId}
                        </div>
                      )}
                      {(worker.failureCode || worker.terminalCause) && (
                        <div className="text-destructive mt-1 text-xs break-words">
                          {worker.failureCode ?? worker.terminalCause}
                        </div>
                      )}
                      <WorkerOperatorActions
                        runId={detail.run.id}
                        worker={worker}
                      />
                      {worker.sessionId &&
                        ["running", "waiting_for_operator"].includes(
                          worker.status
                        ) && (
                          <Button
                            className="mt-2"
                            size="sm"
                            variant="outline"
                            disabled={completeWorker.isPending}
                            onClick={() => {
                              resetLifecycleErrors();
                              if (
                                !window.confirm(
                                  "Stop this worker and mark its visible completion report ready for inspection? Its worktree will be preserved."
                                )
                              )
                                return;
                              void completeWorker
                                .mutateAsync(worker.id)
                                .catch(() => undefined);
                            }}
                          >
                            Mark report done
                          </Button>
                        )}
                    </div>
                  ))}
                </div>
                {completeWorker.isError && (
                  <div className="text-destructive mt-2 text-xs">
                    {completeWorker.error.message}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="rounded-md border">
          <div className="border-b px-3 py-2">
            <h3 className="text-sm font-medium">Events</h3>
          </div>
          <div className="grid gap-2 p-3">
            {detail.events.map((event) => (
              <div key={event.id} className="rounded border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {event.eventType.replaceAll("_", " ")}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {labelDate(event.createdAt)}
                  </span>
                </div>
                <div className="text-muted-foreground text-xs">
                  {event.actor}
                </div>
                {event.payload != null && (
                  <pre className="text-muted-foreground mt-1 overflow-auto text-[10px] whitespace-pre-wrap">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export function FleetManagementView({ onClose }: { onClose?: () => void }) {
  const runs = useFleetRunsQuery(true);
  const analytics = useFleetAnalyticsQuery(true);
  const repos = useDispatchReposQuery(true);
  const projects = useProjectsQuery();
  const createRun = useCreateFleetRun();
  const importRun = useImportFleetRun();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [inputMode, setInputMode] = useState<"epic" | "plan">("epic");
  const [importVerifyCommand, setImportVerifyCommand] = useState("npm test");
  const [repoId, setRepoId] = useState(NONE);
  const [projectId, setProjectId] = useState(NONE);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [autoPlan, setAutoPlan] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [autoFix, setAutoFix] = useState(false);
  const [maxAutomaticFixRounds, setMaxAutomaticFixRounds] = useState(2);
  const [autoMerge, setAutoMerge] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<"github_pr" | "local">(
    "github_pr"
  );
  const [retentionDays, setRetentionDays] = useState(30);
  const [allowSensitivePaths, setAllowSensitivePaths] = useState(false);
  const [allowUnconfinedAgents, setAllowUnconfinedAgents] = useState(false);
  const [plannerTaskCap, setPlannerTaskCap] = useState(8);
  const [reviewPolicy, setReviewPolicy] =
    useState<FleetReviewPolicy>("four_agent");
  const detailRef = useRef<HTMLElement>(null);

  const selectedRun = useMemo(
    () => (runs.data ?? []).find((run) => run.id === selectedRunId) ?? null,
    [runs.data, selectedRunId]
  );
  const detail = useFleetRunQuery(selectedRunId, selectedRunId != null);

  function selectRun(id: string) {
    setSelectedRunId(id);
    if (window.innerWidth < 1024) {
      requestAnimationFrame(() =>
        detailRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        })
      );
    }
  }

  useEffect(() => {
    if (!selectedRunId && runs.data?.[0]) setSelectedRunId(runs.data[0].id);
  }, [runs.data, selectedRunId]);

  async function handleCreateRun() {
    createRun.reset();
    importRun.reset();
    const automationPolicy = {
      version: 1 as const,
      automaticPlanning: autoPlan,
      automaticPlanApproval: autoApprove,
      automaticStart: autoStart,
      automaticFixes: autoFix,
      maxAutomaticFixRounds: autoFix ? maxAutomaticFixRounds : 0,
      automaticMerge: autoMerge,
      mergeTarget,
      allowSensitivePaths,
      allowUnconfinedAgents,
      plannerTaskCap,
      cleanupPolicy: "preserve" as const,
      retentionDays,
    };
    try {
      const target = {
        repoId: repoId === NONE ? null : repoId,
        projectId: projectId === NONE ? null : projectId,
      };
      const options = {
        ...target,
        budgetUsd: budgetUsd.trim() ? Number(budgetUsd) : null,
        provider,
        model: model.trim() || null,
        maxConcurrency,
        reviewPolicy,
        automationPolicy,
      };
      const created =
        inputMode === "plan"
          ? await importRun.mutateAsync({
              source: {
                kind: "text",
                name,
                text: goal,
                ...target,
                provider,
                model: model.trim() || null,
                claimMode: "write",
                verifyCommand: importVerifyCommand.trim() || null,
              },
              options,
            })
          : await createRun.mutateAsync({ name, goal, ...options });
      setSelectedRunId(created.run.id);
      setName("");
      setGoal("");
      setBudgetUsd("");
    } catch {
      // React Query owns the rendered error state.
    }
  }

  const automaticPlanNeedsTarget =
    autoPlan && repoId === NONE && projectId === NONE;
  const createPending = createRun.isPending || importRun.isPending;
  const createError = createRun.error?.message ?? importRun.error?.message;

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <Network className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">Fleet Management</span>
          <span className="text-muted-foreground text-xs">
            {runs.data?.length ?? 0} runs
          </span>
          {analytics.data && (
            <span className="text-muted-foreground hidden items-center gap-1 text-xs sm:flex">
              <BarChart3 className="h-3.5 w-3.5" />
              {analytics.data.runOutcomes.completed ?? 0} completed · $
              {analytics.data.budget.spentUsd.toFixed(2)} spent
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh Fleet Management"
            onClick={() => {
              void runs.refetch();
              if (selectedRunId) void detail.refetch();
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close Fleet Management"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto border-t lg:grid-cols-[22rem_minmax(0,1fr)] lg:overflow-hidden">
        <aside
          id="fleet-run-list"
          className="flex min-h-0 flex-col gap-3 border-r p-4"
        >
          <section className="rounded-md border p-3">
            <div className="mb-3 flex items-center gap-2">
              <Plus className="h-4 w-4" />
              <h3 className="text-sm font-medium">Draft run</h3>
            </div>
            <div className="grid gap-2">
              <Select
                value={inputMode}
                onValueChange={(value) =>
                  setInputMode(value === "plan" ? "plan" : "epic")
                }
              >
                <SelectTrigger aria-label="Fleet input mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="epic">
                    Epic/specification — plan automatically
                  </SelectItem>
                  <SelectItem value="plan">
                    Existing Markdown task plan — import
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input
                aria-label="Fleet run name"
                placeholder="Name"
                maxLength={FLEET_RUN_NAME_MAX}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Textarea
                aria-label={
                  inputMode === "plan" ? "Fleet task plan" : "Fleet run goal"
                }
                placeholder={
                  inputMode === "plan"
                    ? "Markdown tasks with [files: path] claims"
                    : "High-level epic or project specification"
                }
                maxLength={FLEET_RUN_GOAL_MAX}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
              {inputMode === "plan" && (
                <label className="grid gap-1 text-xs">
                  <span>Default verification command for write tasks</span>
                  <Input
                    aria-label="Imported plan verification command"
                    placeholder="npm test"
                    value={importVerifyCommand}
                    onChange={(event) =>
                      setImportVerifyCommand(event.target.value)
                    }
                  />
                  <span className="text-muted-foreground">
                    Runs without a shell; use &amp;&amp; only to separate direct
                    command steps.
                  </span>
                </label>
              )}
              <Select
                value={repoId}
                onValueChange={(value) => {
                  setRepoId(value);
                  if (value !== NONE) setProjectId(NONE);
                }}
              >
                <SelectTrigger aria-label="Repository">
                  <SelectValue placeholder="Repository" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No repository</SelectItem>
                  {(repos.data ?? []).map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repo.repo_slug}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={projectId}
                onValueChange={(value) => {
                  setProjectId(value);
                  if (value !== NONE) setRepoId(NONE);
                }}
              >
                <SelectTrigger aria-label="Project">
                  <SelectValue placeholder="Project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No project</SelectItem>
                  {(projects.data ?? []).map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label="Budget USD"
                  inputMode="decimal"
                  placeholder="Budget"
                  value={budgetUsd}
                  onChange={(event) => setBudgetUsd(event.target.value)}
                />
                <Input
                  aria-label="Max concurrency"
                  type="number"
                  min={1}
                  max={40}
                  value={maxConcurrency}
                  onChange={(event) =>
                    setMaxConcurrency(Number(event.target.value))
                  }
                />
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                <span>
                  {inputMode === "plan"
                    ? "Continue the imported plan automatically"
                    : "Plan automatically after creating the run"}
                  <span className="text-muted-foreground mt-0.5 block">
                    {inputMode === "plan"
                      ? "Uses the imported graph; no planner session is needed."
                      : "Generates and allocates tasks, then waits for approval."}
                  </span>
                </span>
                <input
                  aria-label="Plan automatically"
                  type="checkbox"
                  checked={autoPlan}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setAutoPlan(enabled);
                    if (!enabled) {
                      setAutoApprove(false);
                      setAutoStart(false);
                      setAutoFix(false);
                      setAutoMerge(false);
                      setAllowUnconfinedAgents(false);
                    }
                  }}
                />
              </label>
              {autoPlan && inputMode === "epic" && (
                <label className="grid gap-1 text-xs">
                  <span>Planner task cap (1-40)</span>
                  <Input
                    aria-label="Planner task cap"
                    type="number"
                    min={1}
                    max={40}
                    value={plannerTaskCap}
                    onChange={(event) =>
                      setPlannerTaskCap(Number(event.target.value))
                    }
                  />
                  <span className="text-muted-foreground">
                    Maximum tasks the generated plan may contain.
                  </span>
                </label>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label="Provider"
                  placeholder="Provider"
                  maxLength={FLEET_PROVIDER_MAX}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                />
                <Input
                  aria-label="Model"
                  placeholder="Model"
                  maxLength={FLEET_MODEL_MAX}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </div>
              <Select
                value={reviewPolicy}
                onValueChange={(value) => {
                  const next = value as FleetReviewPolicy;
                  setReviewPolicy(next);
                  if (next === "manual") {
                    setAutoApprove(false);
                    setAutoStart(false);
                    setAutoFix(false);
                    setAutoMerge(false);
                    setAllowUnconfinedAgents(false);
                  }
                }}
              >
                <SelectTrigger aria-label="Review policy">
                  <SelectValue placeholder="Review policy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="four_agent">Four-agent</SelectItem>
                  <SelectItem value="four_agent_plus_red_team">
                    Four-agent + red-team
                  </SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
              <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                <span>
                  Approve an exact reviewed plan automatically
                  <span className="text-muted-foreground mt-0.5 block">
                    Waits for four independent clean critics bound to the plan,
                    execution contract, policy, and base commit.
                  </span>
                </span>
                <input
                  aria-label="Approve plans automatically"
                  type="checkbox"
                  disabled={!autoPlan || reviewPolicy === "manual"}
                  checked={autoApprove}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setAutoApprove(enabled);
                    if (!enabled) {
                      setAutoStart(false);
                      setAutoFix(false);
                      setAutoMerge(false);
                      setAllowUnconfinedAgents(false);
                    }
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                <span>
                  Start approved work automatically
                  <span className="text-muted-foreground mt-0.5 block">
                    Uses compare-and-set and rechecks policy, base, and
                    execution hashes before any worker can launch.
                  </span>
                </span>
                <input
                  aria-label="Start approved work automatically"
                  type="checkbox"
                  disabled={!autoApprove}
                  checked={autoStart}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setAutoStart(enabled);
                    if (!enabled) {
                      setAutoFix(false);
                      setAutoMerge(false);
                      setAllowUnconfinedAgents(false);
                    }
                  }}
                />
              </label>
              {autoApprove && (
                <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                  <span>
                    Allow sensitive paths
                    <span className="text-muted-foreground mt-0.5 block">
                      Explicitly permits automatic approval for CI,
                      agent-policy, environment, or secret-related paths.
                    </span>
                  </span>
                  <input
                    aria-label="Allow sensitive paths"
                    type="checkbox"
                    checked={allowSensitivePaths}
                    onChange={(event) =>
                      setAllowSensitivePaths(event.target.checked)
                    }
                  />
                </label>
              )}
              {autoStart && (
                <div className="grid gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-xs">
                  <div className="text-amber-700 dark:text-amber-300">
                    Unattended agents can execute code and modify the selected
                    repository. Without a detected OS sandbox, automatic start
                    remains paused unless you grant the consent below.
                  </div>
                  <label className="flex items-center gap-2">
                    <input
                      aria-label="Allow unconfined unattended agents"
                      type="checkbox"
                      checked={allowUnconfinedAgents}
                      onChange={(event) =>
                        setAllowUnconfinedAgents(event.target.checked)
                      }
                    />
                    I explicitly allow unattended agents without OS confinement.
                  </label>
                </div>
              )}
              <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                <span>
                  Fix blocking review findings automatically
                  <span className="text-muted-foreground mt-0.5 block">
                    Re-verifies and re-runs all four exact-head reviews after
                    each bounded fix attempt.
                  </span>
                </span>
                <input
                  aria-label="Fix review findings automatically"
                  type="checkbox"
                  disabled={!autoStart}
                  checked={autoFix}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setAutoFix(enabled);
                    if (!enabled) setAutoMerge(false);
                  }}
                />
              </label>
              {autoFix && (
                <label className="grid gap-1 text-xs">
                  <span>Maximum automatic fix rounds (1-20)</span>
                  <Input
                    aria-label="Maximum automatic fix rounds"
                    type="number"
                    min={1}
                    max={20}
                    value={maxAutomaticFixRounds}
                    onChange={(event) =>
                      setMaxAutomaticFixRounds(Number(event.target.value))
                    }
                  />
                </label>
              )}
              <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                <span>
                  Merge the fully green result automatically
                  <span className="text-muted-foreground mt-0.5 block">
                    Requires exact-SHA verification, four clean independent
                    reviews, authorized fix rounds, and a final integration
                    verification.
                  </span>
                </span>
                <input
                  aria-label="Merge green results automatically"
                  type="checkbox"
                  disabled={!autoFix || maxAutomaticFixRounds < 1}
                  checked={autoMerge}
                  onChange={(event) => setAutoMerge(event.target.checked)}
                />
              </label>
              {autoMerge && (
                <label className="grid gap-1 text-xs">
                  <span>Merge destination</span>
                  <Select
                    value={mergeTarget}
                    onValueChange={(value) =>
                      setMergeTarget(value === "local" ? "local" : "github_pr")
                    }
                  >
                    <SelectTrigger aria-label="Automatic merge destination">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="github_pr">
                        GitHub PR, CI, then merge
                      </SelectItem>
                      <SelectItem value="local">
                        Local fast-forward only
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              )}
              <label className="grid gap-1 text-xs">
                <span>Audit artifact retention (days)</span>
                <Input
                  aria-label="Fleet artifact retention days"
                  type="number"
                  min={1}
                  max={3650}
                  value={retentionDays}
                  onChange={(event) =>
                    setRetentionDays(Number(event.target.value))
                  }
                />
                <span className="text-muted-foreground">
                  Audit metadata stays durable; oversized artifact bodies may be
                  pruned after this period.
                </span>
              </label>
              <Button
                className="gap-2"
                disabled={
                  !name.trim() ||
                  !goal.trim() ||
                  automaticPlanNeedsTarget ||
                  createPending
                }
                onClick={() => void handleCreateRun()}
              >
                {createPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {autoMerge
                  ? "Create epic-to-merged run"
                  : autoStart
                    ? "Create autonomous run"
                    : autoPlan
                      ? "Create and plan"
                      : "Create draft"}
              </Button>
              {createError && (
                <div className="text-destructive flex items-center gap-2 text-xs">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {createError}
                </div>
              )}
              {automaticPlanNeedsTarget && (
                <div className="text-muted-foreground text-xs">
                  Select a repository or project to create and plan
                  automatically. Turn automatic planning off to save a goal-only
                  draft.
                </div>
              )}
            </div>
          </section>

          <section className="lg:min-h-0 lg:flex-1 lg:overflow-auto">
            <div className="mb-2 flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              <h3 className="text-sm font-medium">Runs</h3>
            </div>
            {runs.isLoading ? (
              <div className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading
              </div>
            ) : runs.isError ? (
              <div className="text-destructive flex items-center gap-2 py-4 text-sm">
                <AlertCircle className="h-4 w-4" />
                {runs.error.message}
              </div>
            ) : runs.data?.length === 0 ? (
              <div className="text-muted-foreground py-4 text-sm">
                No fleet runs
              </div>
            ) : (
              <div className="grid gap-2">
                {(runs.data ?? []).map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    selected={selectedRun?.id === run.id}
                    onSelect={() => selectRun(run.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </aside>

        <main
          ref={detailRef}
          className="flex min-h-0 flex-col lg:overflow-hidden"
        >
          {selectedRunId == null ? (
            <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
              Select or create a fleet run
            </div>
          ) : detail.isLoading ? (
            <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-6 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading
            </div>
          ) : detail.isError ? (
            <div className="text-destructive flex flex-1 items-center justify-center gap-2 p-6 text-sm">
              <AlertCircle className="h-4 w-4" />
              {detail.error.message}
            </div>
          ) : detail.data ? (
            <>
              <div className="px-4 py-3">
                <h2 className="truncate text-lg font-semibold">
                  {detail.data.run.name}
                </h2>
                <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                  {detail.data.run.goal}
                </p>
              </div>
              <RunDetail
                detail={detail.data}
                onBack={() =>
                  document.getElementById("fleet-run-list")?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  })
                }
              />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
