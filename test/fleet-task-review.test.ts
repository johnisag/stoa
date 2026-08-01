import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import {
  DEFAULT_FLEET_AUTOMATION_POLICY,
  fleetAutomationPolicyJson,
} from "@/lib/fleet/automation-policy";
import { generateBranchName } from "@/lib/git";
import type { FleetGitState } from "@/lib/fleet/git-state";
import { hashFleetAutomationPolicy } from "@/lib/fleet/hash";
import { toFleetTaskDto } from "@/lib/fleet/engine";
import {
  FLEET_PLAN_REVIEW_LENSES,
  type FleetPlanReviewFinding,
} from "@/lib/fleet/plan-review";
import {
  hashFleetVerificationEvidence,
  parseFleetTaskFixResult,
  parseFleetTaskReviewResult,
  reconcileFleetTaskReviews,
  type FleetTaskReviewDeps,
} from "@/lib/fleet/task-review";
import type {
  FleetAutomationPolicy,
  FleetTaskRow,
  FleetTaskReviewRow,
  FleetVerificationRow,
} from "@/lib/fleet/types";

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
const PROJECT_PATH = "C:\\repo";
const TASK_WORKTREE = "C:\\repo\\.stoa-worktrees\\task-1";
const TASK_BRANCH = "fleet-task-1";

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
  verdict: "clean" | "changes_requested"
): string {
  const findings: FleetPlanReviewFinding[] =
    verdict === "clean"
      ? []
      : [
          {
            severity: "blocker",
            title: "Broken edge case",
            body: "Handle the exact failure before merge.",
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
    return {
      id: `review-session-${request.lens}`,
      worktree_path: `C:\\review-${request.lens}`,
      branch_name: generateBranchName(request.branchFeature),
    };
  });
  const spawnFix = vi.fn(async (request) => {
    const sessionId = "fix-session-1";
    db.prepare(
      `INSERT OR IGNORE INTO sessions
       (id, name, tmux_name, agent_type, model, status, working_directory,
        worker_task, worker_status, created_at, updated_at)
       VALUES (?, 'fixer', ?, 'codex', '', 'running', ?, ?, 'running', ?, ?)`
    ).run(
      sessionId,
      `codex-${sessionId}`,
      TASK_WORKTREE,
      request.persistedPrompt,
      "2026-01-01T00:10:00.000Z",
      "2026-01-01T00:10:00.000Z"
    );
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
      now: () => new Date("2026-01-01T00:10:00.000Z"),
      randomId: () => `runtime-${++id}`,
      randomNonce: () => REVIEW_NONCE,
      prepareResultPath: async ({ kind, requestId }) =>
        `C:\\fleet-task-runtime\\${kind}\\${requestId}.json`,
      readResult: async (path) => {
        if (path.includes("\\fixes\\")) {
          const row = db
            .prepare(`SELECT * FROM fleet_task_fixes WHERE result_path = ?`)
            .get(path) as {
            fleet_run_id: string;
            task_id: string;
            attempt: number;
            round: number;
            old_head_sha: string;
            verification_evidence_hash: string;
            policy_hash: string;
          };
          const text = JSON.stringify({
            schemaVersion: 1,
            nonce: REVIEW_NONCE,
            runId: row.fleet_run_id,
            taskId: row.task_id,
            attempt: row.attempt,
            round: row.round,
            oldHeadSha: row.old_head_sha,
            verificationEvidenceHash: row.verification_evidence_hash,
            policyHash: row.policy_hash,
            newHeadSha: input.newHead ?? NEW_HEAD_SHA,
            summary: "Committed the scoped correction.",
          });
          return { ok: true as const, text, bytes: Buffer.byteLength(text) };
        }
        const row = db
          .prepare(`SELECT * FROM fleet_task_reviews WHERE result_path = ?`)
          .get(path) as FleetTaskReviewRow;
        const text = resultForRow(row, input.verdict?.(row.lens) ?? "clean");
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

describe("Fleet exact-SHA task review and automatic fix runtime", () => {
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
      expect(item.prompt).toContain("C:\\fleet-task-runtime\\reviews\\");
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
    const resultPath = "C:\\fleet-task-runtime\\reviews\\recovered-review.json";
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
        index === 0 ? null : `C:\\old-review-${index}`,
        index === 0 ? branch : `old-branch-${index}`,
        "2025-12-31T00:00:00.000Z",
        "2025-12-31T00:01:00.000Z",
        index === 0 ? null : "2025-12-31T00:02:00.000Z",
        "2025-12-31T00:00:00.000Z",
        "2025-12-31T00:00:00.000Z"
      );
    }
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, agent_type, model, status, working_directory,
        worker_task, worker_status, worktree_path, branch_name, created_at,
        updated_at)
       VALUES ('recovered-session', 'review', 'codex-review', 'codex', '',
         'running', ?, ?, 'running', ?, ?, ?, ?)`
    ).run(
      `C:\\recovered-review`,
      `Persisted prompt ${resultPath}`,
      `C:\\recovered-review`,
      branch,
      "2025-12-31T00:00:00.000Z",
      "2025-12-31T00:00:00.000Z"
    );
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
      `C:\\recovered-review`,
      PROJECT_PATH,
      true
    );
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "needs_inspection" });
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
  });
});
