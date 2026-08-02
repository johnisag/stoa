import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSchema } from "@/lib/db/schema";
import {
  appendFleetSupervisorRecommendation,
  getFleetSupervisorSnapshot,
  parseFleetSupervisorRecommendationInput,
} from "@/lib/fleet/supervisor";
import { recommendFleetSupervisorActions } from "@/lib/fleet/supervisor-rules";
import type {
  AppendFleetSupervisorRecommendationInput,
  FleetSupervisorSnapshotState,
} from "@/lib/fleet/supervisor-types";
import { POST as postSupervisorRecommendation } from "@/app/api/fleet/runs/[id]/supervisor/route";

const RUN_ID = "supervisor-run";
const PLAN_HASH = "1".repeat(64);
const POLICY_HASH = "2".repeat(64);
const BASE_SHA = "a".repeat(40);

function insertTask(
  db: Database.Database,
  input: {
    id: string;
    order: number;
    status: string;
    providerState?: string;
    failureCode?: string | null;
    verificationStatus?: string | null;
    reviewStatus?: string | null;
    integrationState?: string;
  }
): void {
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, description, status, task_type, sort_order,
      file_claims_json, priority, working_directory, base_branch, base_sha,
      head_sha, provider_state, provider_last_error, max_attempts,
      current_attempt, verification_status, review_status, integration_state,
      failure_code, fix_error)
     VALUES (?, ?, ?, ?, ?, 'implementation', ?, '[]', ?, '/repo', 'main',
      ?, ?, ?, 'TOP_SECRET_PROVIDER_ERROR', 3, 1, ?, ?, ?, ?,
      'TOP_SECRET_FIX_ERROR')`
  ).run(
    input.id,
    RUN_ID,
    `TOP_SECRET_TITLE_${input.id}`,
    `TOP_SECRET_DESCRIPTION_${input.id}`,
    input.status,
    input.order,
    input.order,
    BASE_SHA,
    String(input.order + 3)
      .repeat(40)
      .slice(0, 40),
    input.providerState ?? "ready",
    input.verificationStatus ?? null,
    input.reviewStatus ?? null,
    input.integrationState ?? "pending",
    input.failureCode ?? null
  );
}

function insertWorker(
  db: Database.Database,
  id: string,
  taskId: string,
  status: string
): void {
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, status, provider, model, attempt,
      worktree_path, report_path, report_state, report_status, report_error,
      failure_code)
     VALUES (?, ?, ?, ?, 'codex', 'TOP_SECRET_MODEL', 1,
      '/TOP_SECRET_WORKTREE', '/TOP_SECRET_REPORT', 'invalid', 'failed',
      'TOP_SECRET_REPORT_ERROR', 'worker_report_failed')`
  ).run(id, RUN_ID, taskId, status);
}

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, desired_state, approval_state, plan_hash,
      approved_plan_hash, automation_policy_json, automation_policy_hash,
      automation_base_sha, integration_state, max_concurrency,
      recovery_required, settings_json)
     VALUES (?, 'TOP_SECRET_RUN_NAME', 'TOP_SECRET_RUN_GOAL', 'running',
      'running', 'approved', ?, ?, '{}', ?, ?, 'idle', 3, 1, '{}')`
  ).run(RUN_ID, PLAN_HASH, PLAN_HASH, POLICY_HASH, BASE_SHA);
  insertTask(db, {
    id: "retry-task",
    order: 0,
    status: "failed",
    providerState: "failed",
    failureCode: "spawn_failed",
  });
  insertTask(db, {
    id: "inspect-task",
    order: 1,
    status: "needs_inspection",
    providerState: "ready",
    failureCode: "verification_error",
    verificationStatus: "error",
    reviewStatus: "changes_requested",
  });
  insertTask(db, {
    id: "backoff-task",
    order: 2,
    status: "ready",
    providerState: "backoff",
  });
  insertWorker(db, "worker-failed", "retry-task", "failed");
  insertWorker(db, "worker-waiting", "inspect-task", "waiting_for_operator");
  db.prepare(
    `INSERT INTO fleet_artifacts
     (id, fleet_run_id, artifact_type, title, body, severity, actor)
     VALUES ('secret-artifact', ?, 'note', 'TOP_SECRET_ARTIFACT_TITLE',
       'TOP_SECRET_ARTIFACT_BODY', 'info', 'test')`
  ).run(RUN_ID);
}

function recommendationInput(
  snapshot: NonNullable<ReturnType<typeof getFleetSupervisorSnapshot>>
): AppendFleetSupervisorRecommendationInput {
  if (!snapshot.bindings.executionHash) {
    throw new Error("test snapshot should have an execution hash");
  }
  return {
    expectedSnapshotHash: snapshot.snapshotHash,
    expectedPlanHash: snapshot.bindings.planHash,
    expectedPolicyHash: snapshot.bindings.policyHash,
    expectedExecutionHash: snapshot.bindings.executionHash,
    expectedBaseSha: snapshot.bindings.baseSha,
    source: "external_ai",
    summary: "Inspect the blocked task before any operator action.",
    actions: [
      {
        kind: "inspect",
        taskId: "inspect-task",
        rationale: "Exact verification evidence is not clean.",
      },
    ],
  };
}

function snapshotFleetTables(
  db: Database.Database,
  excluded: string[] = []
): Record<string, unknown[]> {
  const names = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'fleet_%'
       ORDER BY name ASC`
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    names
      .filter(({ name }) => !excluded.includes(name))
      .map(({ name }) => [
        name,
        db.prepare(`SELECT * FROM "${name}" ORDER BY rowid ASC`).all(),
      ])
  );
}

describe("Fleet supervisor", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    seed(db);
  });

  it("builds a bounded, deterministic, secret-safe durable snapshot", () => {
    const first = getFleetSupervisorSnapshot(RUN_ID, db, {
      tasks: 2,
      workers: 1,
      attention: 3,
      recommendations: 2,
    });
    const second = getFleetSupervisorSnapshot(RUN_ID, db, {
      tasks: 2,
      workers: 1,
      attention: 3,
      recommendations: 2,
    });

    expect(first).toEqual(second);
    expect(first?.advisoryOnly).toBe(true);
    expect(first?.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.tasks).toHaveLength(2);
    expect(first?.workers).toHaveLength(1);
    expect(first?.attention.length).toBeLessThanOrEqual(3);
    expect(first?.recommendations.length).toBeLessThanOrEqual(2);
    expect(first?.truncation).toMatchObject({
      tasks: true,
      workers: true,
      attention: true,
    });
    expect(JSON.stringify(first)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(first)).not.toContain("/repo");
    expect(db.inTransaction).toBe(false);
  });

  it("fails closed when the durable execution graph exceeds hard safety bounds", () => {
    const insert = db.prepare(
      `INSERT INTO fleet_tasks
       (id, fleet_run_id, title, status, task_type, sort_order, file_claims_json,
        working_directory, base_branch, provider_state)
       VALUES (?, ?, 'bounded task', 'ready', 'implementation', ?, '[]',
        '/repo', 'main', 'ready')`
    );
    db.transaction(() => {
      for (let index = 3; index < 257; index += 1) {
        insert.run(`bounded-task-${index}`, RUN_ID, index);
      }
    })();

    const snapshot = getFleetSupervisorSnapshot(RUN_ID, db);
    expect(snapshot?.tasks).toHaveLength(64);
    expect(snapshot?.truncation).toMatchObject({
      tasks: true,
      executionContract: true,
    });
    expect(snapshot?.bindings).toMatchObject({
      executionHash: null,
      contractComplete: false,
    });
    expect(snapshot?.merge).toMatchObject({
      assessmentComplete: false,
      canFinalize: false,
    });
    expect(snapshot?.attention).toContainEqual(
      expect.objectContaining({
        rank: 1,
        severity: "critical",
        code: "execution_contract_exceeds_safety_bounds",
      })
    );
  });

  it("changes the snapshot hash when durable Fleet truth changes", () => {
    const before = getFleetSupervisorSnapshot(RUN_ID, db);
    db.prepare(
      `UPDATE fleet_tasks SET status = 'ready', provider_state = 'ready',
       failure_code = NULL WHERE id = 'retry-task'`
    ).run();
    const after = getFleetSupervisorSnapshot(RUN_ID, db);
    expect(after?.snapshotHash).not.toBe(before?.snapshotHash);
  });

  it("orders attention by stable safety rank before task and worker identity", () => {
    const snapshot = getFleetSupervisorSnapshot(RUN_ID, db);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.attention[0]).toMatchObject({
      rank: 0,
      severity: "critical",
      code: "run_recovery_required",
    });
    const ordered = [...(snapshot?.attention ?? [])].sort(
      (left, right) =>
        left.rank - right.rank ||
        (left.taskId ?? "").localeCompare(right.taskId ?? "") ||
        (left.workerId ?? "").localeCompare(right.workerId ?? "") ||
        left.code.localeCompare(right.code)
    );
    expect(snapshot?.attention).toEqual(ordered);
  });

  it("uses a pure rules engine for approval, retry, inspect, pause, and merge readiness", () => {
    const snapshot = getFleetSupervisorSnapshot(RUN_ID, db);
    if (!snapshot) throw new Error("missing test snapshot");
    const state: FleetSupervisorSnapshotState = {
      ...snapshot,
      run: { ...snapshot.run, approvalState: "needs_approval" },
      bindings: {
        ...snapshot.bindings,
        contractComplete: true,
        planHash: PLAN_HASH,
        policyHash: POLICY_HASH,
        executionHash: "3".repeat(64),
        baseSha: BASE_SHA,
      },
      gates: {
        ...snapshot.gates,
        planReview: {
          required: 4,
          exactCleanLenses: 4,
          independentReviewers: 4,
          complete: true,
        },
      },
      merge: {
        ...snapshot.merge,
        assessmentComplete: true,
        readyTaskIds: ["retry-task"],
        canFinalize: false,
      },
    };
    const before = JSON.stringify(state);
    const recommendations = recommendFleetSupervisorActions(state);
    expect(JSON.stringify(state)).toBe(before);
    expect(new Set(recommendations.map((item) => item.kind))).toEqual(
      new Set(["approval", "retry", "inspect", "pause", "merge_readiness"])
    );
    expect(recommendFleetSupervisorActions(state)).toEqual(recommendations);
  });

  it("rejects stale bindings without mutating any Fleet table", () => {
    const snapshot = getFleetSupervisorSnapshot(RUN_ID, db);
    if (!snapshot) throw new Error("missing test snapshot");
    const before = snapshotFleetTables(db);
    const result = appendFleetSupervisorRecommendation(
      RUN_ID,
      {
        ...recommendationInput(snapshot),
        expectedSnapshotHash: "f".repeat(64),
      },
      { db }
    );
    expect(result).toEqual({
      error: "Fleet supervisor snapshot or execution binding is stale",
      status: 409,
    });
    expect(snapshotFleetTables(db)).toEqual(before);
  });

  it("validates every task in bounded grouping and merge-order advice", () => {
    const snapshot = getFleetSupervisorSnapshot(RUN_ID, db);
    if (!snapshot) throw new Error("missing test snapshot");
    const before = snapshotFleetTables(db);
    const result = appendFleetSupervisorRecommendation(
      RUN_ID,
      {
        ...recommendationInput(snapshot),
        actions: [
          {
            kind: "grouping",
            taskIds: ["retry-task", "unknown-task"],
            rationale: "These tasks appear to share one bounded review scope.",
          },
        ],
      },
      { db }
    );
    expect(result).toEqual({
      error: "recommendation references an unknown task",
      status: 400,
    });
    expect(snapshotFleetTables(db)).toEqual(before);
  });

  it("appends only an immutable advisory artifact and event", () => {
    const snapshot = getFleetSupervisorSnapshot(RUN_ID, db);
    if (!snapshot) throw new Error("missing test snapshot");
    const before = snapshotFleetTables(db, [
      "fleet_artifacts",
      "fleet_events",
      "fleet_resource_usage_buckets",
    ]);
    const artifactCount = db
      .prepare(`SELECT COUNT(*) AS count FROM fleet_artifacts`)
      .get() as { count: number };
    const eventCount = db
      .prepare(`SELECT COUNT(*) AS count FROM fleet_events`)
      .get() as { count: number };

    const result = appendFleetSupervisorRecommendation(
      RUN_ID,
      recommendationInput(snapshot),
      {
        db,
        id: () => "supervisor-artifact",
        now: () => new Date("2026-08-01T12:00:00.000Z"),
      }
    );
    expect(result).toMatchObject({
      artifactId: "supervisor-artifact",
      snapshotHash: snapshot.snapshotHash,
      advisoryOnly: true,
    });
    expect(
      snapshotFleetTables(db, [
        "fleet_artifacts",
        "fleet_events",
        "fleet_resource_usage_buckets",
      ])
    ).toEqual(before);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM fleet_artifacts`).get() as {
          count: number;
        }
      ).count
    ).toBe(artifactCount.count + 1);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM fleet_events`).get() as {
          count: number;
        }
      ).count
    ).toBe(eventCount.count + 1);

    const artifact = db
      .prepare(`SELECT * FROM fleet_artifacts WHERE id = 'supervisor-artifact'`)
      .get() as {
      artifact_type: string;
      severity: string;
      metadata_json: string;
      body: string;
      content_hash: string;
    };
    expect(artifact.artifact_type).toBe("fleet_supervisor_recommendation");
    expect(artifact.severity).toBe("info");
    expect(JSON.parse(artifact.metadata_json)).toMatchObject({
      immutable: true,
      advisoryOnly: true,
      snapshotHash: snapshot.snapshotHash,
      bindings: {
        planHash: PLAN_HASH,
        policyHash: POLICY_HASH,
        executionHash: snapshot.bindings.executionHash,
        baseSha: BASE_SHA,
      },
    });
    expect(artifact.content_hash).toBe(
      createHash("sha256").update(artifact.body).digest("hex")
    );
    const event = db
      .prepare(
        `SELECT payload FROM fleet_events
         WHERE event_type = 'supervisor_recommendation_appended'`
      )
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      artifactId: "supervisor-artifact",
      contentHash: artifact.content_hash,
      snapshotHash: snapshot.snapshotHash,
      advisoryOnly: true,
      bindings: {
        planHash: PLAN_HASH,
        policyHash: POLICY_HASH,
        executionHash: snapshot.bindings.executionHash,
        baseSha: BASE_SHA,
      },
    });
    expect(getFleetSupervisorSnapshot(RUN_ID, db)?.snapshotHash).toBe(
      snapshot.snapshotHash
    );
  });

  it("rejects executable or capability-shaped recommendation fields", () => {
    const snapshot = getFleetSupervisorSnapshot(RUN_ID, db);
    if (!snapshot) throw new Error("missing test snapshot");
    const parsed = parseFleetSupervisorRecommendationInput({
      ...recommendationInput(snapshot),
      capability: { action: "merge" },
    });
    expect(parsed).toEqual({
      error: "recommendation body has unsupported fields",
      status: 400,
    });
  });

  it("enforces the UTF-8 recommendation bound even outside the HTTP route", () => {
    const snapshot = getFleetSupervisorSnapshot(RUN_ID, db);
    if (!snapshot) throw new Error("missing test snapshot");
    const before = snapshotFleetTables(db);
    const result = appendFleetSupervisorRecommendation(
      RUN_ID,
      {
        ...recommendationInput(snapshot),
        actions: Array.from({ length: 16 }, () => ({
          kind: "inspect",
          taskId: null,
          rationale: "😀".repeat(256),
        })),
      },
      { db }
    );
    expect(result).toEqual({
      error: "Fleet supervisor recommendation is too large",
      status: 413,
    });
    expect(snapshotFleetTables(db)).toEqual(before);
  });

  it("enforces admin scope before reading an external recommendation body", async () => {
    const response = await postSupervisorRecommendation(
      new NextRequest(`http://localhost/api/fleet/runs/${RUN_ID}/supervisor`, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: RUN_ID }) }
    );
    expect(response.status).toBe(403);
  });

  it("keeps framework-neutral supervisor contracts client-import safe", () => {
    const root = process.cwd();
    for (const relative of [
      "lib/fleet/supervisor-types.ts",
      "lib/fleet/supervisor-rules.ts",
    ]) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      expect(source).not.toMatch(/from ["']next(?:\/|["'])/);
      expect(source).not.toMatch(/from ["']@\/lib\/db(?:\/|["'])/);
      expect(source).not.toMatch(/from ["']better-sqlite3["']/);
      expect(source).not.toMatch(/from ["'](?:node:)?(?:fs|path|crypto)["']/);
    }
  });
});
