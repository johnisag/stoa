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
  Monitor,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  useFleetCancellationPreview,
  useRequestFleetCleanup,
  useFleetMergeStatus,
  useRequestFleetMerge,
  useAuthorizeFleetLanding,
  useRetryFleetLanding,
  useFleetSupervisorSnapshot,
  useRetryFleetTask,
  useReconcileFleetTaskVerification,
  useReconcileFleetTaskReview,
  useMessageFleetWorker,
  useKillFleetWorker,
  useFleetWorkerOutput,
  useFleetArtifactBody,
  useFleetApprovalControl,
  useFleetApprovalControlPreview,
} from "@/data/fleet/queries";
import { useProjectsQuery } from "@/data/projects/queries";
import type {
  FleetAutomationCleanupPolicy,
  FleetArtifactSeverity,
  FleetDestructiveActionPreview,
  FleetArtifactDto,
  FleetEventDto,
  FleetReviewPolicy,
  FleetRunDetailDto,
  FleetRunDto,
  FleetTaskDto,
  FleetVerificationDto,
  FleetWorkerDto,
} from "@/lib/fleet/types";
import {
  FLEET_DEFAULT_RESOURCE_LIMITS,
  type FleetResourceLimits,
} from "@/lib/fleet/resource-admission";
import {
  FLEET_DEFAULT_PARALLEL_WORKERS,
  FLEET_MAX_TOTAL_WORKERS,
  FLEET_PARALLEL_WORKERS_WARNING_THRESHOLD,
} from "@/lib/fleet/admission";
import {
  FLEET_MODEL_MAX,
  FLEET_PROVIDER_MAX,
  FLEET_RUN_GOAL_MAX,
  FLEET_RUN_NAME_MAX,
} from "@/lib/fleet/engine";
import { cn } from "@/lib/utils";
import type {
  FleetApprovalControlBinding,
  FleetApprovalControlPreviewDto,
  FleetTaskApprovalControlBinding,
} from "@/lib/fleet/approval-control-types";

const NONE = "__none__";
type MobileFleetSection = "plan" | "tasks" | "workers" | "events" | "merge";

const MOBILE_FLEET_SECTIONS: Array<{
  id: MobileFleetSection;
  label: string;
}> = [
  { id: "plan", label: "Plan" },
  { id: "tasks", label: "Tasks" },
  { id: "workers", label: "Workers" },
  { id: "events", label: "Events" },
  { id: "merge", label: "Merge" },
];

type NumericFleetResourceKey = Exclude<
  keyof FleetResourceLimits,
  "providerCaps"
>;

const FLEET_RESOURCE_FIELDS: ReadonlyArray<{
  key: NumericFleetResourceKey;
  label: string;
  unit: string;
}> = [
  { key: "pty", label: "PTY slots", unit: "slots" },
  { key: "transportHost", label: "Transport host slots", unit: "slots" },
  { key: "verifier", label: "Verifier slots", unit: "slots" },
  { key: "gitOperation", label: "Git operation slots", unit: "slots" },
  { key: "mergeOperation", label: "Merge operation slots", unit: "slots" },
  {
    key: "worktreesPerRepo",
    label: "Worktrees per repository",
    unit: "worktrees",
  },
  { key: "diskBytes", label: "Fleet disk limit", unit: "bytes" },
  {
    key: "outputBytesPerMinute",
    label: "Output rate limit",
    unit: "bytes/minute",
  },
  {
    key: "artifactBytesPerMinute",
    label: "Artifact rate limit",
    unit: "bytes/minute",
  },
  {
    key: "artifactBytesTotal",
    label: "Artifact total limit",
    unit: "bytes",
  },
  {
    key: "eventBytesPerMinute",
    label: "Event byte rate limit",
    unit: "bytes/minute",
  },
  {
    key: "eventFanoutPerMinute",
    label: "Event fanout rate limit",
    unit: "events/minute",
  },
  {
    key: "eventBytesTotal",
    label: "Event total limit",
    unit: "bytes",
  },
];

function parseProviderCaps(
  value: string
): { ok: true; caps: Record<string, number> } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, caps: {} };
  const entries = trimmed
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > 32) {
    return { ok: false, error: "Provider caps support at most 32 providers" };
  }
  const caps: Record<string, number> = {};
  for (const entry of entries) {
    const match = /^([a-z0-9][a-z0-9_-]{0,31})\s*=\s*(\d+)$/i.exec(entry);
    if (!match) {
      return {
        ok: false,
        error: `Invalid provider cap "${entry}"; use provider=limit`,
      };
    }
    const provider = match[1].toLowerCase();
    const limit = Number(match[2]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40) {
      return {
        ok: false,
        error: `Provider cap for ${provider} must be an integer from 1 to 40`,
      };
    }
    caps[provider] = limit;
  }
  return { ok: true, caps };
}

type FleetAttentionCategory =
  | "approval"
  | "security"
  | "verification"
  | "review"
  | "claim-drift"
  | "budget"
  | "recovery"
  | "merge"
  | "operator"
  | "failure"
  | "cleanup";

const FLEET_ATTENTION_LABELS: Record<FleetAttentionCategory, string> = {
  approval: "Approval required",
  security: "Secret / security",
  verification: "Failed verification",
  review: "Blocking review",
  "claim-drift": "Claim drift",
  budget: "Budget",
  recovery: "Recovery",
  merge: "Merge",
  operator: "Operator request",
  failure: "Failure",
  cleanup: "Cleanup",
};

interface FleetAttentionItem {
  id: string;
  priority: number;
  category: FleetAttentionCategory;
  label: string;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  return `${value.toLocaleString("en-US")} tokens`;
}

function payloadId(payload: unknown, keys: string[]): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}

function taskAttentionPriority(task: FleetTaskDto): number {
  if (task.status === "waiting_for_operator") return 1;
  if (task.status === "failed") return 2;
  if (["blocked", "needs_inspection", "needs_followup"].includes(task.status)) {
    return 3;
  }
  if (task.providerState === "backoff" || task.retryNotBefore) return 5;
  return 99;
}

function workerAttentionPriority(worker: FleetWorkerDto): number {
  if (
    worker.status === "waiting_for_operator" ||
    worker.renderedStatus === "waiting"
  ) {
    return 1;
  }
  if (
    ["failed", "dead"].includes(worker.status) ||
    worker.renderedStatus === "error" ||
    worker.renderedStatus === "dead"
  ) {
    return 2;
  }
  if (worker.status === "cleanup_pending" || worker.renderedStatusError) {
    return 4;
  }
  return 99;
}

type FleetEvidenceBinding = "current" | "historical" | "unknown";

const FLEET_UNRESOLVED_TASK_STATUSES = new Set<FleetTaskDto["status"]>([
  "blocked",
  "failed",
  "needs_followup",
  "needs_inspection",
  "waiting_for_operator",
]);

function isFleetEvidenceHash(value: string | null): value is string {
  return value != null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function fleetEvidenceBinding(
  current: string | null,
  artifact: string | null
): FleetEvidenceBinding {
  if (current && artifact && current.toLowerCase() === artifact.toLowerCase()) {
    return "current";
  }
  if (isFleetEvidenceHash(current) && isFleetEvidenceHash(artifact)) {
    return "historical";
  }
  return "unknown";
}

function taskHasExplicitUnresolvedState(task: FleetTaskDto): boolean {
  return (
    FLEET_UNRESOLVED_TASK_STATUSES.has(task.status) ||
    task.verificationStatus === "fail" ||
    task.verificationStatus === "error" ||
    task.reviewStatus === "changes_requested"
  );
}

/**
 * Artifacts are an append-only audit trail, while attention is current state.
 * Only a well-formed, contradictory binding proves an artifact historical;
 * incomplete or malformed evidence stays visible so the UI fails closed.
 */
function blockerArtifactNeedsAttention(
  detail: FleetRunDetailDto,
  artifact: FleetArtifactDto
): boolean {
  const planBinding = fleetEvidenceBinding(
    detail.run.planHash,
    artifact.planHash
  );
  if (planBinding === "historical") return false;

  if (!artifact.taskId) {
    const integrationBinding = fleetEvidenceBinding(
      detail.run.integrationHeadSha,
      artifact.headSha
    );
    return integrationBinding !== "historical";
  }

  const task = detail.tasks.find(
    (candidate) => candidate.id === artifact.taskId
  );
  if (!task) return true;

  const headBinding = fleetEvidenceBinding(task.headSha, artifact.headSha);
  if (headBinding === "current") return true;
  if (headBinding === "historical") {
    return taskHasExplicitUnresolvedState(task);
  }
  return true;
}

function buildFleetAttention(
  detail: FleetRunDetailDto,
  approvalPreview?: FleetApprovalControlPreviewDto | null,
  planApprovalNeedsOperator = false
): FleetAttentionItem[] {
  const items: FleetAttentionItem[] = [];
  const push = (
    id: string,
    priority: number,
    category: FleetAttentionCategory,
    label: string
  ) => items.push({ id, priority, category, label });
  const specializedTasks = new Set<string>();

  if (
    detail.run.approvalState === "blocked" ||
    (detail.run.approvalState === "needs_approval" && planApprovalNeedsOperator)
  ) {
    push(
      "approval",
      0,
      "approval",
      detail.run.approvalState === "blocked"
        ? "Plan approval is blocked"
        : "Reviewed plan requires approval"
    );
  }
  if (
    approvalPreview?.approvedVsCurrent.planChanged ||
    approvalPreview?.approvedVsCurrent.executionChanged ||
    approvalPreview?.approvedVsCurrent.policyChanged
  ) {
    const changed = [
      approvalPreview.approvedVsCurrent.planChanged ? "plan" : null,
      approvalPreview.approvedVsCurrent.executionChanged ? "execution" : null,
      approvalPreview.approvedVsCurrent.policyChanged ? "policy" : null,
    ].filter((value): value is string => value != null);
    push(
      "approval-binding-drift",
      0,
      "approval",
      `Approved vs current ${changed.join(", ")} hash changed`
    );
  }
  for (const task of approvalPreview?.tasks ?? []) {
    if (!task.quarantinedForClaimApproval) continue;
    specializedTasks.add(task.id);
    const title =
      detail.tasks.find((candidate) => candidate.id === task.id)?.title ??
      task.id;
    if (task.sensitivePaths.length > 0) {
      push(
        `security:${task.id}`,
        0,
        "security",
        `${title}: sensitive path approval required (${task.sensitivePaths
          .map((path) => path.path)
          .join(", ")})`
      );
    } else {
      push(
        `claim-drift:${task.id}`,
        4,
        "claim-drift",
        `${title}: actual claims exceed the approved set`
      );
    }
  }
  for (const task of detail.tasks) {
    if (
      task.verificationStatus === "fail" ||
      task.verificationStatus === "error"
    ) {
      specializedTasks.add(task.id);
      push(
        `verification:${task.id}`,
        2,
        "verification",
        `${task.title}: verification ${task.verificationStatus}`
      );
    }
    if (task.reviewStatus === "changes_requested") {
      specializedTasks.add(task.id);
      push(
        `review:${task.id}`,
        3,
        "review",
        `${task.title}: blocking review findings`
      );
    }
    const addedClaims = task.actualFileClaims.filter(
      (claim) => !task.fileClaims.includes(claim)
    );
    if (addedClaims.length > 0 && !specializedTasks.has(task.id)) {
      specializedTasks.add(task.id);
      push(
        `claim-drift:${task.id}`,
        4,
        "claim-drift",
        `${task.title}: ${addedClaims.length} unapproved actual claim${
          addedClaims.length === 1 ? "" : "s"
        }`
      );
    }
  }
  for (const artifact of detail.artifacts) {
    if (
      artifact.severity !== "blocker" ||
      !blockerArtifactNeedsAttention(detail, artifact)
    ) {
      continue;
    }
    const descriptor =
      `${artifact.artifactType} ${artifact.title}`.toLowerCase();
    const security = /secret|credential|security|sensitive|token|\.env/.test(
      descriptor
    );
    push(
      `artifact:${artifact.id}`,
      security ? 0 : 3,
      security ? "security" : "review",
      `${artifact.title}: blocker artifact`
    );
  }
  if (detail.run.automationLastError) {
    push(
      "automation",
      0,
      "recovery",
      `Automation paused: ${detail.run.automationLastError}`
    );
  }
  if (detail.run.pauseReason === "budget_exhausted") {
    push(
      "budget",
      0,
      "budget",
      "Budget exhausted; automatic starts are blocked"
    );
  } else if (detail.run.budgetHardLimitAt) {
    push("budget-hard-limit", 0, "budget", "Budget hard limit reached");
  } else if (detail.run.budgetWarningEmittedAt) {
    push("budget-warning", 5, "budget", "Budget warning threshold reached");
  }
  if (detail.run.recoveryRequired) {
    push(
      "recovery",
      0,
      "recovery",
      "Recovery must finish before new workers launch"
    );
  }
  if (detail.run.integrationError) {
    push("merge", 0, "merge", `Merge blocked: ${detail.run.integrationError}`);
  } else if (detail.run.integrationState === "awaiting_operator") {
    push("merge", 5, "merge", "Merge is waiting for operator action");
  }
  for (const task of detail.tasks) {
    if (specializedTasks.has(task.id)) continue;
    const priority = taskAttentionPriority(task);
    if (priority < 99) {
      push(
        `task:${task.id}`,
        priority * 10,
        task.status === "waiting_for_operator"
          ? "operator"
          : task.status === "failed"
            ? "failure"
            : "review",
        `${task.title}: ${task.status.replaceAll("_", " ")}`
      );
    }
  }
  for (const worker of detail.workers) {
    const priority = workerAttentionPriority(worker);
    if (priority < 99) {
      const task = detail.tasks.find(
        (candidate) => candidate.id === worker.taskId
      );
      push(
        `worker:${worker.id}`,
        priority * 10,
        worker.status === "waiting_for_operator" ||
          worker.renderedStatus === "waiting"
          ? "operator"
          : ["failed", "dead"].includes(worker.status) ||
              worker.renderedStatus === "error" ||
              worker.renderedStatus === "dead"
            ? "failure"
            : "cleanup",
        `${task?.title ?? "Unlinked worker"} attempt ${worker.attempt}: ${
          worker.renderedStatus
            ? `rendered ${worker.renderedStatus}`
            : worker.renderedStatusError
              ? "rendered status unavailable"
              : worker.status.replaceAll("_", " ")
        }`
      );
    }
  }
  return items.sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id)
  );
}

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
  outputOpen,
  onToggleOutput,
}: {
  runId: string;
  worker: FleetWorkerDto;
  outputOpen: boolean;
  onToggleOutput: () => void;
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
            aria-expanded={outputOpen}
            aria-label={`Rendered output for worker attempt ${worker.attempt}`}
            onClick={onToggleOutput}
          >
            <Monitor className="h-3.5 w-3.5" />
            {outputOpen ? "Hide output" : "Load output"}
          </Button>
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

function WorkerOutputPanel({
  runId,
  worker,
  onClose,
}: {
  runId: string;
  worker: FleetWorkerDto;
  onClose: () => void;
}) {
  const output = useFleetWorkerOutput(
    runId,
    worker.id,
    worker.attempt,
    worker.sessionId,
    true,
    80
  );
  return (
    <div className="bg-muted/30 mt-2 grid gap-2 rounded border p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">
          Rendered terminal · exact attempt {worker.attempt}
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={output.isFetching}
            onClick={() => void output.refetch()}
          >
            Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      {output.isLoading || output.isFetching ? (
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading rendered
          output
        </div>
      ) : output.error ? (
        <div className="text-destructive text-xs">{output.error.message}</div>
      ) : (
        <>
          <pre className="bg-background max-h-64 overflow-auto rounded border p-2 font-mono text-[11px] whitespace-pre-wrap">
            {output.data?.output || "No rendered output"}
          </pre>
          <span className="text-muted-foreground text-[10px]">
            {output.data?.lines ?? 0} lines
            {output.data?.truncated ? " · bounded preview" : ""}
            {output.data?.capturedAt
              ? ` · ${labelDate(output.data.capturedAt)}`
              : ""}
          </span>
        </>
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

function ApprovalPreview({
  detail,
  estimate,
}: {
  detail: FleetRunDetailDto;
  estimate: FleetApprovalControlPreviewDto["estimate"] | null;
}) {
  const preview = detail.run.approvalPreview;
  const budgetExceeded =
    estimate?.budgetComparison.usd === "exceeds" ||
    estimate?.budgetComparison.tokens === "exceeds";
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
            Further gated actions
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
      <div
        className={cn(
          "mt-3 rounded border p-2 text-xs",
          budgetExceeded &&
            "border-destructive/40 bg-destructive/5 text-destructive"
        )}
        data-testid="fleet-approval-cost-estimate"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">Estimated remaining Fleet spend</span>
          <span className="text-[10px] uppercase">
            {estimate?.confidence ?? "unknown"} confidence
          </span>
        </div>
        {estimate?.estimatedUsd == null || estimate.estimatedTokens == null ? (
          <p className="text-muted-foreground mt-1">
            No future paid session can be estimated until a runnable plan or
            pending planner exists. This is not a zero-cost estimate.
          </p>
        ) : (
          <>
            <p className="mt-1">
              Conservative remaining reservation:{" "}
              {formatUsd(estimate.estimatedUsd)} and{" "}
              {formatTokens(estimate.estimatedTokens)} tokens across{" "}
              {estimate.sessionCounts.total} sessions (
              {estimate.sessionCounts.workerAttempts} worker attempts,{" "}
              {estimate.sessionCounts.taskReviews} task reviews,{" "}
              {estimate.sessionCounts.planReviews} plan reviews,{" "}
              {estimate.sessionCounts.planner} planner).
            </p>
            <p className="text-muted-foreground mt-1">
              Projected total including current spent and reserved:{" "}
              {estimate.projectedTotalUsd == null
                ? "unknown USD"
                : formatUsd(estimate.projectedTotalUsd)}{" "}
              and{" "}
              {estimate.projectedTotalTokens == null
                ? "unknown tokens"
                : formatTokens(estimate.projectedTotalTokens)}{" "}
              tokens. Budget: USD {estimate.budgetComparison.usd}, tokens{" "}
              {estimate.budgetComparison.tokens}.
            </p>
          </>
        )}
        {estimate?.capped && (
          <p className="mt-1 font-medium">
            Estimate reached a safety bound; actual remaining spend may be
            higher.
          </p>
        )}
        {estimate?.exclusions.map((exclusion) => (
          <p key={exclusion} className="text-muted-foreground mt-1 text-[10px]">
            {exclusion}
          </p>
        ))}
      </div>
    </section>
  );
}

function approvalBindingsCurrent(
  preview: FleetApprovalControlPreviewDto
): boolean {
  return !(
    !preview.bindings.currentPolicyHash ||
    preview.approvedVsCurrent.planChanged ||
    preview.approvedVsCurrent.executionChanged ||
    preview.approvedVsCurrent.policyChanged
  );
}

function exactRunApprovalBinding(
  preview: FleetApprovalControlPreviewDto,
  action: string
): FleetApprovalControlBinding | null {
  if (!approvalBindingsCurrent(preview)) return null;
  return {
    requestId: operatorRequestId(action),
    expectedPlanHash: preview.bindings.currentPlanHash,
    expectedExecutionHash: preview.bindings.currentExecutionHash,
    expectedPolicyHash: preview.bindings.currentPolicyHash!,
    expectedBaseSha: preview.bindings.baseSha,
    expectedRunUpdatedAt: preview.bindings.runUpdatedAt,
  };
}

function exactTaskApprovalBinding(
  preview: FleetApprovalControlPreviewDto,
  task: FleetApprovalControlPreviewDto["tasks"][number],
  action: string
): FleetTaskApprovalControlBinding | null {
  const run = exactRunApprovalBinding(preview, action);
  return run
    ? {
        ...run,
        expectedTaskStatus: task.status,
        expectedTaskApprovalState: task.approvalState,
        expectedAttempt: task.attempt,
        expectedTaskBaseSha: task.baseSha,
        expectedHeadSha: task.headSha,
        expectedTaskUpdatedAt: task.updatedAt,
      }
    : null;
}

function FleetApprovalControls({
  runId,
  taskTitleById,
  controlWindowOpen,
}: {
  runId: string;
  taskTitleById: Map<string, string>;
  controlWindowOpen: boolean;
}) {
  const previewQuery = useFleetApprovalControlPreview(runId, true);
  const approval = useFleetApprovalControl(runId);
  const preview = previewQuery.data;
  const [concurrency, setConcurrency] = useState(1);
  const [usdBudget, setUsdBudget] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const [overrideHardStop, setOverrideHardStop] = useState(false);
  const approvalFormAuthorityKey = preview
    ? JSON.stringify([
        runId,
        preview.run.maxConcurrency,
        preview.run.budgetUsd,
        preview.run.budgetTokens,
        preview.run.pauseReason,
      ])
    : null;

  useEffect(() => {
    if (!preview) return;
    setConcurrency(preview.run.maxConcurrency);
    setUsdBudget(
      preview.run.budgetUsd == null ? "" : String(preview.run.budgetUsd)
    );
    setTokenBudget(
      preview.run.budgetTokens == null ? "" : String(preview.run.budgetTokens)
    );
    setOverrideHardStop(false);
  }, [approvalFormAuthorityKey]);

  if (previewQuery.isLoading) {
    return (
      <section className="rounded-md border p-3 text-xs">
        <span className="text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading exact
          approval controls
        </span>
      </section>
    );
  }
  if (previewQuery.error || !preview) {
    return (
      <section className="rounded-md border p-3 text-xs">
        <span className="text-muted-foreground">
          Admin approval controls unavailable
          {previewQuery.error ? `: ${previewQuery.error.message}` : "."}
        </span>
      </section>
    );
  }

  const exact = approvalBindingsCurrent(preview) && controlWindowOpen;
  const parsedUsdBudget = usdBudget.trim() === "" ? null : Number(usdBudget);
  const parsedTokenBudget =
    tokenBudget.trim() === "" ? null : Number(tokenBudget);
  const usdBudgetChanged = parsedUsdBudget !== preview.run.budgetUsd;
  const tokenBudgetChanged = parsedTokenBudget !== preview.run.budgetTokens;
  const usdBudgetIncreases =
    parsedUsdBudget === null
      ? preview.run.budgetUsd !== null
      : Number.isFinite(parsedUsdBudget) &&
        parsedUsdBudget >= 0 &&
        parsedUsdBudget <= 1_000_000_000 &&
        preview.run.budgetUsd !== null &&
        parsedUsdBudget > preview.run.budgetUsd;
  const tokenBudgetIncreases =
    parsedTokenBudget === null
      ? preview.run.budgetTokens !== null
      : Number.isSafeInteger(parsedTokenBudget) &&
        parsedTokenBudget >= 0 &&
        parsedTokenBudget <= 1_000_000_000_000 &&
        preview.run.budgetTokens !== null &&
        parsedTokenBudget > preview.run.budgetTokens;
  const budgetChangesValid =
    (!usdBudgetChanged || usdBudgetIncreases) &&
    (!tokenBudgetChanged || tokenBudgetIncreases);
  const budgetIncreases =
    budgetChangesValid && (usdBudgetIncreases || tokenBudgetIncreases);
  const hardStop = preview.run.pauseReason === "budget_exhausted";
  const changedLabels = [
    preview.approvedVsCurrent.planChanged ? "plan" : null,
    preview.approvedVsCurrent.executionChanged ? "execution" : null,
    preview.approvedVsCurrent.policyChanged ? "policy" : null,
  ].filter((value): value is string => value != null);
  const bindingComparisons = [
    {
      id: "plan",
      label: "Plan",
      approved: preview.bindings.approvedPlanHash,
      current: preview.bindings.currentPlanHash,
      changed: preview.approvedVsCurrent.planChanged,
    },
    {
      id: "execution",
      label: "Execution",
      approved: preview.bindings.approvedExecutionHash,
      current: preview.bindings.currentExecutionHash,
      changed: preview.approvedVsCurrent.executionChanged,
    },
    {
      id: "policy",
      label: "Policy",
      approved: preview.bindings.storedPolicyHash,
      current: preview.bindings.currentPolicyHash,
      changed: preview.approvedVsCurrent.policyChanged,
    },
  ];

  return (
    <section className="rounded-md border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          <h3 className="text-sm font-medium">Exact approval controls</h3>
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] uppercase",
            exact
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "bg-destructive/10 text-destructive"
          )}
        >
          {exact
            ? "bindings current"
            : !controlWindowOpen
              ? "control window closed"
              : `${changedLabels.join(" / ") || "invalid"} changed`}
        </span>
      </div>
      <div className="grid gap-3 p-3">
        <div
          className="grid gap-2 text-[10px] md:grid-cols-3"
          data-testid="approval-binding-comparison"
        >
          {bindingComparisons.map((comparison) => (
            <div
              key={comparison.id}
              className="grid min-w-0 gap-1 rounded border p-2"
              data-testid={`approval-dimension-${comparison.id}`}
            >
              <span className="flex items-center justify-between gap-2 uppercase">
                <span className="text-muted-foreground">
                  {comparison.label}
                </span>
                <span
                  className={cn(
                    "rounded px-1 py-0.5",
                    comparison.changed
                      ? "bg-destructive/10 text-destructive"
                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  )}
                >
                  {comparison.changed ? "changed" : "exact match"}
                </span>
              </span>
              <span className="text-muted-foreground uppercase">
                Approved hash
              </span>
              <span className="font-mono break-all">
                {comparison.approved ?? "none"}
              </span>
              <span className="text-muted-foreground uppercase">
                Current hash
              </span>
              <span className="font-mono break-all">
                {comparison.current ?? "invalid"}
              </span>
            </div>
          ))}
          <div className="text-muted-foreground md:col-span-3">
            <span className="uppercase">Base commit</span>
            <span className="ml-2 font-mono break-all">
              {preview.bindings.baseSha ?? "not repository-bound"}
            </span>
          </div>
        </div>
        {!exact && (
          <div className="border-destructive/40 bg-destructive/5 text-destructive rounded border p-2 text-xs">
            {controlWindowOpen
              ? "Controls are locked because the approved and current exact bindings differ. Refresh or re-approve the changed contract first."
              : "Controls are locked because the run is terminal or external landing is already authorized."}
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2">
          <div className="grid gap-2 rounded border p-2">
            <label className="grid gap-1 text-xs">
              <span>Approved concurrency</span>
              <Input
                aria-label="Approved Fleet concurrency"
                type="number"
                min={1}
                max={40}
                value={concurrency}
                onChange={(event) => setConcurrency(Number(event.target.value))}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !exact ||
                approval.isPending ||
                !Number.isSafeInteger(concurrency) ||
                concurrency < 1 ||
                concurrency > 40 ||
                concurrency === preview.run.maxConcurrency
              }
              onClick={() => {
                const binding = exactRunApprovalBinding(
                  preview,
                  "approval-concurrency"
                );
                if (!binding) return;
                if (
                  !window.confirm(
                    `Approve concurrency ${preview.run.maxConcurrency} → ${concurrency} against the displayed exact contract?`
                  )
                )
                  return;
                approval.reset();
                void approval
                  .mutateAsync({
                    kind: "concurrency",
                    body: { ...binding, maxConcurrency: concurrency },
                  })
                  .catch(() => undefined);
              }}
            >
              Approve concurrency change
            </Button>
          </div>
          <div className="grid gap-2 rounded border p-2">
            <label className="grid gap-1 text-xs">
              <span>Approved USD budget (blank = unlimited)</span>
              <Input
                aria-label="Approved Fleet USD budget"
                inputMode="decimal"
                value={usdBudget}
                onChange={(event) => setUsdBudget(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs">
              <span>Approved token budget (blank = unlimited)</span>
              <Input
                aria-label="Approved Fleet token budget"
                inputMode="numeric"
                value={tokenBudget}
                onChange={(event) => setTokenBudget(event.target.value)}
              />
            </label>
            <span className="text-muted-foreground text-[10px]">
              Current use: {formatUsd(preview.run.spentBudgetUsd)} spent +{" "}
              {formatUsd(preview.run.reservedBudgetUsd)} reserved;{" "}
              {formatTokens(preview.run.spentBudgetTokens)} spent +{" "}
              {formatTokens(preview.run.reservedBudgetTokens)} reserved. Stop
              mode: {preview.run.budgetStopMode}.
            </span>
            {hardStop && (
              <label className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                <input
                  aria-label="Override exact budget hard stop"
                  type="checkbox"
                  checked={overrideHardStop}
                  onChange={(event) =>
                    setOverrideHardStop(event.target.checked)
                  }
                />
                Explicitly clear this exact budget-exhausted hard stop after the
                increase is approved.
              </label>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={
                !exact ||
                approval.isPending ||
                !budgetIncreases ||
                (hardStop && !overrideHardStop)
              }
              onClick={() => {
                const binding = exactRunApprovalBinding(
                  preview,
                  "approval-budget"
                );
                if (!binding || !budgetIncreases) return;
                const changes = [
                  usdBudgetIncreases
                    ? `USD ${preview.run.budgetUsd == null ? "unlimited" : `$${preview.run.budgetUsd}`} to ${parsedUsdBudget == null ? "unlimited" : `$${parsedUsdBudget}`}`
                    : null,
                  tokenBudgetIncreases
                    ? `tokens ${preview.run.budgetTokens == null ? "unlimited" : preview.run.budgetTokens.toLocaleString()} to ${parsedTokenBudget == null ? "unlimited" : parsedTokenBudget.toLocaleString()}`
                    : null,
                ].filter((value): value is string => value != null);
                if (
                  !window.confirm(
                    `Approve budget change (${changes.join("; ")})${overrideHardStop ? " and clear the exact hard stop" : ""}?`
                  )
                )
                  return;
                approval.reset();
                void approval
                  .mutateAsync({
                    kind: "budget",
                    body: {
                      ...binding,
                      ...(usdBudgetIncreases
                        ? { budgetUsd: parsedUsdBudget }
                        : {}),
                      ...(tokenBudgetIncreases
                        ? { budgetTokens: parsedTokenBudget }
                        : {}),
                      overrideHardStop,
                      expectedPauseReason: preview.run.pauseReason,
                    },
                  })
                  .catch(() => undefined);
              }}
            >
              Approve budget change
            </Button>
          </div>
        </div>
        {preview.tasks.some(
          (task) => task.notYetStarted || task.quarantinedForClaimApproval
        ) && (
          <div className="grid gap-2">
            <div className="text-muted-foreground text-[10px] font-medium uppercase">
              Task approvals
            </div>
            {preview.tasks
              .filter(
                (task) => task.notYetStarted || task.quarantinedForClaimApproval
              )
              .map((task) => {
                const bind = (action: string) =>
                  exactTaskApprovalBinding(preview, task, action);
                return (
                  <div key={task.id} className="grid gap-2 rounded border p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        {taskTitleById.get(task.id) ?? task.id}
                      </span>
                      <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
                        {task.status} · {task.approvalState}
                      </span>
                    </div>
                    {task.addedActualClaims.length > 0 && (
                      <div className="text-muted-foreground text-[11px]">
                        Exact added claims: {task.addedActualClaims.join(", ")}
                        {task.sensitivePaths.length > 0
                          ? ` · sensitive: ${task.sensitivePaths.map((path) => `${path.path} (${path.reason})`).join(", ")}`
                          : ""}
                      </div>
                    )}
                    {task.skipClosure.blockers.length > 0 && (
                      <div className="text-muted-foreground text-[11px]">
                        Skip blocked: {task.skipClosure.blockers.join("; ")}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {task.notYetStarted && task.skipClosure.eligible && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!exact || approval.isPending}
                          onClick={() => {
                            const binding = bind("approval-task-skip");
                            if (!binding) return;
                            if (
                              !window.confirm(
                                `Skip the exact ${task.skipClosure.taskIds.length}-task dependency closure? This cannot be undone in this run.`
                              )
                            )
                              return;
                            approval.reset();
                            void approval
                              .mutateAsync({
                                kind: "task_skip",
                                taskId: task.id,
                                body: {
                                  ...binding,
                                  expectedSkipClosureHash:
                                    task.skipClosure.hash,
                                },
                              })
                              .catch(() => undefined);
                          }}
                        >
                          Skip {task.skipClosure.taskIds.length}-task closure
                        </Button>
                      )}
                      {task.notYetStarted &&
                        (task.manualLaunchApprovalRequired ||
                          task.approvalState === "approved") && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!exact || approval.isPending}
                            onClick={() => {
                              const required =
                                !task.manualLaunchApprovalRequired;
                              const binding = bind("approval-manual-launch");
                              if (!binding) return;
                              if (
                                !window.confirm(
                                  required
                                    ? "Require an exact manual approval before this task may launch?"
                                    : "Approve this exact task for scheduler launch?"
                                )
                              )
                                return;
                              approval.reset();
                              void approval
                                .mutateAsync({
                                  kind: "task_manual_launch",
                                  taskId: task.id,
                                  body: { ...binding, required },
                                })
                                .catch(() => undefined);
                            }}
                          >
                            {task.manualLaunchApprovalRequired
                              ? "Approve manual launch"
                              : "Require manual launch"}
                          </Button>
                        )}
                      {task.notYetStarted && task.plannedClaims.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!exact || approval.isPending}
                          onClick={() => {
                            const binding = bind("approval-read-only");
                            if (!binding) return;
                            if (
                              !window.confirm(
                                "Convert this exact unstarted task to read-only exploration and rebind the approved plan?"
                              )
                            )
                              return;
                            approval.reset();
                            void approval
                              .mutateAsync({
                                kind: "task_read_only",
                                taskId: task.id,
                                body: binding,
                              })
                              .catch(() => undefined);
                          }}
                        >
                          Convert to read-only
                        </Button>
                      )}
                      {task.quarantinedForClaimApproval &&
                        task.actualClaims.length > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!exact || approval.isPending}
                            onClick={() => {
                              const binding = bind("approval-task-claims");
                              if (!binding) return;
                              const sensitive = task.sensitivePaths.length > 0;
                              if (
                                !window.confirm(
                                  sensitive
                                    ? "Explicitly approve the displayed sensitive claim expansion, then require fresh verification and four exact-head reviews?"
                                    : "Approve the displayed exact claim expansion, then require fresh verification and four exact-head reviews?"
                                )
                              )
                                return;
                              approval.reset();
                              void approval
                                .mutateAsync({
                                  kind: "task_claims",
                                  taskId: task.id,
                                  body: {
                                    ...binding,
                                    expectedActualClaimsHash:
                                      task.actualClaimsHash,
                                    approvedActualClaims: task.actualClaims,
                                    approveSensitivePaths: sensitive,
                                  },
                                })
                                .catch(() => undefined);
                            }}
                          >
                            Approve exact claim expansion
                          </Button>
                        )}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
        {approval.error && (
          <div className="text-destructive text-xs">
            {approval.error.message}
          </div>
        )}
        {preview.recentApprovals.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer font-medium">
              Recent exact approvals ({preview.recentApprovals.length})
            </summary>
            <ul className="mt-2 grid gap-1">
              {preview.recentApprovals.map((event, index) => (
                <li
                  key={`${event.createdAt}:${event.eventType}:${index}`}
                  className="rounded border px-2 py-1"
                >
                  {event.eventType.replaceAll("_", " ")} · {event.actor} ·{" "}
                  {labelDate(event.createdAt)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

type DestructiveFleetAction = "cancel-and-clean" | "cleanup";

function DestructiveFleetActionDialog({
  action,
  runId,
  preview,
  isLoading,
  error,
  isPending,
  confirmation,
  onConfirmationChange,
  onOpenChange,
  onConfirm,
}: {
  action: DestructiveFleetAction | null;
  runId: string;
  preview: FleetDestructiveActionPreview | null;
  isLoading: boolean;
  error: string | null;
  isPending: boolean;
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const destructiveCancel = action === "cancel-and-clean";
  const exactConfirmation = confirmation === runId;
  const canConfirm =
    preview?.complete === true && exactConfirmation && !isPending;
  const retentionDays = preview?.effects.artifactBodyRetentionDays ?? null;

  return (
    <Dialog open={action !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-4 pt-4 pr-12 pb-3 text-left">
          <DialogTitle>
            {destructiveCancel
              ? "Cancel and clean Fleet-owned worktrees"
              : "Clean archived Fleet-owned worktrees"}
          </DialogTitle>
          <DialogDescription>
            Review the bounded, ownership-verified targets below. Stoa binds
            this exact target digest and refuses the mutation if it changes.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-3 overflow-y-auto px-4 text-xs">
          {isLoading && (
            <div className="text-muted-foreground flex items-center gap-2 rounded border p-3">
              <Loader2 className="h-4 w-4 animate-spin" /> Verifying exact Fleet
              ownership...
            </div>
          )}
          {error && (
            <div className="text-destructive rounded border p-3">{error}</div>
          )}
          {preview && (
            <>
              {!preview.complete && (
                <div className="rounded border border-red-500/50 bg-red-500/5 p-3 text-red-700 dark:text-red-300">
                  Preview limit reached for: {preview.truncatedKinds.join(", ")}
                  . This action is disabled because unseen objects cannot be
                  approved safely.
                </div>
              )}
              {preview.complete &&
                preview.truncatedKinds.includes("artifacts") && (
                  <div className="text-muted-foreground rounded border p-3">
                    Preserved artifact display is truncated; artifacts are not
                    destructive targets and do not block this exact target set.
                  </div>
                )}

              <section
                aria-label="Expected destructive action data loss"
                className="rounded border border-red-500/40 bg-red-500/5 p-3"
              >
                <h4 className="font-medium">Expected data loss</h4>
                <ul className="mt-1 list-inside list-disc space-y-1">
                  {destructiveCancel && (
                    <li>
                      {preview.sessions.filter((session) => session.active)
                        .length || "No"}{" "}
                      active Fleet-owned session process
                      {preview.sessions.filter((session) => session.active)
                        .length === 1
                        ? ""
                        : "es"}{" "}
                      will be stopped; unsaved in-memory agent state is lost.
                    </li>
                  )}
                  <li>
                    {preview.worktrees.length || "No"} listed, verified worktree
                    director{preview.worktrees.length === 1 ? "y" : "ies"} and
                    any uncommitted or untracked files inside will be
                    permanently removed
                    {destructiveCancel
                      ? " after owned sessions become terminal"
                      : ""}
                    .
                  </li>
                  <li>
                    {preview.effects.preserveBranches
                      ? "Listed branches and committed Git history are preserved."
                      : "Worker branches are preserved; the explicitly listed Fleet integration branch is deleted after exact head checks."}
                  </li>
                  <li>
                    Audit artifact metadata is preserved
                    {retentionDays == null
                      ? "; artifact bodies remain subject to the configured retention policy."
                      : `; artifact bodies remain subject to the ${retentionDays}-day retention policy.`}
                  </li>
                  {preview.excludedWorktreeCount > 0 && (
                    <li>
                      {preview.excludedWorktreeCount} recorded worktree path
                      {preview.excludedWorktreeCount === 1 ? " was" : "s were"}
                      excluded and will not be deleted because exact Fleet
                      ownership could not be proven.
                    </li>
                  )}
                </ul>
              </section>

              <div className="grid gap-3 md:grid-cols-2">
                <section
                  aria-label="Affected Fleet owners"
                  className="rounded border p-3"
                >
                  <h4 className="font-medium">
                    Owners ({preview.owners.length})
                  </h4>
                  {preview.owners.length === 0 ? (
                    <p className="text-muted-foreground mt-1">None recorded.</p>
                  ) : (
                    <ul className="mt-1 grid gap-1">
                      {preview.owners.map((owner) => (
                        <li
                          key={`${owner.ownerType}:${owner.ownerId}`}
                          className="min-w-0 rounded bg-black/5 px-2 py-1 dark:bg-white/5"
                        >
                          <span className="font-medium">
                            {owner.ownerType.replaceAll("_", " ")}
                          </span>{" "}
                          <span className="font-mono break-all">
                            {owner.ownerId}
                          </span>
                          {owner.sessionId && (
                            <span className="text-muted-foreground block break-all">
                              session {owner.sessionId}
                              {owner.active ? " (active)" : ""}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section
                  aria-label="Affected Fleet sessions"
                  className="rounded border p-3"
                >
                  <h4 className="font-medium">
                    Sessions ({preview.sessions.length})
                  </h4>
                  {preview.sessions.length === 0 ? (
                    <p className="text-muted-foreground mt-1">None recorded.</p>
                  ) : (
                    <ul className="mt-1 grid gap-1">
                      {preview.sessions.map((session) => (
                        <li
                          key={session.id}
                          className="min-w-0 rounded bg-black/5 px-2 py-1 dark:bg-white/5"
                        >
                          <span className="font-mono break-all">
                            {session.id}
                          </span>
                          <span className="text-muted-foreground block break-words">
                            {session.name ?? "Unnamed session"}
                            {session.status ? ` · ${session.status}` : ""}
                            {session.active ? " · active owner" : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              <section
                aria-label="Affected Fleet worktrees"
                className="rounded border p-3"
              >
                <h4 className="font-medium">
                  Worktrees deleted ({preview.worktrees.length})
                </h4>
                {preview.worktrees.length === 0 ? (
                  <p className="text-muted-foreground mt-1">None verified.</p>
                ) : (
                  <ul className="mt-1 grid gap-2">
                    {preview.worktrees.map((worktree) => (
                      <li
                        key={worktree.worktreePath}
                        className="min-w-0 rounded bg-black/5 px-2 py-1 dark:bg-white/5"
                      >
                        <span className="block font-mono break-all">
                          {worktree.worktreePath}
                        </span>
                        <span className="text-muted-foreground block break-all">
                          repo {worktree.projectPath} · owners{" "}
                          {worktree.owners
                            .map(
                              (owner) => `${owner.ownerType}:${owner.ownerId}`
                            )
                            .join(", ")}
                        </span>
                        {worktree.expectedHeadSha && (
                          <span className="text-muted-foreground block font-mono break-all">
                            expected head {worktree.expectedHeadSha}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="grid gap-3 md:grid-cols-2">
                <section
                  aria-label="Affected Fleet branches"
                  className="rounded border p-3"
                >
                  <h4 className="font-medium">
                    Branches ({preview.branches.length})
                  </h4>
                  {preview.branches.length === 0 ? (
                    <p className="text-muted-foreground mt-1">None recorded.</p>
                  ) : (
                    <ul className="mt-1 grid gap-1">
                      {preview.branches.map((branch) => (
                        <li
                          key={`${branch.ownerType}:${branch.ownerId}:${branch.branchName}`}
                          className="font-mono break-all"
                        >
                          {branch.branchName} · {branch.ownerType}:
                          {branch.ownerId} ·{" "}
                          {branch.preserved ? "preserved" : "deleted"}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section
                  aria-label="Preserved Fleet artifacts"
                  className="rounded border p-3"
                >
                  <h4 className="font-medium">
                    Artifacts preserved ({preview.artifacts.length})
                  </h4>
                  {preview.artifacts.length === 0 ? (
                    <p className="text-muted-foreground mt-1">None recorded.</p>
                  ) : (
                    <ul className="mt-1 grid gap-1">
                      {preview.artifacts.map((artifact) => (
                        <li key={artifact.id} className="min-w-0 break-words">
                          <span className="font-mono break-all">
                            {artifact.id}
                          </span>{" "}
                          · {artifact.artifactType} · {artifact.title}
                          {artifact.bodyPrunedAt
                            ? " · body already pruned"
                            : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </>
          )}

          <label className="grid gap-1 pb-1">
            <span>
              Type <span className="font-mono font-medium">{runId}</span> to
              confirm this destructive action.
            </span>
            <Input
              aria-label="Type Fleet run ID to confirm destructive action"
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              onChange={(event) => onConfirmationChange(event.target.value)}
            />
          </label>
        </div>

        <DialogFooter className="border-t px-4 pt-3 pb-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep everything
          </Button>
          <Button
            variant="destructive"
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {destructiveCancel ? "Cancel and clean" : "Delete worktrees"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunDetail({
  detail,
  onBack,
  focusTaskId,
  selectionKey,
}: {
  detail: FleetRunDetailDto;
  onBack: () => void;
  focusTaskId?: string;
  selectionKey?: string;
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
  const [destructiveAction, setDestructiveAction] =
    useState<DestructiveFleetAction | null>(null);
  const [destructiveConfirmation, setDestructiveConfirmation] = useState("");
  const cleanupPreview = useFleetCleanupPreview(
    detail.run.id,
    detail.run.archivedAt != null
  );
  const cancellationPreview = useFleetCancellationPreview(
    detail.run.id,
    destructiveAction === "cancel-and-clean"
  );
  const mergeStatus = useFleetMergeStatus(
    detail.run.id,
    detail.tasks.length > 0 && detail.run.approvalState === "approved"
  );
  const requestMerge = useRequestFleetMerge(detail.run.id);
  const authorizeLanding = useAuthorizeFleetLanding(detail.run.id);
  const retryLanding = useRetryFleetLanding(detail.run.id);
  const supervisor = useFleetSupervisorSnapshot(
    detail.run.id,
    detail.tasks.length > 0
  );
  const attentionApprovalPreview = useFleetApprovalControlPreview(
    detail.run.id,
    true
  );
  const runDetailRef = useRef<HTMLDivElement>(null);
  const reviewedPlanText = detail.run.planText ?? "";
  const [planText, setPlanText] = useState(
    detail.run.planText ?? detail.run.goal
  );
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactBody, setArtifactBody] = useState("");
  const [artifactTaskId, setArtifactTaskId] = useState(NONE);
  const [artifactSeverity, setArtifactSeverity] =
    useState<FleetArtifactSeverity>("warning");
  const [mobileSection, setMobileSection] =
    useState<MobileFleetSection>("plan");
  const [outputWorkerId, setOutputWorkerId] = useState<string | null>(null);
  const [expandedArtifact, setExpandedArtifact] = useState<{
    id: string;
    surface: "task" | "artifact";
  } | null>(null);
  const expandedArtifactMetadata = expandedArtifact
    ? (detail.artifacts.find(
        (artifact) => artifact.id === expandedArtifact.id
      ) ?? null)
    : null;
  const artifactBodyQuery = useFleetArtifactBody(
    detail.run.id,
    expandedArtifact?.id ?? null,
    expandedArtifact !== null && !expandedArtifactMetadata?.bodyPrunedAt
  );

  const expandedArtifactBody = expandedArtifactMetadata?.bodyPrunedAt
    ? "Artifact body pruned; immutable metadata remains available."
    : artifactBodyQuery.isLoading
      ? "Loading artifact body..."
      : artifactBodyQuery.error
        ? `Artifact body unavailable: ${artifactBodyQuery.error.message}`
        : artifactBodyQuery.data?.body || "Artifact body is empty";

  useEffect(() => {
    setPlanText(detail.run.planText ?? detail.run.goal);
    setArtifactTitle("");
    setArtifactBody("");
    setArtifactTaskId(NONE);
    setArtifactSeverity("warning");
    setMobileSection(focusTaskId ? "tasks" : "plan");
    setOutputWorkerId(null);
    setExpandedArtifact(null);
    setDestructiveAction(null);
    setDestructiveConfirmation("");
  }, [detail.run.id, detail.run.goal, detail.run.planText, focusTaskId]);

  useEffect(() => {
    if (!focusTaskId) return;
    setMobileSection("tasks");
    const frame = requestAnimationFrame(() => {
      const target = [
        ...(runDetailRef.current?.querySelectorAll<HTMLElement>(
          "[data-fleet-task-id]"
        ) ?? []),
      ].find((element) => element.dataset.fleetTaskId === focusTaskId);
      target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [detail.run.id, focusTaskId, selectionKey]);

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

  function closeDestructiveAction() {
    setDestructiveAction(null);
    setDestructiveConfirmation("");
  }

  async function handleDestructiveAction() {
    if (destructiveConfirmation !== detail.run.id || !destructiveAction) return;
    const preview =
      destructiveAction === "cancel-and-clean"
        ? cancellationPreview.data
        : cleanupPreview.data?.impact;
    if (!preview?.complete) return;
    resetLifecycleErrors();
    try {
      if (destructiveAction === "cancel-and-clean") {
        await cancelRun.mutateAsync({
          actor: "operator",
          mode: "cancel-and-clean-owned-worktrees",
          confirm: true,
          confirmation: destructiveConfirmation,
          previewDigest: preview.targetDigest,
        });
      } else {
        await cleanupRun.mutateAsync({
          confirmation: destructiveConfirmation,
          previewDigest: preview.targetDigest,
        });
      }
      closeDestructiveAction();
    } catch {
      // React Query owns the rendered error state.
    }
  }

  const planReviewGate = supervisor.data?.gates?.planReview;
  const planReviewsComplete =
    detail.run.reviewPolicy === "manual" || planReviewGate?.complete === true;
  const currentPlanHasBlocker = detail.artifacts.some(
    (artifact) =>
      artifact.severity === "blocker" &&
      (artifact.planHash === detail.run.planHash || artifact.planHash == null)
  );
  const planApprovalActionable =
    !plannerActive &&
    planReviewsComplete &&
    detail.run.approvalState === "needs_approval" &&
    !!detail.run.planHash &&
    !!reviewedPlanText &&
    !currentPlanHasBlocker;
  const planApprovalNeedsOperator =
    planApprovalActionable &&
    (!detail.run.automationPolicy.automaticPlanApproval ||
      Boolean(detail.run.automationLastError));
  const canApprove = planApprovalActionable && planText === reviewedPlanText;
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
  const terminalRun = ["completed", "failed", "canceled"].includes(
    detail.run.status
  );
  const externalLandingActive = detail.run.mergeRequestedAt != null;
  const manualMergeIntentActive =
    detail.run.mergeRequestKind === "manual" &&
    detail.run.mergeTarget != null &&
    !externalLandingActive;
  const manualLandingPreconditions = useMemo(() => {
    const target = detail.run.mergeTarget;
    const planHash = detail.run.planHash;
    const executionHash =
      attentionApprovalPreview.data?.bindings.currentExecutionHash;
    const baseSha = detail.run.automationBaseSha;
    const integrationHeadSha = detail.run.integrationHeadSha;
    const finalVerificationCurrent = mergeStatus.data?.operations.some(
      (operation) =>
        operation.type === "final_verify" &&
        operation.state === "completed" &&
        operation.resultHeadSha === integrationHeadSha
    );
    if (
      !manualMergeIntentActive ||
      mergeStatus.data?.integration.state !== "ready_to_finalize" ||
      !mergeStatus.data.readiness.canFinalize ||
      !finalVerificationCurrent ||
      (target !== "local" && target !== "github_pr") ||
      !planHash ||
      !executionHash ||
      !baseSha ||
      !integrationHeadSha ||
      attentionApprovalPreview.data?.approvedVsCurrent.planChanged ||
      attentionApprovalPreview.data?.approvedVsCurrent.executionChanged ||
      attentionApprovalPreview.data?.approvedVsCurrent.policyChanged
    ) {
      return null;
    }
    return {
      target,
      expectedPlanHash: planHash,
      expectedExecutionHash: executionHash,
      expectedBaseSha: baseSha,
      expectedIntegrationHeadSha: integrationHeadSha,
    };
  }, [
    attentionApprovalPreview.data,
    detail.run.automationBaseSha,
    detail.run.integrationHeadSha,
    detail.run.mergeTarget,
    detail.run.planHash,
    manualMergeIntentActive,
    mergeStatus.data,
  ]);
  const finalVerificationRetry = manualMergeIntentActive
    ? mergeStatus.data?.retry
    : null;
  const landingRetry =
    externalLandingActive && mergeStatus.data?.retry.action === "retry_landing"
      ? mergeStatus.data.retry
      : null;
  const interruptControlOpen =
    ["running", "reviewing", "merging"].includes(detail.run.status) &&
    !externalLandingActive;
  const approvalControlWindowOpen = !terminalRun && !externalLandingActive;
  const taskTitleById = useMemo(
    () => new Map(detail.tasks.map((task) => [task.id, task.title])),
    [detail.tasks]
  );
  const artifactsById = useMemo(
    () => new Map(detail.artifacts.map((artifact) => [artifact.id, artifact])),
    [detail.artifacts]
  );
  const artifactTotal = detail.artifactTotal ?? detail.artifacts.length;
  const eventTotal = detail.eventTotal ?? detail.events.length;
  const latestTaskEvent = useMemo(() => {
    const events = new Map<string, FleetEventDto>();
    for (const event of detail.events) {
      const taskId = payloadId(event.payload, ["taskId", "task_id"]);
      if (taskId && !events.has(taskId)) events.set(taskId, event);
    }
    return events;
  }, [detail.events]);
  const latestWorkerEvent = useMemo(() => {
    const events = new Map<string, FleetEventDto>();
    for (const event of detail.events) {
      const workerId = payloadId(event.payload, ["workerId", "worker_id"]);
      if (workerId && !events.has(workerId)) events.set(workerId, event);
    }
    return events;
  }, [detail.events]);
  const currentWorkerByTask = useMemo(() => {
    const workers = new Map<string, FleetWorkerDto>();
    for (const worker of detail.workers) {
      if (!worker.taskId) continue;
      const current = workers.get(worker.taskId);
      if (!current || worker.attempt >= current.attempt) {
        workers.set(worker.taskId, worker);
      }
    }
    return workers;
  }, [detail.workers]);
  const lifecycleError =
    resumeRun.error?.message ??
    pauseRun.error?.message ??
    cancelRun.error?.message ??
    archiveRun.error?.message ??
    cleanupRun.error?.message ??
    cleanupPreview.error?.message ??
    mergeStatus.error?.message ??
    requestMerge.error?.message ??
    authorizeLanding.error?.message ??
    retryLanding.error?.message;
  const resetLifecycleErrors = () => {
    resumeRun.reset();
    pauseRun.reset();
    cancelRun.reset();
    completeWorker.reset();
    archiveRun.reset();
    cleanupRun.reset();
    requestMerge.reset();
    authorizeLanding.reset();
    retryLanding.reset();
  };
  const attention = useMemo(
    () =>
      buildFleetAttention(
        detail,
        attentionApprovalPreview.data,
        planApprovalNeedsOperator
      ),
    [detail, attentionApprovalPreview.data, planApprovalNeedsOperator]
  );
  const attentionWorkers = detail.workers.filter(
    (worker) => workerAttentionPriority(worker) < 99
  );
  const attentionTasks = detail.tasks.filter(
    (task) => taskAttentionPriority(task) < 99
  );
  const sortedTasks = [...detail.tasks].sort((a, b) => {
    const rank = taskAttentionPriority(a) - taskAttentionPriority(b);
    if (rank !== 0) return rank;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.sortOrder - b.sortOrder;
  });
  const sortedWorkers = [...detail.workers].sort((a, b) => {
    const rank = workerAttentionPriority(a) - workerAttentionPriority(b);
    if (rank !== 0) return rank;
    return b.attempt - a.attempt || a.id.localeCompare(b.id);
  });

  return (
    <div
      ref={runDetailRef}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-4"
    >
      <div className="bg-background sticky top-0 z-20 grid gap-2 pb-1">
        <nav
          aria-label="Fleet run sections"
          className="grid grid-cols-5 gap-1 rounded-md border p-1 lg:hidden"
        >
          {MOBILE_FLEET_SECTIONS.map((section) => (
            <Button
              key={section.id}
              size="sm"
              variant={mobileSection === section.id ? "default" : "ghost"}
              aria-selected={mobileSection === section.id}
              onClick={() => setMobileSection(section.id)}
            >
              {section.label}
            </Button>
          ))}
        </nav>
        <section
          aria-label="Fleet attention queue"
          className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium">Attention queue</span>
            <span className="text-muted-foreground text-[10px]">
              Security and exact approvals first, then verification, reviews,
              drift, recovery, and delivery failures.
            </span>
          </div>
          {attention.length === 0 ? (
            <p className="text-muted-foreground mt-1 text-xs">
              No urgent attention. Routine progress stays in the section views.
            </p>
          ) : (
            <ol
              className="mt-1 grid gap-1 text-xs"
              data-testid="attention-items"
            >
              {attention.slice(0, 8).map((item) => (
                <li
                  key={item.id}
                  className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2"
                >
                  <span
                    className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase"
                    data-attention-category={item.category}
                  >
                    {FLEET_ATTENTION_LABELS[item.category]}
                  </span>
                  <span className="min-w-0 break-words">{item.label}</span>
                </li>
              ))}
              {attention.length > 8 && (
                <li className="text-muted-foreground">
                  +{attention.length - 8} more in Tasks or Workers
                </li>
              )}
            </ol>
          )}
        </section>
      </div>

      <section
        className={cn(
          mobileSection === "plan" ? "grid" : "hidden lg:grid",
          "gap-3 rounded-md border p-3 md:grid-cols-3 xl:grid-cols-6"
        )}
      >
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
              Internal session {detail.run.plannerSessionId} is intentionally
              hidden from Sessions. Fleet captures its result automatically;
              cancel the planner here if it stalls.
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
            {detail.run.budgetUsd == null && detail.run.budgetTokens == null ? (
              "Unset"
            ) : (
              <span className="grid gap-0.5">
                {detail.run.budgetUsd != null && (
                  <span>
                    ${detail.run.spentBudgetUsd.toFixed(2)} spent + $
                    {detail.run.reservedBudgetUsd.toFixed(2)} reserved of $
                    {detail.run.budgetUsd.toFixed(2)}
                  </span>
                )}
                {detail.run.budgetTokens != null && (
                  <span>
                    {detail.run.spentBudgetTokens.toLocaleString()} tokens spent
                    + {detail.run.reservedBudgetTokens.toLocaleString()}{" "}
                    reserved of {detail.run.budgetTokens.toLocaleString()}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="text-muted-foreground mt-1 text-[10px]">
            {detail.run.costConfidence} confidence ·{" "}
            {Math.round(detail.run.budgetWarningThreshold * 100)}% warning ·{" "}
            {detail.run.budgetStopMode.replaceAll("_", " ")}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[10px] font-medium uppercase">
            Automation
          </div>
          <div className="text-sm">
            {detail.run.automationPolicy.automaticPlanning
              ? "Auto plan"
              : "Manual plan"}
            {detail.run.automationPolicy.automaticPlanApproval
              ? " · auto approve"
              : " · manual approve"}
            {detail.run.automationPolicy.automaticStart
              ? " · auto start"
              : " · manual start"}
          </div>
          <div className="text-muted-foreground mt-1 text-[10px]">
            {detail.run.reviewPolicy === "manual"
              ? "Manual plan approval + four task reviews"
              : "Four plan reviewers + four task reviews"}
            {detail.run.automationPolicy.automaticFixes
              ? ` · up to ${detail.run.automationPolicy.maxAutomaticFixRounds} auto-fix rounds`
              : ""}
            {detail.run.automationPolicy.automaticMerge
              ? ` · auto merge to ${detail.run.automationPolicy.mergeTarget}`
              : ""}
          </div>
        </div>
      </section>

      <section className="bg-background flex flex-wrap items-center gap-2 rounded-md border p-3 shadow-sm">
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
          disabled={!interruptControlOpen || pauseRun.isPending}
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
          variant="outline"
          disabled={!interruptControlOpen || pauseRun.isPending}
          onClick={() => {
            resetLifecycleErrors();
            if (
              !window.confirm(
                "Pause new work and ask every active Fleet agent session to stop safely? Stoa will stop sessions that remain active after the 30-second grace period."
              )
            ) {
              return;
            }
            void pauseRun
              .mutateAsync({
                actor: "operator",
                mode: "pause-and-interrupt",
                graceMs: 30_000,
              })
              .catch(() => undefined);
          }}
        >
          <Pause className="h-4 w-4" /> Pause and stop agents
        </Button>
        <Button
          className="gap-2"
          variant="destructive"
          aria-label="Cancel"
          disabled={
            terminalRun ||
            externalLandingActive ||
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
          <Square className="h-4 w-4" /> Cancel, preserve worktrees
        </Button>
        <Button
          className="gap-2"
          variant="destructive"
          disabled={
            terminalRun ||
            externalLandingActive ||
            plannerActive ||
            cancelRun.isPending
          }
          onClick={() => {
            resetLifecycleErrors();
            setDestructiveConfirmation("");
            setDestructiveAction("cancel-and-clean");
          }}
        >
          <Trash2 className="h-4 w-4" /> Cancel and clean owned worktrees
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
                setDestructiveConfirmation("");
                setDestructiveAction("cleanup");
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
        {externalLandingActive && !terminalRun && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            External landing is authorized. Pause, cancel, and exact approval
            controls are locked until landing completes.
          </span>
        )}
        {detail.run.recoveryRequired && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Recovery must finish before new workers launch.
          </span>
        )}
        {detail.run.pauseReason === "budget_exhausted" && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            Budget exhausted. Use the exact approval control below to increase
            the budget, explicitly clear the hard stop, then resume.
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

      <DestructiveFleetActionDialog
        action={destructiveAction}
        runId={detail.run.id}
        preview={
          destructiveAction === "cancel-and-clean"
            ? (cancellationPreview.data ?? null)
            : destructiveAction === "cleanup"
              ? (cleanupPreview.data?.impact ?? null)
              : null
        }
        isLoading={
          destructiveAction === "cancel-and-clean"
            ? cancellationPreview.isLoading
            : destructiveAction === "cleanup"
              ? cleanupPreview.isLoading
              : false
        }
        error={
          destructiveAction === "cancel-and-clean"
            ? (cancellationPreview.error?.message ?? null)
            : destructiveAction === "cleanup"
              ? (cleanupPreview.error?.message ?? null)
              : null
        }
        isPending={
          destructiveAction === "cancel-and-clean"
            ? cancelRun.isPending
            : cleanupRun.isPending
        }
        confirmation={destructiveConfirmation}
        onConfirmationChange={setDestructiveConfirmation}
        onOpenChange={(open) => {
          if (!open) closeDestructiveAction();
        }}
        onConfirm={() => void handleDestructiveAction()}
      />

      <div className={mobileSection === "plan" ? "block" : "hidden lg:block"}>
        <ApprovalPreview
          detail={detail}
          estimate={attentionApprovalPreview.data?.estimate ?? null}
        />
      </div>
      {detail.run.approvalState === "approved" && (
        <div className={mobileSection === "plan" ? "block" : "hidden lg:block"}>
          <FleetApprovalControls
            runId={detail.run.id}
            taskTitleById={taskTitleById}
            controlWindowOpen={approvalControlWindowOpen}
          />
        </div>
      )}

      <section
        className={cn(
          "rounded-md border",
          mobileSection === "plan" ? "block" : "hidden lg:block"
        )}
      >
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
            detail.run.reviewPolicy !== "manual" &&
            !planReviewsComplete && (
              <div className="text-muted-foreground text-xs">
                Four independent clean plan critics must finish before approval
                {planReviewGate
                  ? ` (${planReviewGate.exactCleanLenses}/${planReviewGate.required} clean lenses, ${planReviewGate.independentReviewers} independent reviewers)`
                  : "."}
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

      <section
        className={cn(
          "rounded-md border",
          mobileSection === "tasks" ? "block" : "hidden lg:block"
        )}
      >
        <div className="border-b px-3 py-2">
          <h3 className="text-sm font-medium">Task graph</h3>
        </div>
        <div className="grid gap-2 p-3">
          {detail.tasks.length === 0 ? (
            <p className="text-muted-foreground text-sm">No tasks</p>
          ) : (
            sortedTasks.map((task) => {
              const taskEvent = latestTaskEvent.get(task.id);
              const taskWorker = currentWorkerByTask.get(task.id);
              const diffArtifact: FleetArtifactDto | undefined =
                task.diffArtifactId
                  ? artifactsById.get(task.diffArtifactId)
                  : undefined;
              const diffOpen =
                !!diffArtifact &&
                expandedArtifact?.id === diffArtifact.id &&
                expandedArtifact.surface === "task";
              return (
                <div
                  key={task.id}
                  data-fleet-task-id={task.id}
                  className={cn(
                    "grid gap-2 rounded border px-3 py-2 md:grid-cols-[minmax(0,1fr)_auto]",
                    focusTaskId === task.id &&
                      "border-primary/60 bg-primary/5 ring-primary/20 ring-2"
                  )}
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
                    {task.riskNotes.length > 0 && (
                      <div
                        className="mt-2 grid gap-1.5"
                        data-testid={`fleet-task-risks-${task.id}`}
                      >
                        <div className="text-muted-foreground text-[10px] font-medium uppercase">
                          Known risks
                        </div>
                        {task.riskNotes.map((note, index) => (
                          <div
                            key={`${note.severity}-${index}`}
                            className="grid gap-1 rounded border px-2 py-1.5 text-[11px] break-words"
                          >
                            <div className="flex items-start gap-2">
                              <span
                                aria-label={`${note.severity} severity`}
                                className={cn(
                                  "shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase",
                                  note.severity === "high"
                                    ? "bg-destructive/10 text-destructive"
                                    : note.severity === "medium"
                                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                      : "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                )}
                              >
                                {note.severity}
                              </span>
                              <span>
                                <span className="font-medium">Risk:</span>{" "}
                                {note.risk}
                              </span>
                            </div>
                            <div className="text-muted-foreground">
                              <span className="font-medium">Mitigation:</span>{" "}
                              {note.mitigation}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {task.verifyCommand && (
                      <div className="text-muted-foreground mt-1 font-mono text-[11px] break-all">
                        Verify: {task.verifyCommand}
                      </div>
                    )}
                    {(task.branchName || task.worktreePath) && (
                      <div className="text-muted-foreground mt-2 grid gap-0.5 text-[11px]">
                        {task.branchName && (
                          <span className="font-mono break-all">
                            Branch: {task.branchName}
                          </span>
                        )}
                        {task.worktreePath && (
                          <span className="font-mono break-all">
                            Worktree: {task.worktreePath}
                          </span>
                        )}
                      </div>
                    )}
                    {taskEvent && (
                      <div className="text-muted-foreground mt-1 text-[11px]">
                        Latest event: {taskEvent.eventType.replaceAll("_", " ")}{" "}
                        · {labelDate(taskEvent.createdAt)}
                      </div>
                    )}
                    {taskWorker &&
                      (taskWorker.reservationUsd > 0 ||
                        taskWorker.reservationTokens > 0 ||
                        taskWorker.actualCostUsd != null ||
                        taskWorker.actualTokens != null) && (
                        <div className="text-muted-foreground mt-1 text-[11px]">
                          Attempt {taskWorker.attempt}:{" "}
                          {taskWorker.actualCostUsd != null
                            ? `$${taskWorker.actualCostUsd.toFixed(2)} actual`
                            : `$${taskWorker.reservationUsd.toFixed(2)} reserved`}
                          {taskWorker.actualTokens != null
                            ? ` · ${taskWorker.actualTokens.toLocaleString()} actual tokens`
                            : taskWorker.reservationTokens > 0
                              ? ` · ${taskWorker.reservationTokens.toLocaleString()} reserved tokens`
                              : ""}
                          {` · ${taskWorker.costConfidence === "unknown" ? taskWorker.reservationConfidence : taskWorker.costConfidence} confidence`}
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
                        (verification) =>
                          verification.id === task.verificationId
                      )}
                    />
                    <div className="flex flex-wrap justify-end gap-1">
                      {diffArtifact && (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-expanded={diffOpen}
                          onClick={() =>
                            setExpandedArtifact(
                              diffOpen
                                ? null
                                : { id: diffArtifact.id, surface: "task" }
                            )
                          }
                        >
                          {diffOpen ? "Hide exact diff" : "Inspect exact diff"}
                        </Button>
                      )}
                    </div>
                  </div>
                  {diffOpen && diffArtifact && (
                    <div className="bg-muted/30 grid gap-1 rounded border p-2 md:col-span-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-medium">
                          Authoritative Git evidence
                        </span>
                        <span className="font-mono text-[10px] break-all">
                          head{" "}
                          {diffArtifact.headSha ?? task.headSha ?? "unknown"}
                        </span>
                      </div>
                      <pre className="bg-background max-h-64 overflow-auto rounded border p-2 text-[11px] whitespace-pre-wrap">
                        {expandedArtifactBody}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>

      {supervisor.data && (
        <section
          className={cn(
            "rounded-md border",
            mobileSection === "plan" ? "block" : "hidden lg:block"
          )}
        >
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
        <section
          className={cn(
            "rounded-md border",
            mobileSection === "merge" ? "block" : "hidden lg:block"
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <span className="flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              <h3 className="text-sm font-medium">Merge queue</h3>
            </span>
            <span className="bg-foreground/10 rounded px-1.5 py-0.5 text-[10px] uppercase">
              {externalLandingActive
                ? landingRetry?.state === "available"
                  ? "landing recovery available"
                  : landingRetry?.state === "blocked"
                    ? "landing recovery blocked"
                    : "landing authorized"
                : manualMergeIntentActive
                  ? finalVerificationRetry?.state === "available"
                    ? "verification retry available"
                    : finalVerificationRetry?.state === "blocked" ||
                        finalVerificationRetry?.state === "exhausted"
                      ? `verification retry ${finalVerificationRetry.state}`
                      : "internal staging"
                  : detail.run.integrationState.replaceAll("_", " ")}
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
            {detail.run.status === "completed" &&
              detail.run.mergeTarget === "local" &&
              detail.run.integrationState === "completed" && (
                <div
                  className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-800 dark:text-amber-200"
                  role="status"
                >
                  The approved local branch ref was advanced. Fleet
                  intentionally left the source checkout index and files
                  unchanged so a concurrent branch switch could not overwrite
                  unrelated work. Refresh that checkout explicitly when it is
                  safe.
                </div>
              )}
            {landingRetry && (
              <div className="grid gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
                <div className="font-medium">Exact-bound landing recovery</div>
                <p className="text-muted-foreground">
                  {landingRetry.available
                    ? landingRetry.instructions
                    : (landingRetry.reason ??
                      "Landing recovery is not currently safe.")}
                </p>
                <dl className="grid gap-1 md:grid-cols-[auto_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">Target ref</dt>
                  <dd className="font-mono break-all">
                    {landingRetry.targetRef ?? "Unavailable"}
                  </dd>
                  <dt className="text-muted-foreground">
                    Required current SHA
                  </dt>
                  <dd className="font-mono break-all">
                    {landingRetry.requiredTargetSha ?? "Unavailable"}
                  </dd>
                  <dt className="text-muted-foreground">Exact result SHA</dt>
                  <dd className="font-mono break-all">
                    {landingRetry.integrationHeadSha ?? "Unavailable"}
                  </dd>
                </dl>
                <p className="text-muted-foreground">
                  This does not issue new landing authority. The server will
                  keep the run locked if the target cannot be read or has moved
                  to any other SHA.
                </p>
                {landingRetry.available &&
                  landingRetry.operationId &&
                  landingRetry.preconditions &&
                  landingRetry.target && (
                    <Button
                      className="w-fit"
                      size="sm"
                      variant="outline"
                      disabled={retryLanding.isPending}
                      onClick={() => {
                        const retry = landingRetry.preconditions;
                        if (
                          !retry ||
                          !landingRetry.operationId ||
                          !landingRetry.target
                        ) {
                          return;
                        }
                        resetLifecycleErrors();
                        if (
                          !window.confirm(
                            `Retry the already-authorized exact landing?\n\nTarget: ${landingRetry.targetRef}\nTarget must equal: ${landingRetry.requiredTargetSha}\nExact result: ${landingRetry.integrationHeadSha}\n\nThe server will re-read the authoritative target ref and every landing gate. No new landing authority is issued.`
                          )
                        ) {
                          return;
                        }
                        void retryLanding
                          .mutateAsync({
                            target: landingRetry.target,
                            expectedOperationId: landingRetry.operationId,
                            expectedPlanHash: retry.planHash,
                            expectedExecutionHash: retry.executionHash,
                            expectedBaseSha: retry.baseSha,
                            expectedIntegrationHeadSha:
                              retry.integrationHeadSha,
                          })
                          .catch(() => undefined);
                      }}
                    >
                      {retryLanding.isPending && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      Prove target and retry landing
                    </Button>
                  )}
              </div>
            )}
            {manualMergeIntentActive && (
              <div className="rounded border border-blue-500/40 bg-blue-500/5 p-2 text-xs">
                <div className="font-medium">
                  Internal staging for{" "}
                  {(detail.run.mergeTarget ?? "unknown target").replaceAll(
                    "_",
                    " "
                  )}
                </div>
                <p className="text-muted-foreground mt-1">
                  The target intent is recorded and duplicate staging requests
                  are disabled. External landing is not authorized yet, so
                  pause, cancel, and exact approval controls remain open.
                </p>
                {finalVerificationRetry?.action ===
                  "retry_final_verification" && (
                  <div className="mt-2 grid gap-2 border-t border-blue-500/20 pt-2">
                    <p
                      className={cn(
                        finalVerificationRetry.available
                          ? "text-foreground"
                          : "text-muted-foreground"
                      )}
                    >
                      {finalVerificationRetry.available
                        ? `Final verification attempt ${finalVerificationRetry.attemptCount} failed. Retry is available for the same exact approved plan, execution, base, and integration head after remediation.`
                        : (finalVerificationRetry.reason ??
                          "Final verification retry is not currently safe.")}
                    </p>
                    {finalVerificationRetry.available &&
                      finalVerificationRetry.preconditions &&
                      detail.run.mergeTarget && (
                        <Button
                          className="w-fit"
                          size="sm"
                          variant="outline"
                          disabled={requestMerge.isPending}
                          onClick={() => {
                            const retry = finalVerificationRetry.preconditions;
                            if (!retry || !detail.run.mergeTarget) return;
                            resetLifecycleErrors();
                            if (
                              !window.confirm(
                                `Retry final verification attempt ${finalVerificationRetry.attemptCount + 1} of ${finalVerificationRetry.maxAttempts} for the exact integration head? Confirm only after remediating the displayed verifier or artifact-capacity error.`
                              )
                            )
                              return;
                            void requestMerge
                              .mutateAsync({
                                target: detail.run.mergeTarget,
                                expectedPlanHash: retry.planHash,
                                expectedExecutionHash: retry.executionHash,
                                expectedBaseSha: retry.baseSha,
                                expectedIntegrationHeadSha:
                                  retry.integrationHeadSha,
                              })
                              .catch(() => undefined);
                          }}
                        >
                          Retry final verification
                        </Button>
                      )}
                  </div>
                )}
                {manualLandingPreconditions && (
                  <div className="mt-2 grid gap-2 border-t border-blue-500/20 pt-2">
                    <p className="text-foreground">
                      Final verification passed for the exact integration head.
                      External landing still requires your explicit
                      authorization.
                    </p>
                    <Button
                      className="w-fit"
                      size="sm"
                      disabled={authorizeLanding.isPending}
                      onClick={() => {
                        resetLifecycleErrors();
                        const action =
                          manualLandingPreconditions.target === "github_pr"
                            ? "push the integration branch, open or reuse its GitHub PR, wait for required checks, and fast-forward the configured target ref with an exact old-OID lease"
                            : "fast-forward the approved local branch ref while leaving the source checkout index and files unchanged";
                        if (
                          !window.confirm(
                            `Authorize Fleet to ${action}?\n\nBase: ${manualLandingPreconditions.expectedBaseSha}\nIntegration head: ${manualLandingPreconditions.expectedIntegrationHeadSha}\n\nThis is the external landing authorization and locks pause, cancel, and exact approval controls.`
                          )
                        ) {
                          return;
                        }
                        void authorizeLanding
                          .mutateAsync(manualLandingPreconditions)
                          .catch(() => undefined);
                      }}
                    >
                      {authorizeLanding.isPending && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      {manualLandingPreconditions.target === "github_pr"
                        ? "Authorize GitHub landing"
                        : "Authorize local branch-ref fast-forward"}
                    </Button>
                  </div>
                )}
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
            {!externalLandingActive && !manualMergeIntentActive && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={requestMerge.isPending}
                  onClick={() => {
                    resetLifecycleErrors();
                    if (
                      !window.confirm(
                        "Begin internal staging for a GitHub PR? This records the target intent but does not authorize external landing. Fleet will pin exact reviewed heads and refuse stale results."
                      )
                    )
                      return;
                    void requestMerge
                      .mutateAsync("github_pr")
                      .catch(() => undefined);
                  }}
                >
                  Stage for GitHub PR
                </Button>
                <Button
                  variant="outline"
                  disabled={requestMerge.isPending}
                  onClick={() => {
                    resetLifecycleErrors();
                    if (
                      !window.confirm(
                        "Begin internal staging for a local fast-forward? This records the target intent but does not authorize landing. Fleet will refuse a dirty or moved checkout and run final verification first."
                      )
                    )
                      return;
                    void requestMerge
                      .mutateAsync("local")
                      .catch(() => undefined);
                  }}
                >
                  Stage for local fast-forward
                </Button>
              </div>
            )}
          </div>
        </section>
      )}
      {(detail.tasks.length === 0 ||
        detail.run.approvalState !== "approved") && (
        <section
          className={cn(
            "rounded-md border p-3 text-sm",
            mobileSection === "merge" ? "block" : "hidden"
          )}
        >
          <h3 className="font-medium">Merge queue</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            Merge controls unlock only after a plan is approved and its task
            graph exists.
          </p>
        </section>
      )}

      <section
        className={cn(
          "rounded-md border",
          mobileSection === "plan" ? "block" : "hidden lg:block"
        )}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Paperclip className="h-4 w-4" />
          <h3 className="text-sm font-medium">Run artifacts</h3>
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
                {detail.artifactHasMore
                  ? `Showing ${detail.artifacts.length} of ${artifactTotal} artifacts`
                  : `${artifactTotal} artifacts`}
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
          {detail.artifactHasMore && (
            <p className="text-muted-foreground text-xs" role="status">
              The newest artifact window, up to 1,000 current actionable
              blockers, and every task-referenced report, diff, and verification
              record are shown. Older unreferenced metadata is omitted from this
              view.
            </p>
          )}
          {detail.artifacts.length > 0 && (
            <div className="grid gap-2">
              {detail.artifacts.map((artifact) => {
                const bodyOpen =
                  expandedArtifact?.id === artifact.id &&
                  expandedArtifact.surface === "artifact";
                return (
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
                      <span>{artifact.artifactType.replaceAll("_", " ")}</span>
                      <span>{artifact.byteCount.toLocaleString()} bytes</span>
                      {artifact.contentHash && (
                        <span className="max-w-48 truncate font-mono">
                          hash {artifact.contentHash}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-muted-foreground text-[11px]">
                        {artifact.actor} - {labelDate(artifact.createdAt)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-expanded={bodyOpen}
                        aria-label={`${bodyOpen ? "Hide" : "Load"} artifact body: ${artifact.title}`}
                        onClick={() =>
                          setExpandedArtifact(
                            bodyOpen
                              ? null
                              : { id: artifact.id, surface: "artifact" }
                          )
                        }
                      >
                        {bodyOpen ? "Hide body" : "Load body"}
                      </Button>
                    </div>
                    {bodyOpen && (
                      <pre className="bg-background mt-2 max-h-64 overflow-auto rounded border p-2 text-[11px] break-words whitespace-pre-wrap">
                        {expandedArtifactBody}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div
          className={cn(
            "rounded-md border",
            mobileSection === "workers" ? "block" : "hidden lg:block"
          )}
        >
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
                      {(worker.branchName || worker.worktreePath) && (
                        <div className="text-muted-foreground mt-1 grid gap-0.5 text-[10px]">
                          {worker.branchName && (
                            <span className="font-mono break-all">
                              branch {worker.branchName}
                            </span>
                          )}
                          {worker.worktreePath && (
                            <span className="font-mono break-all">
                              worktree {worker.worktreePath}
                            </span>
                          )}
                        </div>
                      )}
                      <div
                        className="text-muted-foreground mt-1 text-[11px]"
                        data-testid={`worker-meta-${worker.id}`}
                      >
                        Heartbeat:{" "}
                        {worker.lastHeartbeatAt
                          ? labelDate(worker.lastHeartbeatAt)
                          : "not reported"}
                        {worker.reservationUsd > 0
                          ? ` · reservation $${worker.reservationUsd.toFixed(2)}`
                          : ""}
                        {worker.reservationTokens > 0
                          ? ` / ${worker.reservationTokens.toLocaleString()} tokens`
                          : ""}
                        {worker.actualCostUsd != null
                          ? ` · actual $${worker.actualCostUsd.toFixed(2)}`
                          : ""}
                        {worker.actualTokens != null
                          ? ` / ${worker.actualTokens.toLocaleString()} tokens`
                          : ""}
                        {worker.reservationUsd > 0 ||
                        worker.actualCostUsd != null
                          ? ` · ${worker.costConfidence === "unknown" ? worker.reservationConfidence : worker.costConfidence} confidence`
                          : ""}
                      </div>
                      {(worker.renderedStatus ||
                        worker.renderedStatusError) && (
                        <div
                          className="bg-muted/50 mt-2 rounded border px-2 py-1.5 text-[11px]"
                          data-testid={`worker-rendered-status-${worker.id}`}
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-medium">
                              Rendered status:{" "}
                              {worker.renderedStatus ?? "unavailable"}
                            </span>
                            {worker.renderedStatusLastCapturedAt && (
                              <span className="text-muted-foreground">
                                captured{" "}
                                {labelDate(worker.renderedStatusLastCapturedAt)}
                              </span>
                            )}
                            {worker.renderedStatusSummaryRedacted && (
                              <span className="text-muted-foreground">
                                redacted
                                {worker.renderedStatusReplacementCount > 0
                                  ? ` (${worker.renderedStatusReplacementCount})`
                                  : ""}
                              </span>
                            )}
                          </div>
                          {worker.renderedStatusSummary && (
                            <div className="mt-1 break-words whitespace-pre-wrap">
                              {worker.renderedStatusSummary}
                            </div>
                          )}
                          {worker.renderedStatusError && (
                            <div className="text-destructive mt-1">
                              {worker.renderedStatusError}
                            </div>
                          )}
                        </div>
                      )}
                      {worker.interruptRequestedAt && (
                        <div
                          className="text-muted-foreground mt-1 text-[11px]"
                          data-testid={`worker-interrupt-${worker.id}`}
                        >
                          Interrupt {worker.interruptCause ?? "requested"} ·
                          notice {worker.interruptNoticeState} · stop{" "}
                          {worker.interruptStopState}
                          {worker.interruptDeadlineAt
                            ? ` · deadline ${labelDate(worker.interruptDeadlineAt)}`
                            : ""}
                        </div>
                      )}
                      {latestWorkerEvent.get(worker.id) && (
                        <div className="text-muted-foreground mt-1 text-[11px]">
                          Latest event:{" "}
                          {latestWorkerEvent
                            .get(worker.id)!
                            .eventType.replaceAll("_", " ")}{" "}
                          ·{" "}
                          {labelDate(
                            latestWorkerEvent.get(worker.id)!.createdAt
                          )}
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
                        outputOpen={outputWorkerId === worker.id}
                        onToggleOutput={() =>
                          setOutputWorkerId(
                            outputWorkerId === worker.id ? null : worker.id
                          )
                        }
                      />
                      {outputWorkerId === worker.id &&
                        !!worker.sessionId &&
                        ["running", "waiting_for_operator"].includes(
                          worker.status
                        ) && (
                          <WorkerOutputPanel
                            runId={detail.run.id}
                            worker={worker}
                            onClose={() => setOutputWorkerId(null)}
                          />
                        )}
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

        <div
          className={cn(
            "rounded-md border",
            mobileSection === "events" ? "block" : "hidden lg:block"
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <h3 className="text-sm font-medium">Events</h3>
            <span className="text-muted-foreground text-[11px]">
              {detail.eventHasMore
                ? `${detail.events.length} of ${eventTotal}`
                : eventTotal}
            </span>
          </div>
          <div className="grid gap-2 p-3">
            {detail.eventHasMore && (
              <p className="text-muted-foreground text-xs" role="status">
                Showing the newest {detail.events.length} of {eventTotal}{" "}
                events.
              </p>
            )}
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

export function FleetManagementView({
  onClose,
  initialRunId,
  initialTaskId,
  selectionKey,
}: {
  onClose?: () => void;
  initialRunId?: string;
  initialTaskId?: string;
  selectionKey?: string;
}) {
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
  const [budgetTokens, setBudgetTokens] = useState("");
  const [budgetStopMode, setBudgetStopMode] = useState<
    "pause-new" | "hard-stop" | "ask-operator"
  >("pause-new");
  const [budgetWarningPercent, setBudgetWarningPercent] = useState(80);
  const [providerCapsText, setProviderCapsText] = useState("");
  const [maxRetriesPerTask, setMaxRetriesPerTask] = useState(1);
  const [resourceLimits, setResourceLimits] = useState<FleetResourceLimits>(
    () => ({
      ...FLEET_DEFAULT_RESOURCE_LIMITS,
      providerCaps: {},
    })
  );
  const [provider, setProvider] = useState("claude");
  const [model, setModel] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState(
    FLEET_DEFAULT_PARALLEL_WORKERS
  );
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
  const [cleanupPolicy, setCleanupPolicy] =
    useState<FleetAutomationCleanupPolicy>("preserve");
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
  const terminalHistoryAtLimit =
    (runs.data ?? []).filter(
      (run) =>
        run.archivedAt != null ||
        ["completed", "failed", "canceled"].includes(run.status)
    ).length >= 100;
  const selectedRepo = useMemo(
    () => (repos.data ?? []).find((repo) => repo.id === repoId) ?? null,
    [repoId, repos.data]
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

  useEffect(() => {
    if (initialRunId) setSelectedRunId(initialRunId);
  }, [initialRunId, selectionKey]);

  async function handleCreateRun() {
    createRun.reset();
    importRun.reset();
    const providerCaps = parseProviderCaps(providerCapsText);
    if (!providerCaps.ok) return;
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
      cleanupPolicy,
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
        budgetTokens: budgetTokens.trim() ? Number(budgetTokens) : null,
        budgetStopMode,
        budgetWarningThreshold: budgetWarningPercent / 100,
        providerCaps: providerCaps.caps,
        resourceLimits: {
          ...resourceLimits,
          providerCaps: providerCaps.caps,
        },
        maxRetriesPerTask,
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
      setBudgetTokens("");
    } catch {
      // React Query owns the rendered error state.
    }
  }

  const executableTargetSelected = repoId !== NONE || projectId !== NONE;
  const targetQueriesLoading = repos.isLoading || projects.isLoading;
  const targetQueriesError = repos.error?.message ?? projects.error?.message;
  const draftNeedsTarget =
    !executableTargetSelected && (autoPlan || inputMode === "plan");
  const unattendedAgentLaunchEnabled =
    executableTargetSelected ||
    reviewPolicy !== "manual" ||
    (autoPlan && inputMode === "epic") ||
    autoApprove ||
    autoStart;
  const unattendedConsentMissing =
    unattendedAgentLaunchEnabled && !allowUnconfinedAgents;
  const createPending = createRun.isPending || importRun.isPending;
  const createError = createRun.error?.message ?? importRun.error?.message;
  const providerCaps = useMemo(
    () => parseProviderCaps(providerCapsText),
    [providerCapsText]
  );
  const resourceLimitsValid = FLEET_RESOURCE_FIELDS.every(({ key }) => {
    const value = resourceLimits[key];
    return Number.isSafeInteger(value) && value > 0;
  });
  const budgetsValid =
    (!budgetUsd.trim() ||
      (Number.isFinite(Number(budgetUsd)) &&
        Number(budgetUsd) >= 0 &&
        Number(budgetUsd) <= 1_000_000_000)) &&
    (!budgetTokens.trim() ||
      (Number.isSafeInteger(Number(budgetTokens)) &&
        Number(budgetTokens) >= 0 &&
        Number(budgetTokens) <= 1_000_000_000_000));
  const plannerTaskCapValid =
    !autoPlan ||
    inputMode !== "epic" ||
    (Number.isSafeInteger(plannerTaskCap) &&
      plannerTaskCap >= 1 &&
      plannerTaskCap <= 40);
  const automaticFixRoundsValid =
    !autoFix ||
    (Number.isSafeInteger(maxAutomaticFixRounds) &&
      maxAutomaticFixRounds >= 1 &&
      maxAutomaticFixRounds <= 20);
  const retentionDaysValid =
    Number.isSafeInteger(retentionDays) &&
    retentionDays >= 1 &&
    retentionDays <= 3650;
  const draftSettingsValid =
    providerCaps.ok &&
    resourceLimitsValid &&
    budgetsValid &&
    Number.isSafeInteger(maxConcurrency) &&
    maxConcurrency >= 1 &&
    maxConcurrency <= FLEET_MAX_TOTAL_WORKERS &&
    Number.isSafeInteger(maxRetriesPerTask) &&
    maxRetriesPerTask >= 0 &&
    maxRetriesPerTask <= 9 &&
    Number.isFinite(budgetWarningPercent) &&
    budgetWarningPercent >= 1 &&
    budgetWarningPercent <= 100 &&
    plannerTaskCapValid &&
    automaticFixRoundsValid &&
    retentionDaysValid;

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <Network className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">Fleet Management</span>
          <span className="text-muted-foreground text-xs">
            {runs.data?.length ?? 0} visible runs
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
          className="flex min-h-0 flex-col gap-3 border-r p-4 lg:overflow-y-auto"
        >
          <section className="shrink-0 rounded-md border p-3">
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
                disabled={repos.isLoading || repos.isError}
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
                disabled={projects.isLoading || projects.isError}
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
              {targetQueriesLoading && (
                <div
                  className="text-muted-foreground flex items-center gap-2 text-xs"
                  role="status"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading
                  repositories and projects
                </div>
              )}
              {targetQueriesError && (
                <div
                  className="text-destructive grid gap-2 rounded border px-3 py-2 text-xs"
                  role="alert"
                >
                  <span>
                    Could not load repositories or projects:{" "}
                    {targetQueriesError}
                  </span>
                  <Button
                    className="w-fit"
                    size="sm"
                    variant="outline"
                    disabled={repos.isFetching || projects.isFetching}
                    onClick={() => {
                      void Promise.all([repos.refetch(), projects.refetch()]);
                    }}
                  >
                    {(repos.isFetching || projects.isFetching) && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    Retry targets
                  </Button>
                </div>
              )}
              {selectedRepo?.base_branch && (
                <div
                  className="bg-muted/30 rounded border px-3 py-2 text-xs"
                  aria-label="Fleet base branch"
                >
                  <span className="text-muted-foreground">Base branch </span>
                  <span className="font-mono break-all">
                    {selectedRepo.base_branch}
                  </span>
                </div>
              )}
              {projectId !== NONE && (
                <div className="text-muted-foreground rounded border px-3 py-2 text-xs">
                  Base branch resolves from the selected project repository
                  before the plan contract is approved.
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Input
                  aria-label="Budget USD"
                  inputMode="decimal"
                  placeholder="USD budget"
                  value={budgetUsd}
                  onChange={(event) => setBudgetUsd(event.target.value)}
                />
                <Input
                  aria-label="Token budget"
                  inputMode="numeric"
                  placeholder="Token budget"
                  value={budgetTokens}
                  onChange={(event) => setBudgetTokens(event.target.value)}
                />
                <Input
                  aria-label="Max parallel workers"
                  type="number"
                  min={1}
                  max={FLEET_MAX_TOTAL_WORKERS}
                  value={maxConcurrency}
                  onChange={(event) =>
                    setMaxConcurrency(Number(event.target.value))
                  }
                />
                <Input
                  aria-label="Retries per task"
                  type="number"
                  min={0}
                  max={9}
                  value={maxRetriesPerTask}
                  onChange={(event) =>
                    setMaxRetriesPerTask(Number(event.target.value))
                  }
                />
              </div>
              {maxConcurrency > FLEET_PARALLEL_WORKERS_WARNING_THRESHOLD && (
                <div
                  className="text-xs text-amber-700 dark:text-amber-300"
                  role="alert"
                >
                  More than {FLEET_PARALLEL_WORKERS_WARNING_THRESHOLD} parallel
                  workers can exhaust local terminals, worktrees, provider
                  capacity, and disk. Confirm this host has enough resources.
                </div>
              )}
              <details className="rounded-md border px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium">
                  Budget policy and resource limits
                </summary>
                <div className="mt-3 grid gap-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span>Budget stop mode</span>
                      <Select
                        value={budgetStopMode}
                        onValueChange={(value) =>
                          setBudgetStopMode(
                            value === "hard-stop" || value === "ask-operator"
                              ? value
                              : "pause-new"
                          )
                        }
                      >
                        <SelectTrigger aria-label="Budget stop mode">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pause-new">
                            Pause new launches
                          </SelectItem>
                          <SelectItem value="hard-stop">
                            Interrupt after grace period
                          </SelectItem>
                          <SelectItem value="ask-operator">
                            Ask operator
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="grid gap-1">
                      <span>Budget warning threshold (%)</span>
                      <Input
                        aria-label="Budget warning threshold"
                        type="number"
                        min={1}
                        max={100}
                        value={budgetWarningPercent}
                        onChange={(event) =>
                          setBudgetWarningPercent(Number(event.target.value))
                        }
                      />
                      {(!Number.isFinite(budgetWarningPercent) ||
                        budgetWarningPercent < 1 ||
                        budgetWarningPercent > 100) && (
                        <span className="text-destructive">
                          Enter a percentage from 1 to 100.
                        </span>
                      )}
                    </label>
                  </div>
                  <label className="grid gap-1">
                    <span>Provider concurrency caps</span>
                    <Textarea
                      aria-label="Provider concurrency caps"
                      rows={2}
                      placeholder="claude=2, hermes=4"
                      value={providerCapsText}
                      onChange={(event) =>
                        setProviderCapsText(event.target.value)
                      }
                    />
                    <span className="text-muted-foreground">
                      Comma or line-separated provider=limit pairs. Blank uses
                      provider defaults.
                    </span>
                    {!providerCaps.ok && (
                      <span className="text-destructive">
                        {providerCaps.error}
                      </span>
                    )}
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {FLEET_RESOURCE_FIELDS.map((field) => (
                      <label key={field.key} className="grid min-w-0 gap-1">
                        <span>{field.label}</span>
                        <Input
                          aria-label={field.label}
                          type="number"
                          min={1}
                          step={1}
                          value={resourceLimits[field.key]}
                          onChange={(event) =>
                            setResourceLimits((current) => ({
                              ...current,
                              [field.key]: Number(event.target.value),
                            }))
                          }
                        />
                        <span className="text-muted-foreground">
                          {field.unit}
                        </span>
                      </label>
                    ))}
                  </div>
                  {!resourceLimitsValid && (
                    <span className="text-destructive">
                      Every resource limit must be a positive whole number.
                    </span>
                  )}
                </div>
              </details>
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
                      setReviewPolicy("manual");
                      setAutoApprove(false);
                      setAutoStart(false);
                      setAutoFix(false);
                      setAutoMerge(false);
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
                <label className="grid gap-1 text-xs">
                  <span>Preferred/default provider</span>
                  <Input
                    aria-label="Preferred/default provider"
                    placeholder="Provider"
                    maxLength={FLEET_PROVIDER_MAX}
                    value={provider}
                    onChange={(event) => setProvider(event.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-xs">
                  <span>Preferred model</span>
                  <Input
                    aria-label="Preferred model"
                    placeholder="Model"
                    maxLength={FLEET_MODEL_MAX}
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  />
                </label>
              </div>
              <p className="text-muted-foreground text-xs">
                Fleet allocates available agents automatically. The provider is
                the preferred default when a task has no exact allocation.
              </p>
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
                  }
                }}
              >
                <SelectTrigger aria-label="Review policy">
                  <SelectValue placeholder="Review policy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="four_agent">
                    Four plan critics + four task reviewers
                  </SelectItem>
                  <SelectItem value="manual">
                    Manual plan approval + four task reviews
                  </SelectItem>
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
              {unattendedAgentLaunchEnabled && (
                <div className="grid gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-xs">
                  <div className="text-amber-700 dark:text-amber-300">
                    Every repository- or project-bound Fleet run eventually
                    launches internal unattended agents, including workflows
                    with manual plan approval. Automatic planning and four-agent
                    review can launch them before approval. When strong
                    isolation is unavailable, those launches remain paused
                    unless you grant the consent below.
                  </div>
                  {inputMode === "plan" && reviewPolicy !== "manual" && (
                    <div className="text-muted-foreground">
                      Imported plans skip the planner session, but the
                      four-agent policy still launches four unattended critics
                      before either manual or automatic approval.
                    </div>
                  )}
                  <label className="flex items-center gap-2">
                    <input
                      aria-label="Allow unconfined unattended agents"
                      type="checkbox"
                      checked={allowUnconfinedAgents}
                      onChange={(event) =>
                        setAllowUnconfinedAgents(event.target.checked)
                      }
                    />
                    {
                      "I explicitly allow unattended agents without OS confinement."
                    }
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
                    setAutoFix(event.target.checked);
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
                    reviews, and a final integration verification. Findings
                    pause the run when automatic fixes are disabled.
                  </span>
                </span>
                <input
                  aria-label="Merge green results automatically"
                  type="checkbox"
                  disabled={!autoStart}
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
                        GitHub PR checks, then leased fast-forward
                      </SelectItem>
                      <SelectItem value="local">
                        Local fast-forward only
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {mergeTarget === "github_pr" && (
                    <span className="text-muted-foreground">
                      After PR checks pass, Fleet lands with an exact
                      old-OID-leased fast-forward of the configured target ref.
                      If branch rules reject that update, the run waits for
                      operator action; Fleet does not fall back to a
                      base-unpinned PR merge.
                    </span>
                  )}
                </label>
              )}
              <label className="grid gap-1 text-xs">
                <span>Owned worktree cleanup policy</span>
                <Select
                  value={cleanupPolicy}
                  onValueChange={() => setCleanupPolicy("preserve")}
                >
                  <SelectTrigger aria-label="Fleet cleanup policy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="preserve">
                      Preserve until explicit archived-run cleanup
                    </SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground">
                  The safe default preserves worktrees and branches. Cleanup is
                  an explicit, ownership-checked action after archival.
                </span>
              </label>
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
                  draftNeedsTarget ||
                  unattendedConsentMissing ||
                  !draftSettingsValid ||
                  createPending
                }
                onClick={() => void handleCreateRun()}
              >
                {createPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {inputMode === "plan"
                  ? autoMerge
                    ? "Import plan-to-merged run"
                    : autoStart
                      ? "Import and start plan"
                      : "Import plan draft"
                  : autoMerge
                    ? "Create epic-to-merged run"
                    : autoStart
                      ? "Create autonomous run"
                      : autoPlan
                        ? "Create and plan"
                        : "Create draft"}
              </Button>
              {unattendedConsentMissing && (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  Grant unattended-agent consent above before creating an
                  executable Fleet run. Manual approval does not make Fleet
                  workers interactive; only an unbound goal draft can be saved
                  without this consent.
                </div>
              )}
              {!budgetsValid && (
                <div className="text-destructive text-xs">
                  Budgets must be non-negative finite values; token budgets must
                  be whole numbers.
                </div>
              )}
              {(!Number.isSafeInteger(maxRetriesPerTask) ||
                maxRetriesPerTask < 0 ||
                maxRetriesPerTask > 9) && (
                <div className="text-destructive text-xs">
                  Retries per task must be an integer from 0 to 9.
                </div>
              )}
              {(!Number.isSafeInteger(maxConcurrency) ||
                maxConcurrency < 1 ||
                maxConcurrency > FLEET_MAX_TOTAL_WORKERS) && (
                <div className="text-destructive text-xs">
                  Parallel workers must be an integer from 1 to{" "}
                  {FLEET_MAX_TOTAL_WORKERS}.
                </div>
              )}
              {!plannerTaskCapValid && (
                <div className="text-destructive text-xs">
                  Planner task cap must be an integer from 1 to 40.
                </div>
              )}
              {!automaticFixRoundsValid && (
                <div className="text-destructive text-xs">
                  Automatic fix rounds must be an integer from 1 to 20.
                </div>
              )}
              {!retentionDaysValid && (
                <div className="text-destructive text-xs">
                  Artifact retention must be an integer from 1 to 3650 days.
                </div>
              )}
              {createError && (
                <div className="text-destructive flex items-center gap-2 text-xs">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {createError}
                </div>
              )}
              {draftNeedsTarget &&
                !targetQueriesLoading &&
                !targetQueriesError && (
                  <div className="text-muted-foreground text-xs">
                    {inputMode === "plan"
                      ? "Select a repository or project before importing an executable task plan."
                      : "Select a repository or project to create and plan automatically. Turn automatic planning off to save a goal-only draft."}
                  </div>
                )}
            </div>
          </section>

          <section className="shrink-0">
            <div className="mb-2 flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              <h3 className="text-sm font-medium">Runs</h3>
            </div>
            {terminalHistoryAtLimit && (
              <p className="text-muted-foreground mb-2 text-xs" role="status">
                Terminal and archived history is capped at the 100 most recently
                updated runs. All unarchived active work remains visible.
              </p>
            )}
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
                focusTaskId={
                  detail.data.run.id === initialRunId
                    ? initialTaskId
                    : undefined
                }
                selectionKey={selectionKey}
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
