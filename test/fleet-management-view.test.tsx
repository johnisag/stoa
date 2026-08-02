// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  FleetArtifactDto,
  FleetDestructiveActionPreview,
  FleetRunDetailDto,
  FleetRunDto,
  FleetTaskDto,
  FleetWorkerDto,
} from "@/lib/fleet/types";
import type { FleetSupervisorSnapshot } from "@/lib/fleet/supervisor-types";
import type { FleetApprovalControlPreviewDto } from "@/lib/fleet/approval-control-types";
import type { FleetMergeStatusDto } from "@/data/fleet/queries";

const state = vi.hoisted(() => ({
  detail: null as FleetRunDetailDto | null,
  runs: null as FleetRunDto[] | null,
  approvalPreview: null as FleetApprovalControlPreviewDto | null,
  outputHook: vi.fn(),
  artifactBodyHook: vi.fn(),
  approvalMutation: vi.fn(async (_input: unknown) => undefined),
  pauseMutation: vi.fn(async (_input: unknown) => undefined),
  cancelMutation: vi.fn(async (_input: unknown) => undefined),
  cleanupMutation: vi.fn(async (_input: unknown) => undefined),
  mergeMutation: vi.fn(async (_input: unknown) => undefined),
  landingMutation: vi.fn(async (_input: unknown) => undefined),
  mergeStatus: null as FleetMergeStatusDto | null,
  cancellationPreview: null as FleetDestructiveActionPreview | null,
  cleanupPreview: null as {
    runId: string;
    archived: boolean;
    terminal: boolean;
    eligible: Array<Record<string, unknown>>;
    skipped: Array<Record<string, unknown>>;
    impact: FleetDestructiveActionPreview;
  } | null,
  planReviewComplete: true,
  createMutation: vi.fn(async (_input: unknown) => {
    if (!state.detail) throw new Error("missing Fleet fixture");
    return state.detail;
  }),
}));

function mutation() {
  return {
    mutateAsync: vi.fn(async () => undefined),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  };
}

vi.mock("@/data/dispatch/queries", () => ({
  useDispatchReposQuery: () => ({
    data: [
      { id: "repo-1", repo_slug: "acme/stoa", base_branch: "release/main" },
    ],
  }),
}));
vi.mock("@/data/projects/queries", () => ({
  useProjectsQuery: () => ({ data: [] }),
}));
vi.mock("@/data/fleet/queries", () => ({
  useFleetRunsQuery: () => ({
    data: state.runs ?? (state.detail ? [state.detail.run] : []),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useFleetRunQuery: () => ({
    data: state.detail,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useFleetAnalyticsQuery: () => ({
    data: {
      runOutcomes: { completed: 2 },
      budget: { spentUsd: 1.25 },
    },
  }),
  useFleetCleanupPreview: () => ({
    data: state.cleanupPreview,
    error: null,
    isLoading: false,
  }),
  useFleetCancellationPreview: () => ({
    data: state.cancellationPreview,
    error: null,
    isLoading: false,
  }),
  useFleetMergeStatus: () => ({ data: state.mergeStatus, error: null }),
  useFleetSupervisorSnapshot: () => ({
    data: {
      snapshotHash: "supervisor-hash",
      attention: [
        {
          rank: 1,
          severity: "warning",
          code: "inspect_task",
          taskId: "task-blocked",
          workerId: null,
        },
      ],
      recommendations: [
        {
          id: "recommendation-1",
          priority: 1,
          kind: "inspect",
          reasonCode: "review_evidence",
          taskId: "task-blocked",
        },
      ],
      gates: {
        planReview: {
          required: 4,
          exactCleanLenses: state.planReviewComplete ? 4 : 2,
          independentReviewers: state.planReviewComplete ? 4 : 2,
          complete: state.planReviewComplete,
        },
      },
    } as FleetSupervisorSnapshot,
    error: null,
  }),
  useFleetApprovalControlPreview: () => ({
    data: state.approvalPreview,
    isLoading: false,
    error: null,
  }),
  useFleetApprovalControl: () => ({
    ...mutation(),
    mutateAsync: state.approvalMutation,
  }),
  useFleetPlanPoll: () => ({ isError: false, error: null }),
  useFleetWorkerOutput: (...args: unknown[]) => {
    state.outputHook(...args);
    return {
      data: {
        output: "rendered worker line",
        lines: 1,
        truncated: false,
        capturedAt: "2026-08-01T10:00:00.000Z",
      },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useFleetArtifactBody: (
    runId: string | null,
    artifactId: string | null,
    enabled: boolean
  ) => {
    state.artifactBodyHook(runId, artifactId, enabled);
    const artifact = state.detail?.artifacts.find(
      (candidate) => candidate.id === artifactId
    );
    return {
      data:
        enabled && artifact
          ? {
              id: artifact.id,
              contentHash: artifact.contentHash,
              byteCount: artifact.byteCount,
              body: artifact.body,
              bodyPrunedAt: artifact.bodyPrunedAt,
            }
          : undefined,
      isLoading: false,
      error: null,
    };
  },
  useApproveFleetPlan: mutation,
  useAttachFleetArtifact: mutation,
  useCreateFleetRun: () => ({
    ...mutation(),
    mutateAsync: state.createMutation,
  }),
  useIngestFleetPlan: mutation,
  useStartFleetPlan: mutation,
  useCancelFleetPlan: mutation,
  useResumeFleetRun: mutation,
  usePauseFleetRun: () => ({
    ...mutation(),
    mutateAsync: state.pauseMutation,
  }),
  useCancelFleetRun: () => ({
    ...mutation(),
    mutateAsync: state.cancelMutation,
  }),
  useCompleteFleetWorker: mutation,
  useImportFleetRun: mutation,
  useArchiveFleetRun: mutation,
  useRequestFleetCleanup: () => ({
    ...mutation(),
    mutateAsync: state.cleanupMutation,
  }),
  useRequestFleetMerge: () => ({
    ...mutation(),
    mutateAsync: state.mergeMutation,
  }),
  useAuthorizeFleetLanding: () => ({
    ...mutation(),
    mutateAsync: state.landingMutation,
  }),
  useRetryFleetTask: mutation,
  useReconcileFleetTaskVerification: mutation,
  useReconcileFleetTaskReview: mutation,
  useMessageFleetWorker: mutation,
  useKillFleetWorker: mutation,
}));

import { FleetManagementView } from "@/components/views/FleetManagementView";

function task(
  input: Partial<FleetTaskDto> & Pick<FleetTaskDto, "id" | "title">
): FleetTaskDto {
  const { id, title, ...overrides } = input;
  return {
    id,
    title,
    parentTaskId: null,
    dependsOnTaskIds: [],
    description: null,
    status: "ready",
    taskType: "implementation",
    sortOrder: 0,
    fileClaims: [],
    priority: 1,
    agentType: "hermes",
    model: "kimi-k3",
    workingDirectory: "C:\\repo",
    baseBranch: "main",
    sourceRef: null,
    sourceStepId: null,
    sourceIssueId: null,
    sourceIssueNumber: null,
    branchName: null,
    worktreePath: null,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    actualFileClaims: [],
    reportArtifactId: null,
    diffArtifactId: null,
    verificationId: null,
    verificationStatus: null,
    verificationSpecHash: null,
    verifiedHeadSha: null,
    verificationArtifactId: null,
    verificationStartedAt: null,
    verificationCompletedAt: null,
    reviewStatus: null,
    reviewHeadSha: null,
    reviewVerificationHash: null,
    reviewCompletedAt: null,
    fixRounds: 0,
    activeFixId: null,
    fixerSessionId: null,
    fixError: null,
    retryNotBefore: null,
    providerFailureCount: 0,
    providerState: "ready",
    providerLastError: null,
    integrationState: "pending",
    integrationOperationId: null,
    integratedHeadSha: null,
    integratedAt: null,
    maxAttempts: 3,
    currentAttempt: 1,
    acceptanceCriteria: "All tests pass",
    riskNotes: [],
    verifyCommand: "npm test",
    failureCode: null,
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

function worker(
  input: Partial<FleetWorkerDto> & Pick<FleetWorkerDto, "id" | "taskId">
): FleetWorkerDto {
  const {
    id,
    taskId,
    interruptNoticeState = "unattempted",
    interruptStopState = "unattempted",
    interruptCause = null,
    renderedStatus = null,
    renderedStatusSummary = null,
    renderedStatusSummaryRedacted = false,
    renderedStatusReplacementCount = 0,
    renderedStatusStabilityCount = 0,
    renderedStatusLastCapturedAt = null,
    renderedStatusNextCaptureAt = null,
    renderedStatusError = null,
    ...overrides
  } = input;
  return {
    id,
    taskId,
    sessionId: null,
    status: "completed",
    provider: "hermes",
    model: "kimi-k3",
    attempt: 1,
    spawnRequestId: null,
    worktreePath: null,
    branchName: null,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    reportState: "accepted",
    reportStatus: "succeeded",
    reportSubmittedAt: null,
    reportCollectedAt: null,
    reportBytes: 0,
    actualClaims: [],
    diffSummary: null,
    reportPollCount: 0,
    reportLastPolledAt: null,
    reportNextPollAt: null,
    reportError: null,
    reservationUsd: 0,
    reservationTokens: 0,
    reservationConfidence: "unknown",
    reservationBasis: null,
    actualCostUsd: null,
    actualTokens: null,
    costConfidence: "unknown",
    costReconciledAt: null,
    interruptRequestedAt: null,
    interruptDeadlineAt: null,
    interruptNoticeState,
    interruptStopState,
    interruptCause,
    renderedStatus,
    renderedStatusSummary,
    renderedStatusSummaryRedacted,
    renderedStatusReplacementCount,
    renderedStatusStabilityCount,
    renderedStatusLastCapturedAt,
    renderedStatusNextCaptureAt,
    renderedStatusError,
    terminalCause: null,
    failureCode: null,
    createdAt: "2026-08-01T08:00:00.000Z",
    lastHeartbeatAt: null,
    endedAt: null,
    ...overrides,
  };
}

function blockerArtifact(
  input: Partial<FleetArtifactDto> & Pick<FleetArtifactDto, "id" | "title">
): FleetArtifactDto {
  const { id, title, ...overrides } = input;
  return {
    id,
    title,
    taskId: null,
    workerId: null,
    attempt: null,
    planHash: "plan-hash",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    contentHash: `${id}-hash`,
    metadata: {},
    byteCount: 64,
    artifactType: "task_review_finding",
    body: "Review finding",
    bodyPrunedAt: null,
    severity: "blocker",
    actor: "fleet-task-review:correctness",
    createdAt: "2026-08-01T09:45:00.000Z",
    ...overrides,
  };
}

function detailFixture(): FleetRunDetailDto {
  const diff: FleetArtifactDto = {
    id: "diff-1",
    taskId: "task-active",
    workerId: "worker-active",
    attempt: 2,
    planHash: "plan-hash",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    contentHash: "diff-hash",
    metadata: {},
    byteCount: 40,
    artifactType: "worker_git_state",
    title: "Authoritative worker Git state",
    body: '{"files":["src/fleet.ts"]}',
    bodyPrunedAt: null,
    severity: "info",
    actor: "scheduler",
    createdAt: "2026-08-01T09:30:00.000Z",
  };
  const tasks = [
    task({
      id: "task-routine",
      title: "Routine Task",
      status: "completed",
      sortOrder: 0,
    }),
    task({
      id: "task-blocked",
      title: "Blocked Task",
      status: "needs_inspection",
      sortOrder: 1,
    }),
    task({
      id: "task-failed",
      title: "Failed Task",
      status: "failed",
      sortOrder: 2,
    }),
    task({
      id: "task-active",
      title: "Waiting Task",
      status: "waiting_for_operator",
      sortOrder: 3,
      currentAttempt: 2,
      branchName: "fleet/run/task/2",
      worktreePath: "C:\\repo\\.stoa-worktrees\\task-2",
      diffArtifactId: "diff-1",
    }),
  ];
  const workers = [
    worker({
      id: "worker-active",
      taskId: "task-active",
      sessionId: "session-exact",
      status: "waiting_for_operator",
      attempt: 2,
      branchName: "fleet/run/task/2",
      worktreePath: "C:\\repo\\.stoa-worktrees\\task-2",
      reservationUsd: 0.25,
      lastHeartbeatAt: "2026-08-01T09:59:00.000Z",
      interruptRequestedAt: "2026-08-01T09:58:00.000Z",
      interruptDeadlineAt: "2026-08-01T09:58:30.000Z",
      interruptNoticeState: "delivered",
      interruptStopState: "unattempted",
      interruptCause: "operator_pause",
      renderedStatus: "waiting",
      renderedStatusSummary: "Waiting for operator approval",
      renderedStatusSummaryRedacted: true,
      renderedStatusReplacementCount: 2,
      renderedStatusStabilityCount: 1,
      renderedStatusLastCapturedAt: "2026-08-01T09:59:30.000Z",
      renderedStatusNextCaptureAt: "2026-08-01T10:00:00.000Z",
    }),
    worker({
      id: "worker-dead",
      taskId: "task-failed",
      status: "dead",
      failureCode: "heartbeat_timeout",
    }),
  ];
  return {
    run: {
      id: "run-1",
      name: "Autonomous delivery",
      goal: "Ship the whole epic",
      repoId: "repo-1",
      projectId: null,
      sourceKind: "text",
      sourceId: null,
      sourceName: null,
      status: "running",
      budgetUsd: 10,
      budgetTokens: 100_000,
      provider: "hermes",
      model: "kimi-k3",
      maxConcurrency: 4,
      reviewPolicy: "manual",
      approvalState: "approved",
      planHash: "plan-hash",
      planText: "1. Ship it",
      approvedPlanHash: "plan-hash",
      approvedBy: "operator",
      approvedAt: "2026-08-01T08:00:00.000Z",
      desiredState: "running",
      automationPolicy: {
        version: 1,
        automaticPlanning: true,
        automaticPlanApproval: false,
        automaticStart: true,
        automaticFixes: true,
        maxAutomaticFixRounds: 2,
        automaticMerge: true,
        mergeTarget: "github_pr",
        allowSensitivePaths: false,
        allowUnconfinedAgents: false,
        plannerTaskCap: 8,
        cleanupPolicy: "preserve",
        retentionDays: 30,
      },
      automationPolicyHash: "policy-hash",
      automationGrantedBy: "operator",
      automationGrantedAt: "2026-08-01T08:00:00.000Z",
      automationBaseSha: "a".repeat(40),
      automationLastError: "base commit moved",
      mergeRequestedAt: null,
      mergeRequestedBy: null,
      mergeRequestKind: null,
      mergeTarget: null,
      integrationState: "idle",
      integrationBranch: null,
      integrationWorktree: null,
      integrationBaseSha: null,
      integrationHeadSha: null,
      integrationPrNumber: null,
      integrationPrUrl: null,
      integrationPrHeadSha: null,
      integrationMergeSha: null,
      integrationError: null,
      integrationUpdatedAt: null,
      archivedAt: null,
      archivedBy: null,
      retentionDays: 30,
      schedulerEpoch: 1,
      recoveryRequired: false,
      reservedBudgetUsd: 0.5,
      spentBudgetUsd: 1.25,
      reservedBudgetTokens: 5_000,
      spentBudgetTokens: 12_500,
      costConfidence: "medium",
      budgetStopMode: "pause-new",
      budgetWarningThreshold: 0.8,
      budgetWarningEmittedAt: null,
      budgetHardLimitAt: null,
      budgetInterruptDeadlineAt: null,
      providerCaps: {},
      resourceLimits: {
        pty: 8,
        transportHost: 8,
        verifier: 2,
        gitOperation: 2,
        mergeOperation: 1,
        worktreesPerRepo: 8,
        diskBytes: 1_000_000,
        outputBytesPerMinute: 1_000_000,
        artifactBytesPerMinute: 1_000_000,
        artifactBytesTotal: 10_000_000,
        eventFanoutPerMinute: 1_000,
        eventBytesPerMinute: 1_000_000,
        eventBytesTotal: 10_000_000,
        providerCaps: {},
      },
      defaultMaxAttempts: 3,
      pauseMode: null,
      pauseReason: null,
      cancelMode: null,
      taskCount: tasks.length,
      workerCount: workers.length,
      attentionCount: 0,
      awaitingManualMerge: false,
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      approvalPreview: {
        requiredGates: ["four exact task reviews"],
        blockedActions: [],
        canApproveExecutableWork: true,
      },
      plannerState: "ready",
      plannerError: null,
      plannerProvider: "hermes",
      plannerSessionId: null,
    },
    tasks,
    workers,
    artifacts: [diff],
    verifications: [],
    events: [
      {
        id: 2,
        eventType: "worker_waiting_for_operator",
        actor: "scheduler",
        payload: { taskId: "task-active", workerId: "worker-active" },
        createdAt: "2026-08-01T09:58:00.000Z",
      },
      {
        id: 1,
        eventType: "task_inspection_requested",
        actor: "verifier",
        payload: { taskId: "task-blocked" },
        createdAt: "2026-08-01T09:40:00.000Z",
      },
    ],
  };
}

function destructivePreviewFixture(
  overrides: Partial<FleetDestructiveActionPreview> = {}
): FleetDestructiveActionPreview {
  const worktreePath = "C:\\repo\\.stoa-worktrees\\task-2";
  return {
    runId: "run-1",
    action: "cancel",
    revision: "b".repeat(64),
    targetDigest: "a".repeat(64),
    complete: true,
    objectLimit: 128,
    truncatedKinds: [],
    excludedWorktreeCount: 0,
    owners: [
      {
        ownerType: "worker",
        ownerId: "worker-active",
        taskId: "task-active",
        sessionId: "session-exact",
        sessionName: "Fleet worker active",
        sessionStatus: "running",
        active: true,
      },
    ],
    sessions: [
      {
        id: "session-exact",
        name: "Fleet worker active",
        status: "running",
        active: true,
        owners: [{ ownerType: "worker", ownerId: "worker-active" }],
      },
    ],
    worktrees: [
      {
        worktreePath,
        projectPath: "C:\\repo",
        exists: true,
        expectedHeadSha: null,
        owners: [
          {
            ownerType: "worker",
            ownerId: "worker-active",
            workerId: "worker-active",
            sessionId: "session-exact",
          },
        ],
        branchNames: ["fleet/run/task/2"],
        sessionIds: ["session-exact"],
      },
    ],
    branches: [
      {
        branchName: "fleet/run/task/2",
        worktreePath,
        ownerType: "worker",
        ownerId: "worker-active",
        expectedHeadSha: null,
        preserved: true,
      },
    ],
    artifacts: [
      {
        id: "diff-1",
        taskId: "task-active",
        workerId: "worker-active",
        artifactType: "worker_diff",
        title: "Worker diff",
        byteCount: 128,
        bodyPrunedAt: null,
        preserved: true,
      },
    ],
    effects: {
      stopActiveSessions: true,
      deleteVerifiedWorktrees: true,
      preserveBranches: true,
      preserveArtifactMetadata: true,
      artifactBodyRetentionDays: 30,
    },
    ...overrides,
  };
}

function approvalPreviewFixture(): FleetApprovalControlPreviewDto {
  return {
    runId: "run-1",
    estimate: {
      kind: "estimated_remaining",
      estimatedUsd: 2.5,
      estimatedTokens: 400_000,
      confidence: "medium",
      capped: false,
      sessionCounts: {
        workerAttempts: 2,
        taskReviews: 4,
        planReviews: 0,
        planner: 0,
        total: 6,
      },
      projectedTotalUsd: 4.25,
      projectedTotalTokens: 412_000,
      budgetComparison: { usd: "within", tokens: "exceeds" },
      exclusions: [
        "Additional attempts created by future plan changes are not estimable.",
      ],
    },
    bindings: {
      approvedPlanHash: "1".repeat(64),
      currentPlanHash: "1".repeat(64),
      approvedExecutionHash: "2".repeat(64),
      currentExecutionHash: "2".repeat(64),
      storedPolicyHash: "3".repeat(64),
      currentPolicyHash: "3".repeat(64),
      baseSha: "a".repeat(40),
      runUpdatedAt: "2026-08-01T10:00:00.000Z",
    },
    approvedVsCurrent: {
      planChanged: false,
      executionChanged: false,
      policyChanged: false,
    },
    run: {
      status: "running",
      maxConcurrency: 4,
      budgetUsd: 10,
      budgetTokens: 100_000,
      reservedBudgetUsd: 0.5,
      spentBudgetUsd: 1.25,
      reservedBudgetTokens: 2_000,
      spentBudgetTokens: 10_000,
      budgetStopMode: "pause-new",
      budgetHardLimitAt: null,
      budgetInterruptDeadlineAt: null,
      pauseReason: null,
    },
    tasks: [
      {
        id: "task-routine",
        status: "ready",
        approvalState: "approved",
        attempt: 0,
        baseSha: null,
        headSha: null,
        updatedAt: "2026-08-01T09:00:00.000Z",
        notYetStarted: true,
        hasActiveWorker: false,
        manualLaunchApprovalRequired: false,
        approvedTaskHash: "1".repeat(64),
        plannedClaims: ["src/routine.ts"],
        actualClaims: [],
        actualClaimsHash: "4".repeat(64),
        addedActualClaims: [],
        sensitivePaths: [],
        quarantinedForClaimApproval: false,
        skipClosure: {
          taskIds: ["task-routine"],
          hash: "5".repeat(64),
          eligible: true,
          blockers: [],
        },
      },
      {
        id: "task-blocked",
        status: "needs_inspection",
        approvalState: "approved",
        attempt: 1,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        updatedAt: "2026-08-01T09:40:00.000Z",
        notYetStarted: false,
        hasActiveWorker: false,
        manualLaunchApprovalRequired: false,
        approvedTaskHash: "1".repeat(64),
        plannedClaims: ["src"],
        actualClaims: ["src", ".github/workflows/ci.yml"],
        actualClaimsHash: "6".repeat(64),
        addedActualClaims: [".github/workflows/ci.yml"],
        sensitivePaths: [
          { path: ".github/workflows/ci.yml", reason: "automation" },
        ],
        quarantinedForClaimApproval: true,
        skipClosure: {
          taskIds: ["task-blocked"],
          hash: "7".repeat(64),
          eligible: false,
          blockers: ["task already started"],
        },
      },
    ],
    recentApprovals: [],
  };
}

describe("FleetManagementView status drilldowns", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    state.detail = detailFixture();
    state.runs = null;
    state.approvalPreview = approvalPreviewFixture();
    state.cancellationPreview = destructivePreviewFixture();
    state.cleanupPreview = null;
    state.mergeStatus = null;
    state.planReviewComplete = true;
    state.outputHook.mockClear();
    state.artifactBodyHook.mockClear();
    state.approvalMutation.mockClear();
    state.pauseMutation.mockClear();
    state.cancelMutation.mockClear();
    state.cleanupMutation.mockClear();
    state.mergeMutation.mockClear();
    state.landingMutation.mockClear();
    state.createMutation.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("defaults to six parallel workers and warns above twelve", async () => {
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    const input = screen.getByLabelText(
      "Max parallel workers"
    ) as HTMLInputElement;
    expect(input.value).toBe("6");
    fireEvent.change(input, { target: { value: "13" } });
    expect(
      screen.getByText(/More than 12 parallel workers can exhaust/)
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "12" } });
    expect(
      screen.queryByText(/More than 12 parallel workers can exhaust/)
    ).toBeNull();
  });

  it("shows the conservative pre-approval estimate and budget comparison", async () => {
    render(<FleetManagementView />);
    const estimate = await screen.findByTestId("fleet-approval-cost-estimate");
    expect(estimate.textContent).toContain("Estimated remaining Fleet spend");
    expect(estimate.textContent).toContain("$2.50");
    expect(estimate.textContent).toContain("400,000 tokens");
    expect(estimate.textContent).toContain("tokens exceeds");
    expect(estimate.textContent).not.toContain("zero-cost estimate");
  });

  it("keeps four-agent approval disabled until all exact critics are clean", async () => {
    state.detail!.run.status = "draft";
    state.detail!.run.approvalState = "needs_approval";
    state.detail!.run.reviewPolicy = "four_agent";
    state.detail!.run.approvedPlanHash = null;
    state.detail!.run.approvedAt = null;
    state.detail!.run.approvedBy = null;
    state.detail!.artifacts = [];
    state.planReviewComplete = false;

    const first = render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      screen.getByText(/Four independent clean plan critics must finish/)
        .textContent
    ).toContain("2/4 clean lenses, 2 independent reviewers");
    expect(screen.queryByText("Reviewed plan requires approval")).toBeNull();

    first.unmount();
    state.planReviewComplete = true;
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(screen.getByText("Reviewed plan requires approval")).toBeTruthy();
  });

  it("keeps healthy automatic plan approval out of operator attention", async () => {
    state.detail!.run.status = "draft";
    state.detail!.run.approvalState = "needs_approval";
    state.detail!.run.reviewPolicy = "four_agent";
    state.detail!.run.automationPolicy.automaticPlanApproval = true;
    state.detail!.run.automationLastError = null;
    state.detail!.run.approvedPlanHash = null;
    state.detail!.artifacts = [];
    state.planReviewComplete = true;

    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    expect(screen.queryByText("Reviewed plan requires approval")).toBeNull();
  });

  it("renders structured task risk severity and mitigation beside acceptance", async () => {
    state.detail!.tasks[0]!.riskNotes = [
      {
        severity: "high",
        risk: "The migration can leave a partial index",
        mitigation: "Run it transactionally and verify the index",
      },
    ];
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    const risks = screen.getByTestId("fleet-task-risks-task-routine");
    expect(risks.textContent).toContain("Known risks");
    expect(risks.textContent).toContain(
      "Risk: The migration can leave a partial index"
    );
    expect(risks.textContent).toContain(
      "Mitigation: Run it transactionally and verify the index"
    );
    expect(screen.getByLabelText("high severity").textContent).toBe("high");
    expect(
      screen.getAllByText("Acceptance: All tests pass").length
    ).toBeGreaterThan(0);
  });

  it("renders epic-to-merge automation controls and the explicit manual policy", async () => {
    render(<FleetManagementView />);
    expect(
      await screen.findByRole("heading", { name: "Autonomous delivery" })
    ).toBeTruthy();
    expect(screen.getByLabelText("Plan automatically")).toBeTruthy();
    expect(screen.getByLabelText("Approve plans automatically")).toBeTruthy();
    expect(
      screen.getByLabelText("Start approved work automatically")
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Fix review findings automatically")
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Merge green results automatically")
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Plan automatically"));
    fireEvent.click(screen.getByLabelText("Approve plans automatically"));
    fireEvent.click(screen.getByLabelText("Start approved work automatically"));
    expect(
      (
        screen.getByLabelText(
          "Merge green results automatically"
        ) as HTMLInputElement
      ).disabled
    ).toBe(false);
    fireEvent.click(screen.getByLabelText("Merge green results automatically"));
    expect(screen.getByText(/exact old-OID-leased fast-forward/)).toBeTruthy();
    expect(screen.getByText(/does not fall back/)).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Fix review findings automatically"
        ) as HTMLInputElement
      ).checked
    ).toBe(false);
    expect(
      screen.getAllByText(/Manual plan approval \+ four task reviews/).length
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText("Review policy"));
    expect(
      await screen.findByText(/Four plan critics \+ four task reviewers/)
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("option", {
        name: "Manual plan approval + four task reviews",
      })
    );
    expect(screen.queryByText(/extra red-team/)).toBeNull();
    expect(
      screen.getAllByText(/\$1\.25 spent \+ \$0\.50 reserved/).length
    ).toBeGreaterThan(0);
    expect(screen.getByText("Exact approval controls")).toBeTruthy();
    expect(screen.getByText("bindings current")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve concurrency change" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve budget change" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Skip 1-task closure" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Require manual launch" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Convert to read-only" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approve exact claim expansion" })
    ).toBeTruthy();
    expect(
      screen.getByText(/sensitive: \.github\/workflows\/ci\.yml/)
    ).toBeTruthy();
  });

  it("renders a durable attention queue in documented priority order", async () => {
    render(<FleetManagementView />);
    const queue = await screen.findByTestId("attention-items");
    const text = queue.textContent ?? "";
    expect(text.indexOf("Automation paused")).toBeLessThan(
      text.indexOf("Blocked Task")
    );
    expect(text.indexOf("Blocked Task")).toBeLessThan(
      text.indexOf("Waiting Task")
    );
    expect(text.indexOf("Waiting Task")).toBeLessThan(
      text.indexOf("Failed Task")
    );
  });

  it("keeps historical blockers in Artifacts after a clean descendant leaves urgent attention", async () => {
    const detail = state.detail!;
    const historicalTitle = "Historical blocker fixed on a descendant";
    const currentTitle = "Current unresolved blocker";
    const fixed = detail.tasks.find(
      (candidate) => candidate.id === "task-routine"
    )!;
    fixed.status = "merged";
    fixed.headSha = "c".repeat(40);
    fixed.verificationStatus = "pass";
    fixed.verifiedHeadSha = fixed.headSha;
    fixed.reviewStatus = "clean";
    fixed.reviewHeadSha = fixed.headSha;
    const unresolved = detail.tasks.find(
      (candidate) => candidate.id === "task-blocked"
    )!;
    unresolved.headSha = "d".repeat(40);
    detail.artifacts.push(
      blockerArtifact({
        id: "historical-blocker",
        title: historicalTitle,
        taskId: fixed.id,
        attempt: fixed.currentAttempt,
        headSha: "b".repeat(40),
      }),
      blockerArtifact({
        id: "current-blocker",
        title: currentTitle,
        taskId: unresolved.id,
        attempt: unresolved.currentAttempt,
        headSha: unresolved.headSha,
      })
    );

    render(<FleetManagementView />);
    const queue = await screen.findByTestId("attention-items");
    expect(within(queue).queryByText(new RegExp(historicalTitle))).toBeNull();
    expect(within(queue).getByText(new RegExp(currentTitle))).toBeTruthy();

    const artifacts = screen.getByRole("heading", {
      name: "Run artifacts",
    }).parentElement?.parentElement;
    expect(artifacts).toBeTruthy();
    expect(within(artifacts!).getByText(historicalTitle)).toBeTruthy();
  });

  it("discloses bounded artifact and event metadata windows", async () => {
    state.detail!.artifactTotal = 143;
    state.detail!.artifactHasMore = true;
    state.detail!.eventTotal = 87;
    state.detail!.eventHasMore = true;

    render(<FleetManagementView />);

    expect(await screen.findByText("Showing 1 of 143 artifacts")).toBeTruthy();
    expect(
      screen.getByText(/every task-referenced report, diff, and verification/)
    ).toBeTruthy();
    expect(screen.getByText("Showing the newest 2 of 87 events.")).toBeTruthy();
  });

  it("discloses that only terminal history is capped", async () => {
    state.runs = Array.from({ length: 100 }, (_, index) => ({
      ...state.detail!.run,
      id: `terminal-${index}`,
      name: `Terminal ${index}`,
      status: "completed" as const,
    }));

    render(<FleetManagementView />);

    expect(
      await screen.findByText(/Terminal and archived history is capped/)
    ).toBeTruthy();
    expect(
      screen.getByText(/All unarchived active work remains visible/)
    ).toBeTruthy();
  });

  it("fails closed when a clean task has malformed current-head evidence", async () => {
    const detail = state.detail!;
    const title = "Blocker with unverifiable current binding";
    const task = detail.tasks.find(
      (candidate) => candidate.id === "task-routine"
    )!;
    task.status = "merged";
    task.headSha = "malformed-current-head";
    task.verificationStatus = "pass";
    task.verifiedHeadSha = task.headSha;
    task.reviewStatus = "clean";
    task.reviewHeadSha = task.headSha;
    detail.artifacts.push(
      blockerArtifact({
        id: "malformed-binding-blocker",
        title,
        taskId: task.id,
        headSha: "b".repeat(40),
      })
    );

    render(<FleetManagementView />);
    const queue = await screen.findByTestId("attention-items");
    expect(within(queue).getByText(new RegExp(title))).toBeTruthy();
  });

  it("submits a changed run control with the displayed exact bindings", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    fireEvent.change(screen.getByLabelText("Approved Fleet concurrency"), {
      target: { value: "5" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Approve concurrency change" })
    );

    await waitFor(() => expect(state.approvalMutation).toHaveBeenCalled());
    expect(state.approvalMutation).toHaveBeenCalledWith({
      kind: "concurrency",
      body: expect.objectContaining({
        expectedPlanHash: "1".repeat(64),
        expectedExecutionHash: "2".repeat(64),
        expectedPolicyHash: "3".repeat(64),
        expectedBaseSha: "a".repeat(40),
        expectedRunUpdatedAt: "2026-08-01T10:00:00.000Z",
        maxConcurrency: 5,
      }),
    });
  });

  it("requires confirmation before pausing and interrupting active workers", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });

    fireEvent.click(
      screen.getByRole("button", { name: "Pause and stop agents" })
    );

    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("30-second grace period")
    );
    await waitFor(() =>
      expect(state.pauseMutation).toHaveBeenCalledWith({
        actor: "operator",
        mode: "pause-and-interrupt",
        graceMs: 30_000,
      })
    );
  });

  it("shows exact destructive-cancel impact and requires the typed run id", async () => {
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel and clean owned worktrees",
      })
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Cancel and clean Fleet-owned worktrees",
      })
    ).toBeTruthy();
    expect(
      within(
        within(dialog).getByRole("region", {
          name: "Affected Fleet owners",
        })
      ).getByText("worker-active")
    ).toBeTruthy();
    expect(
      within(
        within(dialog).getByRole("region", {
          name: "Affected Fleet sessions",
        })
      ).getByText("session-exact")
    ).toBeTruthy();
    expect(
      within(dialog).getByText("C:\\repo\\.stoa-worktrees\\task-2")
    ).toBeTruthy();
    expect(within(dialog).getByText(/fleet\/run\/task\/2/)).toBeTruthy();
    expect(within(dialog).getByText(/diff-1/)).toBeTruthy();
    expect(within(dialog).getByText(/uncommitted or untracked/)).toBeTruthy();
    expect(
      within(
        within(dialog).getByRole("region", {
          name: "Expected destructive action data loss",
        })
      ).getByText(/branches.*preserved/i)
    ).toBeTruthy();

    const confirm = within(dialog).getByRole("button", {
      name: "Cancel and clean",
    }) as HTMLButtonElement;
    const input = within(dialog).getByLabelText(
      "Type Fleet run ID to confirm destructive action"
    );
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "wrong-run" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "run-1" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(state.cancelMutation).toHaveBeenCalledWith({
        actor: "operator",
        mode: "cancel-and-clean-owned-worktrees",
        confirm: true,
        confirmation: "run-1",
        previewDigest: "a".repeat(64),
      })
    );
  });

  it("shows the exact archived cleanup preview before deleting worktrees", async () => {
    const impact = destructivePreviewFixture();
    state.detail = {
      ...state.detail!,
      run: {
        ...state.detail!.run,
        status: "canceled",
        desiredState: "canceled",
        archivedAt: "2026-08-01T11:00:00.000Z",
      },
    };
    state.cleanupPreview = {
      runId: "run-1",
      archived: true,
      terminal: true,
      eligible: [
        {
          ownerType: "worker",
          ownerId: "worker-active",
          workerId: "worker-active",
          worktreePath: impact.worktrees[0].worktreePath,
          projectPath: impact.worktrees[0].projectPath,
          exists: true,
          ownerCount: 1,
        },
      ],
      skipped: [],
      impact,
    };

    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    fireEvent.click(screen.getByRole("button", { name: "Clean 1 worktree" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Clean archived Fleet-owned worktrees",
      })
    ).toBeTruthy();
    fireEvent.change(
      within(dialog).getByLabelText(
        "Type Fleet run ID to confirm destructive action"
      ),
      { target: { value: "run-1" } }
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete worktrees" })
    );

    await waitFor(() =>
      expect(state.cleanupMutation).toHaveBeenCalledWith({
        confirmation: "run-1",
        previewDigest: "a".repeat(64),
      })
    );
  });

  it("keeps pause, cancel, and exact controls open during internal integration staging", async () => {
    state.detail = {
      ...state.detail!,
      run: {
        ...state.detail!.run,
        status: "merging",
        integrationState: "integrating",
        mergeRequestedAt: null,
        mergeRequestedBy: "operator",
        mergeRequestKind: "manual",
        mergeTarget: "github_pr",
      },
    };
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });

    expect(
      (
        screen.getByRole("button", {
          name: "Pause new work",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(screen.queryByText("control window closed")).toBeNull();
    expect(screen.getByText("internal staging")).toBeTruthy();
    expect(
      screen.getByText(/External landing is not authorized yet/)
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Stage for GitHub PR" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Stage for local fast-forward" })
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("Approved Fleet concurrency"), {
      target: { value: "5" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Approve concurrency change",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("requires a second exact confirmation before a staged head can land", async () => {
    const planHash = "1".repeat(64);
    const executionHash = "2".repeat(64);
    const baseSha = "a".repeat(40);
    const integrationHeadSha = "c".repeat(40);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    state.detail = {
      ...state.detail!,
      run: {
        ...state.detail!.run,
        status: "merging",
        planHash,
        approvedPlanHash: planHash,
        integrationState: "ready_to_finalize",
        integrationBaseSha: baseSha,
        integrationHeadSha,
        mergeRequestedAt: null,
        mergeRequestedBy: "operator",
        mergeRequestKind: "manual",
        mergeTarget: "github_pr",
      },
    };
    state.mergeStatus = {
      readiness: {
        runId: "run-1",
        requested: false,
        target: "github_pr",
        integrationState: "ready_to_finalize",
        readyTaskIds: [],
        waitingTaskIds: [],
        mergedTaskIds: ["task-active", "task-blocked"],
        blockers: [],
        allTasksIntegrated: true,
        canFinalize: true,
      },
      integration: {
        state: "ready_to_finalize",
        target: "github_pr",
        requestedAt: null,
        requestedBy: "operator",
        requestKind: "manual",
        branch: "stoa/fleet/integration-run-1",
        worktree: "C:\\repo\\.stoa-worktrees\\integration-run-1",
        baseSha,
        headSha: integrationHeadSha,
        prNumber: null,
        prUrl: null,
        prHeadSha: null,
        mergeSha: null,
        error: null,
      },
      operations: [
        {
          id: "final-verify-1",
          taskId: null,
          type: "final_verify",
          state: "completed",
          resultHeadSha: integrationHeadSha,
          attemptCount: 1,
          error: null,
          updatedAt: "2026-08-01T10:01:00.000Z",
        },
      ],
      retry: {
        action: null,
        state: "not_applicable",
        available: false,
        reason: null,
        operationId: null,
        attemptCount: 0,
        maxAttempts: 3,
        preconditions: null,
      },
    };

    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    expect(state.landingMutation).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Authorize GitHub landing" })
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(`Integration head: ${integrationHeadSha}`)
    );
    await waitFor(() =>
      expect(state.landingMutation).toHaveBeenCalledWith({
        target: "github_pr",
        expectedPlanHash: planHash,
        expectedExecutionHash: executionHash,
        expectedBaseSha: baseSha,
        expectedIntegrationHeadSha: integrationHeadSha,
      })
    );
    expect(state.mergeMutation).not.toHaveBeenCalled();
  });

  it("offers one exact same-target retry when final verification is safely retryable", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const planHash = "1".repeat(64);
    const executionHash = "2".repeat(64);
    const baseSha = "a".repeat(40);
    const integrationHeadSha = "c".repeat(40);
    state.detail = {
      ...state.detail!,
      run: {
        ...state.detail!.run,
        status: "merging",
        integrationState: "awaiting_operator",
        integrationError: "Fleet artifact_bytes_total quota exceeded",
        integrationBaseSha: baseSha,
        integrationHeadSha,
        mergeRequestedAt: null,
        mergeRequestedBy: "operator",
        mergeRequestKind: "manual",
        mergeTarget: "github_pr",
      },
    };
    state.mergeStatus = {
      readiness: {
        runId: "run-1",
        requested: false,
        target: "github_pr",
        integrationState: "awaiting_operator",
        readyTaskIds: [],
        waitingTaskIds: [],
        mergedTaskIds: ["task-active", "task-blocked"],
        blockers: [],
        allTasksIntegrated: true,
        canFinalize: true,
      },
      integration: {
        state: "awaiting_operator",
        target: "github_pr",
        requestedAt: null,
        requestedBy: "operator",
        requestKind: "manual",
        branch: "stoa/fleet/integration-run-1",
        worktree: "C:\\repo\\.stoa-worktrees\\integration-run-1",
        baseSha,
        headSha: integrationHeadSha,
        prNumber: null,
        prUrl: null,
        prHeadSha: null,
        mergeSha: null,
        error: "Fleet artifact_bytes_total quota exceeded",
      },
      operations: [
        {
          id: "final-verify-1",
          taskId: null,
          type: "final_verify",
          state: "failed",
          attemptCount: 1,
          error: "Fleet artifact_bytes_total quota exceeded",
          updatedAt: "2026-08-01T10:01:00.000Z",
        },
      ],
      retry: {
        action: "retry_final_verification",
        state: "available",
        available: true,
        reason: null,
        operationId: "final-verify-1",
        attemptCount: 1,
        maxAttempts: 3,
        preconditions: {
          planHash,
          executionHash,
          baseSha,
          integrationHeadSha,
        },
      },
    };

    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    expect(screen.getByText("verification retry available")).toBeTruthy();
    expect(
      screen.getByText(/same exact approved plan, execution, base/)
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Stage for GitHub PR" })
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry final verification" })
    );
    await waitFor(() => expect(state.mergeMutation).toHaveBeenCalled());
    expect(state.mergeMutation).toHaveBeenCalledWith({
      target: "github_pr",
      expectedPlanHash: planHash,
      expectedExecutionHash: executionHash,
      expectedBaseSha: baseSha,
      expectedIntegrationHeadSha: integrationHeadSha,
    });
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("attempt 2 of 3")
    );
  });

  it("locks interrupt and exact controls after external landing authorization", async () => {
    state.detail = {
      ...state.detail!,
      run: {
        ...state.detail!.run,
        status: "merging",
        integrationState: "ready_to_finalize",
        mergeRequestedAt: "2026-08-01T10:01:00.000Z",
        mergeRequestedBy: "fleet-automation",
        mergeRequestKind: "automatic",
        mergeTarget: "local",
      },
    };
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });

    expect(
      (
        screen.getByRole("button", {
          name: "Pause new work",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(screen.getByText("control window closed")).toBeTruthy();
    expect(screen.getByText(/External landing is authorized/)).toBeTruthy();
  });

  it("submits only changed budget dimensions against the exact run binding", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    fireEvent.change(screen.getByLabelText("Approved Fleet token budget"), {
      target: { value: "120000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Approve budget change" })
    );

    await waitFor(() => expect(state.approvalMutation).toHaveBeenCalled());
    const mutation = state.approvalMutation.mock.calls[0]?.[0] as {
      kind: string;
      body: Record<string, unknown>;
    };
    expect(mutation).toMatchObject({
      kind: "budget",
      body: {
        expectedPlanHash: "1".repeat(64),
        expectedExecutionHash: "2".repeat(64),
        expectedPolicyHash: "3".repeat(64),
        expectedBaseSha: "a".repeat(40),
        expectedRunUpdatedAt: "2026-08-01T10:00:00.000Z",
        budgetTokens: 120_000,
        overrideHardStop: false,
        expectedPauseReason: null,
      },
    });
    expect(mutation.body).not.toHaveProperty("budgetUsd");
  });

  it("renders mobile sections, exact task/worker controls, and supervisor evidence", async () => {
    const onOpenSession = vi.fn();
    render(<FleetManagementView onOpenSession={onOpenSession} />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });

    const nav = screen.getByRole("navigation", { name: "Fleet run sections" });
    const tasksTab = within(nav).getByRole("button", { name: "Tasks" });
    fireEvent.click(tasksTab);
    expect(tasksTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Branch: fleet/run/task/2")).toBeTruthy();
    expect(
      screen.getAllByText(/Latest event: worker waiting for operator/)
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Open active session" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Inspect exact diff" }));
    expect(screen.getByText("Authoritative Git evidence")).toBeTruthy();
    expect(screen.getAllByText(/src\/fleet\.ts/).length).toBeGreaterThan(0);
    expect(screen.getByText("Advisory supervisor")).toBeTruthy();
    expect(
      screen.getByText(/Recommendations are hash-bound evidence only/)
    ).toBeTruthy();
  });

  it("loads output for only the selected exact worker and opens its persisted session", async () => {
    const onOpenSession = vi.fn();
    render(<FleetManagementView onOpenSession={onOpenSession} />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    expect(state.outputHook).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(onOpenSession).toHaveBeenCalledWith("session-exact");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Rendered output for worker attempt 2",
      })
    );

    expect(state.outputHook).toHaveBeenCalledWith(
      "run-1",
      "worker-active",
      2,
      "session-exact",
      true,
      80
    );
    expect(screen.getByText("rendered worker line")).toBeTruthy();
    const workerMeta = screen.getByTestId("worker-meta-worker-active");
    expect(workerMeta.textContent).toContain("2026-08-01 09:59:00.000");
    expect(workerMeta.textContent).toContain("reservation $0.25");
    const renderedStatus = screen.getByTestId(
      "worker-rendered-status-worker-active"
    );
    expect(renderedStatus.textContent).toContain("Rendered status: waiting");
    expect(renderedStatus.textContent).toContain(
      "Waiting for operator approval"
    );
    expect(renderedStatus.textContent).toContain("redacted (2)");
    const interrupt = screen.getByTestId("worker-interrupt-worker-active");
    expect(interrupt.textContent).toContain(
      "Interrupt operator_pause · notice delivered · stop unattempted"
    );
  });

  it("submits token, retry, provider, budget-policy, and every resource setting", async () => {
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });

    fireEvent.click(screen.getByText("Budget policy and resource limits"));
    expect(screen.getByLabelText("Token budget")).toBeTruthy();
    expect(screen.getByLabelText("Budget stop mode")).toBeTruthy();
    expect(screen.getByLabelText("Budget warning threshold")).toBeTruthy();
    expect(screen.getByLabelText("Provider concurrency caps")).toBeTruthy();
    for (const label of [
      "PTY slots",
      "Transport host slots",
      "Verifier slots",
      "Git operation slots",
      "Merge operation slots",
      "Worktrees per repository",
      "Fleet disk limit",
      "Output rate limit",
      "Artifact rate limit",
      "Artifact total limit",
      "Event byte rate limit",
      "Event fanout rate limit",
      "Event total limit",
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByLabelText("Fleet cleanup policy")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Fleet run name"), {
      target: { value: "Resource-bound run" },
    });
    fireEvent.change(screen.getByLabelText("Fleet run goal"), {
      target: { value: "Exercise exact draft controls" },
    });
    fireEvent.click(screen.getByLabelText("Plan automatically"));
    fireEvent.change(screen.getByLabelText("Budget USD"), {
      target: { value: "25" },
    });
    fireEvent.change(screen.getByLabelText("Token budget"), {
      target: { value: "250000" },
    });
    fireEvent.change(screen.getByLabelText("Budget warning threshold"), {
      target: { value: "75" },
    });
    fireEvent.change(screen.getByLabelText("Retries per task"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Provider concurrency caps"), {
      target: { value: "claude=2, hermes=3" },
    });
    fireEvent.change(screen.getByLabelText("Verifier slots"), {
      target: { value: "3" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(state.createMutation).toHaveBeenCalled());
    expect(state.createMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Resource-bound run",
        goal: "Exercise exact draft controls",
        budgetUsd: 25,
        budgetTokens: 250_000,
        budgetStopMode: "pause-new",
        budgetWarningThreshold: 0.75,
        providerCaps: { claude: 2, hermes: 3 },
        maxRetriesPerTask: 4,
        resourceLimits: expect.objectContaining({
          verifier: 3,
          providerCaps: { claude: 2, hermes: 3 },
          eventBytesPerMinute: expect.any(Number),
          eventFanoutPerMinute: expect.any(Number),
          eventBytesTotal: expect.any(Number),
        }),
        automationPolicy: expect.objectContaining({
          cleanupPolicy: "preserve",
        }),
      })
    );
  });

  it("validates planner, automatic-fix, and retention bounds before creation", async () => {
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    fireEvent.change(screen.getByLabelText("Fleet run name"), {
      target: { value: "Bounded automation" },
    });
    fireEvent.change(screen.getByLabelText("Fleet run goal"), {
      target: { value: "Reject invalid client settings" },
    });
    fireEvent.click(screen.getByLabelText("Repository"));
    fireEvent.click(await screen.findByText("acme/stoa"));
    fireEvent.click(
      screen.getByLabelText("Allow unconfined unattended agents")
    );

    fireEvent.change(screen.getByLabelText("Planner task cap"), {
      target: { value: "41" },
    });
    expect(
      screen.getByText("Planner task cap must be an integer from 1 to 40.")
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Create and plan",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Planner task cap"), {
      target: { value: "8" },
    });

    fireEvent.click(screen.getByLabelText("Approve plans automatically"));
    fireEvent.click(screen.getByLabelText("Start approved work automatically"));
    fireEvent.click(screen.getByLabelText("Fix review findings automatically"));
    fireEvent.change(screen.getByLabelText("Maximum automatic fix rounds"), {
      target: { value: "0" },
    });
    expect(
      screen.getByText("Automatic fix rounds must be an integer from 1 to 20.")
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Create autonomous run",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Maximum automatic fix rounds"), {
      target: { value: "2" },
    });

    fireEvent.change(screen.getByLabelText("Fleet artifact retention days"), {
      target: { value: "0" },
    });
    expect(
      screen.getByText(
        "Artifact retention must be an integer from 1 to 3650 days."
      )
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Create autonomous run",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Fleet artifact retention days"), {
      target: { value: "30" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Create autonomous run",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("allows an auto-plan-only run to grant unattended-agent consent", async () => {
    render(<FleetManagementView />);
    const consent = await screen.findByLabelText(
      "Allow unconfined unattended agents"
    );
    expect(
      (screen.getByLabelText("Plan automatically") as HTMLInputElement).checked
    ).toBe(true);
    expect(
      (
        screen.getByLabelText(
          "Start approved work automatically"
        ) as HTMLInputElement
      ).checked
    ).toBe(false);
    expect((consent as HTMLInputElement).checked).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Create and plan",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      screen.getByText(/Grant unattended-agent consent above/)
    ).toBeTruthy();

    fireEvent.click(consent);
    fireEvent.click(screen.getByLabelText("Approve plans automatically"));
    fireEvent.click(screen.getByLabelText("Start approved work automatically"));
    fireEvent.click(screen.getByLabelText("Start approved work automatically"));
    fireEvent.click(screen.getByLabelText("Approve plans automatically"));
    expect((consent as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByLabelText("Fleet run name"), {
      target: { value: "Planner-only run" },
    });
    fireEvent.change(screen.getByLabelText("Fleet run goal"), {
      target: { value: "Generate a safe plan and wait" },
    });
    fireEvent.click(screen.getByLabelText("Repository"));
    fireEvent.click(await screen.findByText("acme/stoa"));
    expect(
      (
        screen.getByRole("button", {
          name: "Create and plan",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create and plan" }));

    await waitFor(() => expect(state.createMutation).toHaveBeenCalled());
    expect(state.createMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Planner-only run",
        goal: "Generate a safe plan and wait",
        repoId: "repo-1",
        automationPolicy: expect.objectContaining({
          automaticPlanning: true,
          automaticPlanApproval: false,
          automaticStart: false,
          allowUnconfinedAgents: true,
        }),
      })
    );
  });

  it("retains consent when switching a target-bound run to manual planning", async () => {
    render(<FleetManagementView />);
    const consent = await screen.findByLabelText(
      "Allow unconfined unattended agents"
    );
    fireEvent.click(consent);
    fireEvent.click(screen.getByLabelText("Plan automatically"));
    fireEvent.click(screen.getByLabelText("Repository"));
    fireEvent.click(await screen.findByText("acme/stoa"));

    expect(
      (
        screen.getByLabelText(
          "Allow unconfined unattended agents"
        ) as HTMLInputElement
      ).checked
    ).toBe(true);
  });

  it("requires consent for a target-bound imported manual plan", async () => {
    render(<FleetManagementView />);
    fireEvent.click(await screen.findByLabelText("Fleet input mode"));
    fireEvent.click(await screen.findByText(/Existing Markdown task plan/));
    fireEvent.click(screen.getByLabelText("Review policy"));
    fireEvent.click(
      screen.getByRole("option", {
        name: "Manual plan approval + four task reviews",
      })
    );
    fireEvent.click(screen.getByLabelText("Repository"));
    fireEvent.click(await screen.findByText("acme/stoa"));

    expect(
      screen.getByLabelText("Allow unconfined unattended agents")
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Manual approval does not make Fleet workers interactive/
      )
    ).toBeTruthy();
  });

  it("explains imported-plan critic consent before either approval mode", async () => {
    render(<FleetManagementView />);
    fireEvent.click(await screen.findByLabelText("Fleet input mode"));
    fireEvent.click(
      await screen.findByText("Existing Markdown task plan — import")
    );
    expect(
      screen.getByLabelText("Allow unconfined unattended agents")
    ).toBeTruthy();
    expect(
      screen.getByText(/Imported plans skip the planner session/).textContent
    ).toContain("before either manual or automatic approval");
    expect(
      (screen.getByLabelText("Approve plans automatically") as HTMLInputElement)
        .checked
    ).toBe(false);
    expect(
      (
        screen.getByLabelText(
          "Start approved work automatically"
        ) as HTMLInputElement
      ).checked
    ).toBe(false);
  });

  it("does not erase exact approval-control edits on polling refreshes", async () => {
    state.approvalPreview!.run.pauseReason = "budget_exhausted";
    const view = render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    const concurrency = screen.getByLabelText(
      "Approved Fleet concurrency"
    ) as HTMLInputElement;
    const usd = screen.getByLabelText(
      "Approved Fleet USD budget"
    ) as HTMLInputElement;
    const tokens = screen.getByLabelText(
      "Approved Fleet token budget"
    ) as HTMLInputElement;
    const hardStop = screen.getByLabelText(
      "Override exact budget hard stop"
    ) as HTMLInputElement;
    fireEvent.change(concurrency, { target: { value: "9" } });
    fireEvent.change(usd, { target: { value: "20" } });
    fireEvent.change(tokens, { target: { value: "200000" } });
    fireEvent.click(hardStop);

    state.approvalPreview = {
      ...state.approvalPreview!,
      bindings: {
        ...state.approvalPreview!.bindings,
        runUpdatedAt: "2026-08-01T10:01:00.000Z",
      },
    };
    view.rerender(<FleetManagementView />);
    expect(concurrency.value).toBe("9");
    expect(usd.value).toBe("20");
    expect(tokens.value).toBe("200000");
    expect(hardStop.checked).toBe(true);

    state.approvalPreview = {
      ...state.approvalPreview!,
      run: { ...state.approvalPreview!.run, maxConcurrency: 7, budgetUsd: 30 },
    };
    view.rerender(<FleetManagementView />);
    await waitFor(() => expect(concurrency.value).toBe("7"));
    expect(usd.value).toBe("30");
  });

  it("explains that active planner sessions are intentionally hidden", async () => {
    state.detail!.run.plannerState = "running";
    state.detail!.run.plannerSessionId = "planner-internal-session";
    state.detail!.run.plannerProvider = "codex";

    render(<FleetManagementView />);
    expect(
      await screen.findByText(/intentionally hidden from Sessions/)
    ).toBeTruthy();
    expect(screen.queryByText(/Open it from Sessions/)).toBeNull();
  });

  it("shows the exact configured base branch for a selected repository", async () => {
    render(<FleetManagementView />);
    const trigger = await screen.findByLabelText("Repository");
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("acme/stoa"));
    expect(screen.getByLabelText("Fleet base branch").textContent).toContain(
      "release/main"
    );
  });

  it("keeps artifact bodies out of the DOM until exactly one is expanded", async () => {
    render(<FleetManagementView />);
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    const body = '{"files":["src/fleet.ts"]}';
    expect(screen.queryByText(body)).toBeNull();
    expect(state.artifactBodyHook).toHaveBeenLastCalledWith(
      "run-1",
      null,
      false
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Load artifact body: Authoritative worker Git state",
      })
    );
    expect(screen.getAllByText(body)).toHaveLength(1);
    expect(state.artifactBodyHook).toHaveBeenLastCalledWith(
      "run-1",
      "diff-1",
      true
    );

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect exact diff" }));
    expect(screen.getAllByText(body)).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "Load artifact body: Authoritative worker Git state",
      })
    ).toBeTruthy();
  });

  it("distinguishes every documented attention category", async () => {
    const detail = state.detail!;
    detail.run.approvalState = "needs_approval";
    detail.run.budgetWarningEmittedAt = "2026-08-01T09:50:00.000Z";
    detail.run.integrationError = "exact CI head moved";
    const failed = detail.tasks.find(
      (candidate) => candidate.id === "task-failed"
    )!;
    failed.verificationStatus = "fail";
    const blocked = detail.tasks.find(
      (candidate) => candidate.id === "task-blocked"
    )!;
    blocked.reviewStatus = "changes_requested";
    const routine = detail.tasks.find(
      (candidate) => candidate.id === "task-routine"
    )!;
    routine.actualFileClaims = ["src/unplanned.ts"];

    render(<FleetManagementView />);
    const queue = await screen.findByTestId("attention-items");
    for (const category of [
      "Approval required",
      "Secret / security",
      "Failed verification",
      "Blocking review",
      "Claim drift",
      "Budget",
      "Recovery",
      "Merge",
    ]) {
      expect(within(queue).getAllByText(category).length).toBeGreaterThan(0);
    }
  });

  it("accepts an exact Fleet Board run/task handoff on mobile", async () => {
    render(
      <FleetManagementView
        initialRunId="run-1"
        initialTaskId="task-blocked"
        selectionKey="selection-1"
      />
    );
    await screen.findByRole("heading", { name: "Autonomous delivery" });
    const nav = screen.getByRole("navigation", { name: "Fleet run sections" });
    await waitFor(() =>
      expect(
        within(nav)
          .getByRole("button", { name: "Tasks" })
          .getAttribute("aria-selected")
      ).toBe("true")
    );
    const selected = document.querySelector<HTMLElement>(
      '[data-fleet-task-id="task-blocked"]'
    );
    expect(selected?.className).toContain("ring-primary/20");
  });
});
