import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import {
  FLEET_PROVIDER_BACKOFF_MAX_MS,
  fleetProviderBackoffMs,
  fleetProviderRetryIsDue,
  fleetProviderRetryNotBefore,
} from "@/lib/fleet/backoff";
import {
  archiveFleetRun,
  claimFleetCleanupAction,
  deriveFleetRunStatus,
  previewFleetCleanup,
  reconcileFleetLifecycle,
  reconcileFleetRunStatuses,
  requestFleetCleanup,
  type FleetLifecycleDeps,
} from "@/lib/fleet/lifecycle";
import { getWorktreesDir, normalizeWorktreePath } from "@/lib/worktrees";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const PROJECT = path.resolve("C:\\repo");
const WORKTREE = path.join(getWorktreesDir(), "fleet-lifecycle-test");
const HASH = "a".repeat(64);

let db: InstanceType<typeof Database>;

function addRun(
  status = "completed",
  overrides: { archivedAt?: string | null; retentionDays?: number | null } = {}
): void {
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, approval_state, provider, max_concurrency,
      settings_json, started_at, ended_at, archived_at, archived_by,
      retention_days, spent_budget_usd, reserved_budget_usd, budget_usd)
     VALUES ('run-1', 'Fleet', 'Ship', ?, 'approved', 'codex', 2, '{}',
      '2026-08-01T11:00:00.000Z', '2026-08-01T12:00:00.000Z', ?,
      CASE WHEN ? IS NULL THEN NULL ELSE 'operator' END, ?, 1.25, 0, 2.5)`
  ).run(
    status,
    overrides.archivedAt ?? null,
    overrides.archivedAt ?? null,
    overrides.retentionDays ?? null
  );
}

function addOwnedWorktree(
  overrides: { worktree?: string; leasePath?: string; project?: string } = {}
): void {
  const worktree = overrides.worktree ?? WORKTREE;
  const project = overrides.project ?? PROJECT;
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, status, task_type, sort_order, file_claims_json,
      approval_state, working_directory, worktree_path)
     VALUES ('task-1', 'run-1', 'Task', 'merged', 'task', 1, '["lib"]',
      'approved', ?, ?)`
  ).run(project, worktree);
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, status, provider, attempt, worktree_path,
      created_at, ended_at)
     VALUES ('worker-1', 'run-1', 'task-1', 'completed', 'codex', 1, ?, ?, ?)`
  ).run(worktree, NOW.toISOString(), NOW.toISOString());
  db.prepare(
    `INSERT INTO fleet_resource_leases
     (id, fleet_run_id, worker_id, resource_type, resource_key, status)
     VALUES ('lease-1', 'run-1', 'worker-1', 'worktree', ?, 'reserved')`
  ).run(overrides.leasePath ?? worktree);
}

function lifecycleDeps(
  overrides: Partial<FleetLifecycleDeps> = {}
): Partial<FleetLifecycleDeps> {
  return {
    db,
    now: () => NOW,
    pathExists: () => true,
    getMainRepoPath: async () => PROJECT,
    deleteWorktree: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
});

describe("Fleet provider backoff", () => {
  it("uses a deterministic bounded exponential schedule across restart", () => {
    expect([1, 2, 3, 4].map(fleetProviderBackoffMs)).toEqual([
      5_000, 10_000, 20_000, 40_000,
    ]);
    expect(fleetProviderBackoffMs(100)).toBe(FLEET_PROVIDER_BACKOFF_MAX_MS);
    const retry = fleetProviderRetryNotBefore(NOW, 2);
    expect(retry).toBe("2026-08-01T12:00:10.000Z");
    expect(fleetProviderRetryIsDue(retry, NOW)).toBe(false);
    expect(
      fleetProviderRetryIsDue(retry, new Date("2026-08-01T12:00:10.000Z"))
    ).toBe(true);
  });
});

describe("Fleet archive and scoped cleanup", () => {
  it("supports dry-run, requires exact confirmation, and deletes once via CAS", async () => {
    addRun();
    addOwnedWorktree();
    let exists = true;
    const remove = vi.fn(async (worktree: string, project: string) => {
      expect(worktree).toBe(WORKTREE);
      expect(project).toBe(PROJECT);
      exists = false;
    });
    const deps = lifecycleDeps({
      pathExists: () => exists,
      deleteWorktree: remove,
    });

    const dryRun = await requestFleetCleanup("run-1", { dryRun: true }, deps);
    expect(dryRun).toMatchObject({ dryRun: true, queued: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_cleanup_actions`).get()
    ).toEqual({ n: 0 });

    expect(archiveFleetRun("run-1", { confirm: true }, deps)).toMatchObject({
      error: expect.any(String),
    });
    expect(
      archiveFleetRun(
        "run-1",
        { confirm: true, confirmation: "run-1", retentionDays: 30 },
        deps
      )
    ).toEqual({
      archivedAt: NOW.toISOString(),
      retentionDays: 30,
    });
    expect(
      await requestFleetCleanup(
        "run-1",
        { confirm: true, confirmation: "wrong" },
        deps
      )
    ).toMatchObject({ error: expect.any(String) });

    expect(
      await requestFleetCleanup(
        "run-1",
        { confirm: true, confirmation: "run-1" },
        deps
      )
    ).toMatchObject({ dryRun: false, queued: 1 });
    expect(
      await reconcileFleetLifecycle(deps, {
        owner: "lifecycle-a",
        maxActions: 1,
      })
    ).toBe(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT state, attempt_count FROM fleet_cleanup_actions
           WHERE action_type = 'delete_worktree'`
        )
        .get()
    ).toEqual({ state: "completed", attempt_count: 1 });
    expect(
      db.prepare(`SELECT status FROM fleet_resource_leases`).get()
    ).toEqual({ status: "released" });
    expect(await reconcileFleetLifecycle(deps)).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects unowned, mismatched, and broad worktree paths", async () => {
    addRun("completed", { archivedAt: NOW.toISOString() });
    addOwnedWorktree({
      worktree: PROJECT,
      leasePath: path.join(getWorktreesDir(), "different"),
    });
    const preview = await previewFleetCleanup("run-1", lifecycleDeps());
    expect(preview).toMatchObject({ eligible: [] });
    expect("error" in preview ? [] : preview.skipped).toHaveLength(1);
    expect(
      await requestFleetCleanup(
        "run-1",
        { confirm: true, confirmation: "run-1" },
        lifecycleDeps()
      )
    ).toMatchObject({ queued: 0 });
  });

  it("recovers an expired cleanup claim without double execution", async () => {
    addRun("completed", { archivedAt: NOW.toISOString() });
    addOwnedWorktree();
    let exists = true;
    const remove = vi.fn(async () => {
      exists = false;
    });
    const deps = lifecycleDeps({
      pathExists: () => exists,
      deleteWorktree: remove,
    });
    await requestFleetCleanup(
      "run-1",
      { confirm: true, confirmation: "run-1" },
      deps
    );
    const action = db.prepare(`SELECT id FROM fleet_cleanup_actions`).get() as {
      id: string;
    };
    expect(
      claimFleetCleanupAction({
        db,
        actionId: action.id,
        owner: "old-process",
        now: new Date("2026-08-01T11:00:00.000Z"),
        leaseMs: 1_000,
      })
    ).toBe(true);
    expect(
      claimFleetCleanupAction({
        db,
        actionId: action.id,
        owner: "other-process",
        now: new Date("2026-08-01T11:00:00.500Z"),
        leaseMs: 1_000,
      })
    ).toBe(false);
    expect(
      await reconcileFleetLifecycle(deps, {
        owner: "new-process",
        maxActions: 1,
      })
    ).toBe(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(
      db.prepare(`SELECT attempt_count FROM fleet_cleanup_actions`).get()
    ).toEqual({ attempt_count: 2 });
  });

  it("normalizes recorded paths with the host's Windows case semantics", () => {
    const normalized = normalizeWorktreePath(WORKTREE);
    expect(normalized).toBe(normalizeWorktreePath(path.resolve(WORKTREE)));
    if (process.platform === "win32") {
      expect(normalizeWorktreePath(WORKTREE.toUpperCase())).toBe(normalized);
    }
  });
});

describe("Fleet retention and run aggregation", () => {
  it("prunes only eligible archived bodies while preserving evidence summaries", async () => {
    addRun("completed", {
      archivedAt: "2026-07-01T12:00:00.000Z",
      retentionDays: 1,
    });
    const largeBody = "x".repeat(20 * 1024);
    const insert = db.prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, content_hash, metadata_json, byte_count,
        artifact_type, title, body, severity, actor)
       VALUES (?, 'run-1', ?, ?, ?, ?, ?, ?, 'info', 'test')`
    );
    insert.run(
      "critic-1",
      HASH,
      '{"kind":"preserved"}',
      Buffer.byteLength(largeBody),
      "critic_finding",
      "Large finding",
      largeBody
    );
    insert.run(
      "verification-1",
      "b".repeat(64),
      '{"kind":"verification"}',
      Buffer.byteLength(largeBody),
      "verification_result",
      "Verification summary",
      largeBody
    );
    db.prepare(
      `INSERT INTO fleet_events (fleet_run_id, event_type, actor, payload)
       VALUES ('run-1', 'immutable_audit', 'test', '{}')`
    ).run();

    expect(await reconcileFleetLifecycle(lifecycleDeps())).toBe(1);
    const critic = db
      .prepare(
        `SELECT body, content_hash, metadata_json, byte_count, body_pruned_at
         FROM fleet_artifacts WHERE id = 'critic-1'`
      )
      .get() as Record<string, unknown>;
    expect(JSON.parse(String(critic.body))).toMatchObject({
      pruned: true,
      contentHash: HASH,
    });
    expect(critic).toMatchObject({
      content_hash: HASH,
      metadata_json: '{"kind":"preserved"}',
      byte_count: Buffer.byteLength(largeBody),
      body_pruned_at: NOW.toISOString(),
    });
    expect(
      db
        .prepare(`SELECT body FROM fleet_artifacts WHERE id = 'verification-1'`)
        .get()
    ).toEqual({ body: largeBody });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = 'run-1' AND event_type = 'immutable_audit'`
        )
        .get()
    ).toEqual({ n: 1 });
    expect(await reconcileFleetLifecycle(lifecycleDeps())).toBe(0);
  });

  it("derives reviewing, merging, completed, and unresolved states purely", () => {
    const run = {
      status: "running" as const,
      integration_state: "idle" as const,
      merge_requested_at: null,
    };
    expect(
      deriveFleetRunStatus(run, [
        { task_type: "explore", status: "completed" },
        { task_type: "task", status: "merged" },
      ])
    ).toBe("completed");
    expect(
      deriveFleetRunStatus(run, [
        { task_type: "task", status: "ready_to_merge" },
      ])
    ).toBe("reviewing");
    expect(
      deriveFleetRunStatus(run, [{ task_type: "task", status: "merging" }])
    ).toBe("merging");
    expect(
      deriveFleetRunStatus(run, [
        { task_type: "task", status: "needs_inspection" },
      ])
    ).toBe("reviewing");
    expect(
      deriveFleetRunStatus({ ...run, integration_state: "waiting_ci" }, [
        { task_type: "task", status: "merged" },
      ])
    ).toBe("merging");
  });

  it("aggregates run status once across repeated restart ticks", () => {
    addRun("running");
    db.prepare(
      `INSERT INTO fleet_tasks
       (id, fleet_run_id, title, status, task_type, sort_order, file_claims_json,
        approval_state)
       VALUES ('read-1', 'run-1', 'Read', 'completed', 'explore', 1, '[]',
        'approved'),
              ('write-1', 'run-1', 'Write', 'merged', 'task', 2, '["lib"]',
        'approved')`
    ).run();
    expect(reconcileFleetRunStatuses(lifecycleDeps())).toBe(1);
    expect(reconcileFleetRunStatuses(lifecycleDeps())).toBe(0);
    expect(db.prepare(`SELECT status FROM fleet_runs`).get()).toEqual({
      status: "completed",
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events WHERE event_type = 'run_completed'`
        )
        .get()
    ).toEqual({ n: 1 });
  });
});
