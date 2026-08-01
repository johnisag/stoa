import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import type { Project } from "@/lib/db/types";
import type { DispatchRepo } from "@/lib/dispatch/types";
import { expandHome } from "@/lib/platform";
import type {
  FleetIntegrationState,
  FleetMergeOperationRow,
  FleetMergeOperationType,
  FleetMergeTarget,
  FleetRunRow,
  FleetTaskRow,
} from "./types";

const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const TERMINAL_SUCCESS_STATUSES = new Set(["merged", "completed", "skipped"]);

export const FLEET_MERGE_REVIEW_LENSES = [
  "correctness_security",
  "conventions_cross_platform",
  "simplicity_ux",
  "adversarial_red_team",
] as const;

export interface FleetMergeRunRow extends FleetRunRow {
  merge_requested_at: string | null;
  merge_requested_by: string | null;
  merge_request_kind: "manual" | "automatic" | null;
  merge_target: FleetMergeTarget | null;
  integration_state: FleetIntegrationState;
  integration_branch: string | null;
  integration_worktree: string | null;
  integration_base_sha: string | null;
  integration_head_sha: string | null;
  integration_pr_number: number | null;
  integration_pr_url: string | null;
  integration_pr_head_sha: string | null;
  integration_merge_sha: string | null;
  integration_error: string | null;
}

export interface FleetMergeTargetInfo {
  repoPath: string;
  repoSlug: string | null;
  baseBranch: string;
}

export interface FleetMergeReadiness {
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
}

export interface FleetMergeStatus {
  readiness: FleetMergeReadiness;
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
    type: FleetMergeOperationType;
    state: string;
    expectedBaseSha: string;
    expectedTaskHeadSha: string | null;
    resultHeadSha: string | null;
    attemptCount: number;
    error: string | null;
    updatedAt: string;
  }>;
}

function validSha(value: string | null | undefined): value is string {
  return typeof value === "string" && FULL_GIT_SHA.test(value);
}

function parseJsonObject(
  value: string | null | undefined
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function approvedExecutionHash(run: FleetRunRow): string | null {
  const value = parseJsonObject(run.settings_json).approvedExecutionHash;
  return typeof value === "string" && value ? value : null;
}

export function resolveFleetMergeTarget(
  db: Database.Database,
  run: FleetRunRow,
  tasks: FleetTaskRow[]
): FleetMergeTargetInfo | null {
  if (run.repo_id) {
    const repo = queries.getDispatchRepo(db).get(run.repo_id) as
      DispatchRepo | undefined;
    if (!repo?.repo_path) return null;
    return {
      repoPath: expandHome(repo.repo_path),
      repoSlug: repo.repo_slug || null,
      baseBranch: repo.base_branch || tasks[0]?.base_branch || "main",
    };
  }
  if (run.project_id) {
    const project = queries.getProject(db).get(run.project_id) as
      Project | undefined;
    if (!project?.working_directory) return null;
    return {
      repoPath: expandHome(project.working_directory),
      repoSlug: null,
      baseBranch: tasks[0]?.base_branch || "main",
    };
  }
  const cwd = tasks.find((task) => task.working_directory)?.working_directory;
  return cwd
    ? {
        repoPath: expandHome(cwd),
        repoSlug: null,
        baseBranch: tasks[0]?.base_branch || "main",
      }
    : null;
}

function exactReviewGate(
  db: Database.Database,
  run: FleetRunRow,
  task: FleetTaskRow
): string | null {
  if (!validSha(task.head_sha)) return "task head SHA is missing or invalid";
  if (
    task.verification_status !== "pass" ||
    task.verified_head_sha !== task.head_sha ||
    !task.verification_id ||
    !task.review_verification_hash
  ) {
    return "task verification is not an exact-head pass";
  }
  if (
    task.review_status !== "clean" ||
    task.review_head_sha !== task.head_sha
  ) {
    return "task review pointer is not clean for the exact head";
  }
  if (!run.automation_policy_hash) return "automation policy hash is missing";
  const verification = db
    .prepare(
      `SELECT id FROM fleet_verifications
       WHERE id = ? AND task_id = ? AND attempt = ? AND head_sha = ?
         AND status = 'pass' AND output_hash IS NOT NULL`
    )
    .get(
      task.verification_id,
      task.id,
      task.current_attempt ?? 0,
      task.head_sha
    );
  if (!verification) return "exact verification evidence is missing";
  const reviews = db
    .prepare(
      `SELECT lens, reviewer_session_id FROM fleet_task_reviews
       WHERE task_id = ? AND attempt = ? AND head_sha = ?
         AND verification_id = ? AND verification_evidence_hash = ?
         AND policy_hash = ? AND state = 'clean' AND verdict = 'clean'`
    )
    .all(
      task.id,
      task.current_attempt ?? 0,
      task.head_sha,
      task.verification_id,
      task.review_verification_hash,
      run.automation_policy_hash
    ) as { lens: string; reviewer_session_id: string }[];
  const reviewers = new Map<string, string>();
  for (const review of reviews) {
    if (
      FLEET_MERGE_REVIEW_LENSES.includes(
        review.lens as (typeof FLEET_MERGE_REVIEW_LENSES)[number]
      ) &&
      review.reviewer_session_id
    ) {
      reviewers.set(review.lens, review.reviewer_session_id);
    }
  }
  if (
    !FLEET_MERGE_REVIEW_LENSES.every((lens) => reviewers.has(lens)) ||
    new Set(reviewers.values()).size !== FLEET_MERGE_REVIEW_LENSES.length
  ) {
    return "four independent clean exact-head reviews are required";
  }
  return null;
}

function evidenceGate(
  db: Database.Database,
  task: FleetTaskRow
): string | null {
  if (task.failure_code)
    return `task has unresolved failure: ${task.failure_code}`;
  const blocker = db
    .prepare(
      `SELECT id FROM fleet_artifacts
       WHERE task_id = ? AND severity = 'blocker' AND head_sha = ? LIMIT 1`
    )
    .get(task.id, task.head_sha ?? "");
  if (blocker) return "task has unresolved blocker findings";
  const worker = db
    .prepare(
      `SELECT * FROM fleet_workers
       WHERE task_id = ? AND attempt = ?
       ORDER BY report_collected_at DESC, created_at DESC, id DESC LIMIT 1`
    )
    .get(task.id, task.current_attempt ?? 0) as
    | {
        report_state: string;
        report_status: string | null;
        head_sha: string | null;
      }
    | undefined;
  if (
    !worker ||
    worker.report_state !== "accepted" ||
    worker.report_status !== "succeeded" ||
    worker.head_sha !== task.head_sha
  ) {
    return "accepted successful exact-head worker evidence is missing";
  }
  if (!task.report_artifact_id) return "worker report artifact is missing";
  const report = db
    .prepare(`SELECT body FROM fleet_artifacts WHERE id = ? AND task_id = ?`)
    .get(task.report_artifact_id, task.id) as { body: string } | undefined;
  const followUps = report
    ? parseJsonObject(report.body).followUps
    : ["missing report artifact"];
  if (!Array.isArray(followUps) || followUps.length > 0) {
    return "worker report has unresolved follow-up questions";
  }
  if (!task.diff_artifact_id) return "authoritative Git artifact is missing";
  const diff = db
    .prepare(
      `SELECT metadata_json FROM fleet_artifacts WHERE id = ? AND task_id = ?`
    )
    .get(task.diff_artifact_id, task.id) as
    { metadata_json: string } | undefined;
  const drift = diff
    ? parseJsonObject(diff.metadata_json).claimDrift
    : { hasDrift: true };
  if (
    drift &&
    typeof drift === "object" &&
    (drift as { hasDrift?: unknown }).hasDrift !== false
  ) {
    return "authoritative Git evidence has unresolved claim drift";
  }
  return null;
}

function blockingDependencies(
  db: Database.Database,
  runId: string,
  taskId: string
): { id: string; status: string }[] {
  return db
    .prepare(
      `SELECT upstream.id, upstream.status
       FROM fleet_task_dependencies dependency
       JOIN fleet_tasks upstream ON upstream.id = dependency.depends_on_task_id
       WHERE dependency.fleet_run_id = ? AND dependency.task_id = ?
         AND dependency.dependency_type = 'blocks'`
    )
    .all(runId, taskId) as { id: string; status: string }[];
}

export function inspectFleetMergeReadiness(
  db: Database.Database,
  runId: string
): FleetMergeReadiness | null {
  const run = queries.getFleetRun(db).get(runId) as
    FleetMergeRunRow | undefined;
  if (!run) return null;
  const tasks = queries.listFleetTasksForRun(db).all(runId) as FleetTaskRow[];
  const readyTaskIds: string[] = [];
  const waitingTaskIds: string[] = [];
  const mergedTaskIds: string[] = [];
  const blockers: string[] = [];
  if (
    run.approval_state !== "approved" ||
    !run.plan_hash ||
    run.approved_plan_hash !== run.plan_hash
  ) {
    blockers.push("run does not have an exact approved plan");
  }
  if (!validSha(run.automation_base_sha)) {
    blockers.push("run base commit is not durably bound");
  }
  if (!resolveFleetMergeTarget(db, run, tasks)) {
    blockers.push("run has no source repository checkout");
  }
  for (const task of tasks) {
    if (task.status === "merged") {
      mergedTaskIds.push(task.id);
      continue;
    }
    if (["completed", "skipped"].includes(task.status)) continue;
    if (task.status !== "ready_to_merge") {
      waitingTaskIds.push(task.id);
      if (
        ["failed", "canceled", "needs_inspection", "needs_followup"].includes(
          task.status
        )
      ) {
        blockers.push(
          `${task.id}: task requires operator resolution (${task.status})`
        );
      }
      continue;
    }
    const dependencies = blockingDependencies(db, runId, task.id);
    if (
      dependencies.some(
        (dependency) => !TERMINAL_SUCCESS_STATUSES.has(dependency.status)
      )
    ) {
      waitingTaskIds.push(task.id);
      continue;
    }
    const reason = exactReviewGate(db, run, task) ?? evidenceGate(db, task);
    if (reason) {
      waitingTaskIds.push(task.id);
      blockers.push(`${task.id}: ${reason}`);
      continue;
    }
    readyTaskIds.push(task.id);
  }
  const allTasksIntegrated = tasks.every((task) =>
    TERMINAL_SUCCESS_STATUSES.has(task.status)
  );
  return {
    runId,
    requested: !!run.merge_requested_at,
    target: run.merge_target,
    integrationState: run.integration_state ?? "idle",
    readyTaskIds,
    waitingTaskIds,
    mergedTaskIds,
    blockers,
    allTasksIntegrated,
    canFinalize: allTasksIntegrated && blockers.length === 0,
  };
}

export function getFleetMergeStatus(
  runId: string,
  db: Database.Database = getDb()
): FleetMergeStatus | null {
  const run = queries.getFleetRun(db).get(runId) as
    FleetMergeRunRow | undefined;
  const readiness = inspectFleetMergeReadiness(db, runId);
  if (!run || !readiness) return null;
  const operations = db
    .prepare(
      `SELECT * FROM fleet_merge_operations
       WHERE fleet_run_id = ? ORDER BY created_at ASC, id ASC LIMIT 200`
    )
    .all(runId) as FleetMergeOperationRow[];
  return {
    readiness,
    integration: {
      state: run.integration_state ?? "idle",
      target: run.merge_target,
      requestedAt: run.merge_requested_at,
      requestedBy: run.merge_requested_by,
      requestKind: run.merge_request_kind,
      branch: run.integration_branch,
      worktree: run.integration_worktree,
      baseSha: run.integration_base_sha,
      headSha: run.integration_head_sha,
      prNumber: run.integration_pr_number,
      prUrl: run.integration_pr_url,
      prHeadSha: run.integration_pr_head_sha,
      mergeSha: run.integration_merge_sha,
      error: run.integration_error,
    },
    operations: operations.map((operation) => ({
      id: operation.id,
      taskId: operation.task_id,
      type: operation.operation_type,
      state: operation.state,
      expectedBaseSha: operation.expected_base_sha,
      expectedTaskHeadSha: operation.expected_task_head_sha,
      resultHeadSha: operation.result_head_sha,
      attemptCount: operation.attempt_count,
      error: operation.error,
      updatedAt: operation.updated_at,
    })),
  };
}
