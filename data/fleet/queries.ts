import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ApproveFleetPlanInput,
  AttachFleetArtifactInput,
  CreateFleetRunInput,
  FleetRunDetailDto,
  FleetRunDto,
  FleetArtifactBodyDto,
  FleetDestructiveActionPreview,
  IngestFleetPlanInput,
  PauseFleetRunInput,
  ResumeFleetRunInput,
  CancelFleetRunInput,
  FleetMergeTarget,
} from "@/lib/fleet/types";
import type { FleetSupervisorSnapshot } from "@/lib/fleet/supervisor-types";
import type { FleetWorkerOutputDto } from "@/lib/fleet/worker-output-types";
import type {
  FleetApprovalControlMutation,
  FleetApprovalControlPreviewDto,
  FleetApprovalControlResponseDto,
} from "@/lib/fleet/approval-control-types";
import { fleetKeys } from "./keys";

export async function fetchFleetRuns(): Promise<FleetRunDto[]> {
  const res = await fetch("/api/fleet/runs");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load fleet runs");
  return data.runs ?? [];
}

async function fetchFleetRun(id: string): Promise<FleetRunDetailDto> {
  const res = await fetch(`/api/fleet/runs/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load fleet run");
  return data as FleetRunDetailDto;
}

export function useFleetRunsQuery(enabled = true) {
  return useQuery({
    queryKey: fleetKeys.runs(),
    queryFn: fetchFleetRuns,
    enabled,
    staleTime: 5000,
    refetchInterval: enabled ? 15000 : false,
  });
}

export function useFleetRunQuery(id: string | null, enabled = true) {
  return useQuery({
    queryKey: fleetKeys.run(id ?? "__disabled__"),
    queryFn: enabled && id ? () => fetchFleetRun(id) : skipToken,
    staleTime: 5000,
    refetchInterval: enabled && id ? 5000 : false,
  });
}

/** Lazy, exact-attempt terminal preview. The component mounts this query for at
 * most one selected worker; it deliberately has no polling interval. */
export function useFleetWorkerOutput(
  runId: string | null,
  workerId: string | null,
  expectedAttempt: number | null,
  expectedSessionId: string | null,
  enabled = true,
  lines = 80
) {
  return useQuery({
    queryKey: [
      ...fleetKeys.run(runId ?? "__disabled__"),
      "worker-output",
      workerId ?? "__none__",
      expectedAttempt,
      expectedSessionId,
      lines,
    ],
    queryFn:
      enabled &&
      runId &&
      workerId &&
      expectedAttempt != null &&
      expectedSessionId
        ? async () => {
            const query = new URLSearchParams({
              expectedAttempt: String(expectedAttempt),
              expectedSessionId,
              lines: String(lines),
            });
            const res = await fetch(
              `/api/fleet/runs/${encodeURIComponent(runId)}/workers/${encodeURIComponent(workerId)}/output?${query}`,
              { cache: "no-store" }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(
                data.error || "Failed to load rendered Fleet worker output"
              );
            }
            return data as FleetWorkerOutputDto;
          }
        : skipToken,
    enabled:
      enabled &&
      !!runId &&
      !!workerId &&
      expectedAttempt != null &&
      !!expectedSessionId,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

/** Fetch at most one immutable artifact body after explicit user expansion. */
export function useFleetArtifactBody(
  runId: string | null,
  artifactId: string | null,
  enabled = true
) {
  return useQuery({
    queryKey: [
      ...fleetKeys.run(runId ?? "__disabled__"),
      "artifact-body",
      artifactId ?? "__none__",
    ],
    queryFn:
      enabled && runId && artifactId
        ? async () => {
            const res = await fetch(
              `/api/fleet/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
              { cache: "no-store" }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(
                data.error || "Failed to load Fleet artifact body"
              );
            }
            return data as FleetArtifactBodyDto;
          }
        : skipToken,
    enabled: enabled && !!runId && !!artifactId,
    // Bodies are immutable until retention pruning. Treat cached data as stale
    // so a close/re-open cannot resurrect a body after the server pruned it.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useFleetApprovalControlPreview(
  runId: string | null,
  enabled = true
) {
  return useQuery({
    queryKey: [...fleetKeys.run(runId ?? "__disabled__"), "approval-preview"],
    queryFn:
      enabled && runId
        ? async () => {
            const res = await fetch(
              `/api/fleet/runs/${encodeURIComponent(runId)}/approvals/preview`,
              { cache: "no-store" }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(
                data.error || "Failed to load exact Fleet approval controls"
              );
            }
            return data as FleetApprovalControlPreviewDto;
          }
        : skipToken,
    enabled: enabled && !!runId,
    staleTime: 2000,
    refetchInterval: enabled && runId ? 5000 : false,
  });
}

export function useFleetApprovalControl(runId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: FleetApprovalControlMutation) => {
      if (!runId) throw new Error("No Fleet run selected");
      const taskPrefix =
        "taskId" in input ? `/tasks/${encodeURIComponent(input.taskId)}` : "";
      const suffix =
        input.kind === "concurrency"
          ? "/controls/concurrency"
          : input.kind === "budget"
            ? "/controls/budget"
            : input.kind === "task_skip"
              ? `${taskPrefix}/controls/skip`
              : input.kind === "task_manual_launch"
                ? `${taskPrefix}/controls/manual-launch`
                : input.kind === "task_read_only"
                  ? `${taskPrefix}/controls/read-only`
                  : `${taskPrefix}/claims/approve`;
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}${suffix}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.body),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Fleet approval control was rejected");
      }
      return data as FleetApprovalControlResponseDto;
    },
    onSuccess: (result) => {
      if (!runId) return;
      qc.setQueryData(
        [...fleetKeys.run(runId), "approval-preview"],
        result.preview
      );
      qc.invalidateQueries({ queryKey: fleetKeys.run(runId) });
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
    },
  });
}

export function useCreateFleetRun() {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: CreateFleetRunInput) => {
      const res = await fetch("/api/fleet/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to create fleet run");
      return data as FleetRunDetailDto;
    },
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      qc.setQueryData(fleetKeys.run(detail.run.id), detail);
    },
  });
}

export interface ImportFleetRunInput {
  source: unknown;
  options?: Omit<CreateFleetRunInput, "name" | "goal">;
}

export interface FleetCleanupPreview {
  runId: string;
  archived: boolean;
  terminal: boolean;
  eligible: Array<{
    ownerType: "worker" | "plan_review" | "task_review" | "fixer";
    ownerId: string;
    workerId: string | null;
    worktreePath: string;
    projectPath: string;
    exists: boolean;
    ownerCount: number;
  }>;
  skipped: Array<{
    ownerType: "worker" | "plan_review" | "task_review" | "fixer";
    ownerId: string;
    workerId: string | null;
    worktreePath: string;
    reason: string;
  }>;
  impact: FleetDestructiveActionPreview;
}

export interface FleetAnalyticsDto {
  runCount: number;
  archivedRunCount: number;
  runOutcomes: Record<string, number>;
  taskOutcomes: Record<string, number>;
  providerOutcomes: Record<
    string,
    { total: number; completed: number; failed: number; other: number }
  >;
  durations: {
    completedRuns: number;
    averageSeconds: number | null;
    maximumSeconds: number | null;
  };
  budget: {
    configuredUsd: number;
    reservedUsd: number;
    spentUsd: number;
  };
}

export interface FleetMergeStatusDto {
  readiness: {
    runId: string;
    requested: boolean;
    target: FleetMergeTarget | null;
    integrationState: string;
    readyTaskIds: string[];
    waitingTaskIds: string[];
    mergedTaskIds: string[];
    blockers: string[];
    allTasksIntegrated: boolean;
    canFinalize: boolean;
  };
  integration: {
    state: string;
    target: FleetMergeTarget | null;
    requestedAt: string | null;
    requestedBy: string | null;
    requestKind: "manual" | "automatic" | null;
    branch: string | null;
    worktree: string | null;
    baseSha: string | null;
    headSha: string | null;
    prNumber: number | null;
    prUrl: string | null;
    prHeadSha: string | null;
    mergeSha: string | null;
    error: string | null;
  };
  operations: Array<{
    id: string;
    taskId: string | null;
    type: string;
    state: string;
    resultHeadSha?: string | null;
    attemptCount: number;
    error: string | null;
    updatedAt: string;
  }>;
  retry: {
    action: "retry_final_verification" | null;
    state: "not_applicable" | "available" | "blocked" | "exhausted";
    available: boolean;
    reason: string | null;
    operationId: string | null;
    attemptCount: number;
    maxAttempts: number;
    preconditions: {
      planHash: string;
      executionHash: string;
      baseSha: string;
      integrationHeadSha: string;
    } | null;
  };
}

export function useImportFleetRun() {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: ImportFleetRunInput) => {
      const res = await fetch("/api/fleet/runs/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to import fleet run");
      return data as FleetRunDetailDto;
    },
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      qc.setQueryData(fleetKeys.run(detail.run.id), detail);
    },
  });
}

export function useFleetAnalyticsQuery(enabled = true) {
  return useQuery({
    queryKey: [...fleetKeys.all, "analytics"],
    queryFn: async () => {
      const res = await fetch("/api/fleet/analytics?limitRuns=100");
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error || "Failed to load fleet analytics");
      return data as FleetAnalyticsDto;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
  });
}

export function useFleetSupervisorSnapshot(
  runId: string | null,
  enabled = true
) {
  return useQuery({
    queryKey: [...fleetKeys.run(runId ?? "__disabled__"), "supervisor"],
    queryFn:
      enabled && runId
        ? async () => {
            const res = await fetch(
              `/api/fleet/runs/${encodeURIComponent(runId)}/supervisor`
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(
                data.error || "Failed to load Fleet supervisor snapshot"
              );
            }
            return data as FleetSupervisorSnapshot;
          }
        : skipToken,
    enabled: enabled && !!runId,
    staleTime: 2000,
    refetchInterval: enabled && runId ? 5000 : false,
  });
}

export function useFleetCleanupPreview(runId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...fleetKeys.run(runId ?? "__disabled__"), "cleanup-preview"],
    queryFn:
      enabled && runId
        ? async () => {
            const res = await fetch(
              `/api/fleet/runs/${encodeURIComponent(runId)}/cleanup`,
              { cache: "no-store" }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(data.error || "Failed to preview Fleet cleanup");
            }
            return data as FleetCleanupPreview;
          }
        : skipToken,
    enabled: enabled && !!runId,
    staleTime: 5000,
  });
}

export function useFleetCancellationPreview(
  runId: string | null,
  enabled = true
) {
  return useQuery({
    queryKey: [...fleetKeys.run(runId ?? "__disabled__"), "cancel-preview"],
    queryFn:
      enabled && runId
        ? async () => {
            const res = await fetch(
              `/api/fleet/runs/${encodeURIComponent(runId)}/cancel`,
              { cache: "no-store" }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(
                data.error || "Failed to preview destructive Fleet cancellation"
              );
            }
            return data as FleetDestructiveActionPreview;
          }
        : skipToken,
    enabled: enabled && !!runId,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useFleetMergeStatus(runId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...fleetKeys.run(runId ?? "__disabled__"), "merge"],
    queryFn:
      enabled && runId
        ? async () => {
            const res = await fetch(
              `/api/fleet/runs/${encodeURIComponent(runId)}/merge`
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(
                data.error || "Failed to load Fleet merge status"
              );
            }
            return data as FleetMergeStatusDto;
          }
        : skipToken,
    enabled: enabled && !!runId,
    staleTime: 2000,
    refetchInterval: enabled && runId ? 5000 : false,
  });
}

export function useRequestFleetMerge(runId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: FleetMergeRequestInput | FleetMergeTarget) => {
      if (!runId) throw new Error("No fleet run selected");
      const request: FleetMergeRequestInput =
        typeof input === "string"
          ? (() => {
              const detail = qc.getQueryData<FleetRunDetailDto>(
                fleetKeys.run(runId)
              );
              if (!detail?.run.planHash) {
                throw new Error(
                  "Refresh the Fleet run before requesting an exact merge"
                );
              }
              return {
                target: input,
                expectedPlanHash: detail.run.planHash,
                expectedBaseSha: detail.run.automationBaseSha,
                expectedIntegrationHeadSha: detail.run.integrationHeadSha,
              };
            })()
          : input;
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}/merge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to request Fleet merge");
      }
      return data as FleetMergeStatusDto;
    },
    onSuccess: (status) => {
      if (!runId) return;
      qc.setQueryData([...fleetKeys.run(runId), "merge"], status);
      qc.invalidateQueries({ queryKey: fleetKeys.run(runId) });
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
    },
  });
}

export function useAuthorizeFleetLanding(runId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: FleetLandingAuthorizationInput) => {
      if (!runId) throw new Error("No fleet run selected");
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}/merge/authorize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to authorize Fleet landing");
      }
      return data as FleetMergeStatusDto;
    },
    onSuccess: (status) => {
      if (!runId) return;
      qc.setQueryData([...fleetKeys.run(runId), "merge"], status);
      qc.invalidateQueries({ queryKey: fleetKeys.run(runId) });
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
    },
  });
}

export function useArchiveFleetRun(runId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: { retentionDays: number }) => {
      if (!runId) throw new Error("No fleet run selected");
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}/archive`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirm: true,
            confirmation: runId,
            retentionDays: input.retentionDays,
            actor: "operator",
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to archive Fleet run");
      return data as { archivedAt: string; retentionDays: number | null };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      if (runId) qc.invalidateQueries({ queryKey: fleetKeys.run(runId) });
      qc.invalidateQueries({ queryKey: [...fleetKeys.all, "analytics"] });
    },
  });
}

export function useRequestFleetCleanup(runId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: {
      confirmation: string;
      previewDigest: string;
    }) => {
      if (!runId) throw new Error("No fleet run selected");
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}/cleanup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirm: true,
            confirmation: input.confirmation,
            previewDigest: input.previewDigest,
            actor: "operator",
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error || "Failed to queue Fleet cleanup");
      return data as {
        dryRun: false;
        queued: number;
        preview: FleetCleanupPreview;
      };
    },
    onSuccess: () => {
      if (runId) {
        qc.invalidateQueries({ queryKey: fleetKeys.run(runId) });
        qc.invalidateQueries({
          queryKey: [...fleetKeys.run(runId), "cleanup-preview"],
        });
      }
    },
  });
}

function useFleetRunMutation<TInput>(
  mutationFn: (input: TInput) => Promise<FleetRunDetailDto>
) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn,
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      qc.setQueryData(fleetKeys.run(detail.run.id), detail);
    },
  });
}

export function useIngestFleetPlan(runId: string | null) {
  return useFleetRunMutation(async (input: IngestFleetPlanInput) => {
    if (!runId) throw new Error("No fleet run selected");
    const res = await fetch(
      `/api/fleet/runs/${encodeURIComponent(runId)}/plan`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to ingest fleet plan");
    return data as FleetRunDetailDto;
  });
}

export function useStartFleetPlan() {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: { runId: string; taskCap?: number }) => {
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(input.runId)}/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskCap: input.taskCap }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error || "Failed to start fleet planner");
      return data as FleetRunDetailDto;
    },
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      qc.setQueryData(fleetKeys.run(detail.run.id), detail);
    },
  });
}

export function useFleetPlanPoll(runId: string | null, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...fleetKeys.run(runId ?? "__disabled__"), "planner"],
    queryFn:
      enabled && runId
        ? async () => {
            const res = await fetch(
              `/api/fleet/runs/${encodeURIComponent(runId)}/generate`
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(data.error || "Failed to poll fleet planner");
            }
            const detail = data as FleetRunDetailDto;
            qc.setQueryData(fleetKeys.run(runId), detail);
            if (
              ![
                "starting",
                "running",
                "finalizing",
                "cleanup_pending",
              ].includes(detail.run.plannerState)
            ) {
              qc.invalidateQueries({ queryKey: fleetKeys.runs() });
            }
            return detail;
          }
        : skipToken,
    refetchInterval: enabled && runId ? 2000 : false,
    staleTime: 0,
  });
}

export function useCancelFleetPlan(runId: string | null) {
  return useFleetRunMutation(async () => {
    if (!runId) throw new Error("No fleet run selected");
    const res = await fetch(
      `/api/fleet/runs/${encodeURIComponent(runId)}/generate`,
      { method: "DELETE" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(data.error || "Failed to cancel fleet planner");
    return data as FleetRunDetailDto;
  });
}

export function useApproveFleetPlan(runId: string | null) {
  return useFleetRunMutation(async (input: ApproveFleetPlanInput) => {
    if (!runId) throw new Error("No fleet run selected");
    const res = await fetch(
      `/api/fleet/runs/${encodeURIComponent(runId)}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to approve fleet plan");
    return data as FleetRunDetailDto;
  });
}

export function useAttachFleetArtifact(runId: string | null) {
  return useFleetRunMutation(async (input: AttachFleetArtifactInput) => {
    if (!runId) throw new Error("No fleet run selected");
    const res = await fetch(
      `/api/fleet/runs/${encodeURIComponent(runId)}/artifacts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to attach finding");
    return data as FleetRunDetailDto;
  });
}

function useFleetAction<TInput>(runId: string | null, action: string) {
  return useFleetRunMutation(async (input: TInput) => {
    if (!runId) throw new Error("No fleet run selected");
    const res = await fetch(
      `/api/fleet/runs/${encodeURIComponent(runId)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed to ${action} fleet run`);
    return data as FleetRunDetailDto;
  });
}

export function useResumeFleetRun(runId: string | null) {
  return useFleetAction<ResumeFleetRunInput>(runId, "resume");
}

export function usePauseFleetRun(runId: string | null) {
  return useFleetAction<PauseFleetRunInput>(runId, "pause");
}

export function useCancelFleetRun(runId: string | null) {
  return useFleetAction<CancelFleetRunInput>(runId, "cancel");
}

export function useCompleteFleetWorker(runId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (workerId: string) => {
      if (!runId) throw new Error("No fleet run selected");
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}/workers/${encodeURIComponent(workerId)}/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: "operator" }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to mark worker complete");
      }
      return data as FleetRunDetailDto;
    },
    onSuccess: (detail) => {
      if (runId) qc.invalidateQueries({ queryKey: fleetKeys.run(runId) });
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      qc.setQueryData(fleetKeys.run(detail.run.id), detail);
    },
  });
}

export interface FleetTaskActionPreconditions {
  requestId: string;
  expectedPlanHash: string;
  expectedAttempt: number;
  expectedHeadSha: string | null;
}

export interface FleetReviewActionPreconditions extends FleetTaskActionPreconditions {
  expectedHeadSha: string;
  expectedVerificationEvidenceHash: string;
}

export interface FleetWorkerActionPreconditions {
  requestId: string;
  expectedAttempt: number;
  expectedSessionId: string;
}

export interface FleetOperatorActionResponse {
  ok: true;
  action: string;
  idempotent: boolean;
  processed?: number;
  queued?: boolean;
  run: FleetRunDetailDto;
}

export interface FleetMergeRequestInput {
  target: "local" | "github_pr";
  expectedPlanHash: string;
  expectedExecutionHash?: string;
  expectedBaseSha: string | null;
  expectedIntegrationHeadSha: string | null;
}

export interface FleetLandingAuthorizationInput {
  target: "local" | "github_pr";
  expectedPlanHash: string;
  expectedExecutionHash: string;
  expectedBaseSha: string;
  expectedIntegrationHeadSha: string;
}

function useFleetTaskOperatorAction<TInput>(
  runId: string | null,
  taskId: string | null,
  action: "retry" | "verification" | "review"
) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: TInput) => {
      if (!runId || !taskId) throw new Error("No Fleet task selected");
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Failed to ${action} Fleet task`);
      }
      return data as FleetOperatorActionResponse;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      if (runId) {
        qc.setQueryData(fleetKeys.run(runId), result.run);
      }
    },
  });
}

export function useRetryFleetTask(runId: string | null, taskId: string | null) {
  return useFleetTaskOperatorAction<FleetTaskActionPreconditions>(
    runId,
    taskId,
    "retry"
  );
}

export function useReconcileFleetTaskVerification(
  runId: string | null,
  taskId: string | null
) {
  return useFleetTaskOperatorAction<
    FleetTaskActionPreconditions & { expectedHeadSha: string }
  >(runId, taskId, "verification");
}

export function useReconcileFleetTaskReview(
  runId: string | null,
  taskId: string | null
) {
  return useFleetTaskOperatorAction<FleetReviewActionPreconditions>(
    runId,
    taskId,
    "review"
  );
}

function useFleetWorkerOperatorAction<TInput>(
  runId: string | null,
  workerId: string | null,
  action: "message" | "kill"
) {
  const qc = useQueryClient();
  return useMutation({
    retry: 0,
    mutationFn: async (input: TInput) => {
      if (!runId || !workerId) throw new Error("No Fleet worker selected");
      const res = await fetch(
        `/api/fleet/runs/${encodeURIComponent(runId)}/workers/${encodeURIComponent(workerId)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Failed to ${action} Fleet worker`);
      }
      return data as FleetOperatorActionResponse;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: fleetKeys.runs() });
      if (runId) qc.setQueryData(fleetKeys.run(runId), result.run);
    },
  });
}

export function useMessageFleetWorker(
  runId: string | null,
  workerId: string | null
) {
  return useFleetWorkerOperatorAction<
    FleetWorkerActionPreconditions & { message: string }
  >(runId, workerId, "message");
}

export function useKillFleetWorker(
  runId: string | null,
  workerId: string | null
) {
  return useFleetWorkerOperatorAction<
    FleetWorkerActionPreconditions & { preserveWorktree?: true }
  >(runId, workerId, "kill");
}
