import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import { createSchema } from "@/lib/db/schema";
import {
  DEFAULT_FLEET_AUTOMATION_POLICY,
  fleetAutomationPolicyJson,
} from "@/lib/fleet/automation-policy";
import { generateBranchName } from "@/lib/git";
import type { FleetGitState } from "@/lib/fleet/git-state";
import type { FleetAgentProviderId } from "@/lib/fleet/auxiliary-provider";
import { hashFleetAutomationPolicy } from "@/lib/fleet/hash";
import { toFleetTaskDto } from "@/lib/fleet/engine";
import { reserveFleetPaidSession } from "@/lib/fleet/session-admission";
import {
  FLEET_PLAN_REVIEW_LENSES,
  type FleetPlanReviewFinding,
} from "@/lib/fleet/plan-review";
import {
  hashFleetVerificationEvidence,
  parseFleetTaskFixResult,
  parseFleetTaskReviewResult,
  isOwnedFleetTaskReviewResultPath,
  reconcileFleetTaskReviews,
  type FleetTaskReviewDeps,
} from "@/lib/fleet/task-review";
import type {
  FleetAutomationPolicy,
  FleetRunRow,
  FleetTaskFixRow,
  FleetTaskRow,
  FleetTaskReviewRow,
  FleetVerificationRow,
} from "@/lib/fleet/types";
import { insertFleetOwnedSession } from "./fleet-session-fixture";
import { stoaHomeDir } from "@/lib/platform";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const NEW_HEAD_SHA = "c".repeat(40);
const PLAN_HASH = "1".repeat(64);
const SPEC_HASH = "2".repeat(64);
const OUTPUT_HASH = "3".repeat(64);
const REVIEW_NONCE = "one-use-review-nonce";
const RUN_ID = "run-1";
const TASK_ID = "task-1";
const WORKER_ID = "worker-1";
const VERIFICATION_ID = "verification-1";
const PROJECT_PATH = join(tmpdir(), "stoa-fleet-task-review-repo");
const TASK_WORKTREE = join(PROJECT_PATH, ".stoa-worktrees", "task-1");
const TASK_BRANCH = "fleet-task-1";

function taskRuntimeResultPath(
  kind: "reviews" | "fixes",
  requestId: string
): string {
  return join(
    stoaHomeDir(),
    "fleet-task-runtime",
    RUN_ID,
    TASK_ID,
    "1",
    kind,
    `${requestId}.json`
  );
}

function policy(automaticFixes = false): FleetAutomationPolicy {
  return {
    ...DEFAULT_FLEET_AUTOMATION_POLICY,
    automaticPlanning: true,
    automaticPlanApproval: true,
    automaticStart: true,
    automaticFixes,
    maxAutomaticFixRounds: automaticFixes ? 1 : 0,
    allowUnconfinedAgents: true,
  };
}

function setupDb(
  input: {
    automaticFixes?: boolean;
    reviewPolicy?: "four_agent" | "manual";
  } = {}
): {
  db: Database.Database;
  policy: FleetAutomationPolicy;
  policyHash: string;
} {
  const db = new Database(":memory:");
  createSchema(db);
  const reviewPolicy = input.reviewPolicy ?? "four_agent";
  const automationPolicy =
    reviewPolicy === "manual"
      ? { ...DEFAULT_FLEET_AUTOMATION_POLICY, allowUnconfinedAgents: true }
      : policy(input.automaticFixes);
  const policyHash = hashFleetAutomationPolicy(automationPolicy);
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, desired_state, provider, model, review_policy,
      approval_state, plan_hash, approved_plan_hash, automation_policy_json,
      automation_policy_hash, settings_json, created_at, updated_at)
     VALUES (?, 'Run', 'Implement safely', 'running', 'running', 'codex', NULL,
       ?, 'approved', ?, ?, ?, ?, '{}', ?, ?)`
  ).run(
    RUN_ID,
    reviewPolicy,
    PLAN_HASH,
    PLAN_HASH,
    fleetAutomationPolicyJson(automationPolicy),
    policyHash,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z"
  );
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, description, status, task_type, sort_order,
      file_claims_json, actual_file_claims_json, working_directory, base_branch,
      branch_name, worktree_path, base_sha, head_sha, report_artifact_id,
      verification_id, verification_status, verification_spec_hash,
      verified_head_sha, verification_artifact_id, current_attempt,
      acceptance_criteria, verify_command, approved_task_hash, approval_state,
      created_at, updated_at)
     VALUES (?, ?, 'Task', 'Change src/a.ts', 'reviewing', 'implementation', 0,
       '["src"]', '["src/a.ts"]', ?, 'main', ?, ?, ?, ?, 'report-1', ?,
       'pass', ?, ?, 'verification-result-1', 1, 'tests pass',
       'npm test', ?, 'approved', ?, ?)`
  ).run(
    TASK_ID,
    RUN_ID,
    PROJECT_PATH,
    TASK_BRANCH,
    TASK_WORKTREE,
    BASE_SHA,
    HEAD_SHA,
    VERIFICATION_ID,
    SPEC_HASH,
    HEAD_SHA,
    PLAN_HASH,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z"
  );
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, status, provider, attempt, worktree_path,
      branch_name, base_sha, head_sha, report_state, report_status,
      report_collected_at, created_at)
     VALUES (?, ?, ?, 'cleanup_complete', 'codex', 1, ?, ?, ?, ?, 'accepted',
       'succeeded', ?, ?)`
  ).run(
    WORKER_ID,
    RUN_ID,
    TASK_ID,
    TASK_WORKTREE,
    TASK_BRANCH,
    BASE_SHA,
    HEAD_SHA,
    "2026-01-01T00:05:00.000Z",
    "2026-01-01T00:00:00.000Z"
  );
  db.prepare(
    `INSERT INTO fleet_verifications
     (id, fleet_run_id, task_id, worker_id, attempt, base_sha, head_sha,
      spec_hash, command, status, run_count, output_artifact_id, output_hash,
      created_at, updated_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'npm test', 'pass', 1,
       'verification-result-1', ?, ?, ?, ?, ?)`
  ).run(
    VERIFICATION_ID,
    RUN_ID,
    TASK_ID,
    WORKER_ID,
    BASE_SHA,
    HEAD_SHA,
    SPEC_HASH,
    OUTPUT_HASH,
    "2026-01-01T00:01:00.000Z",
    "2026-01-01T00:03:00.000Z",
    "2026-01-01T00:02:00.000Z",
    "2026-01-01T00:03:00.000Z"
  );
  db.prepare(
    `INSERT INTO fleet_artifacts
     (id, fleet_run_id, task_id, worker_id, attempt, plan_hash, base_sha,
      head_sha, content_hash, metadata_json, byte_count, artifact_type, title,
      body, severity, actor, created_at)
     VALUES ('verification-result-1', ?, ?, ?, 1, ?, ?, ?, ?, '{}', 2,
       'verification_result', 'Verification', '{}', 'info', 'verifier', ?)`
  ).run(
    RUN_ID,
    TASK_ID,
    WORKER_ID,
    PLAN_HASH,
    BASE_SHA,
    HEAD_SHA,
    OUTPUT_HASH,
    "2026-01-01T00:03:00.000Z"
  );
  if (input.automaticFixes) {
    db.prepare(
      `INSERT INTO fleet_action_authorizations
       (id, fleet_run_id, action, status, policy_hash, granted_by, granted_at,
        updated_at)
       VALUES ('fix-auth-1', ?, 'fix', 'authorized', ?, 'operator', ?, ?)`
    ).run(
      RUN_ID,
      policyHash,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );
  }
  return { db, policy: automationPolicy, policyHash };
}

function verification(db: Database.Database): FleetVerificationRow {
  return db
    .prepare(`SELECT * FROM fleet_verifications WHERE id = ?`)
    .get(VERIFICATION_ID) as FleetVerificationRow;
}

function gitState(input: {
  baseSha: string;
  headSha: string;
  branch: string;
  changed?: boolean;
  mutated?: boolean;
}): FleetGitState {
  const committedChanges = input.changed
    ? [
        {
          kind: "modified" as const,
          path: "src/a.ts",
          previousPath: null,
          status: "M",
          insertions: 1,
          deletions: 1,
          binary: false,
        },
      ]
    : [];
  return {
    repositoryRoot: PROJECT_PATH,
    caseInsensitivePaths: false,
    baseSha: input.baseSha,
    headSha: input.headSha,
    currentBranch: input.branch,
    committedChanges,
    committedPaths: input.changed ? ["src/a.ts"] : [],
    stagedChanges: [],
    unstagedChanges: [],
    dirtyTrackedPaths: [],
    untrackedPaths: input.mutated ? ["mutated.txt"] : [],
    allTouchedPaths: input.changed
      ? ["src/a.ts"]
      : input.mutated
        ? ["mutated.txt"]
        : [],
    sensitivePaths: [],
    summary: {
      committedFiles: committedChanges.length,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: input.mutated ? 1 : 0,
      insertions: input.changed ? 1 : 0,
      deletions: input.changed ? 1 : 0,
      binaryFiles: 0,
      renamedFiles: 0,
      touchedPathSample: input.changed ? ["src/a.ts"] : [],
      touchedPathsTruncated: false,
    },
  };
}

function resultForRow(
  row: FleetTaskReviewRow,
  verdict: "clean" | "changes_requested",
  findingCanary?: string
): string {
  const findings: FleetPlanReviewFinding[] =
    verdict === "clean"
      ? []
      : [
          {
            severity: "blocker",
            title: findingCanary
              ? `Broken ${findingCanary}`
              : "Broken edge case",
            body: findingCanary
              ? `Handle ${findingCanary} before merge.`
              : "Handle the exact failure before merge.",
          },
        ];
  return JSON.stringify({
    schemaVersion: 1,
    nonce: REVIEW_NONCE,
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
    verdict,
    findings,
  });
}

function runtime(
  db: Database.Database,
  input: {
    verdict?: (lens: string) => "clean" | "changes_requested";
    mutate?: (row: FleetTaskReviewRow) => boolean;
    newHead?: string;
    findingCanary?: string;
    installedProviders?: FleetAgentProviderId[];
    now?: Date;
    idPrefix?: string;
  } = {}
): {
  deps: Partial<FleetTaskReviewDeps>;
  spawnReview: ReturnType<typeof vi.fn>;
  spawnFix: ReturnType<typeof vi.fn>;
  removeWorktree: ReturnType<typeof vi.fn>;
  delivered: Array<{ prompt: string; persistedPrompt: string }>;
} {
  let id = 0;
  const delivered: Array<{ prompt: string; persistedPrompt: string }> = [];
  const spawnReview = vi.fn(async (request) => {
    delivered.push({
      prompt: request.prompt,
      persistedPrompt: request.persistedPrompt,
    });
    const sessionId = `${input.idPrefix ?? "runtime"}-review-session-${request.lens}`;
    const worktreePath = join(PROJECT_PATH, `.review-${request.lens}`);
    const branchName = generateBranchName(request.branchFeature);
    insertFleetOwnedSession(db, {
      runId: request.contract.candidate.fleet_run_id,
      ownerType: "task_review",
      ownerId: request.ownerId,
      sessionId,
      provider: request.provider,
      model: request.model,
      approvalMode: request.approvalMode,
      workingDirectory: worktreePath,
      workerTask: request.persistedPrompt,
      worktreePath,
      branchName,
      baseBranch: request.contract.candidate.task_head_sha,
      conductorSessionId:
        request.contract.candidate.conductor_session_id ?? null,
    });
    return {
      id: sessionId,
      worktree_path: worktreePath,
      branch_name: branchName,
    };
  });
  const spawnFix = vi.fn(async (request) => {
    const sessionId = `${input.idPrefix ?? "runtime"}-fix-session`;
    insertFleetOwnedSession(db, {
      runId: request.contract.candidate.fleet_run_id,
      ownerType: "fixer",
      ownerId: request.ownerId,
      sessionId,
      provider: request.provider,
      model: request.model,
      approvalMode: request.approvalMode,
      workingDirectory: request.row.worktree_path,
      workerTask: request.persistedPrompt,
      worktreePath: request.row.worktree_path,
      branchName: request.row.branch_name,
      baseBranch: request.contract.candidate.task_base_branch ?? "main",
      conductorSessionId:
        request.contract.candidate.conductor_session_id ?? null,
    });
    return { id: sessionId };
  });
  const removeWorktree = vi.fn(async () => {});
  return {
    spawnReview,
    spawnFix,
    removeWorktree,
    delivered,
    deps: {
      db,
      now: () => input.now ?? new Date("2026-01-01T00:10:00.000Z"),
      randomId: () => `${input.idPrefix ?? "runtime"}-${++id}`,
      randomNonce: () => REVIEW_NONCE,
      installedProviders: () => input.installedProviders ?? ["codex"],
      prepareResultPath: async ({ kind, requestId }) =>
        taskRuntimeResultPath(kind, requestId),
      readResult: async (path) => {
        const fix = db
          .prepare(`SELECT * FROM fleet_task_fixes WHERE result_path = ?`)
          .get(path) as
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
          const text = JSON.stringify({
            schemaVersion: 1,
            nonce: REVIEW_NONCE,
            runId: fix.fleet_run_id,
            taskId: fix.task_id,
            attempt: fix.attempt,
            round: fix.round,
            oldHeadSha: fix.old_head_sha,
            verificationEvidenceHash: fix.verification_evidence_hash,
            policyHash: fix.policy_hash,
            newHeadSha: input.newHead ?? NEW_HEAD_SHA,
            summary: "Committed the scoped correction.",
          });
          return { ok: true as const, text, bytes: Buffer.byteLength(text) };
        }
        const row = db
          .prepare(`SELECT * FROM fleet_task_reviews WHERE result_path = ?`)
          .get(path) as FleetTaskReviewRow;
        const text = resultForRow(
          row,
          input.verdict?.(row.lens) ?? "clean",
          input.findingCanary
        );
        return { ok: true as const, text, bytes: Buffer.byteLength(text) };
      },
      removeResult: async () => true,
      sessionExists: async () => true,
      stopSession: async () => true,
      removeWorktree,
      collectGitState: async (options) => {
        const review = db
          .prepare(
            `SELECT * FROM fleet_task_reviews WHERE reviewer_worktree_path = ?`
          )
          .get(options.cwd) as FleetTaskReviewRow | undefined;
        if (review) {
          return gitState({
            baseSha: review.head_sha,
            headSha: review.head_sha,
            branch: review.reviewer_branch_name,
            mutated: input.mutate?.(review) ?? false,
          });
        }
        const expected = options.expectedHeadSha ?? HEAD_SHA;
        return gitState({
          baseSha: options.baseSha,
          headSha: expected,
          branch: TASK_BRANCH,
          changed: true,
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
    },
  };
}

describe("Fleet task-review result ownership", () => {
  it.each([
    {
      name: "POSIX",
      stoaHome: "/home/user/.stoa",
      resultPath:
        "/home/user/.stoa/fleet-task-runtime/run-1/task-1/1/reviews/request-1.json",
    },
    {
      name: "Windows",
      stoaHome: "C:\\Users\\user\\.stoa",
      resultPath:
        "C:\\Users\\user\\.stoa\\fleet-task-runtime\\run-1\\task-1\\1\\reviews\\request-1.json",
    },
  ])(
    "accepts the exact $name review artifact independent of host OS",
    (item) => {
      expect(
        isOwnedFleetTaskReviewResultPath({
          resultPath: item.resultPath,
          runId: RUN_ID,
          taskId: TASK_ID,
          attempt: 1,
          requestId: "request-1",
          stoaHome: item.stoaHome,
        })
      ).toBe(true);
    }
  );

  it.each([
    "/tmp/fleet-task-runtime/run-1/task-1/1/reviews/request-1.json",
    "C:\\Temp\\fleet-task-runtime\\run-1\\task-1\\1\\reviews\\request-1.json",
    "/home/user/.stoa/fleet-task-runtime/foreign/task-1/1/reviews/request-1.json",
    "/home/user/.stoa/fleet-task-runtime/run-1/task-1/1/fixes/request-1.json",
    "/home/user/.stoa/fleet-task-runtime/run-1/task-1/1/reviews/foreign.json",
    "/home/user/.stoa/fleet-task-runtime/run-1/task-1/1/reviews/nested/request-1.json",
  ])("rejects a non-owned review artifact %s", (resultPath) => {
    const stoaHome = resultPath.startsWith("C:\\")
      ? "C:\\Users\\user\\.stoa"
      : "/home/user/.stoa";
    expect(
      isOwnedFleetTaskReviewResultPath({
        resultPath,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        requestId: "request-1",
        stoaHome,
      })
    ).toBe(false);
  });
});

describe("Fleet exact-SHA task review and automatic fix runtime", () => {
  it.each(["reviewing", "merging"] as const)(
    "keeps review admission, orphan checks, and final CAS active in the %s phase",
    async (runStatus) => {
      const { db } = setupDb();
      db.prepare(`UPDATE fleet_runs SET status = ? WHERE id = ?`).run(
        runStatus,
        RUN_ID
      );
      const harness = runtime(db);

      await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
      expect(harness.spawnReview).toHaveBeenCalledTimes(4);
      await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
      expect(
        db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
      ).toEqual({ status: "ready_to_merge" });
    }
  );

  it("scopes an operator-triggered review pass to the exact run and task", async () => {
    const { db } = setupDb();
    const harness = runtime(db);

    await expect(
      reconcileFleetTaskReviews(harness.deps, {
        runId: RUN_ID,
        taskId: "different-task",
        maxTasks: 1,
      })
    ).resolves.toBe(0);
    expect(harness.spawnReview).not.toHaveBeenCalled();
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_task_reviews`).get()
    ).toEqual({ n: 0 });
  });

  it("rolls back paid admission when the required spawn audit cannot persist", async () => {
    const { db } = setupDb();
    const harness = runtime(db);
    db.exec(`
      CREATE TRIGGER reject_task_review_spawn_audit
      BEFORE INSERT ON fleet_events
      WHEN NEW.event_type = 'task_review_spawn_requested'
      BEGIN
        SELECT RAISE(ABORT, 'rejected task review spawn audit');
      END
    `);

    await expect(
      reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 })
    ).rejects.toThrow(/rejected task review spawn audit/);
    expect(harness.spawnReview).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT state, COUNT(*) AS count
           FROM fleet_task_reviews GROUP BY state`
        )
        .all()
    ).toEqual([{ state: "pending", count: 4 }]);
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM fleet_cost_accounts`).get()
    ).toEqual({ count: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM fleet_runtime_leases`).get()
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_events
           WHERE event_type = 'task_review_spawn_requested'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it("binds result parsers to nonce/head/evidence and rejects a no-change fix", () => {
    const { db, policyHash } = setupDb();
    const row = verification(db);
    const evidenceHash = hashFleetVerificationEvidence(row);
    const expected = {
      nonceHash:
        "f59532b337268f3ab947c91c2d6c0ac10bb59e5c3b9f779b53120f0e94499605",
      runId: RUN_ID,
      taskId: TASK_ID,
      workerId: WORKER_ID,
      attempt: 1,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      verificationId: VERIFICATION_ID,
      verificationSpecHash: SPEC_HASH,
      verificationEvidenceHash: evidenceHash,
      policyHash,
      lens: "correctness_security" as const,
    };
    const text = JSON.stringify({
      schemaVersion: 1,
      nonce: REVIEW_NONCE,
      runId: RUN_ID,
      taskId: TASK_ID,
      workerId: WORKER_ID,
      attempt: 1,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      verificationId: VERIFICATION_ID,
      verificationSpecHash: SPEC_HASH,
      verificationEvidenceHash: evidenceHash,
      policyHash,
      lens: "correctness_security",
      verdict: "clean",
      findings: [],
    });
    expect(parseFleetTaskReviewResult(text, expected).ok).toBe(true);
    expect(
      parseFleetTaskReviewResult(text.replace(HEAD_SHA, NEW_HEAD_SHA), expected)
    ).toEqual({ ok: false, error: "task review headSha does not match" });

    const fixText = JSON.stringify({
      schemaVersion: 1,
      nonce: REVIEW_NONCE,
      runId: RUN_ID,
      taskId: TASK_ID,
      attempt: 1,
      round: 1,
      oldHeadSha: HEAD_SHA,
      verificationEvidenceHash: evidenceHash,
      policyHash,
      newHeadSha: HEAD_SHA,
      summary: "No change",
    });
    expect(
      parseFleetTaskFixResult(fixText, {
        nonceHash: expected.nonceHash,
        runId: RUN_ID,
        taskId: TASK_ID,
        attempt: 1,
        round: 1,
        oldHeadSha: HEAD_SHA,
        verificationEvidenceHash: evidenceHash,
        policyHash,
      })
    ).toEqual({
      ok: false,
      error: "automatic fixer did not create a new commit",
    });
  });

  it("requires four distinct clean zero-mutation lanes before ready_to_merge", async () => {
    const { db } = setupDb();
    const harness = runtime(db);
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnReview).toHaveBeenCalledTimes(4);
    expect(harness.delivered).toHaveLength(4);
    for (const item of harness.delivered) {
      expect(item.prompt).toContain(REVIEW_NONCE);
      expect(item.persistedPrompt).not.toContain(REVIEW_NONCE);
      expect(item.persistedPrompt).toContain("[redacted ephemeral nonce]");
      expect(item.prompt).toContain(
        join(
          stoaHomeDir(),
          "fleet-task-runtime",
          RUN_ID,
          TASK_ID,
          "1",
          "reviews"
        )
      );
    }

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    const task = db
      .prepare(
        `SELECT status, review_status, review_head_sha,
                review_verification_hash FROM fleet_tasks WHERE id = ?`
      )
      .get(TASK_ID) as Record<string, unknown>;
    expect(task).toMatchObject({
      status: "ready_to_merge",
      review_status: "clean",
      review_head_sha: HEAD_SHA,
      review_verification_hash: hashFleetVerificationEvidence(verification(db)),
    });
    const dto = toFleetTaskDto(
      db
        .prepare(`SELECT * FROM fleet_tasks WHERE id = ?`)
        .get(TASK_ID) as FleetTaskRow
    );
    expect(dto).toMatchObject({
      reviewStatus: "clean",
      reviewHeadSha: HEAD_SHA,
      reviewVerificationHash: hashFleetVerificationEvidence(verification(db)),
      fixRounds: 0,
      activeFixId: null,
      fixerSessionId: null,
      fixError: null,
    });
    const rows = db
      .prepare(`SELECT * FROM fleet_task_reviews ORDER BY lens`)
      .all() as FleetTaskReviewRow[];
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.reviewer_session_id)).size).toBe(4);
    expect(rows.every((row) => row.state === "clean")).toBe(true);
    expect(harness.removeWorktree).toHaveBeenCalledTimes(4);
  });

  it("retries a transient task-review launch after restart without spinning", async () => {
    const { db } = setupDb();
    const harness = runtime(db);
    harness.spawnReview.mockRejectedValueOnce(
      new Error("429 too many requests")
    );

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    let retry = db
      .prepare(
        `SELECT * FROM fleet_task_reviews
         WHERE state = 'pending' AND launch_failure_count = 1`
      )
      .get() as FleetTaskReviewRow;
    expect(retry).toMatchObject({
      retry_not_before: "2026-01-01T00:10:05.000Z",
      findings_json: "[]",
    });
    expect(harness.spawnReview).toHaveBeenCalledTimes(1);

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnReview).toHaveBeenCalledTimes(1);

    const restarted = runtime(db, {
      now: new Date("2026-01-01T00:10:05.000Z"),
      idPrefix: "review-restart",
    });
    await reconcileFleetTaskReviews(restarted.deps, { maxTasks: 1 });
    retry = db
      .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
      .get(retry.id) as FleetTaskReviewRow;
    expect(retry).toMatchObject({
      state: "running",
      launch_failure_count: 0,
      retry_not_before: null,
    });
    expect(restarted.spawnReview).toHaveBeenCalledTimes(4);
  });

  it("falls back across all review lanes and the fixer without leaking a foreign model", async () => {
    const { db } = setupDb({ automaticFixes: true });
    db.prepare(
      `UPDATE fleet_runs SET provider = 'hermes', model = 'kimi-k3'
       WHERE id = ?`
    ).run(RUN_ID);
    const harness = runtime(db, {
      installedProviders: ["codex"],
      verdict: (lens) =>
        lens === "correctness_security" ? "changes_requested" : "clean",
      newHead: NEW_HEAD_SHA,
    });

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnReview).toHaveBeenCalledTimes(4);
    for (const [request] of harness.spawnReview.mock.calls) {
      expect(request).toMatchObject({ provider: "codex", model: "gpt-5.5" });
    }
    expect(
      db
        .prepare(
          `SELECT provider, model, COUNT(*) AS count
           FROM fleet_task_reviews GROUP BY provider, model`
        )
        .all()
    ).toEqual([{ provider: "codex", model: "gpt-5.5", count: 4 }]);

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnFix).toHaveBeenCalledTimes(1);
    expect(harness.spawnFix.mock.calls[0][0]).toMatchObject({
      provider: "codex",
      model: "gpt-5.5",
    });
    expect(
      db
        .prepare(
          `SELECT provider, model FROM fleet_task_fixes WHERE task_id = ?`
        )
        .get(TASK_ID)
    ).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(
      db
        .prepare(
          `SELECT owner_type, provider, model FROM fleet_cost_accounts
           WHERE owner_type IN ('task_review', 'fixer')
           ORDER BY owner_type, owner_id`
        )
        .all()
    ).toEqual([
      { owner_type: "fixer", provider: "codex", model: "gpt-5.5" },
      ...Array.from({ length: 4 }, () => ({
        owner_type: "task_review",
        provider: "codex",
        model: "gpt-5.5",
      })),
    ]);
  });

  it("runs four task-review lanes in retryable waves when provider capacity is two", async () => {
    const { db } = setupDb();
    db.prepare(`UPDATE fleet_runs SET provider_caps_json = ? WHERE id = ?`).run(
      JSON.stringify({ codex: 2 }),
      RUN_ID
    );
    const harness = runtime(db);

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnReview).toHaveBeenCalledTimes(2);
    expect(
      db
        .prepare(
          `SELECT state, COUNT(*) AS count FROM fleet_task_reviews
           GROUP BY state ORDER BY state`
        )
        .all()
    ).toEqual([
      { state: "pending", count: 2 },
      { state: "running", count: 2 },
    ]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_task_reviews
           WHERE state = 'pending' AND error LIKE '%waiting for runtime capacity%'`
        )
        .get()
    ).toEqual({ count: 2 });

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnReview).toHaveBeenCalledTimes(4);
    expect(
      db
        .prepare(
          `SELECT state, COUNT(*) AS count FROM fleet_task_reviews
           GROUP BY state ORDER BY state`
        )
        .all()
    ).toEqual([
      { state: "clean", count: 2 },
      { state: "running", count: 2 },
    ]);

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(
      db
        .prepare(`SELECT status, review_status FROM fleet_tasks WHERE id = ?`)
        .get(TASK_ID)
    ).toEqual({ status: "ready_to_merge", review_status: "clean" });
    expect(
      db
        .prepare(
          `SELECT state, COUNT(*) AS count FROM fleet_task_reviews GROUP BY state`
        )
        .all()
    ).toEqual([{ state: "clean", count: 4 }]);
  });

  it("keeps budget-denied task reviews pending and starts them after a budget increase", async () => {
    const { db } = setupDb();
    db.prepare(`UPDATE fleet_runs SET budget_usd = 0.1 WHERE id = ?`).run(
      RUN_ID
    );
    const harness = runtime(db);

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnReview).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT state, COUNT(*) AS count FROM fleet_task_reviews
           WHERE error LIKE '%waiting for budget capacity%' GROUP BY state`
        )
        .all()
    ).toEqual([{ state: "pending", count: 4 }]);

    db.prepare(`UPDATE fleet_runs SET budget_usd = 10 WHERE id = ?`).run(
      RUN_ID
    );
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnReview).toHaveBeenCalledTimes(4);
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(
      db
        .prepare(`SELECT status, review_status FROM fleet_tasks WHERE id = ?`)
        .get(TASK_ID)
    ).toEqual({ status: "ready_to_merge", review_status: "clean" });
  });

  it("redacts task-review findings before reviews, artifacts, and fixes persist", async () => {
    const canary = "sk-TASKREVIEWCANARY012345";
    const { db } = setupDb({ automaticFixes: true });
    const harness = runtime(db, {
      verdict: (lens) =>
        lens === "correctness_security" ? "changes_requested" : "clean",
      findingCanary: canary,
    });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });

    const reviews = db
      .prepare(`SELECT findings_json, error FROM fleet_task_reviews`)
      .all();
    const artifacts = db
      .prepare(
        `SELECT title, body FROM fleet_artifacts
         WHERE artifact_type IN ('task_review_result', 'task_review_finding')`
      )
      .all();
    const fixes = db
      .prepare(`SELECT findings_json, error FROM fleet_task_fixes`)
      .all();
    const events = db.prepare(`SELECT payload FROM fleet_events`).all();
    expect(JSON.stringify({ reviews, artifacts, fixes, events })).not.toContain(
      canary
    );
    expect(JSON.stringify({ reviews, artifacts, fixes })).toContain(
      "[REDACTED]"
    );
  });

  it("keeps four exact-head task review lanes for existing manual-policy runs", async () => {
    const { db } = setupDb({ reviewPolicy: "manual" });
    const harness = runtime(db);

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnReview).toHaveBeenCalledTimes(4);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_task_reviews
           WHERE task_id = ? AND head_sha = ?`
        )
        .get(TASK_ID, HEAD_SHA)
    ).toEqual({ count: 4 });

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(
      db
        .prepare(
          `SELECT status, failure_code, review_status, review_head_sha
           FROM fleet_tasks WHERE id = ?`
        )
        .get(TASK_ID)
    ).toEqual({
      status: "ready_to_merge",
      failure_code: null,
      review_status: "clean",
      review_head_sha: HEAD_SHA,
    });
    const rows = db
      .prepare(
        `SELECT lens, reviewer_session_id, state
         FROM fleet_task_reviews WHERE task_id = ? ORDER BY lens ASC`
      )
      .all(TASK_ID) as Array<{
      lens: string;
      reviewer_session_id: string;
      state: string;
    }>;
    expect(rows.map((row) => row.lens).sort()).toEqual(
      [...FLEET_PLAN_REVIEW_LENSES].sort()
    );
    expect(new Set(rows.map((row) => row.reviewer_session_id)).size).toBe(4);
    expect(rows.every((row) => row.state === "clean")).toBe(true);
  });

  it("fails closed on stale passing evidence without spawning reviewers", async () => {
    const { db } = setupDb();
    db.prepare(`UPDATE fleet_tasks SET verified_head_sha = ? WHERE id = ?`).run(
      BASE_SHA,
      TASK_ID
    );
    const harness = runtime(db);
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnReview).not.toHaveBeenCalled();
    expect(
      db
        .prepare(`SELECT status, failure_code FROM fleet_tasks WHERE id = ?`)
        .get(TASK_ID)
    ).toEqual({
      status: "needs_inspection",
      failure_code: "task_review_verification_stale",
    });
  });

  it("turns reviewer mutation into an exact-head blocker when fixes are disabled", async () => {
    const { db } = setupDb();
    const harness = runtime(db, {
      mutate: (row) => row.lens === "adversarial_red_team",
    });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(
      db
        .prepare(`SELECT status, fix_error FROM fleet_tasks WHERE id = ?`)
        .get(TASK_ID)
    ).toMatchObject({
      status: "needs_inspection",
      fix_error: "automatic fixes are disabled",
    });
    const blocker = db
      .prepare(
        `SELECT head_sha, severity, metadata_json FROM fleet_artifacts
         WHERE artifact_type = 'task_review_finding' AND severity = 'blocker'`
      )
      .get() as { head_sha: string; severity: string; metadata_json: string };
    expect(blocker.head_sha).toBe(HEAD_SHA);
    expect(JSON.parse(blocker.metadata_json)).toMatchObject({
      verificationId: VERIFICATION_ID,
      verificationEvidenceHash: hashFleetVerificationEvidence(verification(db)),
    });
  });

  it("recovers a partial reviewer spawn, times it out, and cleans it safely", async () => {
    const { db, policyHash } = setupDb();
    const evidenceHash = hashFleetVerificationEvidence(verification(db));
    const resultPath = taskRuntimeResultPath("reviews", "recover");
    const branch = generateBranchName(
      `fleet-tr-${RUN_ID.slice(0, 8)}-recover-correctness_security`
    );
    for (const [index, lens] of FLEET_PLAN_REVIEW_LENSES.entries()) {
      db.prepare(
        `INSERT INTO fleet_task_reviews
         (id, fleet_run_id, task_id, worker_id, attempt, base_sha, head_sha,
          verification_id, verification_spec_hash, verification_evidence_hash,
          policy_hash, lens, reviewer_session_id, verdict, state, request_id,
          nonce_hash, result_path, result_verdict, project_path,
          reviewer_worktree_path, reviewer_branch_name, findings_json,
          started_at, deadline_at, completed_at, updated_at, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recover', '', ?,
           ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`
      ).run(
        `review-${index}`,
        RUN_ID,
        TASK_ID,
        WORKER_ID,
        BASE_SHA,
        HEAD_SHA,
        VERIFICATION_ID,
        SPEC_HASH,
        evidenceHash,
        policyHash,
        lens,
        index === 0 ? "" : `existing-session-${index}`,
        index === 0 ? "changes_requested" : "clean",
        index === 0 ? "spawning" : "clean",
        index === 0 ? resultPath : "",
        index === 0 ? null : "clean",
        PROJECT_PATH,
        index === 0 ? null : join(PROJECT_PATH, `.old-review-${index}`),
        index === 0 ? branch : `old-branch-${index}`,
        "2025-12-31T00:00:00.000Z",
        "2025-12-31T00:01:00.000Z",
        index === 0 ? null : "2025-12-31T00:02:00.000Z",
        "2025-12-31T00:00:00.000Z",
        "2025-12-31T00:00:00.000Z"
      );
    }
    insertFleetOwnedSession(db, {
      runId: RUN_ID,
      ownerType: "task_review",
      ownerId: "recover",
      sessionId: "recovered-session",
      provider: "codex",
      model: null,
      approvalMode: "full-bypass",
      workingDirectory: join(PROJECT_PATH, ".recovered-review"),
      workerTask: `Persisted prompt ${resultPath}`,
      worktreePath: join(PROJECT_PATH, ".recovered-review"),
      branchName: branch,
      baseBranch: HEAD_SHA,
    });
    const removeWorktree = vi.fn(async () => {});
    await reconcileFleetTaskReviews(
      {
        ...runtime(db).deps,
        readResult: async () => ({
          ok: false as const,
          error: "missing",
          missing: true,
        }),
        sessionExists: async () => false,
        removeWorktree,
      },
      { maxTasks: 1 }
    );
    expect(removeWorktree).toHaveBeenCalledWith(
      join(PROJECT_PATH, ".recovered-review"),
      PROJECT_PATH,
      true
    );
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "needs_inspection" });
  });

  it("fails closed when restart recovery finds a Kilo task reviewer", async () => {
    const { db } = setupDb();
    const harness = runtime(db);
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    const row = db
      .prepare(
        `SELECT * FROM fleet_task_reviews
         WHERE task_id = ? AND lens = 'correctness_security'`
      )
      .get(TASK_ID) as FleetTaskReviewRow;
    db.prepare(
      `UPDATE fleet_task_reviews
       SET state = 'spawning', provider = 'kilo', reviewer_session_id = '',
           reviewer_worktree_path = NULL
       WHERE id = ?`
    ).run(row.id);
    db.prepare(
      `UPDATE fleet_cost_accounts SET provider = 'kilo', session_id = NULL
       WHERE fleet_run_id = ? AND owner_type = 'task_review' AND owner_id = ?`
    ).run(RUN_ID, row.request_id);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(
      row.reviewer_session_id
    );
    db.prepare(
      `UPDATE fleet_runtime_leases SET resource_key = 'kilo'
       WHERE fleet_run_id = ? AND owner_type = 'task_review' AND owner_id = ?
         AND resource_type = 'provider'`
    ).run(RUN_ID, row.request_id);
    insertFleetOwnedSession(db, {
      runId: RUN_ID,
      ownerType: "task_review",
      ownerId: row.request_id,
      sessionId: "recovered-kilo-reviewer",
      provider: "kilo",
      model: null,
      approvalMode: "full-bypass",
      workingDirectory: join(PROJECT_PATH, ".recovered-kilo-review"),
      workerTask: `Persisted prompt ${row.result_path}`,
      worktreePath: join(PROJECT_PATH, ".recovered-kilo-review"),
      branchName: row.reviewer_branch_name,
      baseBranch: HEAD_SHA,
    });
    const stopSession = vi.fn(async () => true);

    await reconcileFleetTaskReviews(
      { ...harness.deps, stopSession },
      { maxTasks: 1 }
    );

    expect(stopSession).toHaveBeenCalledWith(
      "recovered-kilo-reviewer",
      "failed"
    );
    expect(harness.removeWorktree).toHaveBeenCalledWith(
      join(PROJECT_PATH, ".recovered-kilo-review"),
      PROJECT_PATH,
      true
    );
    expect(
      db
        .prepare(
          `SELECT state, reviewer_session_id, error,
                  completed_at IS NOT NULL AS completed
           FROM fleet_task_reviews WHERE id = ?`
        )
        .get(row.id)
    ).toEqual({
      state: "changes_requested",
      reviewer_session_id: "recovered-kilo-reviewer",
      error: "persisted task reviewer provider cannot run unattended",
      completed: 1,
    });
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "needs_inspection" });
    expect(
      db
        .prepare(
          `SELECT session_id,
                  reservation_released_at IS NOT NULL AS released,
                  terminal_at IS NOT NULL AS terminal
           FROM fleet_cost_accounts
           WHERE fleet_run_id = ? AND owner_type = 'task_review'
             AND owner_id = ?`
        )
        .get(RUN_ID, row.request_id)
    ).toEqual({ session_id: null, released: 1, terminal: 1 });
  });

  it("rolls back fixer admission when the pending-row claim cannot persist", async () => {
    const { db } = setupDb({ automaticFixes: true });
    const harness = runtime(db, {
      verdict: (lens) =>
        lens === "correctness_security" ? "changes_requested" : "clean",
    });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(db.prepare(`SELECT state FROM fleet_task_fixes`).get()).toEqual({
      state: "pending",
    });
    db.exec(`
      CREATE TRIGGER reject_fixer_claim
      BEFORE UPDATE ON fleet_task_fixes
      WHEN NEW.state = 'spawning'
      BEGIN
        SELECT RAISE(ABORT, 'rejected fixer claim');
      END
    `);

    await expect(
      reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 })
    ).rejects.toThrow(/rejected fixer claim/);

    expect(db.prepare(`SELECT state FROM fleet_task_fixes`).get()).toEqual({
      state: "pending",
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_cost_accounts
           WHERE owner_type = 'fixer'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'fixer'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it("settles a rejected fixer activation when the spawned session is already gone", async () => {
    const { db } = setupDb({ automaticFixes: true });
    const harness = runtime(db, {
      verdict: (lens) =>
        lens === "correctness_security" ? "changes_requested" : "clean",
    });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    const spawnFix = harness.deps.spawnFix!;

    await reconcileFleetTaskReviews(
      {
        ...harness.deps,
        spawnFix: async (input) => {
          const spawned = await spawnFix(input);
          db.prepare(
            `UPDATE fleet_runtime_leases SET lease_expires_at = ?
             WHERE owner_type = 'fixer' AND status = 'reserved'`
          ).run("2025-01-01T00:00:00.000Z");
          return spawned;
        },
        stopSession: async () => false,
        sessionExists: async () => false,
      },
      { maxTasks: 1 }
    );

    expect(db.prepare(`SELECT state FROM fleet_task_fixes`).get()).toEqual({
      state: "failed",
    });
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "needs_inspection" });
    expect(
      db
        .prepare(
          `SELECT reservation_released_at IS NOT NULL AS released,
                  terminal_at IS NOT NULL AS terminal
           FROM fleet_cost_accounts WHERE owner_type = 'fixer'`
        )
        .get()
    ).toEqual({ released: 1, terminal: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'fixer' AND status = 'reserved'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it("rolls back terminal fixer state until cost and resource settlement succeeds", async () => {
    const { db } = setupDb({ automaticFixes: true });
    const harness = runtime(db, {
      verdict: (lens) =>
        lens === "correctness_security" ? "changes_requested" : "clean",
      newHead: NEW_HEAD_SHA,
    });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(db.prepare(`SELECT state FROM fleet_task_fixes`).get()).toEqual({
      state: "running",
    });
    db.exec(`
      CREATE TRIGGER reject_fixer_settlement
      BEFORE UPDATE ON fleet_cost_accounts
      WHEN OLD.owner_type = 'fixer'
        AND OLD.reservation_released_at IS NULL
        AND NEW.reservation_released_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'rejected fixer settlement');
      END
    `);

    await expect(
      reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 })
    ).rejects.toThrow(/rejected fixer settlement/);

    expect(db.prepare(`SELECT state FROM fleet_task_fixes`).get()).toEqual({
      state: "running",
    });
    expect(
      db
        .prepare(
          `SELECT status, head_sha, active_fix_id FROM fleet_tasks WHERE id = ?`
        )
        .get(TASK_ID)
    ).toMatchObject({
      status: "fixing",
      head_sha: HEAD_SHA,
      active_fix_id: expect.any(String),
    });
    expect(
      db
        .prepare(
          `SELECT reservation_released_at FROM fleet_cost_accounts
           WHERE owner_type = 'fixer'`
        )
        .get()
    ).toEqual({ reservation_released_at: null });
    db.exec(`DROP TRIGGER reject_fixer_settlement`);

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });

    expect(db.prepare(`SELECT state FROM fleet_task_fixes`).get()).toEqual({
      state: "completed",
    });
    expect(
      db
        .prepare(
          `SELECT reservation_released_at IS NOT NULL AS released
           FROM fleet_cost_accounts WHERE owner_type = 'fixer'`
        )
        .get()
    ).toEqual({ released: 1 });
  });

  it("settles a terminal fixer reservation stranded before restart", async () => {
    const { db, policyHash } = setupDb({ automaticFixes: true });
    const harness = runtime(db);
    const now = new Date("2026-01-01T00:10:00.000Z");
    const run = db
      .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
      .get(RUN_ID) as FleetRunRow;
    expect(
      reserveFleetPaidSession(db, {
        run,
        ownerType: "fixer",
        ownerId: "stranded-fix-request",
        taskId: TASK_ID,
        taskType: "fix",
        provider: "codex",
        model: null,
        repositoryKey: PROJECT_PATH,
        now,
        leaseExpiresAt: new Date(now.getTime() + 90_000).toISOString(),
      })
    ).toMatchObject({ admitted: true });
    db.prepare(
      `INSERT INTO fleet_task_fixes
       (id, fleet_run_id, task_id, attempt, round, old_head_sha, policy_hash,
        verification_evidence_hash, state, request_id, completed_at, updated_at)
       VALUES ('stranded-fix', ?, ?, 1, 1, ?, ?, 'evidence', 'failed',
         'stranded-fix-request', ?, ?)`
    ).run(
      RUN_ID,
      TASK_ID,
      HEAD_SHA,
      policyHash,
      now.toISOString(),
      now.toISOString()
    );

    await reconcileFleetTaskReviews(harness.deps, {
      runId: "different-run",
      maxTasks: 1,
    });

    expect(
      db
        .prepare(
          `SELECT reservation_released_at IS NOT NULL AS released,
                  terminal_at IS NOT NULL AS terminal
           FROM fleet_cost_accounts
           WHERE owner_type = 'fixer' AND owner_id = 'stranded-fix-request'`
        )
        .get()
    ).toEqual({ released: 1, terminal: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'fixer' AND owner_id = 'stranded-fix-request'
             AND status = 'reserved'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `SELECT reserved_budget_usd, reserved_budget_tokens
           FROM fleet_runs WHERE id = ?`
        )
        .get(RUN_ID)
    ).toEqual({ reserved_budget_usd: 0, reserved_budget_tokens: 0 });
  });

  it("retries a transient fixer launch after restart without abandoning the task", async () => {
    const { db } = setupDb({ automaticFixes: true });
    const harness = runtime(db, {
      verdict: (lens) =>
        lens === "correctness_security" ? "changes_requested" : "clean",
    });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    harness.spawnFix.mockRejectedValueOnce(new Error("429 too many requests"));

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    let retry = db
      .prepare(`SELECT * FROM fleet_task_fixes WHERE task_id = ?`)
      .get(TASK_ID) as FleetTaskFixRow;
    expect(retry).toMatchObject({
      state: "pending",
      launch_failure_count: 1,
      retry_not_before: "2026-01-01T00:10:05.000Z",
    });
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "fixing" });
    expect(harness.spawnFix).toHaveBeenCalledTimes(1);

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnFix).toHaveBeenCalledTimes(1);

    const restarted = runtime(db, {
      now: new Date("2026-01-01T00:10:05.000Z"),
      idPrefix: "fix-restart",
    });
    await reconcileFleetTaskReviews(restarted.deps, { maxTasks: 1 });
    retry = db
      .prepare(`SELECT * FROM fleet_task_fixes WHERE id = ?`)
      .get(retry.id) as FleetTaskFixRow;
    expect(retry).toMatchObject({
      state: "running",
      launch_failure_count: 0,
      retry_not_before: null,
    });
    expect(restarted.spawnFix).toHaveBeenCalledTimes(1);
  });

  it("fails closed when restart recovery finds a Kilo automatic fixer", async () => {
    const { db } = setupDb({ automaticFixes: true });
    const harness = runtime(db, {
      verdict: (lens) =>
        lens === "correctness_security" ? "changes_requested" : "clean",
    });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    const row = db
      .prepare(`SELECT * FROM fleet_task_fixes WHERE task_id = ?`)
      .get(TASK_ID) as FleetTaskFixRow;
    const run = db
      .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
      .get(RUN_ID) as FleetRunRow;
    const requestId = "recovered-kilo-fix-request";
    const resultPath = taskRuntimeResultPath("fixes", requestId);
    const now = new Date("2026-01-01T00:10:00.000Z");
    expect(
      reserveFleetPaidSession(db, {
        run,
        ownerType: "fixer",
        ownerId: requestId,
        taskId: TASK_ID,
        taskType: "fix",
        provider: "kilo",
        model: null,
        repositoryKey: PROJECT_PATH,
        now,
        leaseExpiresAt: new Date(now.getTime() + 90_000).toISOString(),
      })
    ).toMatchObject({ admitted: true });
    db.prepare(
      `UPDATE fleet_task_fixes
       SET state = 'spawning', provider = 'kilo', request_id = ?,
           nonce_hash = 'recovered', result_path = ?, fixer_session_id = '',
           started_at = ?, deadline_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      requestId,
      resultPath,
      now.toISOString(),
      new Date(now.getTime() + 20 * 60_000).toISOString(),
      now.toISOString(),
      row.id
    );
    insertFleetOwnedSession(db, {
      runId: RUN_ID,
      ownerType: "fixer",
      ownerId: requestId,
      sessionId: "recovered-kilo-fixer",
      provider: "kilo",
      model: null,
      approvalMode: "full-bypass",
      workingDirectory: row.worktree_path!,
      workerTask: `Persisted prompt ${resultPath}`,
      worktreePath: row.worktree_path!,
      branchName: row.branch_name,
      baseBranch: "main",
    });
    const stopSession = vi.fn(async () => true);
    const removeResult = vi.fn(async () => true);

    await reconcileFleetTaskReviews(
      { ...harness.deps, stopSession, removeResult },
      { maxTasks: 1 }
    );

    expect(harness.spawnFix).not.toHaveBeenCalled();
    expect(stopSession).toHaveBeenCalledWith("recovered-kilo-fixer", "failed");
    expect(removeResult).toHaveBeenCalledWith(resultPath);
    expect(
      db
        .prepare(
          `SELECT state, fixer_session_id, error,
                  completed_at IS NOT NULL AS completed
           FROM fleet_task_fixes WHERE id = ?`
        )
        .get(row.id)
    ).toEqual({
      state: "failed",
      fixer_session_id: "recovered-kilo-fixer",
      error: "persisted automatic fixer provider cannot run unattended",
      completed: 1,
    });
    expect(
      db
        .prepare(
          `SELECT status, failure_code, active_fix_id FROM fleet_tasks
           WHERE id = ?`
        )
        .get(TASK_ID)
    ).toEqual({
      status: "needs_inspection",
      failure_code: "automatic_fix_failed",
      active_fix_id: null,
    });
    expect(
      db
        .prepare(
          `SELECT session_id,
                  reservation_released_at IS NOT NULL AS released,
                  terminal_at IS NOT NULL AS terminal
           FROM fleet_cost_accounts
           WHERE fleet_run_id = ? AND owner_type = 'fixer' AND owner_id = ?`
        )
        .get(RUN_ID, requestId)
    ).toEqual({ session_id: null, released: 1, terminal: 1 });
  });

  it("uses the owned worktree for one bounded fix, invalidates old evidence, and preserves blockers", async () => {
    const { db } = setupDb({ automaticFixes: true });
    const harness = runtime(db, {
      verdict: (lens) =>
        lens === "correctness_security" ? "changes_requested" : "clean",
      newHead: NEW_HEAD_SHA,
    });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(
      db
        .prepare(`SELECT status, fix_rounds FROM fleet_tasks WHERE id = ?`)
        .get(TASK_ID)
    ).toEqual({ status: "fixing", fix_rounds: 1 });
    db.prepare(`UPDATE fleet_runs SET status = 'merging' WHERE id = ?`).run(
      RUN_ID
    );
    const oldBlocker = db
      .prepare(
        `SELECT id, severity, body, metadata_json FROM fleet_artifacts
         WHERE artifact_type = 'task_review_finding' AND severity = 'blocker'`
      )
      .get() as Record<string, unknown>;

    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });
    expect(harness.spawnFix).toHaveBeenCalledTimes(1);
    expect(harness.spawnFix.mock.calls[0][0].row.worktree_path).toBe(
      TASK_WORKTREE
    );
    await reconcileFleetTaskReviews(harness.deps, { maxTasks: 1 });

    expect(
      db
        .prepare(
          `SELECT status, head_sha, verification_id, verification_status,
                  review_status, review_head_sha, active_fix_id, fix_rounds
           FROM fleet_tasks WHERE id = ?`
        )
        .get(TASK_ID)
    ).toEqual({
      status: "verifying",
      head_sha: NEW_HEAD_SHA,
      verification_id: null,
      verification_status: null,
      review_status: null,
      review_head_sha: null,
      active_fix_id: null,
      fix_rounds: 1,
    });
    expect(
      db
        .prepare(
          `SELECT id, severity, body, metadata_json FROM fleet_artifacts WHERE id = ?`
        )
        .get(oldBlocker.id)
    ).toEqual(oldBlocker);
    const resolution = db
      .prepare(
        `SELECT head_sha, severity, metadata_json FROM fleet_artifacts
         WHERE artifact_type = 'task_review_resolution'`
      )
      .get() as { head_sha: string; severity: string; metadata_json: string };
    expect(resolution).toMatchObject({
      head_sha: NEW_HEAD_SHA,
      severity: "info",
    });
    expect(JSON.parse(resolution.metadata_json)).toMatchObject({
      oldHeadSha: HEAD_SHA,
      newHeadSha: NEW_HEAD_SHA,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_task_fixes`).get()
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          `SELECT reservation_released_at IS NOT NULL AS released,
                  terminal_at IS NOT NULL AS terminal
           FROM fleet_cost_accounts WHERE owner_type = 'fixer'`
        )
        .get()
    ).toEqual({ released: 1, terminal: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'fixer' AND status = 'reserved'`
        )
        .get()
    ).toEqual({ count: 0 });
  });
});
