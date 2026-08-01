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
  confirmFleetDestructiveAction,
  deriveFleetRunStatus,
  enqueueFleetRetentionActions,
  FLEET_RETENTION_MAX_ROWS_PER_TICK,
  previewFleetCleanup,
  previewFleetDestructiveAction,
  reconcileFleetLifecycle,
  reconcileFleetRunStatuses,
  requestFleetCleanup,
  type FleetLifecycleDeps,
} from "@/lib/fleet/lifecycle";
import { getWorktreesDir, normalizeWorktreePath } from "@/lib/worktrees";
import { fleetIntegrationIdentity } from "@/lib/fleet/merge-contract";

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

async function exactCleanupInput(
  runtime: Partial<FleetLifecycleDeps>
): Promise<{ confirm: true; confirmation: string; previewDigest: string }> {
  const preview = await previewFleetDestructiveAction(
    "run-1",
    runtime,
    "cleanup"
  );
  if ("error" in preview) throw new Error(preview.error);
  return {
    confirm: true,
    confirmation: "run-1",
    previewDigest: preview.targetDigest,
  };
}

async function persistDestructiveAuthorization(
  runtime: Partial<FleetLifecycleDeps>
): Promise<void> {
  const preview = await previewFleetDestructiveAction("run-1", runtime);
  if ("error" in preview) throw new Error(preview.error);
  const confirmed = await confirmFleetDestructiveAction(
    "run-1",
    { previewDigest: preview.targetDigest },
    runtime
  );
  if ("error" in confirmed) throw new Error(confirmed.error);
  const row = db
    .prepare(`SELECT settings_json FROM fleet_runs WHERE id = 'run-1'`)
    .get() as { settings_json: string };
  const settings = JSON.parse(row.settings_json) as Record<string, unknown>;
  settings.destructiveCancellation = {
    schemaVersion: 1,
    previewDigest: confirmed.preview.targetDigest,
    revision: confirmed.preview.revision,
    targetSetDigest: confirmed.targetSetDigest,
    sessionIds: confirmed.sessionIds,
    cleanupTargets: confirmed.cleanupTargets,
    integrationTarget: confirmed.integrationTarget,
  };
  db.prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = 'run-1'`).run(
    JSON.stringify(settings)
  );
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
  it("previews exact owner, session, worktree, branch, and artifact impact", async () => {
    addRun("running", { retentionDays: 30 });
    addOwnedWorktree();
    db.prepare(
      `INSERT INTO sessions
       (id, name, status, worktree_path, branch_name, working_directory)
       VALUES ('session-1', 'Fleet worker', 'running', ?, 'fleet/run/task-1', ?)`
    ).run(WORKTREE, WORKTREE);
    db.prepare(
      `UPDATE fleet_tasks SET status = 'running', branch_name = 'fleet/run/task-1'
       WHERE id = 'task-1'`
    ).run();
    db.prepare(
      `UPDATE fleet_workers SET status = 'running', session_id = 'session-1',
       branch_name = 'fleet/run/task-1', ended_at = NULL
       WHERE id = 'worker-1'`
    ).run();
    db.prepare(
      `INSERT INTO fleet_cost_accounts
       (id, fleet_run_id, session_id, session_key, owner_type, owner_id,
        task_id, provider)
       VALUES ('cost-1', 'run-1', 'session-1', 'fleet-worker', 'worker',
               'worker-1', 'task-1', 'codex')`
    ).run();
    db.prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, task_id, worker_id, artifact_type, title, body,
        byte_count)
       VALUES ('artifact-1', 'run-1', 'task-1', 'worker-1', 'worker_diff',
               'Worker diff', 'body', 4)`
    ).run();

    const preview = await previewFleetDestructiveAction(
      "run-1",
      lifecycleDeps()
    );
    if ("error" in preview) throw new Error(preview.error);

    expect(preview).toMatchObject({
      runId: "run-1",
      complete: true,
      truncatedKinds: [],
      excludedWorktreeCount: 0,
      effects: {
        stopActiveSessions: true,
        deleteVerifiedWorktrees: true,
        preserveBranches: true,
        preserveArtifactMetadata: true,
        artifactBodyRetentionDays: 30,
      },
    });
    expect(preview.owners).toEqual([
      expect.objectContaining({
        ownerType: "worker",
        ownerId: "worker-1",
        taskId: "task-1",
        sessionId: "session-1",
        active: true,
      }),
    ]);
    expect(preview.sessions).toEqual([
      expect.objectContaining({ id: "session-1", active: true }),
    ]);
    expect(preview.worktrees).toEqual([
      expect.objectContaining({
        worktreePath: WORKTREE,
        projectPath: PROJECT,
        exists: true,
        branchNames: ["fleet/run/task-1"],
        sessionIds: ["session-1"],
      }),
    ]);
    expect(preview.branches).toEqual([
      expect.objectContaining({
        branchName: "fleet/run/task-1",
        ownerId: "worker-1",
        preserved: true,
      }),
    ]);
    expect(preview.artifacts).toEqual([
      expect.objectContaining({
        id: "artifact-1",
        artifactType: "worker_diff",
        preserved: true,
      }),
    ]);
  });

  it("binds integration worktree and branch deletion only to destructive cancel", async () => {
    addRun("running");
    addOwnedWorktree();
    const integration = fleetIntegrationIdentity("run-1");
    db.prepare(
      `UPDATE fleet_runs SET integration_state = 'integrating',
       integration_worktree = ?, integration_branch = ?, integration_head_sha = ?
       WHERE id = 'run-1'`
    ).run(integration.worktree, integration.branch, HASH);
    const runtime = lifecycleDeps();

    const cancellation = await previewFleetDestructiveAction(
      "run-1",
      runtime,
      "cancel"
    );
    if ("error" in cancellation) throw new Error(cancellation.error);
    expect(cancellation.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreePath: integration.worktree,
          projectPath: PROJECT,
          expectedHeadSha: HASH,
          owners: [
            expect.objectContaining({ ownerType: "integration_workspace" }),
          ],
        }),
      ])
    );
    expect(cancellation.branches).toContainEqual(
      expect.objectContaining({
        branchName: integration.branch,
        ownerType: "integration_workspace",
        expectedHeadSha: HASH,
        preserved: false,
      })
    );
    expect(cancellation.effects.preserveBranches).toBe(false);

    const archivedCleanup = await previewFleetDestructiveAction(
      "run-1",
      runtime,
      "cleanup"
    );
    if ("error" in archivedCleanup) throw new Error(archivedCleanup.error);
    expect(
      archivedCleanup.worktrees.some(
        (target) => target.worktreePath === integration.worktree
      )
    ).toBe(false);
    expect(archivedCleanup.effects.preserveBranches).toBe(true);
  });

  it("does not stale a destructive target digest when preserved evidence changes", async () => {
    addRun("completed", { archivedAt: NOW.toISOString() });
    addOwnedWorktree();
    const runtime = lifecycleDeps();
    const before = await previewFleetDestructiveAction(
      "run-1",
      runtime,
      "cleanup"
    );
    if ("error" in before) throw new Error(before.error);
    db.prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, artifact_type, title, body, byte_count)
       VALUES ('late-evidence', 'run-1', 'audit', 'Late audit evidence', 'body', 4)`
    ).run();
    const after = await previewFleetDestructiveAction(
      "run-1",
      runtime,
      "cleanup"
    );
    if ("error" in after) throw new Error(after.error);

    expect(after.artifacts).toHaveLength(before.artifacts.length + 1);
    expect(after.revision).toBe(before.revision);
    expect(after.targetDigest).toBe(before.targetDigest);
  });

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
      await requestFleetCleanup("run-1", await exactCleanupInput(deps), deps)
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

  it("archives and completes cleanup exactly once after event quota exhaustion", async () => {
    addRun();
    addOwnedWorktree();
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = 'run-1'`
    ).run(
      JSON.stringify({
        eventFanoutPerMinute: 1,
        eventBytesPerMinute: 1,
        eventBytesTotal: 1,
      })
    );
    let exists = true;
    const remove = vi.fn(async () => {
      exists = false;
    });
    const deps = lifecycleDeps({
      pathExists: () => exists,
      deleteWorktree: remove,
    });

    expect(
      archiveFleetRun("run-1", { confirm: true, confirmation: "run-1" }, deps)
    ).toEqual({ archivedAt: NOW.toISOString(), retentionDays: null });
    expect(
      await requestFleetCleanup("run-1", await exactCleanupInput(deps), deps)
    ).toMatchObject({ dryRun: false, queued: 1 });

    expect(
      await reconcileFleetLifecycle(deps, {
        owner: "quota-cleanup",
        maxActions: 1,
      })
    ).toBe(1);
    expect(await reconcileFleetLifecycle(deps)).toBe(0);
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
      db.prepare(`SELECT event_type FROM fleet_events ORDER BY id`).all()
    ).toEqual([
      { event_type: "run_archived" },
      { event_type: "cleanup_requested" },
      { event_type: "cleanup_action_completed" },
    ]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_resource_usage_buckets`).get()
    ).toEqual({ n: 0 });
  });

  it("recovers a confirmed destructive cancel only after every paid session is terminal", async () => {
    addRun("canceled");
    addOwnedWorktree();
    db.prepare(
      `UPDATE fleet_runs SET cancel_mode = 'cancel-and-clean-owned-worktrees',
       automation_policy_json = ? WHERE id = 'run-1'`
    ).run(JSON.stringify({ retentionDays: 14 }));
    db.prepare(
      `INSERT INTO sessions (id, name, tmux_name)
       VALUES ('session-1', 'Fleet paid reviewer', 'fleet-paid-reviewer')`
    ).run();
    db.prepare(
      `INSERT INTO fleet_cost_accounts
       (id, fleet_run_id, session_id, session_key, owner_type, owner_id, provider)
       VALUES ('cost-1', 'run-1', 'session-1', 'fleet-paid-reviewer',
               'task_review', 'review-1', 'codex')`
    ).run();
    const insertRuntimeLease = db.prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key,
        units, status)
       VALUES (?, 'run-1', 'worker', 'worker-1', ?, ?, ?, 'reserved')`
    );
    insertRuntimeLease.run("runtime-worktree", "repo_worktree", PROJECT, 1);
    insertRuntimeLease.run("runtime-disk", "disk_bytes", WORKTREE, 1024);
    let exists = true;
    let stopAllowed = false;
    const remove = vi.fn(async () => {
      exists = false;
    });
    const deps = lifecycleDeps({
      pathExists: () => exists,
      deleteWorktree: remove,
      stopSession: vi.fn(async () => stopAllowed),
    });
    await persistDestructiveAuthorization(deps);

    expect(
      db
        .prepare(
          `SELECT fleet_run_id, terminal_at FROM fleet_cost_accounts WHERE id = 'cost-1'`
        )
        .get()
    ).toEqual({ fleet_run_id: "run-1", terminal_at: null });
    const blockedReconcile = await reconcileFleetLifecycle(deps);
    expect(
      db
        .prepare(
          `SELECT action_type, state FROM fleet_cleanup_actions ORDER BY action_type`
        )
        .all()
    ).toEqual([]);
    expect(blockedReconcile).toBe(0);
    expect(remove).not.toHaveBeenCalled();
    expect(
      db.prepare(`SELECT archived_at FROM fleet_runs WHERE id = 'run-1'`).get()
    ).toEqual({ archived_at: null });

    stopAllowed = true;
    expect(
      await reconcileFleetLifecycle(deps, {
        owner: "cancel-recovery",
        maxActions: 1,
      })
    ).toBe(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT archived_at, retention_days FROM fleet_runs WHERE id = 'run-1'`
        )
        .get()
    ).toEqual({ archived_at: NOW.toISOString(), retention_days: 14 });
    expect(
      db
        .prepare(
          `SELECT resource_type, status FROM fleet_runtime_leases
           ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "disk_bytes", status: "released" },
      { resource_type: "repo_worktree", status: "released" },
    ]);
    expect(await reconcileFleetLifecycle(deps)).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE event_type = 'destructive_cancel_cleanup_reconciled'`
        )
        .get()
    ).toEqual({ n: 1 });
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
        await exactCleanupInput(lifecycleDeps()),
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
    await requestFleetCleanup("run-1", await exactCleanupInput(deps), deps);
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

  it("redacts cleanup failures before persisting the action and audit event", async () => {
    addRun("completed", { archivedAt: NOW.toISOString() });
    addOwnedWorktree();
    const secret = "correct-horse-battery-staple";
    const deps = lifecycleDeps({
      deleteWorktree: async () => {
        throw new Error(`password=${secret}`);
      },
    });
    await requestFleetCleanup("run-1", await exactCleanupInput(deps), deps);

    expect(await reconcileFleetLifecycle(deps)).toBe(1);
    const action = db
      .prepare(`SELECT state, error FROM fleet_cleanup_actions`)
      .get() as { state: string; error: string };
    const event = db
      .prepare(
        `SELECT payload FROM fleet_events
         WHERE event_type = 'cleanup_action_failed'`
      )
      .get() as { payload: string };
    expect(action).toMatchObject({
      state: "failed",
      error: "password=[REDACTED]",
    });
    expect(action.error).not.toContain(secret);
    expect(event.payload).not.toContain(secret);
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
  it("rolls back a derived run state when its required audit event is over quota", () => {
    addRun("running");
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = 'run-1'`
    ).run(JSON.stringify({ eventBytesTotal: 1 }));
    db.prepare(
      `INSERT INTO fleet_tasks
       (id, fleet_run_id, title, status, task_type, sort_order,
        file_claims_json, approval_state)
       VALUES ('task-1', 'run-1', 'Task', 'merged', 'task', 1, '[]', 'approved')`
    ).run();

    expect(() => reconcileFleetRunStatuses(lifecycleDeps())).toThrow(
      /event_bytes_total quota exceeded/
    );
    expect(
      db.prepare(`SELECT status FROM fleet_runs WHERE id = 'run-1'`).get()
    ).toEqual({ status: "running" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fleet_events`).get()).toEqual({
      n: 0,
    });
  });

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
      "plan-review-1",
      "c".repeat(64),
      '{"kind":"plan-review"}',
      Buffer.byteLength(largeBody),
      "plan_review_finding",
      "Plan finding",
      largeBody
    );
    insert.run(
      "task-review-1",
      "d".repeat(64),
      '{"kind":"task-review"}',
      Buffer.byteLength(largeBody),
      "task_review_finding",
      "Task finding",
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

    expect(await reconcileFleetLifecycle(lifecycleDeps())).toBe(3);
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
    for (const id of ["plan-review-1", "task-review-1"]) {
      const finding = db
        .prepare(
          `SELECT body, content_hash, metadata_json, byte_count, body_pruned_at
           FROM fleet_artifacts WHERE id = ?`
        )
        .get(id) as Record<string, unknown>;
      expect(JSON.parse(String(finding.body))).toMatchObject({ pruned: true });
      expect(finding).toMatchObject({
        byte_count: Buffer.byteLength(largeBody),
        body_pruned_at: NOW.toISOString(),
      });
      expect(String(finding.content_hash)).toHaveLength(64);
      expect(String(finding.metadata_json)).toContain("review");
    }
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

  it("bounds retention discovery and replays without duplicate cleanup actions", async () => {
    addRun("completed", {
      archivedAt: "2026-07-01T12:00:00.000Z",
      retentionDays: 1,
    });
    const largeBody = "x".repeat(20 * 1024);
    const insert = db.prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, content_hash, metadata_json, byte_count,
        artifact_type, title, body, severity, actor)
       VALUES (?, 'run-1', ?, '{}', ?, 'task_review_finding', ?, ?, 'info', 'test')`
    );
    for (
      let index = 0;
      index < FLEET_RETENTION_MAX_ROWS_PER_TICK + 4;
      index++
    ) {
      insert.run(
        `finding-${index}`,
        index.toString(16).padStart(64, "0"),
        Buffer.byteLength(largeBody),
        `Finding ${index}`,
        largeBody
      );
    }

    expect(enqueueFleetRetentionActions(lifecycleDeps())).toBe(
      FLEET_RETENTION_MAX_ROWS_PER_TICK
    );
    expect(enqueueFleetRetentionActions(lifecycleDeps())).toBe(4);
    expect(enqueueFleetRetentionActions(lifecycleDeps())).toBe(0);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_cleanup_actions
           WHERE action_type = 'prune_artifact_body'`
        )
        .get()
    ).toEqual({ n: FLEET_RETENTION_MAX_ROWS_PER_TICK + 4 });

    expect(
      await reconcileFleetLifecycle(lifecycleDeps(), { maxActions: 16 })
    ).toBe(FLEET_RETENTION_MAX_ROWS_PER_TICK + 4);
    expect(await reconcileFleetLifecycle(lifecycleDeps())).toBe(0);
  });

  it("rechecks the retention type allowlist at cleanup CAS execution", async () => {
    addRun("completed", {
      archivedAt: "2026-07-01T12:00:00.000Z",
      retentionDays: 1,
    });
    const largeBody = "x".repeat(20 * 1024);
    db.prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, content_hash, metadata_json, byte_count,
        artifact_type, title, body, severity, actor)
       VALUES ('finding-cas', 'run-1', ?, '{"preserved":true}', ?,
        'task_review_finding', 'Finding', ?, 'info', 'test')`
    ).run(HASH, Buffer.byteLength(largeBody), largeBody);
    db.prepare(
      `INSERT INTO fleet_cleanup_actions
       (id, action_key, fleet_run_id, artifact_id, action_type, state,
        expected_content_hash, requested_by, metadata_json, created_at, updated_at)
       VALUES ('retention-cas', 'retention:finding-cas:test', 'run-1',
        'finding-cas', 'prune_artifact_body', 'pending', ?,
        'retention-policy', '{}', ?, ?)`
    ).run(HASH, NOW.toISOString(), NOW.toISOString());
    db.prepare(
      `UPDATE fleet_artifacts SET artifact_type = 'verification_result'
       WHERE id = 'finding-cas'`
    ).run();

    expect(await reconcileFleetLifecycle(lifecycleDeps())).toBe(1);
    expect(
      db
        .prepare(`SELECT body FROM fleet_artifacts WHERE id = 'finding-cas'`)
        .get()
    ).toEqual({ body: largeBody });
    expect(
      db
        .prepare(
          `SELECT state FROM fleet_cleanup_actions WHERE id = 'retention-cas'`
        )
        .get()
    ).toEqual({ state: "skipped" });
  });

  it("derives reviewing, merging, completed, and unresolved states purely", () => {
    const run = {
      status: "running" as const,
      integration_state: "idle" as const,
      merge_requested_at: null,
      merge_request_kind: null,
      merge_target: null,
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
    expect(
      deriveFleetRunStatus({ ...run, integration_state: "awaiting_operator" }, [
        { task_type: "task", status: "merged" },
      ])
    ).toBe("merging");
    expect(
      deriveFleetRunStatus(
        {
          ...run,
          merge_request_kind: "manual",
          merge_target: "local",
        },
        [{ task_type: "task", status: "merged" }]
      )
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
