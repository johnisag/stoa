import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const gitState = vi.hoisted(() => ({ baseSha: "a".repeat(40) }));

vi.mock("@/lib/git-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git-status")>();
  return {
    ...actual,
    getDefaultBranch: () => "main",
    isGitRepo: () => true,
    resolveGitCommit: () => gitState.baseSha,
  };
});

import { POST as useCapabilityRoute } from "@/app/api/fleet/capabilities/action/route";
import { POST as issueCapabilityRoute } from "@/app/api/fleet/capabilities/route";
import { createSchema } from "@/lib/db/schema";
import { DEFAULT_FLEET_AUTOMATION_POLICY } from "@/lib/fleet/automation-policy";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "@/lib/fleet/hash";
import {
  claimStoredFleetCapability,
  executeStoredFleetCapability,
  finalizeStoredFleetCapability,
  issueStoredFleetCapability,
  revokeStoredFleetCapability,
} from "@/lib/fleet/capability-runtime";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
} from "@/lib/fleet/types";

const NOW = 5_000_000;
const MERGE_BASE_SHA = "a".repeat(40);
const MERGE_INTEGRATION_SHA = "b".repeat(40);
const MERGE_VERIFICATION_HASH = "c".repeat(64);
const MERGE_RUN_ID = "merge-run";
const databases: Database.Database[] = [];

function database() {
  const db = new Database(":memory:");
  createSchema(db);
  databases.push(db);
  return db;
}

function issueInput(overrides: Record<string, unknown> = {}) {
  return {
    action: "fleet:create",
    runId: "run-1",
    taskId: null,
    workerId: null,
    attempt: null,
    payload: { name: "Capability run", goal: "Exercise exact delegation" },
    ttlMs: 10_000,
    ...overrides,
  };
}

function issued(
  db: Database.Database,
  overrides: Record<string, unknown> = {}
) {
  const result = issueStoredFleetCapability(issueInput(overrides), "alice", {
    db,
    nowMs: NOW,
  });
  expect("error" in result, "error" in result ? result.error : undefined).toBe(
    false
  );
  if ("error" in result) throw new Error(result.error);
  return result;
}

function exactMergeRows(db: Database.Database) {
  return {
    tasks: db
      .prepare(
        `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
      )
      .all(MERGE_RUN_ID) as FleetTaskRow[],
    claims: db
      .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
      .all(MERGE_RUN_ID) as FleetTaskClaimRow[],
    dependencies: db
      .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
      .all(MERGE_RUN_ID) as FleetTaskDependencyRow[],
  };
}

function approveCurrentMergeContract(
  db: Database.Database,
  updatePlan: boolean
): { planHash: string; executionHash: string } {
  const rows = exactMergeRows(db);
  if (updatePlan) {
    const planHash = hashFleetTaskRows(rows.tasks, rows.dependencies);
    db.prepare(
      `UPDATE fleet_runs SET plan_hash = ?, approved_plan_hash = ? WHERE id = ?`
    ).run(planHash, planHash, MERGE_RUN_ID);
    db.prepare(
      `UPDATE fleet_tasks SET approved_task_hash = ? WHERE fleet_run_id = ?`
    ).run(planHash, MERGE_RUN_ID);
  }
  const run = db
    .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
    .get(MERGE_RUN_ID) as FleetRunRow;
  const executionHash = hashFleetExecutionContract({ run, ...rows });
  db.prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`).run(
    JSON.stringify({ approvedExecutionHash: executionHash }),
    MERGE_RUN_ID
  );
  return { planHash: run.plan_hash!, executionHash };
}

function seedExactMergeRun(
  db: Database.Database,
  recoveryRequired = false
): { planHash: string; executionHash: string } {
  db.prepare(
    `INSERT INTO dispatch_repos
     (id, repo_path, repo_slug, agent_type, daily_quota, max_concurrency,
      base_branch, mode, enabled)
     VALUES ('capability-repo', '/repo', 'owner/repo', 'codex', 10, 4,
             'main', 'auto', 1)`
  ).run();
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, repo_id, status, desired_state, approval_state,
      automation_base_sha, recovery_required, settings_json)
     VALUES (?, 'Merge', 'Goal', 'capability-repo', 'running', 'running',
             'approved', ?, ?, '{}')`
  ).run(MERGE_RUN_ID, MERGE_BASE_SHA, recoveryRequired ? 1 : 0);
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, description, status, task_type, sort_order,
      file_claims_json, working_directory, base_branch, approval_state)
     VALUES ('merge-task', ?, 'Merge task', 'Exact merge task', 'ready',
             'implementation', 0, '[]', '/repo', 'main', 'approved')`
  ).run(MERGE_RUN_ID);
  return approveCurrentMergeContract(db, true);
}

function allowCapabilityLaunch(db: Database.Database): void {
  const automationPolicy = {
    ...DEFAULT_FLEET_AUTOMATION_POLICY,
    allowUnconfinedAgents: true,
  };
  db.prepare(
    `UPDATE fleet_runs
     SET automation_policy_json = ?, automation_policy_hash = ?
     WHERE id = ?`
  ).run(
    JSON.stringify(automationPolicy),
    hashFleetAutomationPolicy(automationPolicy),
    MERGE_RUN_ID
  );
}

function seedApprovalCapabilityRun(db: Database.Database): {
  planHash: string;
} {
  seedExactMergeRun(db);
  allowCapabilityLaunch(db);
  db.prepare(
    `UPDATE fleet_tasks
     SET status = 'draft', approval_state = 'draft',
         agent_type = 'claude', model = 'sonnet', approved_task_hash = NULL
     WHERE fleet_run_id = ?`
  ).run(MERGE_RUN_ID);
  db.prepare(
    `INSERT INTO fleet_task_claims
     (id, fleet_run_id, task_id, path, claim_type, confidence)
     VALUES ('merge-task-claim', ?, 'merge-task', '*', 'unknown', 0)`
  ).run(MERGE_RUN_ID);
  const contract = approveCurrentMergeContract(db, true);
  db.prepare(
    `UPDATE fleet_runs
     SET status = 'draft', desired_state = 'draft',
         approval_state = 'needs_approval', review_policy = 'manual',
         model = 'sonnet',
         automation_base_sha = NULL, approved_plan_hash = NULL,
         approved_by = NULL, approved_at = NULL, settings_json = '{}'
     WHERE id = ?`
  ).run(MERGE_RUN_ID);
  db.prepare(
    `UPDATE fleet_tasks SET approved_task_hash = NULL WHERE fleet_run_id = ?`
  ).run(MERGE_RUN_ID);
  gitState.baseSha = MERGE_BASE_SHA;
  return { planHash: contract.planHash };
}

function issueMergeCapability(db: Database.Database) {
  return issued(db, {
    action: "fleet:merge",
    runId: MERGE_RUN_ID,
    payload: { target: "local" },
  });
}

function prepareFinalVerifiedLanding(db: Database.Database): void {
  const run = db
    .prepare(`SELECT plan_hash FROM fleet_runs WHERE id = ?`)
    .get(MERGE_RUN_ID) as { plan_hash: string };
  db.prepare(
    `UPDATE fleet_tasks
     SET status = 'merged', integration_state = 'merged',
         integrated_head_sha = ?, integrated_at = datetime('now')
     WHERE fleet_run_id = ?`
  ).run(MERGE_INTEGRATION_SHA, MERGE_RUN_ID);
  db.prepare(
    `UPDATE fleet_runs
     SET status = 'merging', integration_state = 'ready_to_finalize',
         integration_base_sha = automation_base_sha,
         integration_head_sha = ?
     WHERE id = ?`
  ).run(MERGE_INTEGRATION_SHA, MERGE_RUN_ID);
  db.prepare(
    `INSERT INTO fleet_artifacts
     (id, fleet_run_id, plan_hash, base_sha, head_sha, content_hash,
      artifact_type, title, body, severity, actor)
     VALUES ('final-verify-artifact', ?, ?, ?, ?, ?,
             'fleet_final_verification', 'Final verification', '{}', 'info',
             'fleet-merge')`
  ).run(
    MERGE_RUN_ID,
    run.plan_hash,
    MERGE_BASE_SHA,
    MERGE_INTEGRATION_SHA,
    MERGE_VERIFICATION_HASH
  );
  db.prepare(
    `INSERT INTO fleet_merge_operations
     (id, operation_key, fleet_run_id, operation_type, state,
      expected_base_sha, result_head_sha, verification_output_hash,
      output_artifact_id, completed_at)
     VALUES ('final-verify-operation', 'final-verify-operation', ?,
             'final_verify', 'completed', ?, ?, ?, 'final-verify-artifact',
             datetime('now'))`
  ).run(
    MERGE_RUN_ID,
    MERGE_INTEGRATION_SHA,
    MERGE_INTEGRATION_SHA,
    MERGE_VERIFICATION_HASH
  );
}

function capabilityUseState(db: Database.Database, id: string) {
  return db
    .prepare(
      `SELECT consumed_at_ms, lease_owner, use_count
       FROM fleet_capabilities WHERE id = ?`
    )
    .get(id);
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("durable Fleet capabilities", () => {
  it.each([
    ["fleet:start", "planned", "paused"],
    ["fleet:resume", "paused", "planned"],
  ] as const)(
    "does not let a held %s capability cross from %s to %s",
    async (action, issuedStatus, changedStatus) => {
      const db = database();
      seedExactMergeRun(db);
      allowCapabilityLaunch(db);
      db.prepare(
        `UPDATE fleet_runs SET status = ?, desired_state = ? WHERE id = ?`
      ).run(issuedStatus, issuedStatus, MERGE_RUN_ID);
      const result = issued(db, {
        action,
        runId: MERGE_RUN_ID,
        payload: {},
      });

      db.prepare(
        `UPDATE fleet_runs SET status = ?, desired_state = ? WHERE id = ?`
      ).run(changedStatus, changedStatus, MERGE_RUN_ID);

      await expect(
        executeStoredFleetCapability(
          {
            token: result.token,
            scope: result.capability.scope,
            payload: {},
          },
          { db, nowMs: NOW + 1 }
        )
      ).resolves.toMatchObject({ status: 409 });
      expect(capabilityUseState(db, result.capability.id)).toEqual({
        consumed_at_ms: null,
        lease_owner: null,
        use_count: 0,
      });
      expect(
        db
          .prepare(`SELECT status FROM fleet_runs WHERE id = ?`)
          .get(MERGE_RUN_ID)
      ).toEqual({ status: changedStatus });
    }
  );

  it("does not let a held resume capability survive a paused state cycle", async () => {
    const db = database();
    seedExactMergeRun(db);
    allowCapabilityLaunch(db);
    db.prepare(
      `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused'
       WHERE id = ?`
    ).run(MERGE_RUN_ID);
    const result = issued(db, {
      action: "fleet:resume",
      runId: MERGE_RUN_ID,
      payload: {},
    });

    db.prepare(
      `UPDATE fleet_runs
       SET status = 'running', desired_state = 'running',
           scheduler_epoch = scheduler_epoch + 1
       WHERE id = ?`
    ).run(MERGE_RUN_ID);
    db.prepare(
      `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused'
       WHERE id = ?`
    ).run(MERGE_RUN_ID);

    await expect(
      executeStoredFleetCapability(
        {
          token: result.token,
          scope: result.capability.scope,
          payload: {},
        },
        { db, nowMs: NOW + 1 }
      )
    ).resolves.toEqual({
      error: "capability action intent changed",
      status: 409,
    });
    expect(capabilityUseState(db, result.capability.id)).toEqual({
      consumed_at_ms: null,
      lease_owner: null,
      use_count: 0,
    });
    expect(
      db
        .prepare(`SELECT status, scheduler_epoch FROM fleet_runs WHERE id = ?`)
        .get(MERGE_RUN_ID)
    ).toEqual({ status: "paused", scheduler_epoch: 1 });
  });

  it.each(["base", "policy", "execution"] as const)(
    "rejects %s drift before using an exact approval capability",
    async (dimension) => {
      const db = database();
      seedApprovalCapabilityRun(db);
      const result = issued(db, {
        action: "fleet:approve",
        runId: MERGE_RUN_ID,
        payload: {},
      });

      if (dimension === "base") {
        gitState.baseSha = "d".repeat(40);
      } else if (dimension === "policy") {
        const changedPolicy = {
          ...DEFAULT_FLEET_AUTOMATION_POLICY,
          allowSensitivePaths: true,
          allowUnconfinedAgents: true,
        };
        db.prepare(
          `UPDATE fleet_runs
           SET automation_policy_json = ?, automation_policy_hash = ?
           WHERE id = ?`
        ).run(
          JSON.stringify(changedPolicy),
          hashFleetAutomationPolicy(changedPolicy),
          MERGE_RUN_ID
        );
      } else {
        db.prepare(
          `UPDATE fleet_runs SET max_concurrency = max_concurrency + 1
           WHERE id = ?`
        ).run(MERGE_RUN_ID);
      }

      await expect(
        executeStoredFleetCapability(
          {
            token: result.token,
            scope: result.capability.scope,
            payload: {},
          },
          { db, nowMs: NOW + 1 }
        )
      ).resolves.toEqual({
        error: "capability action intent changed",
        status: 409,
      });
      expect(capabilityUseState(db, result.capability.id)).toEqual({
        consumed_at_ms: null,
        lease_owner: null,
        use_count: 0,
      });
      expect(
        db
          .prepare(`SELECT status, approval_state FROM fleet_runs WHERE id = ?`)
          .get(MERGE_RUN_ID)
      ).toEqual({ status: "draft", approval_state: "needs_approval" });
    }
  );

  it("uses an approval capability only for its exact composite contract", async () => {
    const db = database();
    const { planHash } = seedApprovalCapabilityRun(db);
    const result = issued(db, {
      action: "fleet:approve",
      runId: MERGE_RUN_ID,
      payload: {},
    });

    const executed = await executeStoredFleetCapability(
      {
        token: result.token,
        scope: result.capability.scope,
        payload: {},
      },
      { db, nowMs: NOW + 1 }
    );

    expect(
      "error" in executed,
      "error" in executed ? executed.error : undefined
    ).toBe(false);
    expect(capabilityUseState(db, result.capability.id)).toMatchObject({
      consumed_at_ms: NOW + 1,
      lease_owner: null,
      use_count: 1,
    });
    expect(
      db
        .prepare(
          `SELECT status, approval_state, approved_plan_hash, automation_base_sha
           FROM fleet_runs WHERE id = ?`
        )
        .get(MERGE_RUN_ID)
    ).toEqual({
      status: "planned",
      approval_state: "approved",
      approved_plan_hash: planHash,
      automation_base_sha: MERGE_BASE_SHA,
    });
  });

  it("fails closed when a capability starts an approved run without an exact base", async () => {
    const db = database();
    seedExactMergeRun(db);
    allowCapabilityLaunch(db);
    approveCurrentMergeContract(db, false);
    db.prepare(
      `UPDATE fleet_runs SET status = 'planned', automation_base_sha = NULL
       WHERE id = ?`
    ).run(MERGE_RUN_ID);
    const result = issued(db, {
      action: "fleet:start",
      runId: MERGE_RUN_ID,
      payload: {},
    });

    await expect(
      executeStoredFleetCapability(
        {
          token: result.token,
          scope: result.capability.scope,
          payload: {},
        },
        { db, nowMs: NOW + 1 }
      )
    ).resolves.toEqual({
      error: "approved run has no exact base commit",
      status: 409,
    });
    expect(
      db.prepare(`SELECT status FROM fleet_runs WHERE id = ?`).get(MERGE_RUN_ID)
    ).toEqual({ status: "planned" });
  });

  it("does not consume a launch capability while run recovery is unresolved", async () => {
    const db = database();
    seedExactMergeRun(db, true);
    const result = issueMergeCapability(db);
    await expect(
      executeStoredFleetCapability(
        {
          token: result.token,
          scope: result.capability.scope,
          payload: { target: "local" },
        },
        { db, nowMs: NOW + 1 }
      )
    ).resolves.toMatchObject({ status: 503 });
    expect(capabilityUseState(db, result.capability.id)).toEqual({
      consumed_at_ms: null,
      lease_owner: null,
      use_count: 0,
    });
  });

  it("rejects an exactly re-approved plan drift before consuming a merge capability", async () => {
    const db = database();
    seedExactMergeRun(db);
    const result = issueMergeCapability(db);
    db.prepare(
      `UPDATE fleet_tasks SET title = 'Changed plan' WHERE id = ?`
    ).run("merge-task");
    approveCurrentMergeContract(db, true);

    await expect(
      executeStoredFleetCapability(
        {
          token: result.token,
          scope: result.capability.scope,
          payload: { target: "local" },
        },
        { db, nowMs: NOW + 1 }
      )
    ).resolves.toEqual({
      error: "capability action intent changed",
      status: 409,
    });
    expect(capabilityUseState(db, result.capability.id)).toEqual({
      consumed_at_ms: null,
      lease_owner: null,
      use_count: 0,
    });
  });

  it("rejects an exactly re-approved execution drift before consuming a merge capability", async () => {
    const db = database();
    seedExactMergeRun(db);
    const result = issueMergeCapability(db);
    db.prepare(`UPDATE fleet_runs SET max_concurrency = 2 WHERE id = ?`).run(
      MERGE_RUN_ID
    );
    approveCurrentMergeContract(db, false);

    await expect(
      executeStoredFleetCapability(
        {
          token: result.token,
          scope: result.capability.scope,
          payload: { target: "local" },
        },
        { db, nowMs: NOW + 1 }
      )
    ).resolves.toEqual({
      error: "capability action intent changed",
      status: 409,
    });
    expect(capabilityUseState(db, result.capability.id)).toEqual({
      consumed_at_ms: null,
      lease_owner: null,
      use_count: 0,
    });
  });

  it("uses and consumes a merge capability only for its exact approved contract", async () => {
    const db = database();
    seedExactMergeRun(db);
    const result = issueMergeCapability(db);

    await expect(
      executeStoredFleetCapability(
        {
          token: result.token,
          scope: result.capability.scope,
          payload: { target: "local" },
        },
        { db, nowMs: NOW + 1 }
      )
    ).resolves.toMatchObject({ result: { readiness: {} } });
    expect(capabilityUseState(db, result.capability.id)).toEqual({
      consumed_at_ms: NOW + 1,
      lease_owner: null,
      use_count: 1,
    });
    expect(
      db
        .prepare(
          `SELECT merge_request_kind, merge_target, merge_requested_by
           FROM fleet_runs WHERE id = ?`
        )
        .get(MERGE_RUN_ID)
    ).toEqual({
      merge_request_kind: "manual",
      merge_target: "local",
      merge_requested_by: `fleet-capability:${result.capability.id}`,
    });
  });

  it("uses separate pre-issued capabilities to stage and authorize exact-head landing", async () => {
    const db = database();
    seedExactMergeRun(db);
    const staging = issueMergeCapability(db);

    await expect(
      executeStoredFleetCapability(
        {
          token: staging.token,
          scope: staging.capability.scope,
          payload: { target: "local" },
        },
        { db, nowMs: NOW + 1 }
      )
    ).resolves.toMatchObject({ result: { readiness: { requested: false } } });
    prepareFinalVerifiedLanding(db);

    const landing = issued(db, {
      action: "fleet:land",
      runId: MERGE_RUN_ID,
      payload: { target: "local" },
    });
    expect(landing.capability.scope).toMatchObject({
      action: "fleet:land",
      boundHash: {
        kind: "head",
        value: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });

    db.prepare(
      `UPDATE fleet_runs SET integration_head_sha = ? WHERE id = ?`
    ).run("d".repeat(40), MERGE_RUN_ID);
    await expect(
      executeStoredFleetCapability(
        {
          token: landing.token,
          scope: landing.capability.scope,
          payload: { target: "local" },
        },
        { db, nowMs: NOW + 2 }
      )
    ).resolves.toEqual({
      error: "capability action intent changed",
      status: 409,
    });
    expect(capabilityUseState(db, landing.capability.id)).toMatchObject({
      consumed_at_ms: null,
      use_count: 0,
    });
    db.prepare(
      `UPDATE fleet_runs SET integration_head_sha = ? WHERE id = ?`
    ).run(MERGE_INTEGRATION_SHA, MERGE_RUN_ID);

    await expect(
      executeStoredFleetCapability(
        {
          token: landing.token,
          scope: landing.capability.scope,
          payload: { target: "local" },
        },
        { db, nowMs: NOW + 2 }
      )
    ).resolves.toMatchObject({ result: { readiness: { requested: true } } });
    expect(
      db
        .prepare(
          `SELECT merge_requested_at, merge_requested_by
           FROM fleet_runs WHERE id = ?`
        )
        .get(MERGE_RUN_ID)
    ).toMatchObject({
      merge_requested_at: expect.any(String),
      merge_requested_by: `fleet-capability:${landing.capability.id}`,
    });
    expect(capabilityUseState(db, staging.capability.id)).toMatchObject({
      consumed_at_ms: NOW + 1,
      use_count: 1,
    });
    expect(capabilityUseState(db, landing.capability.id)).toMatchObject({
      consumed_at_ms: NOW + 2,
      use_count: 1,
    });
  });

  it("persists only a token digest and returns the secret once", () => {
    const db = database();
    const result = issued(db);
    const row = db
      .prepare(`SELECT * FROM fleet_capabilities WHERE id = ?`)
      .get(result.capability.id) as Record<string, unknown>;

    expect(result.token).toMatch(/^stoa_fleet_v1_[A-Za-z0-9_-]{43}$/);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(result.token);
    expect(JSON.stringify(result.capability)).not.toContain(result.token);
    const audits = db
      .prepare(`SELECT * FROM fleet_capability_audit`)
      .all() as Record<string, unknown>[];
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event_type: "issued",
      action: "fleet:create",
    });
    expect(JSON.stringify(audits)).not.toContain(result.token);
  });

  it("atomically consumes a one-use capability before action and rejects replay", () => {
    const db = database();
    const result = issued(db);
    const request = { token: result.token, scope: result.capability.scope };
    const first = claimStoredFleetCapability(request, { db, nowMs: NOW + 1 });
    expect("error" in first).toBe(false);
    if ("error" in first) return;

    const raced = claimStoredFleetCapability(request, { db, nowMs: NOW + 1 });
    expect(raced).toMatchObject({ error: "capability denied", status: 403 });
    finalizeStoredFleetCapability(first, true, { db, nowMs: NOW + 2 });
    expect(
      claimStoredFleetCapability(request, { db, nowMs: NOW + 3 })
    ).toMatchObject({ error: "capability denied", status: 403 });

    const state = db
      .prepare(
        `SELECT consumed_at_ms, lease_owner, use_count FROM fleet_capabilities WHERE id = ?`
      )
      .get(result.capability.id) as Record<string, unknown>;
    expect(state).toMatchObject({
      consumed_at_ms: NOW + 1,
      lease_owner: null,
      use_count: 1,
    });
    expect(
      db
        .prepare(
          `SELECT event_type FROM fleet_capability_audit
           WHERE capability_id = ? ORDER BY id`
        )
        .all(result.capability.id)
    ).toEqual([
      { event_type: "issued" },
      { event_type: "claimed" },
      { event_type: "succeeded" },
    ]);
  });

  it("consumes and audits a failed one-use attempt before rejecting replay", () => {
    const db = database();
    const result = issued(db);
    const request = { token: result.token, scope: result.capability.scope };
    const claim = claimStoredFleetCapability(request, { db, nowMs: NOW + 1 });
    expect("error" in claim).toBe(false);
    if ("error" in claim) return;
    finalizeStoredFleetCapability(claim, false, { db, nowMs: NOW + 2 });

    expect(
      claimStoredFleetCapability(request, { db, nowMs: NOW + 3 })
    ).toMatchObject({ error: "capability denied", status: 403 });
    expect(
      db
        .prepare(
          `SELECT event_type FROM fleet_capability_audit
           WHERE capability_id = ? ORDER BY id`
        )
        .all(result.capability.id)
    ).toEqual([
      { event_type: "issued" },
      { event_type: "claimed" },
      { event_type: "failed" },
    ]);
  });

  it("rejects malformed and oversized tokens before hashing or SQLite work", () => {
    const db = database();
    const prepare = vi.spyOn(db, "prepare");
    for (const token of [null, "", "bad", "x".repeat(100_000)]) {
      expect(
        claimStoredFleetCapability({ token, scope: {} }, { db, nowMs: NOW + 1 })
      ).toMatchObject({ error: "capability denied", status: 403 });
    }
    expect(prepare).not.toHaveBeenCalled();

    const unknownToken = `stoa_fleet_v1_${"Z".repeat(43)}`;
    expect(
      claimStoredFleetCapability(
        { token: unknownToken, scope: {} },
        { db, nowMs: NOW + 1 }
      )
    ).toMatchObject({ error: "capability denied", status: 403 });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["action", { action: "fleet:plan" }],
    ["run", { runId: "run-2" }],
    ["task", { taskId: "task-2" }],
    ["worker", { workerId: "worker-2" }],
    ["attempt", { attempt: 2 }],
    ["hash", { boundHash: { kind: "artifact", value: "f".repeat(64) } }],
  ])(
    "rejects a valid token with the wrong exact %s scope",
    (_name, scopeChange) => {
      const db = database();
      const result = issued(db);
      const scope = { ...result.capability.scope, ...scopeChange };
      expect(
        claimStoredFleetCapability(
          { token: result.token, scope },
          { db, nowMs: NOW + 1 }
        )
      ).toMatchObject({ error: "capability denied", status: 403 });
      const row = db
        .prepare(`SELECT consumed_at_ms, use_count FROM fleet_capabilities`)
        .get() as Record<string, unknown>;
      expect(row).toMatchObject({ consumed_at_ms: null, use_count: 0 });
    }
  );

  it("rejects expiry, revocation, and a cross-run replay", () => {
    const db = database();
    const expired = issued(db, { runId: "expired-run", ttlMs: 5 });
    expect(
      claimStoredFleetCapability(
        { token: expired.token, scope: expired.capability.scope },
        { db, nowMs: NOW + 5 }
      )
    ).toMatchObject({ error: "capability denied" });

    const revoked = issued(db, { runId: "revoked-run" });
    const revocation = revokeStoredFleetCapability(
      revoked.capability.id,
      "bob",
      { db, nowMs: NOW + 1 }
    );
    expect("error" in revocation).toBe(false);
    expect(
      claimStoredFleetCapability(
        { token: revoked.token, scope: revoked.capability.scope },
        { db, nowMs: NOW + 2 }
      )
    ).toMatchObject({ error: "capability denied" });

    const crossRun = {
      ...revoked.capability.scope,
      runId: "another-run",
    };
    expect(
      claimStoredFleetCapability(
        { token: revoked.token, scope: crossRun },
        { db, nowMs: NOW + 2 }
      )
    ).toMatchObject({ error: "capability denied" });
  });

  it("rejects reusable mutation authority", () => {
    const db = database();
    expect(
      issueStoredFleetCapability(issueInput({ useMode: "reusable" }), "alice", {
        db,
        nowMs: NOW,
      })
    ).toEqual({
      error: "Fleet mutation capabilities must be one-use",
      status: 400,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM fleet_capabilities`).get()
    ).toMatchObject({ count: 0 });
  });

  it("requires reusable read capabilities and isolates list and exact-run scopes", () => {
    const db = database();
    db.exec(`
      INSERT INTO fleet_runs (id, name, goal) VALUES
        ('read-run-1', 'One', 'First run'),
        ('read-run-2', 'Two', 'Second run')
    `);
    expect(
      issueStoredFleetCapability(
        issueInput({
          action: "fleet:read",
          runId: "*",
          payload: undefined,
          useMode: "one_use",
        }),
        "alice",
        { db, nowMs: NOW }
      )
    ).toMatchObject({
      error: expect.stringContaining("must explicitly be reusable"),
    });

    const list = issueStoredFleetCapability(
      issueInput({
        action: "fleet:read",
        runId: "*",
        payload: undefined,
        useMode: "reusable",
      }),
      "alice",
      { db, nowMs: NOW }
    );
    expect("error" in list).toBe(false);
    if ("error" in list) return;
    expect(
      claimStoredFleetCapability(
        {
          token: list.token,
          scope: { ...list.capability.scope, runId: "read-run-1" },
        },
        { db, nowMs: NOW + 1 }
      )
    ).toMatchObject({ error: "capability denied" });
    const listClaim = claimStoredFleetCapability(
      { token: list.token, scope: list.capability.scope },
      { db, nowMs: NOW + 2 }
    );
    expect("error" in listClaim).toBe(false);
    if ("error" in listClaim) return;
    finalizeStoredFleetCapability(listClaim, true, { db, nowMs: NOW + 3 });
    const listClaimAgain = claimStoredFleetCapability(
      { token: list.token, scope: list.capability.scope },
      { db, nowMs: NOW + 4 }
    );
    expect("error" in listClaimAgain).toBe(false);
    if ("error" in listClaimAgain) return;
    finalizeStoredFleetCapability(listClaimAgain, true, {
      db,
      nowMs: NOW + 5,
    });

    const exact = issueStoredFleetCapability(
      issueInput({
        action: "fleet:read",
        runId: "read-run-1",
        payload: undefined,
        useMode: "reusable",
      }),
      "alice",
      { db, nowMs: NOW }
    );
    expect("error" in exact).toBe(false);
    if ("error" in exact) return;
    for (const wrongRun of ["read-run-2", "*"]) {
      expect(
        claimStoredFleetCapability(
          {
            token: exact.token,
            scope: { ...exact.capability.scope, runId: wrongRun },
          },
          { db, nowMs: NOW + 1 }
        )
      ).toMatchObject({ error: "capability denied" });
    }
  });

  it("rejects implicit dimensions and an administrator-supplied wrong intent hash", () => {
    const db = database();
    expect(
      issueStoredFleetCapability(
        {
          action: "fleet:create",
          runId: "run-1",
          payload: { name: "x", goal: "y" },
        },
        "alice",
        { db, nowMs: NOW }
      )
    ).toMatchObject({ error: expect.stringContaining("must be explicit") });
    expect(
      issueStoredFleetCapability(
        issueInput({
          boundHash: { kind: "artifact", value: "0".repeat(64) },
        }),
        "alice",
        { db, nowMs: NOW }
      )
    ).toMatchObject({ error: expect.stringContaining("does not match") });
  });

  it("makes capability audit events append-only", () => {
    const db = database();
    issued(db);
    expect(() =>
      db
        .prepare(`UPDATE fleet_capability_audit SET event_type = 'edited'`)
        .run()
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare(`DELETE FROM fleet_capability_audit`).run()
    ).toThrow(/immutable/);
  });
});

describe("Fleet capability administration route", () => {
  it("denies observers and accepts only admin-scoped issuance requests", async () => {
    const observer = new NextRequest("http://local/api/fleet/capabilities", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stoa-scope": "observer",
      },
      body: JSON.stringify(issueInput()),
    });
    expect((await issueCapabilityRoute(observer)).status).toBe(403);

    const admin = new NextRequest("http://local/api/fleet/capabilities", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stoa-scope": "admin",
      },
      body: JSON.stringify(issueInput({ action: "fleet:root" })),
    });
    expect((await issueCapabilityRoute(admin)).status).toBe(400);
  });
});

describe("Fleet capability action route hardening", () => {
  it("rate-limits each connection IP before capability or DB work", async () => {
    const ip = "198.51.100.231";
    for (let index = 0; index < 60; index++) {
      const request = new NextRequest(
        "http://local/api/fleet/capabilities/action",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-stoa-remote-addr": ip,
          },
          body: "{}",
        }
      );
      expect((await useCapabilityRoute(request)).status).toBe(403);
    }
    const limited = await useCapabilityRoute(
      new NextRequest("http://local/api/fleet/capabilities/action", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stoa-remote-addr": ip,
        },
        body: "{}",
      })
    );
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    const otherClient = await useCapabilityRoute(
      new NextRequest("http://local/api/fleet/capabilities/action", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stoa-remote-addr": "198.51.100.233",
        },
        body: "{}",
      })
    );
    expect(otherClient.status).toBe(403);
  });

  it("rejects an oversized action before parsing or capability lookup", async () => {
    const request = new NextRequest(
      "http://local/api/fleet/capabilities/action",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-stoa-remote-addr": "198.51.100.232",
        },
        body: JSON.stringify({ token: "x".repeat(70 * 1024) }),
      }
    );
    expect((await useCapabilityRoute(request)).status).toBe(413);
  });
});
