"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BadgeCheck,
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
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmProvider";
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
  useCancelFleetRun,
  useFleetRunQuery,
  useFleetRunsQuery,
  useIngestFleetPlan,
  usePauseFleetRun,
  useStartFleetRun,
  useTickFleetRun,
} from "@/data/fleet/queries";
import { useProjectsQuery } from "@/data/projects/queries";
import type {
  FleetArtifactSeverity,
  FleetReviewPolicy,
  FleetRunDetailDto,
  FleetRunDto,
  FleetSchedulerSummary,
} from "@/lib/fleet/types";
import {
  FLEET_MODEL_MAX,
  FLEET_PROVIDER_MAX,
  FLEET_RUN_GOAL_MAX,
  FLEET_RUN_NAME_MAX,
} from "@/lib/fleet/engine";
import { cn } from "@/lib/utils";

const NONE = "__none__";

function labelDate(value: string) {
  return value.replace("T", " ").replace("Z", "");
}

function eventPayloadPreview(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    "launched",
    "recovered",
    "skipped",
    "released",
    "stoppedSessions",
    "error",
    "workerId",
    "taskId",
    "sessionId",
    "branchName",
    "worktreePath",
  ]) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}: ${String(value)}`);
  }
  return parts.length > 0 ? parts.join(" | ") : null;
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

function RunDetail({ detail }: { detail: FleetRunDetailDto }) {
  const confirm = useConfirm();
  const ingestPlan = useIngestFleetPlan(detail.run.id);
  const approvePlan = useApproveFleetPlan(detail.run.id);
  const attachArtifact = useAttachFleetArtifact(detail.run.id);
  const startRun = useStartFleetRun(detail.run.id);
  const tickRun = useTickFleetRun(detail.run.id);
  const pauseRun = usePauseFleetRun(detail.run.id);
  const cancelRun = useCancelFleetRun(detail.run.id);
  const reviewedPlanText = detail.run.planText ?? "";
  const [planText, setPlanText] = useState(
    detail.run.planText ?? detail.run.goal
  );
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactBody, setArtifactBody] = useState("");
  const [artifactTaskId, setArtifactTaskId] = useState(NONE);
  const [artifactSeverity, setArtifactSeverity] =
    useState<FleetArtifactSeverity>("warning");
  const [lifecycleNotice, setLifecycleNotice] = useState<{
    runId: string;
    kind: "summary" | "error";
    value: FleetSchedulerSummary | string;
  } | null>(null);

  useEffect(() => {
    setPlanText(detail.run.planText ?? detail.run.goal);
    setArtifactTitle("");
    setArtifactBody("");
    setArtifactTaskId(NONE);
    setArtifactSeverity("warning");
    setLifecycleNotice(null);
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
        approvedBy: "operator",
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

  async function runLifecycleAction(
    action: "start" | "tick" | "pause" | "cancel"
  ) {
    try {
      if (action === "cancel") {
        const confirmed = await confirm({
          title: "Cancel fleet run?",
          description:
            "Canceling this run stops active fleet workers and marks open tasks canceled. This cannot be undone.",
          confirmLabel: "Cancel run",
          destructive: true,
        });
        if (!confirmed) return;
      }
      const result =
        action === "start"
          ? await startRun.mutateAsync(undefined)
          : action === "tick"
            ? await tickRun.mutateAsync(undefined)
            : action === "pause"
              ? await pauseRun.mutateAsync(undefined)
              : await cancelRun.mutateAsync(undefined);
      if (result.summary) {
        setLifecycleNotice({
          runId: detail.run.id,
          kind: "summary",
          value: result.summary,
        });
      } else {
        setLifecycleNotice(null);
      }
    } catch (error) {
      setLifecycleNotice({
        runId: detail.run.id,
        kind: "error",
        value: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const canApprove =
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
    detail.run.status === "draft" &&
    detail.run.approvalState === "needs_approval" &&
    !!detail.run.planHash &&
    !!reviewedPlanText &&
    planText === reviewedPlanText;
  const lifecycleError =
    lifecycleNotice?.runId === detail.run.id && lifecycleNotice.kind === "error"
      ? (lifecycleNotice.value as string)
      : null;
  const schedulerSummary =
    lifecycleNotice?.runId === detail.run.id &&
    lifecycleNotice.kind === "summary"
      ? (lifecycleNotice.value as FleetSchedulerSummary)
      : null;
  const canStart =
    detail.run.approvalState === "approved" &&
    (detail.run.status === "planned" || detail.run.status === "paused");
  const canTick =
    detail.run.approvalState === "approved" && detail.run.status === "running";
  const canPause =
    detail.run.approvalState === "approved" &&
    (detail.run.status === "planned" || detail.run.status === "running");
  const canCancel =
    detail.run.status !== "completed" && detail.run.status !== "canceled";
  const canShowSchedulerControls = canStart || canTick || canPause;
  const canShowLifecycleControls = canShowSchedulerControls || canCancel;
  const lifecycleBusy =
    startRun.isPending ||
    tickRun.isPending ||
    pauseRun.isPending ||
    cancelRun.isPending;
  const taskTitleById = useMemo(
    () => new Map(detail.tasks.map((task) => [task.id, task.title])),
    [detail.tasks]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-4">
      <section className="grid gap-3 rounded-md border p-3 md:grid-cols-4">
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Status
          </div>
          <div className="text-sm font-medium">{detail.run.status}</div>
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
              : `$${detail.run.budgetUsd.toFixed(2)}`}
          </div>
        </div>
      </section>

      {canShowLifecycleControls && (
        <section className="rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            {canShowSchedulerControls && (
              <>
                {canStart && (
                  <Button
                    className="gap-2"
                    size="sm"
                    disabled={lifecycleBusy}
                    onClick={() => void runLifecycleAction("start")}
                  >
                    {startRun.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {detail.run.status === "paused" ? "Resume" : "Start"}
                  </Button>
                )}
                {canTick && (
                  <Button
                    className="gap-2"
                    size="sm"
                    variant="outline"
                    disabled={lifecycleBusy}
                    onClick={() => void runLifecycleAction("tick")}
                  >
                    {tickRun.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    Tick
                  </Button>
                )}
                {canPause && (
                  <Button
                    className="gap-2"
                    size="sm"
                    variant="outline"
                    disabled={lifecycleBusy}
                    onClick={() => void runLifecycleAction("pause")}
                  >
                    {pauseRun.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Pause className="h-4 w-4" />
                    )}
                    Pause Launches
                  </Button>
                )}
              </>
            )}
            {canCancel && (
              <Button
                className="gap-2"
                size="sm"
                variant="destructive"
                disabled={lifecycleBusy}
                onClick={() => void runLifecycleAction("cancel")}
              >
                {cancelRun.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
                Cancel
              </Button>
            )}
          </div>
          {lifecycleError && (
            <div className="text-destructive mt-2 flex items-center gap-2 text-xs">
              <AlertCircle className="h-3.5 w-3.5" />
              {lifecycleError}
            </div>
          )}
          {schedulerSummary && (
            <div className="text-muted-foreground mt-2 text-xs">
              launched {schedulerSummary.launched} | recovered{" "}
              {schedulerSummary.recovered} | skipped {schedulerSummary.skipped}
            </div>
          )}
        </section>
      )}

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
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]">
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
                !canReplacePlan || !planText.trim() || ingestPlan.isPending
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
          {(ingestPlan.isError || approvePlan.isError) && (
            <div className="text-destructive flex items-center gap-2 text-xs">
              <AlertCircle className="h-3.5 w-3.5" />
              {ingestPlan.error?.message ?? approvePlan.error?.message}
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
            detail.tasks.map((task) => (
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
                </div>
                <div className="flex items-start gap-1">
                  <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
                    {task.status}
                  </span>
                  <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
                    {task.taskType}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

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
              <div className="grid gap-2">
                {detail.workers.map((worker) => {
                  const taskTitle = worker.taskId
                    ? (taskTitleById.get(worker.taskId) ?? worker.taskId)
                    : "No task";
                  return (
                    <div key={worker.id} className="rounded border px-3 py-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <div className="text-sm font-medium">
                          {worker.status}
                        </div>
                        <div className="text-muted-foreground text-xs">
                          attempt {worker.attempt}
                        </div>
                      </div>
                      <div className="text-muted-foreground mt-1 text-xs break-words">
                        {taskTitle}
                      </div>
                      <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                        <span>{worker.provider ?? detail.run.provider}</span>
                        {worker.model && <span>{worker.model}</span>}
                        {worker.sessionId && <span>{worker.sessionId}</span>}
                      </div>
                      {worker.spawnError && (
                        <div className="text-destructive mt-1 text-xs break-words">
                          {worker.spawnError}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-md border">
          <div className="border-b px-3 py-2">
            <h3 className="text-sm font-medium">Events</h3>
          </div>
          <div className="grid gap-2 p-3">
            {detail.events.map((event) => {
              const preview = eventPayloadPreview(event.payload);
              return (
                <div key={event.id} className="rounded border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {event.eventType}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {labelDate(event.createdAt)}
                    </span>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {event.actor}
                  </div>
                  {preview && (
                    <div className="text-muted-foreground mt-1 text-xs break-words">
                      {preview}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

export function FleetManagementView({ onClose }: { onClose?: () => void }) {
  const runs = useFleetRunsQuery(true);
  const repos = useDispatchReposQuery(true);
  const projects = useProjectsQuery();
  const createRun = useCreateFleetRun();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repoId, setRepoId] = useState(NONE);
  const [projectId, setProjectId] = useState(NONE);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [reviewPolicy, setReviewPolicy] =
    useState<FleetReviewPolicy>("four_agent");

  const selectedRun = useMemo(
    () => (runs.data ?? []).find((run) => run.id === selectedRunId) ?? null,
    [runs.data, selectedRunId]
  );
  const detail = useFleetRunQuery(selectedRunId, selectedRunId != null);

  useEffect(() => {
    if (!selectedRunId && runs.data?.[0]) setSelectedRunId(runs.data[0].id);
  }, [runs.data, selectedRunId]);

  async function handleCreateRun() {
    try {
      const created = await createRun.mutateAsync({
        name,
        goal,
        repoId: repoId === NONE ? null : repoId,
        projectId: projectId === NONE ? null : projectId,
        budgetUsd: budgetUsd.trim() ? Number(budgetUsd) : null,
        provider,
        model: model.trim() || null,
        maxConcurrency,
        reviewPolicy,
      });
      setSelectedRunId(created.run.id);
      setName("");
      setGoal("");
      setBudgetUsd("");
    } catch {
      // React Query owns the rendered error state.
    }
  }

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <Network className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">Fleet Management</span>
          <span className="text-muted-foreground text-xs">
            {runs.data?.length ?? 0} runs
          </span>
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
        <aside className="flex min-h-0 flex-col gap-3 border-r p-4">
          <section className="rounded-md border p-3">
            <div className="mb-3 flex items-center gap-2">
              <Plus className="h-4 w-4" />
              <h3 className="text-sm font-medium">Draft run</h3>
            </div>
            <div className="grid gap-2">
              <Input
                aria-label="Fleet run name"
                placeholder="Name"
                maxLength={FLEET_RUN_NAME_MAX}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Textarea
                aria-label="Fleet run goal"
                placeholder="Goal"
                maxLength={FLEET_RUN_GOAL_MAX}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
              <Select value={repoId} onValueChange={setRepoId}>
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
              <Select value={projectId} onValueChange={setProjectId}>
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
                onValueChange={(value) =>
                  setReviewPolicy(value as FleetReviewPolicy)
                }
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
              <Button
                className="gap-2"
                disabled={!name.trim() || !goal.trim() || createRun.isPending}
                onClick={() => void handleCreateRun()}
              >
                {createRun.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Create draft
              </Button>
              {createRun.isError && (
                <div className="text-destructive flex items-center gap-2 text-xs">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {createRun.error.message}
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
                    onSelect={() => setSelectedRunId(run.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </aside>

        <main className="flex min-h-0 flex-col lg:overflow-hidden">
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
              <RunDetail detail={detail.data} />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
