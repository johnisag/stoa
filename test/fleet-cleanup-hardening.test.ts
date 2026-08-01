import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import {
  FLEET_CLEANUP_MAX_ATTEMPTS,
  FLEET_DESTRUCTIVE_PREVIEW_OBJECT_LIMIT,
  previewFleetCleanup,
  previewFleetDestructiveAction,
  reconcileFleetLifecycle,
  requestFleetCleanup,
  type FleetLifecycleDeps,
} from "@/lib/fleet/lifecycle";
import {
  deleteFleetWorkerReportFile,
  fleetWorkerReportPath,
  isFleetOwnedWorkerReportPath,
} from "@/lib/fleet/report-runtime";
import { getWorktreesDir, normalizeWorktreePath } from "@/lib/worktrees";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const PROJECT = path.resolve("C:\repo");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

let db: InstanceType<typeof Database>;

function addRun(id = "run-1", status = "completed"): void {
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, approval_state, provider, max_concurrency,
      settings_json, started_at, ended_at, archived_at, archived_by)
     VALUES (?, 'Fleet', 'Ship', ?, 'approved', 'codex', 16, '{}', ?, ?, ?,
             'operator')`
  ).run(
    id,
    status,
    "2026-08-01T11:00:00.000Z",
    NOW.toISOString(),
    NOW.toISOString()
  );
}

function addWorkerWorktree(index: number, worktreePath: string): void {
  const taskId = `task-${index}`;
  const workerId = `worker-${index}`;
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, status, task_type, sort_order,
      file_claims_json, approval_state, working_directory, worktree_path)
     VALUES (?, 'run-1', ?, 'merged', 'task', ?, '[]', 'approved', ?, ?)`
  ).run(taskId, taskId, index, PROJECT, worktreePath);
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, status, provider, attempt, worktree_path,
      created_at, ended_at)
     VALUES (?, 'run-1', ?, 'completed', 'codex', 1, ?, ?, ?)`
  ).run(workerId, taskId, worktreePath, NOW.toISOString(), NOW.toISOString());
  db.prepare(
    `INSERT INTO fleet_resource_leases
     (id, fleet_run_id, worker_id, resource_type, resource_key, status)
     VALUES (?, 'run-1', ?, 'worktree', ?, 'reserved')`
  ).run(`lease-${index}`, workerId, worktreePath);
}

function deps(
  overrides: Partial<FleetLifecycleDeps> = {}
): Partial<FleetLifecycleDeps> {
  return {
    db,
    now: () => NOW,
    pathExists: () => false,
    getMainRepoPath: async () => PROJECT,
    deleteWorktree: async () => {},
    ...overrides,
  };
}

async function queueCleanup(
  overrides: Partial<FleetLifecycleDeps> = {}
): Promise<number> {
  const runtime = deps(overrides);
  const impact = await previewFleetDestructiveAction(
    "run-1",
    runtime,
    "cleanup"
  );
  if ("error" in impact) throw new Error(impact.error);
  const result = await requestFleetCleanup(
    "run-1",
    {
      confirm: true,
      confirmation: "run-1",
      previewDigest: impact.targetDigest,
    },
    runtime
  );
  if ("error" in result) throw new Error(result.error);
  return result.queued;
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
});

describe("Fleet cleanup pagination and owner recovery", () => {
  it("bounds destructive previews and marks unseen objects fail-closed", async () => {
    addRun();
    db.transaction(() => {
      for (
        let index = 0;
        index < FLEET_DESTRUCTIVE_PREVIEW_OBJECT_LIMIT + 1;
        index += 1
      ) {
        addWorkerWorktree(
          index,
          path.join(getWorktreesDir(), `fleet-preview-${index}`)
        );
      }
    })();

    const preview = await previewFleetDestructiveAction("run-1", deps());
    if ("error" in preview) throw new Error(preview.error);
    expect(preview.complete).toBe(false);
    expect(preview.objectLimit).toBe(FLEET_DESTRUCTIVE_PREVIEW_OBJECT_LIMIT);
    expect(preview.worktrees).toHaveLength(
      FLEET_DESTRUCTIVE_PREVIEW_OBJECT_LIMIT
    );
    expect(preview.owners).toHaveLength(FLEET_DESTRUCTIVE_PREVIEW_OBJECT_LIMIT);
    expect(preview.truncatedKinds).toEqual(
      expect.arrayContaining(["owners", "sessions", "worktrees"])
    );
    expect(
      await requestFleetCleanup(
        "run-1",
        {
          confirm: true,
          confirmation: "run-1",
          previewDigest: preview.targetDigest,
        },
        deps()
      )
    ).toMatchObject({ status: 409 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM fleet_cleanup_actions`).get()
    ).toEqual({ count: 0 });
  });

  it("keeps paginated discovery complete while refusing a 205-target mutation", async () => {
    addRun();
    db.transaction(() => {
      for (let index = 0; index < 205; index += 1) {
        addWorkerWorktree(
          index,
          path.join(
            getWorktreesDir(),
            `fleet-page-${String(index).padStart(3, "0")}`
          )
        );
      }
    })();

    const discovery = await previewFleetCleanup("run-1", deps());
    if ("error" in discovery) throw new Error(discovery.error);
    expect(discovery.eligible).toHaveLength(205);
    const impact = await previewFleetDestructiveAction(
      "run-1",
      deps(),
      "cleanup"
    );
    if ("error" in impact) throw new Error(impact.error);
    expect(impact.complete).toBe(false);
    expect(
      await requestFleetCleanup(
        "run-1",
        {
          confirm: true,
          confirmation: "run-1",
          previewDigest: impact.targetDigest,
        },
        deps()
      )
    ).toMatchObject({ status: 409 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM fleet_cleanup_actions`).get()
    ).toEqual({ count: 0 });
  });

  it("rejects a stale digest when the exact target set changes before POST", async () => {
    addRun();
    addWorkerWorktree(1, path.join(getWorktreesDir(), "fleet-before-post"));
    const impact = await previewFleetDestructiveAction(
      "run-1",
      deps(),
      "cleanup"
    );
    if ("error" in impact) throw new Error(impact.error);
    addWorkerWorktree(2, path.join(getWorktreesDir(), "fleet-after-preview"));

    expect(
      await requestFleetCleanup(
        "run-1",
        {
          confirm: true,
          confirmation: "run-1",
          previewDigest: impact.targetDigest,
        },
        deps()
      )
    ).toMatchObject({ status: 409 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM fleet_cleanup_actions`).get()
    ).toEqual({ count: 0 });
  });

  it("deletes reviewer worktrees and a shared fixer path once, then releases every owner", async () => {
    addRun();
    const workerPath = path.join(getWorktreesDir(), "fleet-shared-fixer");
    const reviewPath = path.join(getWorktreesDir(), "fleet-plan-review");
    const taskReviewPath = path.join(getWorktreesDir(), "fleet-task-review");
    addWorkerWorktree(1, workerPath);
    db.prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key,
        units, status)
       VALUES
       ('worker-repo', 'run-1', 'worker', 'worker-1', 'repo_worktree', ?, 1, 'reserved'),
       ('worker-disk', 'run-1', 'worker', 'worker-1', 'disk_bytes', 'fleet', 1, 'reserved')`
    ).run(PROJECT);
    db.prepare(
      `INSERT INTO fleet_task_fixes
       (id, fleet_run_id, task_id, worker_id, attempt, round, old_head_sha,
        new_head_sha, policy_hash, verification_evidence_hash, state,
        request_id, fixer_session_id, project_path, worktree_path)
       VALUES ('fix-1', 'run-1', 'task-1', 'worker-1', 1, 1, ?, ?, ?, ?,
               'completed', 'fix-request', '', ?, ?)`
    ).run(BASE, HEAD, BASE, HEAD, PROJECT, workerPath);
    db.prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key,
        units, status)
       VALUES
       ('fix-repo', 'run-1', 'fixer', 'fix-request', 'repo_worktree', ?, 1, 'reserved'),
       ('fix-disk', 'run-1', 'fixer', 'fix-request', 'disk_bytes', 'fleet', 1, 'reserved')`
    ).run(PROJECT);
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, working_directory, worktree_path)
       VALUES ('review-session', 'review', 'review', ?, ?)`
    ).run(reviewPath, reviewPath);
    db.prepare(
      `INSERT INTO fleet_reviews
       (id, fleet_run_id, subject_type, subject_hash, policy_hash,
        execution_hash, base_sha, lens, reviewer_session_id, verdict, state,
        request_id, project_path, worktree_path)
       VALUES ('review-1', 'run-1', 'plan', ?, ?, ?, ?, 'correctness',
               'review-session', 'clean', 'clean', 'review-request', ?, ?)`
    ).run(BASE, BASE, BASE, BASE, PROJECT, reviewPath);
    db.prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key,
        units, status)
       VALUES
       ('review-repo', 'run-1', 'plan_review', 'review-request', 'repo_worktree', ?, 1, 'reserved'),
       ('review-disk', 'run-1', 'plan_review', 'review-request', 'disk_bytes', 'fleet', 1, 'reserved')`
    ).run(PROJECT);
    db.prepare(
      `INSERT INTO fleet_verifications
       (id, fleet_run_id, task_id, worker_id, attempt, base_sha, head_sha,
        spec_hash, command, status)
       VALUES ('verification-1', 'run-1', 'task-1', 'worker-1', 1, ?, ?, ?,
               'npm test', 'pass')`
    ).run(BASE, HEAD, BASE);
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, working_directory, worktree_path)
       VALUES ('task-review-session', 'task-review', 'task-review', ?, ?)`
    ).run(taskReviewPath, taskReviewPath);
    db.prepare(
      `INSERT INTO fleet_task_reviews
       (id, fleet_run_id, task_id, worker_id, attempt, base_sha, head_sha,
        verification_id, verification_spec_hash, verification_evidence_hash,
        policy_hash, lens, reviewer_session_id, verdict, state, request_id,
        project_path, reviewer_worktree_path)
       VALUES ('task-review-1', 'run-1', 'task-1', 'worker-1', 1, ?, ?,
               'verification-1', ?, ?, ?, 'security', 'task-review-session',
               'clean', 'clean', 'task-review-request', ?, ?)`
    ).run(BASE, HEAD, BASE, HEAD, BASE, PROJECT, taskReviewPath);
    db.prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key,
        units, status)
       VALUES
       ('task-review-repo', 'run-1', 'task_review', 'task-review-request',
        'repo_worktree', ?, 1, 'reserved'),
       ('task-review-disk', 'run-1', 'task_review', 'task-review-request',
        'disk_bytes', 'fleet', 1, 'reserved')`
    ).run(PROJECT);

    const existing = new Set(
      [workerPath, reviewPath, taskReviewPath].map(normalizeWorktreePath)
    );
    const remove = vi.fn(async (worktreePath: string) => {
      existing.delete(normalizeWorktreePath(worktreePath));
    });
    const runtime = deps({
      pathExists: (value) => existing.has(normalizeWorktreePath(value)),
      deleteWorktree: remove,
    });

    const impact = await previewFleetDestructiveAction(
      "run-1",
      runtime,
      "cleanup"
    );
    if ("error" in impact) throw new Error(impact.error);
    const requested = await requestFleetCleanup(
      "run-1",
      {
        confirm: true,
        confirmation: "run-1",
        previewDigest: impact.targetDigest,
      },
      runtime
    );
    expect(requested).toMatchObject({ queued: 3 });
    expect("error" in requested ? [] : requested.preview.eligible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ worktreePath: workerPath, ownerCount: 2 }),
        expect.objectContaining({ worktreePath: reviewPath, ownerCount: 1 }),
        expect.objectContaining({
          worktreePath: taskReviewPath,
          ownerCount: 1,
        }),
      ])
    );
    expect(
      await reconcileFleetLifecycle(runtime, {
        owner: "all-owners",
        maxActions: 3,
      })
    ).toBe(3);

    expect(remove).toHaveBeenCalledTimes(3);
    expect(new Set(remove.mock.calls.map(([value]) => value))).toEqual(
      new Set([workerPath, reviewPath, taskReviewPath])
    );
    expect(
      db
        .prepare(
          `SELECT owner_type, resource_type, status FROM fleet_runtime_leases
           ORDER BY owner_type, resource_type`
        )
        .all()
    ).toEqual([
      { owner_type: "fixer", resource_type: "disk_bytes", status: "released" },
      {
        owner_type: "fixer",
        resource_type: "repo_worktree",
        status: "released",
      },
      {
        owner_type: "plan_review",
        resource_type: "disk_bytes",
        status: "released",
      },
      {
        owner_type: "plan_review",
        resource_type: "repo_worktree",
        status: "released",
      },
      {
        owner_type: "task_review",
        resource_type: "disk_bytes",
        status: "released",
      },
      {
        owner_type: "task_review",
        resource_type: "repo_worktree",
        status: "released",
      },
      { owner_type: "worker", resource_type: "disk_bytes", status: "released" },
      {
        owner_type: "worker",
        resource_type: "repo_worktree",
        status: "released",
      },
    ]);
  });
});

describe("Fleet cleanup retry bounds", () => {
  it("retries a transient deletion failure on a later lifecycle tick", async () => {
    addRun();
    const worktreePath = path.join(getWorktreesDir(), "fleet-transient");
    addWorkerWorktree(1, worktreePath);
    let exists = true;
    const remove = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary lock"))
      .mockImplementationOnce(async () => {
        exists = false;
      });
    const runtime = deps({ pathExists: () => exists, deleteWorktree: remove });
    expect(await queueCleanup(runtime)).toBe(1);

    expect(await reconcileFleetLifecycle(runtime)).toBe(1);
    expect(
      db.prepare(`SELECT state, attempt_count FROM fleet_cleanup_actions`).get()
    ).toEqual({ state: "failed", attempt_count: 1 });
    expect(await reconcileFleetLifecycle(runtime)).toBe(1);
    expect(
      db.prepare(`SELECT state, attempt_count FROM fleet_cleanup_actions`).get()
    ).toEqual({ state: "completed", attempt_count: 2 });
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("stops retrying a permanently failed action at the global bound", async () => {
    addRun();
    const worktreePath = path.join(getWorktreesDir(), "fleet-permanent");
    addWorkerWorktree(1, worktreePath);
    const remove = vi.fn(async () => {
      throw new Error("still locked");
    });
    const runtime = deps({ pathExists: () => true, deleteWorktree: remove });
    expect(await queueCleanup(runtime)).toBe(1);

    for (
      let attempt = 0;
      attempt < FLEET_CLEANUP_MAX_ATTEMPTS + 2;
      attempt += 1
    ) {
      await reconcileFleetLifecycle(runtime);
    }
    expect(remove).toHaveBeenCalledTimes(FLEET_CLEANUP_MAX_ATTEMPTS);
    expect(
      db.prepare(`SELECT state, attempt_count FROM fleet_cleanup_actions`).get()
    ).toEqual({ state: "failed", attempt_count: FLEET_CLEANUP_MAX_ATTEMPTS });
  });
});

function addReportAttempt(input: {
  index: number;
  reportState: "pending" | "accepted" | "invalid";
  workerStatus: "completed" | "failed" | "canceled";
}): string {
  const taskId = `report-task-${input.index}`;
  const workerId = `report-worker-${input.index}`;
  const reportPath = fleetWorkerReportPath({
    runId: "run-1",
    taskId,
    attempt: 1,
  });
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, status, task_type, sort_order,
      file_claims_json, approval_state)
     VALUES (?, 'run-1', ?, 'canceled', 'task', ?, '[]', 'approved')`
  ).run(taskId, taskId, input.index);
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, status, provider, attempt, report_path,
      report_state, created_at, ended_at)
     VALUES (?, 'run-1', ?, ?, 'codex', 1, ?, ?, ?, ?)`
  ).run(
    workerId,
    taskId,
    input.workerStatus,
    reportPath,
    input.reportState,
    "2026-08-01T11:00:00.000Z",
    NOW.toISOString()
  );
  return reportPath;
}

describe("Fleet raw report cleanup", () => {
  it("removes only the exact attempt path and treats crash-window ENOENT as success", async () => {
    const identity = {
      runId: "run-1",
      taskId: "task-1",
      attempt: 1,
      reportPath: fleetWorkerReportPath({
        runId: "run-1",
        taskId: "task-1",
        attempt: 1,
      }),
    };
    const remove = vi.fn(async () => {});
    expect(isFleetOwnedWorkerReportPath(identity)).toBe(true);
    expect(await deleteFleetWorkerReportFile(identity, remove)).toBe("deleted");
    expect(remove).toHaveBeenCalledWith(identity.reportPath);

    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(
      await deleteFleetWorkerReportFile(identity, async () => {
        throw missing;
      })
    ).toBe("missing");
    await expect(
      deleteFleetWorkerReportFile(
        { ...identity, reportPath: path.join(PROJECT, "report.json") },
        remove
      )
    ).rejects.toThrow(/not owned/);
  });

  it("durably removes accepted, invalid, and canceled pending reports", async () => {
    addRun("run-1", "canceled");
    const paths = [
      addReportAttempt({
        index: 1,
        reportState: "accepted",
        workerStatus: "completed",
      }),
      addReportAttempt({
        index: 2,
        reportState: "invalid",
        workerStatus: "failed",
      }),
      addReportAttempt({
        index: 3,
        reportState: "pending",
        workerStatus: "canceled",
      }),
    ];
    const remove = vi.fn(
      async (
        _identity: Parameters<FleetLifecycleDeps["deleteReportFile"]>[0]
      ) => "missing" as const
    );

    expect(
      await reconcileFleetLifecycle(deps({ deleteReportFile: remove }), {
        owner: "report-cleanup",
        maxActions: 3,
      })
    ).toBe(3);
    expect(
      remove.mock.calls.map(([identity]) => identity.reportPath).sort()
    ).toEqual([...paths].sort());
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_workers WHERE report_path IS NOT NULL`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `SELECT state, COUNT(*) AS count FROM fleet_cleanup_actions
           WHERE action_type = 'delete_report_file' GROUP BY state`
        )
        .all()
    ).toEqual([{ state: "skipped", count: 3 }]);
  });

  it("keeps a failed report action durable and completes it after restart", async () => {
    addRun();
    const reportPath = addReportAttempt({
      index: 1,
      reportState: "accepted",
      workerStatus: "completed",
    });
    const firstProcess = vi.fn(async () => {
      throw new Error("scanner lock");
    });
    expect(
      await reconcileFleetLifecycle(deps({ deleteReportFile: firstProcess }))
    ).toBe(1);
    expect(
      db
        .prepare(
          `SELECT state, attempt_count, target_path
           FROM fleet_cleanup_actions WHERE action_type = 'delete_report_file'`
        )
        .get()
    ).toEqual({ state: "failed", attempt_count: 1, target_path: reportPath });
    expect(db.prepare(`SELECT report_path FROM fleet_workers`).get()).toEqual({
      report_path: reportPath,
    });

    const restartedProcess = vi.fn(async () => "deleted" as const);
    expect(
      await reconcileFleetLifecycle(
        deps({ deleteReportFile: restartedProcess })
      )
    ).toBe(1);
    expect(
      db
        .prepare(
          `SELECT state, attempt_count FROM fleet_cleanup_actions
           WHERE action_type = 'delete_report_file'`
        )
        .get()
    ).toEqual({ state: "completed", attempt_count: 2 });
    expect(db.prepare(`SELECT report_path FROM fleet_workers`).get()).toEqual({
      report_path: null,
    });
  });
});
