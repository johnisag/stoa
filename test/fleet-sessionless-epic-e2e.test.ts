import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as path from "path";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => state.db,
    get db() {
      return state.db;
    },
  };
});

vi.mock("@/lib/git-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git-status")>();
  return {
    ...actual,
    getDefaultBranch: () => "main",
    isGitRepo: () => true,
    resolveGitCommit: () => "a".repeat(40),
  };
});

import { queries } from "@/lib/db";
import { generateBranchName } from "@/lib/git";
import {
  FLEET_PLAN_REVIEW_LENSES,
  reconcileFleetAutomation,
} from "@/lib/fleet/automation";
import type { FleetGitState } from "@/lib/fleet/git-state";
import {
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "@/lib/fleet/hash";
import { fleetIntegrationIdentity } from "@/lib/fleet/merge-contract";
import { approvedExecutionHash } from "@/lib/fleet/merge-readiness";
import { reconcileFleetMerges } from "@/lib/fleet/merge-runtime";
import type { FleetPlanReviewContract } from "@/lib/fleet/plan-review";
import type {
  FleetWorkerReportCollectionInput,
  FleetWorkerReportCollectionResult,
} from "@/lib/fleet/report-runtime";
import { hashFleetReportNonce } from "@/lib/fleet/report";
import {
  reconcileFleetRun,
  reconcileFleetWorkerReport,
  recoverFleetRuns,
  type FleetSchedulerDeps,
} from "@/lib/fleet/scheduler";
import {
  createDraftFleetRun,
  getFleetRunDetail,
  ingestGeneratedFleetRunPlan,
} from "@/lib/fleet/service";
import { startFleetPlanner } from "@/lib/fleet/planner";
import {
  reconcileFleetTaskReviews,
  type FleetTaskReviewDeps,
} from "@/lib/fleet/task-review";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskReviewRow,
  FleetTaskRow,
  FleetWorkerRow,
} from "@/lib/fleet/types";
import {
  reconcileFleetVerifications,
  type FleetVerificationDeps,
} from "@/lib/fleet/verification";

const BASE_SHA = "a".repeat(40);
const TASK_HEAD_SHA = "b".repeat(40);
const INTEGRATION_HEAD_SHA = "c".repeat(40);
const FIXED_HEAD_SHA = "d".repeat(40);
const REPORT_NONCE = "n".repeat(43);
const NOW = new Date("2026-08-01T12:00:00.000Z");
const PROJECT_PATH = path.resolve("fleet-sessionless-e2e-repo");
const TASK_PATH = "src/epic-feature.ts";

let db: InstanceType<typeof Database>;

function renderedGitState(input: {
  root: string;
  baseSha: string;
  headSha: string;
  branch: string;
  changedPath?: string;
}): FleetGitState {
  const committedChanges = input.changedPath
    ? [
        {
          kind: "modified" as const,
          path: input.changedPath,
          previousPath: null,
          status: "M",
          insertions: 4,
          deletions: 1,
          binary: false,
        },
      ]
    : [];
  return {
    repositoryRoot: input.root,
    baseSha: input.baseSha,
    headSha: input.headSha,
    currentBranch: input.branch,
    committedChanges,
    committedPaths: input.changedPath ? [input.changedPath] : [],
    stagedChanges: [],
    unstagedChanges: [],
    dirtyTrackedPaths: [],
    untrackedPaths: [],
    allTouchedPaths: input.changedPath ? [input.changedPath] : [],
    sensitivePaths: [],
    summary: {
      committedFiles: committedChanges.length,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      insertions: input.changedPath ? 4 : 0,
      deletions: input.changedPath ? 1 : 0,
      binaryFiles: 0,
      renamedFiles: 0,
      touchedPathSample: input.changedPath ? [input.changedPath] : [],
      touchedPathsTruncated: false,
    },
  };
}

function insertSession(input: {
  id: string;
  worktree: string;
  branch: string;
}): void {
  db.prepare(
    `INSERT INTO sessions
     (id, name, tmux_name, status, worker_status, working_directory, model,
      group_path, agent_type, branch_name, worktree_path)
     VALUES (?, ?, ?, 'running', 'working', ?, 'test-model', 'sessions',
      'codex', ?, ?)`
  ).run(
    input.id,
    input.id,
    `codex-${input.id}`,
    PROJECT_PATH,
    input.branch,
    input.worktree
  );
}

function reportCollection(
  input: FleetWorkerReportCollectionInput,
  branch: string,
  task: { headSha: string; path: string } = {
    headSha: TASK_HEAD_SHA,
    path: TASK_PATH,
  }
): FleetWorkerReportCollectionResult {
  const report = {
    schemaVersion: 1 as const,
    runId: input.expected.runId,
    taskId: input.expected.taskId,
    workerId: input.expected.workerId,
    attempt: input.expected.attempt,
    spawnRequestId: input.expected.spawnRequestId,
    nonce: REPORT_NONCE,
    baseSha: input.expected.baseSha,
    headSha: task.headSha,
    submittedAt: NOW.toISOString(),
    status: "succeeded" as const,
    summary: "Implemented the project specification.",
    filesChanged: [task.path],
    verification: [],
    risks: [],
    followUps: [],
    mergeReadiness: "ready" as const,
    markdown: "",
  };
  const gitState = renderedGitState({
    root: PROJECT_PATH,
    baseSha: input.expected.baseSha,
    headSha: task.headSha,
    branch,
    changedPath: task.path,
  });
  return {
    kind: "collected",
    report,
    gitState,
    claimDrift: {
      normalizedClaims: [task.path],
      actualPaths: [task.path],
      coveredPaths: [task.path],
      driftPaths: [],
      invalidClaims: [],
      invalidActualPaths: [],
      sensitivePaths: [],
      unknownClaim: false,
      hasDrift: false,
    },
    taskStatus: "verifying",
    failureCode: null,
    reportBytes: Buffer.byteLength(JSON.stringify(report)),
  };
}

function taskReviewRuntime(input: {
  runId: string;
  taskId: string;
  taskWorktree: string;
  taskBranch: string;
  taskHeadSha?: string;
  firstHeadBlocker?: boolean;
  fixedHeadSha?: string;
  idPrefix?: string;
}) {
  let serial = 0;
  const spawnFix = vi.fn(
    async (request: Parameters<FleetTaskReviewDeps["spawnFix"]>[0]) => {
      if (!input.fixedHeadSha) {
        throw new Error(
          "a clean E2E review must not launch an automatic fixer"
        );
      }
      const sessionId = `task-fix-session-${input.taskId}`;
      db.prepare(
        `INSERT INTO sessions
         (id, name, tmux_name, agent_type, model, status, working_directory,
          worker_task, worker_status, branch_name, worktree_path, created_at,
          updated_at)
         VALUES (?, 'automatic fixer', ?, 'codex', '', 'running', ?, ?,
           'working', ?, ?, ?, ?)`
      ).run(
        sessionId,
        `codex-${sessionId}`,
        input.taskWorktree,
        request.persistedPrompt,
        input.taskBranch,
        input.taskWorktree,
        NOW.toISOString(),
        NOW.toISOString()
      );
      return { id: sessionId };
    }
  );
  const spawnReview = vi.fn(
    async (request: Parameters<FleetTaskReviewDeps["spawnReview"]>[0]) => {
      expect(request.contract.candidate.conductor_session_id).toBeNull();
      const reviewedHead =
        request.contract.candidate.task_head_sha ?? TASK_HEAD_SHA;
      const headLabel = reviewedHead.slice(0, 8);
      return {
        id: `task-review-session-${input.taskId}-${headLabel}-${request.lens}`,
        worktree_path: path.join(
          PROJECT_PATH,
          ".stoa-review-worktrees",
          input.taskId,
          headLabel,
          request.lens
        ),
        branch_name: generateBranchName(request.branchFeature),
      };
    }
  );
  const deps: Partial<FleetTaskReviewDeps> = {
    db,
    now: () => NOW,
    randomId: () =>
      `${input.idPrefix ?? "task-review-runtime"}-${input.taskId}-${++serial}`,
    randomNonce: () => "one-use-e2e-review-nonce",
    installedProviders: () => ["codex"],
    prepareResultPath: async ({ kind, requestId }) =>
      path.join(PROJECT_PATH, "fleet-task-runtime", kind, `${requestId}.json`),
    readResult: async (resultPath) => {
      const fix = db
        .prepare(`SELECT * FROM fleet_task_fixes WHERE result_path = ?`)
        .get(resultPath) as
        | {
            fleet_run_id: string;
            task_id: string;
            attempt: number;
            round: number;
            old_head_sha: string;
            verification_evidence_hash: string;
            policy_hash: string;
          }
        | undefined;
      if (fix) {
        if (!input.fixedHeadSha) {
          return { ok: false as const, error: "unexpected automatic fix" };
        }
        const text = JSON.stringify({
          schemaVersion: 1,
          nonce: "one-use-e2e-review-nonce",
          runId: fix.fleet_run_id,
          taskId: fix.task_id,
          attempt: fix.attempt,
          round: fix.round,
          oldHeadSha: fix.old_head_sha,
          verificationEvidenceHash: fix.verification_evidence_hash,
          policyHash: fix.policy_hash,
          newHeadSha: input.fixedHeadSha,
          summary: "Committed the scoped correction requested by review.",
        });
        return { ok: true as const, text, bytes: Buffer.byteLength(text) };
      }
      const row = db
        .prepare(`SELECT * FROM fleet_task_reviews WHERE result_path = ?`)
        .get(resultPath) as FleetTaskReviewRow | undefined;
      if (!row) return { ok: false as const, error: "missing review row" };
      const changesRequested =
        input.firstHeadBlocker === true &&
        row.head_sha === (input.taskHeadSha ?? TASK_HEAD_SHA) &&
        row.lens === "correctness_security";
      const text = JSON.stringify({
        schemaVersion: 1,
        nonce: "one-use-e2e-review-nonce",
        runId: row.fleet_run_id,
        taskId: row.task_id,
        workerId: row.worker_id,
        attempt: row.attempt,
        baseSha: row.base_sha,
        headSha: row.head_sha,
        verificationId: row.verification_id,
        verificationSpecHash: row.verification_spec_hash,
        verificationEvidenceHash: row.verification_evidence_hash,
        policyHash: row.policy_hash,
        lens: row.lens,
        verdict: changesRequested ? "changes_requested" : "clean",
        findings: changesRequested
          ? [
              {
                severity: "blocker",
                title: "Uncovered epic edge case",
                body: "Correct the exact-head regression before merge.",
              },
            ]
          : [],
      });
      return { ok: true as const, text, bytes: Buffer.byteLength(text) };
    },
    removeResult: async () => true,
    sessionExists: async () => true,
    stopSession: async () => true,
    removeWorktree: async () => undefined,
    collectGitState: async (options) => {
      const row = db
        .prepare(
          `SELECT * FROM fleet_task_reviews WHERE reviewer_worktree_path = ?`
        )
        .get(options.cwd) as FleetTaskReviewRow | undefined;
      const expectedHead =
        options.expectedHeadSha ?? input.taskHeadSha ?? TASK_HEAD_SHA;
      return renderedGitState({
        root: PROJECT_PATH,
        baseSha: options.baseSha,
        headSha: row?.head_sha ?? expectedHead,
        branch: row?.reviewer_branch_name ?? input.taskBranch,
        changedPath: row ? undefined : TASK_PATH,
      });
    },
    git: async (_cwd, args) => ({
      stdout:
        args[0] === "merge-base"
          ? `${args[1]}\n`
          : args[0] === "rev-list"
            ? "1\n"
            : "",
      stderr: "",
    }),
    spawnReview,
    spawnFix,
  };
  return { deps, spawnReview, spawnFix };
}

function mergeRuntime(
  runId: string,
  taskWorktree: string,
  taskBranch: string,
  taskHeadSha = TASK_HEAD_SHA
) {
  const integration = fleetIntegrationIdentity(runId);
  const heads = new Map<string, string>([
    [PROJECT_PATH, BASE_SHA],
    [taskWorktree, taskHeadSha],
  ]);
  const branches = new Map<string, string>([
    [PROJECT_PATH, "main"],
    [taskWorktree, taskBranch],
  ]);
  const existingPaths = new Set([PROJECT_PATH, taskWorktree]);
  const verify = vi.fn(async () => ({
    status: "pass" as const,
    output: "all checks passed",
  }));
  let serial = 0;
  let integrationBranchDeleted = false;

  const git = async (cwd: string, args: string[]) => {
    if (args[0] === "rev-parse") {
      const rawRef = args.at(-1) ?? "HEAD";
      const ref = rawRef.replace(/\^\{commit\}$/, "");
      if (ref === integration.branch && !heads.has(integration.worktree)) {
        throw new Error("integration branch does not exist yet");
      }
      const value =
        ref === integration.branch
          ? heads.get(integration.worktree)
          : heads.get(cwd);
      if (!value) throw new Error(`unknown fake Git worktree: ${cwd}`);
      return { stdout: `${value}\n`, stderr: "" };
    }
    if (args[0] === "branch" && args[1] === "--show-current") {
      return { stdout: `${branches.get(cwd) ?? ""}\n`, stderr: "" };
    }
    if (args[0] === "status") return { stdout: "", stderr: "" };
    if (args[0] === "worktree" && args[1] === "add") {
      existingPaths.add(integration.worktree);
      heads.set(integration.worktree, BASE_SHA);
      branches.set(integration.worktree, integration.branch);
      integrationBranchDeleted = false;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "for-each-ref") {
      const head = heads.get(integration.worktree);
      return {
        stdout:
          !integrationBranchDeleted &&
          head &&
          args.at(-1)?.includes(integration.branch)
            ? `${head}\n`
            : "",
        stderr: "",
      };
    }
    if (args[0] === "branch" && args[1] === "-D") {
      integrationBranchDeleted = true;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge-base") {
      const ancestor = args[2];
      const descendant = args[3];
      const known =
        ancestor === descendant ||
        (ancestor === BASE_SHA &&
          [taskHeadSha, INTEGRATION_HEAD_SHA].includes(descendant)) ||
        (ancestor === taskHeadSha && descendant === INTEGRATION_HEAD_SHA);
      if (!known) throw new Error("not an ancestor");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--no-ff") {
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "-c" && args.includes("commit")) {
      heads.set(integration.worktree, INTEGRATION_HEAD_SHA);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--ff-only") {
      heads.set(cwd, args[2]);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--abort") {
      heads.set(cwd, BASE_SHA);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "reset") {
      heads.set(cwd, args[2]);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected fake Git call: ${cwd} ${args.join(" ")}`);
  };

  return {
    integration,
    verify,
    overrides: {
      db,
      now: () => NOW,
      id: () => `merge-operation-${++serial}`,
      leaseOwner: "sessionless-e2e-merge",
      git,
      verify,
      gh: async () => {
        throw new Error("local merge must not invoke GitHub CLI");
      },
      mergePullRequest: async () => {
        throw new Error("local merge must not invoke GitHub merge");
      },
      ensureDirectory: async () => undefined,
      pathExists: async (target: string) => existingPaths.has(target),
      removeWorktree: async (worktree: string) => {
        existingPaths.delete(worktree);
      },
    },
  };
}

interface MultiTaskFixture {
  taskId: string;
  path: string;
  headSha: string;
  baseSha: string;
  worktree: string;
  branch: string;
}

function multiTaskMergeRuntime(
  runId: string,
  fixtures: Map<string, MultiTaskFixture>
) {
  const integration = fleetIntegrationIdentity(runId);
  const integrationHeads = ["e".repeat(40), "f".repeat(40), "9".repeat(40)];
  const heads = new Map<string, string>([[PROJECT_PATH, BASE_SHA]]);
  const branches = new Map<string, string>([[PROJECT_PATH, "main"]]);
  const ancestors = new Map<string, Set<string>>([[BASE_SHA, new Set()]]);
  const existingPaths = new Set([PROJECT_PATH]);
  const removedWorktrees: string[] = [];
  const verify = vi.fn(async () => ({
    status: "pass" as const,
    output: "all exact integration checks passed",
  }));
  let serial = 0;
  let integrationCommit = 0;
  let pendingTaskHead: string | null = null;
  let integrationBranchDeleted = false;

  const recordCommit = (sha: string, parents: string[]) => {
    const inherited = new Set<string>();
    for (const parent of parents) {
      inherited.add(parent);
      for (const ancestor of ancestors.get(parent) ?? []) {
        inherited.add(ancestor);
      }
    }
    ancestors.set(sha, inherited);
  };

  const registerTask = (fixture: MultiTaskFixture) => {
    fixtures.set(fixture.taskId, fixture);
    heads.set(fixture.worktree, fixture.headSha);
    branches.set(fixture.worktree, fixture.branch);
    existingPaths.add(fixture.worktree);
    recordCommit(fixture.headSha, [fixture.baseSha]);
  };

  const git = async (cwd: string, args: string[]) => {
    if (args[0] === "rev-parse") {
      const rawRef = args.at(-1) ?? "HEAD";
      const ref = rawRef.replace(/\^\{commit\}$/, "");
      if (ref === integration.branch && !heads.has(integration.worktree)) {
        throw new Error("integration branch does not exist yet");
      }
      const value =
        ref === integration.branch
          ? heads.get(integration.worktree)
          : heads.get(cwd);
      if (!value) throw new Error(`unknown fake Git worktree: ${cwd}`);
      return { stdout: `${value}\n`, stderr: "" };
    }
    if (args[0] === "branch" && args[1] === "--show-current") {
      return { stdout: `${branches.get(cwd) ?? ""}\n`, stderr: "" };
    }
    if (args[0] === "status") return { stdout: "", stderr: "" };
    if (args[0] === "worktree" && args[1] === "add") {
      existingPaths.add(integration.worktree);
      heads.set(integration.worktree, BASE_SHA);
      branches.set(integration.worktree, integration.branch);
      integrationBranchDeleted = false;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "for-each-ref") {
      const head = heads.get(integration.worktree);
      return {
        stdout:
          !integrationBranchDeleted &&
          head &&
          args.at(-1)?.includes(integration.branch)
            ? `${head}\n`
            : "",
        stderr: "",
      };
    }
    if (args[0] === "branch" && args[1] === "-D") {
      integrationBranchDeleted = true;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge-base") {
      const ancestor = args[2];
      const descendant = args[3];
      if (
        !ancestor ||
        !descendant ||
        (ancestor !== descendant && !ancestors.get(descendant)?.has(ancestor))
      ) {
        throw new Error(`${ancestor ?? "missing"} is not an ancestor`);
      }
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--no-ff") {
      pendingTaskHead = args.at(-1) ?? null;
      if (!pendingTaskHead || !ancestors.has(pendingTaskHead)) {
        throw new Error("merge requested an unknown task head");
      }
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "-c" && args.includes("commit")) {
      const currentHead = heads.get(integration.worktree);
      const nextHead = integrationHeads[integrationCommit++];
      if (!currentHead || !pendingTaskHead || !nextHead) {
        throw new Error("unexpected integration commit");
      }
      recordCommit(nextHead, [currentHead, pendingTaskHead]);
      heads.set(integration.worktree, nextHead);
      pendingTaskHead = null;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--ff-only") {
      const nextHead = args[2];
      if (!nextHead) throw new Error("fast-forward target is missing");
      heads.set(cwd, nextHead);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--abort") {
      pendingTaskHead = null;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "reset") {
      const resetHead = args[2];
      if (!resetHead) throw new Error("reset target is missing");
      heads.set(cwd, resetHead);
      pendingTaskHead = null;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected fake Git call: ${cwd} ${args.join(" ")}`);
  };

  return {
    integration,
    integrationHeads,
    registerTask,
    verify,
    removedWorktrees,
    integrationPathExists: () => existingPaths.has(integration.worktree),
    integrationBranchExists: () => !integrationBranchDeleted,
    overrides: {
      db,
      now: () => NOW,
      id: () => `multi-merge-operation-${++serial}`,
      leaseOwner: "sessionless-multitask-e2e-merge",
      git,
      verify,
      gh: async () => {
        throw new Error("local merge must not invoke GitHub CLI");
      },
      mergePullRequest: async () => {
        throw new Error("local merge must not invoke GitHub merge");
      },
      ensureDirectory: async () => undefined,
      pathExists: async (target: string) => existingPaths.has(target),
      removeWorktree: async (worktree: string) => {
        removedWorktrees.push(worktree);
        existingPaths.delete(worktree);
      },
    },
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  createSchema(db);
  runMigrations(db);
  state.db = db;
  db.prepare(
    `INSERT INTO dispatch_repos
     (id, repo_path, repo_slug, agent_type, daily_quota, max_concurrency,
      base_branch, mode, enabled)
     VALUES ('e2e-repo', ?, 'owner/e2e', 'codex', 100, 8, 'main', 'auto', 1)`
  ).run(PROJECT_PATH);
});

afterEach(() => {
  db.close();
});

describe("Fleet sessionless epic-to-merge orchestration", () => {
  it("auto-plans, fixes a blocker, re-verifies, re-reviews, and merges without a conductor session", async () => {
    const created = createDraftFleetRun({
      name: "Sessionless project specification",
      goal: "Implement the complete project specification and merge it safely.",
      repoId: "e2e-repo",
      provider: "codex",
      reviewPolicy: "four_agent",
      automationPolicy: {
        automaticPlanning: true,
        automaticPlanApproval: true,
        automaticStart: true,
        automaticFixes: true,
        maxAutomaticFixRounds: 1,
        automaticMerge: true,
        mergeTarget: "local",
        allowUnconfinedAgents: true,
      },
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    expect(
      db
        .prepare(`SELECT conductor_session_id FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({ conductor_session_id: null });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({
      n: 0,
    });

    const startPlanner = vi.fn(
      async (
        id: string,
        _options: Parameters<typeof startFleetPlanner>[1],
        actor: Parameters<typeof startFleetPlanner>[2]
      ): Promise<Awaited<ReturnType<typeof startFleetPlanner>>> => {
        expect(actor).toBe("fleet-automation");
        return ingestGeneratedFleetRunPlan(id, {
          planText: "1. Implement the epic [files: src/epic-feature.ts]",
          tasks: [
            {
              title: "Implement the epic",
              description: "Deliver the complete high-level specification.",
              taskType: "implementation",
              parentIndex: null,
              sortOrder: 0,
              fileClaims: [TASK_PATH],
              agentType: "codex",
              model: null,
              acceptanceCriteria: "The project verification passes.",
              verifyCommand: "npm test",
              workingDirectory: PROJECT_PATH,
              baseBranch: "main",
            },
          ],
          source: "planner",
          actor: "fleet-automation",
        });
      }
    );
    const reconcilePlanReviews = vi.fn(
      async (contract: FleetPlanReviewContract) => {
        expect(contract.run.conductor_session_id).toBeNull();
        const insert = db.prepare(
          `INSERT OR IGNORE INTO fleet_reviews
           (id, fleet_run_id, subject_type, subject_hash, policy_hash,
            execution_hash, base_sha, lens, reviewer_session_id, verdict, state)
           VALUES (?, ?, 'plan', ?, ?, ?, ?, ?, ?, 'clean', 'clean')`
        );
        for (const [index, lens] of FLEET_PLAN_REVIEW_LENSES.entries()) {
          insert.run(
            `plan-review-${index}`,
            contract.run.id,
            contract.planHash,
            contract.policyHash,
            contract.executionHash,
            contract.baseSha,
            lens,
            `plan-review-session-${index}`
          );
        }
      }
    );

    let reportReady = false;
    let taskWorktree = "";
    let taskBranch = "";
    const spawn = vi.fn<FleetSchedulerDeps["spawn"]>(async (input) => {
      expect(input.run.conductor_session_id).toBeNull();
      taskWorktree = path.join(PROJECT_PATH, ".stoa-worktrees", input.task.id);
      taskBranch = `fleet-e2e-${input.task.id.slice(0, 8)}`;
      const sessionId = `worker-session-${input.task.id}`;
      insertSession({
        id: sessionId,
        worktree: taskWorktree,
        branch: taskBranch,
      });
      return {
        sessionId,
        worktreePath: taskWorktree,
        branchName: taskBranch,
      };
    });
    const collectReport = vi.fn<FleetSchedulerDeps["collectReport"]>(
      async (input) =>
        reportReady ? reportCollection(input, taskBranch) : { kind: "missing" }
    );
    const stopSession = vi.fn(async () => undefined);
    const schedulerDeps: Partial<FleetSchedulerDeps> = {
      db,
      now: () => NOW,
      spawn,
      prepareAttempt: async ({ runId: id, taskId, attempt }) => ({
        attemptDirectory: path.join(
          PROJECT_PATH,
          ".fleet-attempts",
          id,
          taskId,
          String(attempt)
        ),
        reportPath: path.join(
          PROJECT_PATH,
          ".fleet-attempts",
          id,
          taskId,
          String(attempt),
          "report.json"
        ),
        nonce: REPORT_NONCE,
        nonceHash: hashFleetReportNonce(REPORT_NONCE),
        baseSha: BASE_SHA,
      }),
      collectReport,
      sessionExists: async () => true,
      stopSession,
      sendMessage: async () => undefined,
      sampleCosts: async () => 0,
      resolveBaseSha: async () => BASE_SHA,
    };

    const automationDeps = {
      db,
      now: () => NOW,
      startPlanner,
      reconcilePlanReviews,
      resolveBaseSha: async () => BASE_SHA,
      schedulerReady: () => true,
      confinementAvailable: () => true,
      reconcileRun: async (id: string) => reconcileFleetRun(id, schedulerDeps),
    };

    await reconcileFleetAutomation(40, automationDeps);
    await reconcileFleetAutomation(40, automationDeps);
    await reconcileFleetAutomation(40, automationDeps);

    expect(startPlanner).toHaveBeenCalledTimes(1);
    expect(reconcilePlanReviews).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_reviews
           WHERE fleet_run_id = ? AND subject_type = 'plan'
             AND state = 'clean' AND verdict = 'clean'`
        )
        .get(runId)
    ).toEqual({ n: 4 });
    expect(spawn).toHaveBeenCalledTimes(1);
    const planReviewEvidence = db
      .prepare(
        `SELECT subject_hash, policy_hash, execution_hash, base_sha, lens,
                reviewer_session_id, state
         FROM fleet_reviews WHERE fleet_run_id = ? ORDER BY lens`
      )
      .all(runId) as Array<Record<string, string>>;
    expect(planReviewEvidence).toHaveLength(4);
    expect(new Set(planReviewEvidence.map((row) => row.lens))).toEqual(
      new Set(FLEET_PLAN_REVIEW_LENSES)
    );
    expect(
      new Set(planReviewEvidence.map((row) => row.reviewer_session_id)).size
    ).toBe(4);
    expect(
      planReviewEvidence.every(
        (row) =>
          row.subject_hash === planReviewEvidence[0]?.subject_hash &&
          row.policy_hash === planReviewEvidence[0]?.policy_hash &&
          row.execution_hash === planReviewEvidence[0]?.execution_hash &&
          row.base_sha === BASE_SHA &&
          row.state === "clean"
      )
    ).toBe(true);

    // Simulate two scheduler process starts. Recovery and repeated reconcile
    // must preserve the exact running attempt instead of launching duplicates.
    await recoverFleetRuns(schedulerDeps, { runId });
    await recoverFleetRuns(schedulerDeps, { runId });
    await reconcileFleetRun(runId, schedulerDeps);
    await reconcileFleetRun(runId, schedulerDeps);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_workers WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(`SELECT recovery_required FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({ recovery_required: 0 });

    const worker = db
      .prepare(`SELECT * FROM fleet_workers WHERE fleet_run_id = ?`)
      .get(runId) as FleetWorkerRow;
    reportReady = true;
    expect(
      await reconcileFleetWorkerReport(runId, worker.id, schedulerDeps)
    ).toBe(true);
    expect(
      await reconcileFleetWorkerReport(runId, worker.id, schedulerDeps)
    ).toBe(false);
    expect(stopSession).toHaveBeenCalledTimes(1);

    const task = db
      .prepare(`SELECT id FROM fleet_tasks WHERE fleet_run_id = ?`)
      .get(runId) as { id: string };
    let currentTaskHead = TASK_HEAD_SHA;
    const launchedVerifications: Promise<void>[] = [];
    const verificationDeps: Partial<FleetVerificationDeps> = {
      db,
      now: () => NOW,
      readHead: async () => currentTaskHead,
      readStatus: async () => "",
      run: async () => ({ status: "pass", output: "verification passed" }),
      launch: (operation) => {
        launchedVerifications.push(operation());
      },
    };
    expect(
      await reconcileFleetVerifications(verificationDeps, {
        runId,
        taskId: task.id,
        maxPerTick: 1,
      })
    ).toBe(1);
    await Promise.all(launchedVerifications);
    expect(
      await reconcileFleetVerifications(verificationDeps, {
        runId,
        taskId: task.id,
        maxPerTick: 1,
      })
    ).toBe(0);
    expect(
      db
        .prepare(
          `SELECT status, desired_state, pause_reason FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({
      status: "running",
      desired_state: "running",
      pause_reason: null,
    });

    const reviews = taskReviewRuntime({
      runId,
      taskId: task.id,
      taskWorktree,
      taskBranch,
      taskHeadSha: TASK_HEAD_SHA,
      firstHeadBlocker: true,
      fixedHeadSha: FIXED_HEAD_SHA,
    });
    await reconcileFleetTaskReviews(reviews.deps, {
      runId,
      taskId: task.id,
      maxTasks: 1,
    });
    expect(
      db
        .prepare(`SELECT status, failure_code FROM fleet_tasks WHERE id = ?`)
        .get(task.id)
    ).toEqual({ status: "reviewing", failure_code: null });
    await reconcileFleetTaskReviews(reviews.deps, {
      runId,
      taskId: task.id,
      maxTasks: 1,
    });
    expect(reviews.spawnReview).toHaveBeenCalledTimes(4);
    expect(reviews.spawnFix).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT status, verification_status, review_status, fix_rounds
           FROM fleet_tasks WHERE id = ?`
        )
        .get(task.id)
    ).toEqual({
      status: "fixing",
      verification_status: "pass",
      review_status: "changes_requested",
      fix_rounds: 1,
    });
    const historicalBlocker = db
      .prepare(
        `SELECT id, head_sha, severity, body, metadata_json
         FROM fleet_artifacts
         WHERE fleet_run_id = ? AND task_id = ?
           AND artifact_type = 'task_review_finding'
           AND severity = 'blocker'`
      )
      .get(runId, task.id) as Record<string, unknown>;
    expect(historicalBlocker).toMatchObject({
      head_sha: TASK_HEAD_SHA,
      severity: "blocker",
    });

    // Launch the fixer, then recreate its dependencies before polling. This
    // models a process restart while a paid automatic-fix session is active.
    await reconcileFleetTaskReviews(reviews.deps, {
      runId,
      taskId: task.id,
      maxTasks: 1,
    });
    expect(reviews.spawnFix).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(`SELECT state FROM fleet_task_fixes WHERE task_id = ?`)
        .get(task.id)
    ).toEqual({ state: "running" });
    const restartedReviews = taskReviewRuntime({
      runId,
      taskId: task.id,
      taskWorktree,
      taskBranch,
      taskHeadSha: TASK_HEAD_SHA,
      firstHeadBlocker: true,
      fixedHeadSha: FIXED_HEAD_SHA,
      idPrefix: "task-review-restart",
    });
    await reconcileFleetTaskReviews(restartedReviews.deps, {
      runId,
      taskId: task.id,
      maxTasks: 1,
    });
    expect(restartedReviews.spawnFix).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT status, head_sha, verification_id, verification_status,
                  review_status, active_fix_id, fix_rounds
           FROM fleet_tasks WHERE id = ?`
        )
        .get(task.id)
    ).toEqual({
      status: "verifying",
      head_sha: FIXED_HEAD_SHA,
      verification_id: null,
      verification_status: null,
      review_status: null,
      active_fix_id: null,
      fix_rounds: 1,
    });
    expect(
      db
        .prepare(
          `SELECT id, head_sha, severity, body, metadata_json
           FROM fleet_artifacts WHERE id = ?`
        )
        .get(historicalBlocker.id)
    ).toEqual(historicalBlocker);

    currentTaskHead = FIXED_HEAD_SHA;
    expect(
      await reconcileFleetVerifications(verificationDeps, {
        runId,
        taskId: task.id,
        maxPerTick: 1,
      })
    ).toBe(1);
    await Promise.all(launchedVerifications);
    expect(
      await reconcileFleetVerifications(verificationDeps, {
        runId,
        taskId: task.id,
        maxPerTick: 1,
      })
    ).toBe(0);

    await reconcileFleetTaskReviews(restartedReviews.deps, {
      runId,
      taskId: task.id,
      maxTasks: 1,
    });
    await reconcileFleetTaskReviews(restartedReviews.deps, {
      runId,
      taskId: task.id,
      maxTasks: 1,
    });
    expect(restartedReviews.spawnReview).toHaveBeenCalledTimes(4);
    expect(
      db
        .prepare(
          `SELECT status, verification_status, verified_head_sha,
                  review_status, review_head_sha
           FROM fleet_tasks WHERE id = ?`
        )
        .get(task.id)
    ).toEqual({
      status: "ready_to_merge",
      verification_status: "pass",
      verified_head_sha: FIXED_HEAD_SHA,
      review_status: "clean",
      review_head_sha: FIXED_HEAD_SHA,
    });
    const fixedHeadReviews = db
      .prepare(
        `SELECT lens, reviewer_session_id, verdict, state
         FROM fleet_task_reviews
         WHERE task_id = ? AND head_sha = ? ORDER BY lens`
      )
      .all(task.id, FIXED_HEAD_SHA) as Array<Record<string, string>>;
    expect(fixedHeadReviews).toHaveLength(4);
    expect(new Set(fixedHeadReviews.map((row) => row.lens))).toEqual(
      new Set(FLEET_PLAN_REVIEW_LENSES)
    );
    expect(
      new Set(fixedHeadReviews.map((row) => row.reviewer_session_id)).size
    ).toBe(4);
    expect(
      fixedHeadReviews.every(
        (row) => row.verdict === "clean" && row.state === "clean"
      )
    ).toBe(true);
    expect(
      db
        .prepare(
          `SELECT state, old_head_sha, new_head_sha
           FROM fleet_task_fixes WHERE task_id = ?`
        )
        .get(task.id)
    ).toEqual({
      state: "completed",
      old_head_sha: TASK_HEAD_SHA,
      new_head_sha: FIXED_HEAD_SHA,
    });
    expect(
      db
        .prepare(
          `SELECT action, status FROM fleet_action_authorizations
           WHERE fleet_run_id = ? AND action IN ('fix', 'merge')
           ORDER BY action`
        )
        .all(runId)
    ).toEqual([
      { action: "fix", status: "authorized" },
      { action: "merge", status: "authorized" },
    ]);
    const exactRun = queries.getFleetRun(db).get(runId) as FleetRunRow;
    const exactTasks = queries
      .listFleetTasksForRun(db)
      .all(runId) as FleetTaskRow[];
    const exactDependencies = db
      .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
      .all(runId) as FleetTaskDependencyRow[];
    const exactClaims = db
      .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
      .all(runId) as FleetTaskClaimRow[];
    expect(hashFleetTaskRows(exactTasks, exactDependencies)).toBe(
      exactRun.plan_hash
    );
    expect(
      hashFleetExecutionContract({
        run: exactRun,
        tasks: exactTasks,
        claims: exactClaims,
        dependencies: exactDependencies,
      })
    ).toBe(approvedExecutionHash(exactRun));

    const merge = mergeRuntime(runId, taskWorktree, taskBranch, FIXED_HEAD_SHA);
    await reconcileFleetMerges(merge.overrides, runId);
    await reconcileFleetMerges(merge.overrides, runId);
    // Repeating the final reconcile models restart after final verification;
    // the completed operation is consumed instead of executed twice.
    await reconcileFleetMerges(merge.overrides, runId);
    await reconcileFleetMerges(merge.overrides, runId);
    await reconcileFleetMerges(merge.overrides, runId);

    const finalRun = db
      .prepare(
        `SELECT status, desired_state, conductor_session_id,
                merge_request_kind, merge_target, integration_state,
                integration_merge_sha
         FROM fleet_runs WHERE id = ?`
      )
      .get(runId);
    expect(finalRun).toEqual({
      status: "completed",
      desired_state: "running",
      conductor_session_id: null,
      merge_request_kind: "automatic",
      merge_target: "local",
      integration_state: "cleanup_complete",
      integration_merge_sha: INTEGRATION_HEAD_SHA,
    });
    expect(
      db
        .prepare(`SELECT status, head_sha FROM fleet_tasks WHERE id = ?`)
        .get(task.id)
    ).toEqual({ status: "merged", head_sha: FIXED_HEAD_SHA });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_merge_operations
           WHERE fleet_run_id = ? AND state = 'completed'`
        )
        .get(runId)
    ).toEqual({ n: 3 });
    expect(merge.verify).toHaveBeenCalledTimes(2);

    const detail = getFleetRunDetail(runId);
    expect(detail?.run.status).toBe("completed");
    const lifecycleEvents = db
      .prepare(
        `SELECT event_type FROM fleet_events
         WHERE fleet_run_id = ? AND event_type IN (
           'run_auto_started', 'task_fix_completed',
           'automatic_merge_requested', 'fleet_merge_completed'
         )`
      )
      .all(runId) as Array<{ event_type: string }>;
    expect(new Set(lifecycleEvents.map((event) => event.event_type))).toEqual(
      new Set([
        "run_auto_started",
        "task_fix_completed",
        "automatic_merge_requested",
        "fleet_merge_completed",
      ])
    );
  });

  it("auto-plans three tasks across parallel dependency waves and merges the exact reviewed heads", async () => {
    const created = createDraftFleetRun({
      name: "Sessionless multi-task project specification",
      goal: "Build the API and UI in parallel, then integrate them end to end.",
      repoId: "e2e-repo",
      provider: "codex",
      maxConcurrency: 3,
      reviewPolicy: "four_agent",
      automationPolicy: {
        automaticPlanning: true,
        automaticPlanApproval: true,
        automaticStart: true,
        automaticFixes: true,
        maxAutomaticFixRounds: 1,
        automaticMerge: true,
        mergeTarget: "local",
        allowUnconfinedAgents: true,
      },
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    expect(
      db
        .prepare(`SELECT conductor_session_id FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({ conductor_session_id: null });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({
      n: 0,
    });

    const taskSpecs = new Map([
      ["Build API", { path: "src/api/epic.ts", headSha: "b".repeat(40) }],
      ["Build UI", { path: "src/ui/epic.tsx", headSha: "c".repeat(40) }],
      [
        "Integrate API and UI",
        { path: "src/integration/epic.ts", headSha: "d".repeat(40) },
      ],
    ]);
    const fixtures = new Map<string, MultiTaskFixture>();
    const merge = multiTaskMergeRuntime(runId, fixtures);

    const startPlanner = vi.fn(
      async (
        id: string,
        _options: Parameters<typeof startFleetPlanner>[1],
        actor: Parameters<typeof startFleetPlanner>[2]
      ): Promise<Awaited<ReturnType<typeof startFleetPlanner>>> => {
        expect(actor).toBe("fleet-automation");
        return ingestGeneratedFleetRunPlan(id, {
          planText: [
            "1. Build API [files: src/api/epic.ts]",
            "2. Build UI [files: src/ui/epic.tsx]",
            "3. Integrate API and UI [depends on: 1, 2] [files: src/integration/epic.ts]",
          ].join("\n"),
          tasks: [
            {
              title: "Build API",
              description: "Implement the API half of the epic.",
              taskType: "implementation",
              parentIndex: null,
              sortOrder: 0,
              fileClaims: ["src/api/epic.ts"],
              agentType: "codex",
              model: null,
              acceptanceCriteria: "The API verification passes.",
              verifyCommand: "npm test",
              workingDirectory: PROJECT_PATH,
              baseBranch: "main",
            },
            {
              title: "Build UI",
              description: "Implement the UI half of the epic.",
              taskType: "implementation",
              parentIndex: null,
              sortOrder: 1,
              fileClaims: ["src/ui/epic.tsx"],
              agentType: "codex",
              model: null,
              acceptanceCriteria: "The UI verification passes.",
              verifyCommand: "npm test",
              workingDirectory: PROJECT_PATH,
              baseBranch: "main",
            },
            {
              title: "Integrate API and UI",
              description: "Connect both independently implemented halves.",
              taskType: "integration",
              parentIndex: null,
              sortOrder: 2,
              fileClaims: ["src/integration/epic.ts"],
              agentType: "codex",
              model: null,
              acceptanceCriteria: "The combined project verification passes.",
              verifyCommand: "npm test",
              workingDirectory: PROJECT_PATH,
              baseBranch: "main",
            },
          ],
          dependencies: [[], [], [0, 1]],
          source: "planner",
          actor: "fleet-automation",
        });
      }
    );
    const reconcilePlanReviews = vi.fn(
      async (contract: FleetPlanReviewContract) => {
        expect(contract.run.conductor_session_id).toBeNull();
        expect(contract.tasks).toHaveLength(3);
        expect(contract.dependencies).toHaveLength(2);
        const insert = db.prepare(
          `INSERT OR IGNORE INTO fleet_reviews
           (id, fleet_run_id, subject_type, subject_hash, policy_hash,
            execution_hash, base_sha, lens, reviewer_session_id, verdict, state)
           VALUES (?, ?, 'plan', ?, ?, ?, ?, ?, ?, 'clean', 'clean')`
        );
        for (const [index, lens] of FLEET_PLAN_REVIEW_LENSES.entries()) {
          insert.run(
            `multi-plan-review-${index}`,
            contract.run.id,
            contract.planHash,
            contract.policyHash,
            contract.executionHash,
            contract.baseSha,
            lens,
            `multi-plan-review-session-${index}`
          );
        }
      }
    );

    const reportReady = new Set<string>();
    const spawnOrder: string[] = [];
    const spawn = vi.fn<FleetSchedulerDeps["spawn"]>(async (input) => {
      expect(input.run.conductor_session_id).toBeNull();
      const spec = taskSpecs.get(input.task.title);
      if (!spec) throw new Error(`unknown planned task: ${input.task.title}`);
      const worktree = path.join(
        PROJECT_PATH,
        ".stoa-worktrees",
        input.task.id
      );
      const branch = `fleet-e2e-${input.task.id.slice(0, 8)}`;
      const baseSha = input.task.base_sha;
      if (!baseSha) throw new Error("spawned task is missing its exact base");
      const fixture: MultiTaskFixture = {
        taskId: input.task.id,
        path: spec.path,
        headSha: spec.headSha,
        baseSha,
        worktree,
        branch,
      };
      merge.registerTask(fixture);
      spawnOrder.push(input.task.title);
      const sessionId = `worker-session-${input.task.id}`;
      insertSession({ id: sessionId, worktree, branch });
      return { sessionId, worktreePath: worktree, branchName: branch };
    });
    const collectReport = vi.fn<FleetSchedulerDeps["collectReport"]>(
      async (input) => {
        const fixture = fixtures.get(input.expected.taskId);
        if (!fixture) throw new Error("report requested for an unspawned task");
        return reportReady.has(input.expected.taskId)
          ? reportCollection(input, fixture.branch, {
              headSha: fixture.headSha,
              path: fixture.path,
            })
          : { kind: "missing" };
      }
    );
    const stopSession = vi.fn(async () => undefined);
    const schedulerDeps: Partial<FleetSchedulerDeps> = {
      db,
      now: () => NOW,
      spawn,
      prepareAttempt: async ({ runId: id, taskId, attempt, baseRef }) => ({
        attemptDirectory: path.join(
          PROJECT_PATH,
          ".fleet-attempts",
          id,
          taskId,
          String(attempt)
        ),
        reportPath: path.join(
          PROJECT_PATH,
          ".fleet-attempts",
          id,
          taskId,
          String(attempt),
          "report.json"
        ),
        nonce: REPORT_NONCE,
        nonceHash: hashFleetReportNonce(REPORT_NONCE),
        baseSha: /^[0-9a-f]{40}$/.test(baseRef) ? baseRef : BASE_SHA,
      }),
      collectReport,
      sessionExists: async () => true,
      stopSession,
      sendMessage: async () => undefined,
      sampleCosts: async () => 0,
      resolveBaseSha: async () => BASE_SHA,
    };
    const automationDeps = {
      db,
      now: () => NOW,
      startPlanner,
      reconcilePlanReviews,
      resolveBaseSha: async () => BASE_SHA,
      schedulerReady: () => true,
      confinementAvailable: () => true,
      reconcileRun: async (id: string) => reconcileFleetRun(id, schedulerDeps),
    };

    await reconcileFleetAutomation(40, automationDeps);
    await reconcileFleetAutomation(40, automationDeps);
    await reconcileFleetAutomation(40, automationDeps);

    expect(startPlanner).toHaveBeenCalledTimes(1);
    expect(reconcilePlanReviews).toHaveBeenCalledTimes(1);
    expect(spawnOrder).toEqual(["Build API", "Build UI"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    const tasks = db
      .prepare(
        `SELECT id, title, status, base_sha FROM fleet_tasks
         WHERE fleet_run_id = ? ORDER BY sort_order`
      )
      .all(runId) as Array<{
      id: string;
      title: string;
      status: string;
      base_sha: string | null;
    }>;
    expect(tasks).toHaveLength(3);
    expect(tasks.map((task) => task.status)).toEqual([
      "running",
      "running",
      "ready",
    ]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_task_dependencies WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({ n: 2 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_workers
           WHERE fleet_run_id = ? AND status = 'running'`
        )
        .get(runId)
    ).toEqual({ n: 2 });

    // A scheduler restart preserves both parallel allocations and does not
    // create the dependent task until its exact upstream heads are integrated.
    await recoverFleetRuns(schedulerDeps, { runId });
    await recoverFleetRuns(schedulerDeps, { runId });
    await reconcileFleetRun(runId, schedulerDeps);
    expect(spawn).toHaveBeenCalledTimes(2);

    const launchedVerifications: Promise<void>[] = [];
    const exactVerificationCalls: Array<{ cwd: string; command: string }> = [];
    const verificationDeps: Partial<FleetVerificationDeps> = {
      db,
      now: () => NOW,
      readHead: async (cwd) => {
        const fixture = [...fixtures.values()].find(
          (candidate) => candidate.worktree === cwd
        );
        if (!fixture) throw new Error(`unknown verification worktree: ${cwd}`);
        return fixture.headSha;
      },
      readStatus: async () => "",
      run: async (cwd, command) => {
        exactVerificationCalls.push({ cwd, command });
        return { status: "pass", output: "exact task verification passed" };
      },
      launch: (operation) => {
        launchedVerifications.push(operation());
      },
    };

    const finishTaskWave = async (wave: typeof tasks) => {
      for (const task of wave) {
        reportReady.add(task.id);
        const worker = db
          .prepare(
            `SELECT * FROM fleet_workers WHERE fleet_run_id = ? AND task_id = ?`
          )
          .get(runId, task.id) as FleetWorkerRow;
        expect(
          await reconcileFleetWorkerReport(runId, worker.id, schedulerDeps)
        ).toBe(true);
        expect(
          await reconcileFleetWorkerReport(runId, worker.id, schedulerDeps)
        ).toBe(false);
      }
      expect(
        await reconcileFleetVerifications(verificationDeps, {
          runId,
          maxPerTick: 8,
          maxConcurrent: 8,
        })
      ).toBe(wave.length);
      await Promise.all(launchedVerifications.splice(0));
      for (const task of wave) {
        const fixture = fixtures.get(task.id);
        if (!fixture) throw new Error("review fixture is missing");
        const reviews = taskReviewRuntime({
          runId,
          taskId: task.id,
          taskWorktree: fixture.worktree,
          taskBranch: fixture.branch,
          taskHeadSha: fixture.headSha,
        });
        await reconcileFleetTaskReviews(reviews.deps, {
          runId,
          taskId: task.id,
          maxTasks: 1,
        });
        await reconcileFleetTaskReviews(reviews.deps, {
          runId,
          taskId: task.id,
          maxTasks: 1,
        });
        expect(reviews.spawnReview).toHaveBeenCalledTimes(4);
        expect(reviews.spawnFix).not.toHaveBeenCalled();
      }
    };

    await finishTaskWave(tasks.slice(0, 2));
    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_tasks
           WHERE fleet_run_id = ? AND status = 'ready_to_merge'`
        )
        .get(runId)
    ).toEqual({ n: 2 });

    await reconcileFleetMerges(merge.overrides, runId);
    await reconcileFleetMerges(merge.overrides, runId);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_tasks
           WHERE fleet_run_id = ? AND status = 'merged'`
        )
        .get(runId)
    ).toEqual({ n: 2 });
    expect(
      db
        .prepare(`SELECT status, approval_state FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({ status: "running", approval_state: "approved" });

    const dependent = tasks[2];
    if (!dependent) throw new Error("dependent task is missing");
    expect(
      db
        .prepare(`SELECT base_sha, base_branch FROM fleet_tasks WHERE id = ?`)
        .get(dependent.id)
    ).toEqual({ base_sha: merge.integrationHeads[1], base_branch: "main" });
    expect(await reconcileFleetRun(runId, schedulerDeps)).toBe(1);
    expect(spawnOrder).toEqual([
      "Build API",
      "Build UI",
      "Integrate API and UI",
    ]);
    const dependentFixture = fixtures.get(dependent.id);
    expect(dependentFixture?.baseSha).toBe(merge.integrationHeads[1]);
    expect(
      db
        .prepare(`SELECT base_sha FROM fleet_tasks WHERE id = ?`)
        .get(dependent.id)
    ).toEqual({ base_sha: merge.integrationHeads[1] });

    await finishTaskWave([dependent]);
    expect(stopSession).toHaveBeenCalledTimes(3);

    await reconcileFleetMerges(merge.overrides, runId);
    await reconcileFleetMerges(merge.overrides, runId);
    await reconcileFleetMerges(merge.overrides, runId);
    await reconcileFleetMerges(merge.overrides, runId);
    await reconcileFleetMerges(merge.overrides, runId);

    const finalRun = db
      .prepare(
        `SELECT status, desired_state, conductor_session_id,
                merge_request_kind, merge_target, integration_state,
                integration_merge_sha
         FROM fleet_runs WHERE id = ?`
      )
      .get(runId);
    expect(finalRun).toEqual({
      status: "completed",
      desired_state: "running",
      conductor_session_id: null,
      merge_request_kind: "automatic",
      merge_target: "local",
      integration_state: "cleanup_complete",
      integration_merge_sha: merge.integrationHeads[2],
    });
    expect(
      db
        .prepare(
          `SELECT status, verification_status, review_status
           FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
        )
        .all(runId)
    ).toEqual([
      { status: "merged", verification_status: "pass", review_status: "clean" },
      { status: "merged", verification_status: "pass", review_status: "clean" },
      { status: "merged", verification_status: "pass", review_status: "clean" },
    ]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_task_reviews
           WHERE fleet_run_id = ? AND state = 'clean' AND verdict = 'clean'`
        )
        .get(runId)
    ).toEqual({ n: 12 });
    const reviewerGroups = db
      .prepare(
        `SELECT task_id, COUNT(DISTINCT lens) AS lenses,
                COUNT(DISTINCT reviewer_session_id) AS reviewers,
                COUNT(DISTINCT head_sha) AS heads
         FROM fleet_task_reviews WHERE fleet_run_id = ? GROUP BY task_id
         ORDER BY task_id`
      )
      .all(runId) as Array<{
      task_id: string;
      lenses: number;
      reviewers: number;
      heads: number;
    }>;
    expect(reviewerGroups).toHaveLength(3);
    expect(
      reviewerGroups.every(
        (group) =>
          group.lenses === 4 && group.reviewers === 4 && group.heads === 1
      )
    ).toBe(true);
    expect(
      db
        .prepare(
          `SELECT task_id, head_sha, status FROM fleet_verifications
           WHERE fleet_run_id = ? ORDER BY task_id`
        )
        .all(runId)
    ).toEqual(
      expect.arrayContaining(
        tasks.map((task) => ({
          task_id: task.id,
          head_sha: taskSpecs.get(task.title)?.headSha,
          status: "pass",
        }))
      )
    );
    expect(exactVerificationCalls).toHaveLength(3);
    expect(
      exactVerificationCalls.every((call) => call.command === "npm test")
    ).toBe(true);
    expect(merge.verify).toHaveBeenCalledTimes(4);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_merge_operations
           WHERE fleet_run_id = ? AND state = 'completed'`
        )
        .get(runId)
    ).toEqual({ n: 5 });
    expect(merge.integrationPathExists()).toBe(false);
    expect(merge.integrationBranchExists()).toBe(false);
    expect(merge.removedWorktrees).toEqual([merge.integration.worktree]);

    const detail = getFleetRunDetail(runId);
    expect(detail?.run.status).toBe("completed");
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'run_auto_started'`
        )
        .get(runId)
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'integration_workspace_cleaned'`
        )
        .get(runId)
    ).toEqual({ n: 1 });
  });
});
