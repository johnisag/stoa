import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import {
  collectFleetWorkerReport,
  nextFleetReportPollAt,
} from "@/lib/fleet/report-runtime";
import { hashFleetReportNonce } from "@/lib/fleet/report";
import {
  reconcileFleetRun,
  reconcileFleetWorkerReport,
} from "@/lib/fleet/scheduler";
import type {
  FleetClaimDriftResult,
  FleetGitState,
} from "@/lib/fleet/git-state";
import type { FleetTaskCompletionReport } from "@/lib/fleet/report";
import { insertFleetOwnedSession } from "./fleet-session-fixture";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const NONCE = "n".repeat(43);
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function report(
  overrides: Partial<FleetTaskCompletionReport> & { nonce?: string } = {}
) {
  return JSON.stringify({
    schemaVersion: 1,
    runId: "run-1",
    taskId: "task-1",
    workerId: "worker-1",
    attempt: 1,
    spawnRequestId: "run-1:task-1:1",
    nonce: NONCE,
    baseSha: BASE,
    headSha: HEAD,
    submittedAt: "2026-08-01T11:59:00.000Z",
    status: "succeeded",
    summary: "Implemented the task",
    filesChanged: ["lib/a.ts"],
    verification: [],
    risks: [],
    followUps: [],
    mergeReadiness: "ready",
    markdown: "",
    ...overrides,
  });
}

function gitState(overrides: Partial<FleetGitState> = {}): FleetGitState {
  return {
    repositoryRoot: "C:\\repo",
    baseSha: BASE,
    headSha: HEAD,
    currentBranch: "feature/fleet-task",
    committedChanges: [
      {
        kind: "modified",
        path: "lib/a.ts",
        previousPath: null,
        status: "M",
        insertions: 2,
        deletions: 1,
        binary: false,
      },
    ],
    committedPaths: ["lib/a.ts"],
    stagedChanges: [],
    unstagedChanges: [],
    dirtyTrackedPaths: [],
    untrackedPaths: [],
    allTouchedPaths: ["lib/a.ts"],
    sensitivePaths: [],
    summary: {
      committedFiles: 1,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      insertions: 2,
      deletions: 1,
      binaryFiles: 0,
      renamedFiles: 0,
      touchedPathSample: ["lib/a.ts"],
      touchedPathsTruncated: false,
    },
    ...overrides,
  };
}

const expected = {
  runId: "run-1",
  taskId: "task-1",
  workerId: "worker-1",
  attempt: 1,
  spawnRequestId: "run-1:task-1:1",
  nonceHash: hashFleetReportNonce(NONCE),
  baseSha: BASE,
  spawnedAt: "2026-08-01T11:00:00.000Z",
};

function runtimeDeps(state = gitState()) {
  return {
    readArtifact: vi.fn(async () => ({
      ok: true as const,
      text: report(),
      bytes: Buffer.byteLength(report()),
    })),
    collectGitState: vi.fn(async () => state),
  };
}

describe("Fleet worker report collection", () => {
  it("accepts an authenticated clean committed report and requests verification", async () => {
    const deps = runtimeDeps();
    const result = await collectFleetWorkerReport(
      {
        reportPath: "C:\\fleet\\report.json",
        worktreePath: "C:\\worktree",
        expected,
        plannedClaims: ["lib"],
        allowSensitivePaths: false,
        nowMs: NOW.getTime(),
      },
      deps
    );
    expect(result).toMatchObject({
      kind: "collected",
      taskStatus: "verifying",
      failureCode: null,
    });
    expect(deps.collectGitState).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha: BASE, expectedHeadSha: HEAD })
    );
  });

  it("rejects wrong identity and replay nonce before trusting testimony", async () => {
    const state = gitState();
    for (const text of [
      report({ taskId: "task-other" }),
      report({ nonce: "x".repeat(43) }),
    ]) {
      const result = await collectFleetWorkerReport(
        {
          reportPath: "C:\\fleet\\report.json",
          worktreePath: "C:\\worktree",
          expected,
          plannedClaims: ["lib"],
          allowSensitivePaths: false,
          nowMs: NOW.getTime(),
        },
        {
          readArtifact: async () => ({
            ok: true,
            text,
            bytes: Buffer.byteLength(text),
          }),
          collectGitState: async () => state,
        }
      );
      expect(result).toMatchObject({ kind: "invalid", gitState: state });
    }
  });

  it("quarantines dirty worktrees and claim drift", async () => {
    const dirty = gitState({
      unstagedChanges: [
        {
          kind: "modified",
          path: "lib/a.ts",
          previousPath: null,
          status: "M",
        },
      ],
      dirtyTrackedPaths: ["lib/a.ts"],
    });
    const dirtyResult = await collectFleetWorkerReport(
      {
        reportPath: "C:\\fleet\\report.json",
        worktreePath: "C:\\worktree",
        expected,
        plannedClaims: ["lib"],
        allowSensitivePaths: false,
        nowMs: NOW.getTime(),
      },
      runtimeDeps(dirty)
    );
    expect(dirtyResult).toMatchObject({
      kind: "collected",
      taskStatus: "needs_inspection",
      failureCode: "dirty_worktree",
    });

    const driftResult = await collectFleetWorkerReport(
      {
        reportPath: "C:\\fleet\\report.json",
        worktreePath: "C:\\worktree",
        expected,
        plannedClaims: ["test"],
        allowSensitivePaths: false,
        nowMs: NOW.getTime(),
      },
      runtimeDeps()
    );
    expect(driftResult).toMatchObject({
      kind: "collected",
      taskStatus: "needs_inspection",
      failureCode: "claim_drift",
    });
  });

  it("uses bounded exponential report polling", () => {
    expect(nextFleetReportPollAt(0, NOW.getTime())).toBe(
      "2026-08-01T12:00:01.000Z"
    );
    expect(nextFleetReportPollAt(100, NOW.getTime())).toBe(
      "2026-08-01T12:00:30.000Z"
    );
  });
});

let db: InstanceType<typeof Database>;

function addRuntimeRun(status = "paused") {
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, approval_state, approved_plan_hash, provider,
      max_concurrency, reserved_budget_usd, settings_json)
     VALUES ('run-1', 'Fleet', 'Ship', ?, 'approved', 'plan-hash', 'codex', 40, 0.25, '{}')`
  ).run(status);
}

function addRuntimeWorker(index: number) {
  const taskId = `task-${index}`;
  const workerId = `worker-${index}`;
  const sessionId = `session-${index}`;
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, status, task_type, sort_order, file_claims_json,
      approval_state, working_directory, base_sha, worktree_path,
      current_attempt)
     VALUES (?, 'run-1', ?, 'running', 'task', ?, '["lib"]', 'approved',
      'C:\\repo', ?, ?, 1)`
  ).run(taskId, taskId, index, BASE, `C:\\wt\\${index}`);
  db.prepare(
    `INSERT INTO fleet_task_claims
     (id, fleet_run_id, task_id, path, claim_type, confidence)
     VALUES (?, 'run-1', ?, 'lib', 'exclusive', 1)`
  ).run(`claim-${index}`, taskId);
  insertFleetOwnedSession(db, {
    runId: "run-1",
    ownerType: "worker",
    ownerId: workerId,
    sessionId,
    provider: "codex",
    model: null,
    approvalMode: "full-bypass",
    workingDirectory: `C:\\wt\\${index}`,
    workerTask: `Fleet report runtime worker ${index}`,
    worktreePath: `C:\\wt\\${index}`,
    branchName: `feature/${index}`,
    baseBranch: BASE,
    conductorSessionId: null,
    fleetOwnershipKey: null,
  });
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, session_id, status, provider, attempt,
      spawn_request_id, worktree_path, branch_name, base_sha, report_path,
      report_nonce_hash, report_state, report_next_poll_at, reservation_usd,
      created_at)
     VALUES (?, 'run-1', ?, ?, 'running', 'codex', 1, ?, ?, ?, ?, ?, ?,
      'pending', ?, 0.25, ?)`
  ).run(
    workerId,
    taskId,
    sessionId,
    `run-1:${taskId}:1`,
    `C:\\wt\\${index}`,
    `feature/${index}`,
    BASE,
    `C:\\fleet\\${index}\\report.json`,
    hashFleetReportNonce(NONCE),
    NOW.toISOString(),
    "2026-08-01T11:00:00.000Z"
  );
  return { taskId, workerId, sessionId };
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
});

describe("Fleet report scheduler integration", () => {
  it("persists evidence once, stops the session, and advances a write to verifying", async () => {
    addRuntimeRun();
    const { taskId, workerId } = addRuntimeWorker(1);
    const state = gitState({ currentBranch: "feature/1" });
    const drift: FleetClaimDriftResult = {
      normalizedClaims: ["lib"],
      actualPaths: ["lib/a.ts"],
      coveredPaths: ["lib/a.ts"],
      driftPaths: [],
      invalidClaims: [],
      invalidActualPaths: [],
      sensitivePaths: [],
      unknownClaim: false,
      hasDrift: false,
    };
    const collected = {
      kind: "collected" as const,
      report: JSON.parse(report()) as FleetTaskCompletionReport,
      gitState: state,
      claimDrift: drift,
      taskStatus: "verifying" as const,
      failureCode: null,
      reportBytes: 500,
    };
    const stopSession = vi.fn(async () => {});
    const deps = {
      db,
      now: () => NOW,
      collectReport: vi.fn(async () => collected),
      stopSession,
      sessionExists: async () => true,
    };

    expect(await reconcileFleetWorkerReport("run-1", workerId, deps)).toBe(
      true
    );
    expect(stopSession).toHaveBeenCalledWith("session-1", "completed");
    expect(
      db
        .prepare(`SELECT status, head_sha FROM fleet_tasks WHERE id = ?`)
        .get(taskId)
    ).toEqual({ status: "verifying", head_sha: HEAD });
    expect(
      db
        .prepare(`SELECT status, report_state FROM fleet_workers WHERE id = ?`)
        .get(workerId)
    ).toEqual({ status: "completed", report_state: "accepted" });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_artifacts WHERE worker_id = ?`
        )
        .get(workerId)
    ).toEqual({ n: 2 });

    expect(await reconcileFleetWorkerReport("run-1", workerId, deps)).toBe(
      false
    );
    expect(deps.collectReport).toHaveBeenCalledTimes(1);
  });

  it("backs off report reads across a 40-worker fleet", async () => {
    addRuntimeRun();
    for (let index = 0; index < 40; index += 1) addRuntimeWorker(index);
    const collectReport = vi.fn(async () => ({ kind: "missing" as const }));
    const deps = {
      db,
      now: () => NOW,
      collectReport,
      sessionExists: async () => true,
      stopSession: async () => {},
      resolveBaseSha: async () => BASE,
    };

    await reconcileFleetRun("run-1", deps);
    expect(collectReport).toHaveBeenCalledTimes(40);
    await reconcileFleetRun("run-1", deps);
    expect(collectReport).toHaveBeenCalledTimes(40);
    expect(
      db
        .prepare(
          `SELECT MIN(report_poll_count) AS min_count,
                  MAX(report_poll_count) AS max_count
           FROM fleet_workers WHERE fleet_run_id = 'run-1'`
        )
        .get()
    ).toEqual({ min_count: 1, max_count: 1 });
  });
});
