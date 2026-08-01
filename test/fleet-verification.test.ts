import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import {
  claimFleetVerificationAttempt,
  fleetVerificationAttemptId,
  fleetVerificationInFlightCount,
  parseFleetVerificationSpec,
  reconcileFleetVerifications,
  type FleetVerificationDeps,
} from "@/lib/fleet/verification";
import { spawnArgs, type VerifyResult } from "@/lib/verification/runner";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const DRIFTED_HEAD = "c".repeat(40);
const WORKTREE = "C:\\repo\\.stoa-worktrees\\task-1";
const PLAN_HASH = "plan-hash";
const VERIFY_COMMAND = "npm test && npx tsc --noEmit";

let db: InstanceType<typeof Database>;
const outstanding = new Set<Promise<void>>();
const unblockOutstanding = new Set<() => void>();

function addRun(): void {
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, approval_state, plan_hash, approved_plan_hash,
      provider, max_concurrency, settings_json)
     VALUES ('run-1', 'Fleet', 'Verify changes', 'running', 'approved', ?, ?,
      'codex', 8, '{}')`
  ).run(PLAN_HASH, PLAN_HASH);
}

function addTask(
  index = 1,
  overrides: {
    verifyCommand?: string | null;
    reportState?: string;
    reportStatus?: string | null;
    taskHead?: string;
    workerHead?: string;
    taskBase?: string;
    workerBase?: string;
    taskWorktree?: string;
    workerWorktree?: string;
    actualClaimsJson?: string;
    approvedTaskHash?: string | null;
  } = {}
): { taskId: string; workerId: string; worktree: string } {
  const taskId = `task-${index}`;
  const workerId = `worker-${index}`;
  const worktree =
    overrides.taskWorktree ??
    (index === 1 ? WORKTREE : `C:\\repo\\.stoa-worktrees\\task-${index}`);
  const workerWorktree = overrides.workerWorktree ?? worktree;
  const taskBase = overrides.taskBase ?? BASE;
  const taskHead = overrides.taskHead ?? HEAD;
  const workerBase = overrides.workerBase ?? taskBase;
  const workerHead = overrides.workerHead ?? taskHead;
  const verifyCommand =
    "verifyCommand" in overrides ? overrides.verifyCommand : VERIFY_COMMAND;

  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, status, task_type, sort_order, file_claims_json,
      priority, working_directory, worktree_path, base_sha, head_sha,
      actual_file_claims_json, report_artifact_id, current_attempt,
      verify_command, approved_task_hash, approval_state, updated_at)
     VALUES (?, 'run-1', ?, 'verifying', 'task', ?, '["lib"]', 0,
      'C:\\repo', ?, ?, ?, ?, ?, 1, ?, ?, 'approved', ?)`
  ).run(
    taskId,
    taskId,
    index,
    worktree,
    taskBase,
    taskHead,
    overrides.actualClaimsJson ?? '["lib/a.ts"]',
    `report-${index}`,
    verifyCommand,
    "approvedTaskHash" in overrides ? overrides.approvedTaskHash : PLAN_HASH,
    new Date(NOW.getTime() + index).toISOString()
  );
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, status, provider, attempt, worktree_path,
      base_sha, head_sha, report_state, report_status, report_collected_at,
      created_at)
     VALUES (?, 'run-1', ?, 'completed', 'codex', 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workerId,
    taskId,
    workerWorktree,
    workerBase,
    workerHead,
    overrides.reportState ?? "accepted",
    "reportStatus" in overrides ? overrides.reportStatus : "succeeded",
    NOW.toISOString(),
    NOW.toISOString()
  );
  return { taskId, workerId, worktree };
}

function addPendingAttempt(taskId = "task-1"): {
  id: string;
  specHash: string;
} {
  const parsed = parseFleetVerificationSpec(VERIFY_COMMAND);
  if (!parsed.ok) throw new Error(parsed.error);
  const id = fleetVerificationAttemptId({
    taskId,
    attempt: 1,
    headSha: HEAD,
    specHash: parsed.spec.specHash,
  });
  db.prepare(
    `INSERT INTO fleet_verifications
     (id, fleet_run_id, task_id, worker_id, attempt, base_sha, head_sha,
      spec_hash, command, status, created_at, updated_at)
     VALUES (?, 'run-1', ?, 'worker-1', 1, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    id,
    taskId,
    BASE,
    HEAD,
    parsed.spec.specHash,
    VERIFY_COMMAND,
    NOW.toISOString(),
    NOW.toISOString()
  );
  return { id, specHash: parsed.spec.specHash };
}

function trackedLaunch(tasks: Promise<void>[]) {
  return (task: () => Promise<void>) => {
    const launched = task();
    tasks.push(launched);
    outstanding.add(launched);
    void launched.finally(() => outstanding.delete(launched));
  };
}

async function reconcileAndWait(
  overrides: Partial<FleetVerificationDeps> = {},
  options: Parameters<typeof reconcileFleetVerifications>[1] = {}
): Promise<number> {
  const tasks: Promise<void>[] = [];
  const processed = await reconcileFleetVerifications(
    {
      db,
      now: () => NOW,
      readHead: async () => HEAD,
      readStatus: async () => "",
      run: async () => ({ status: "pass", output: "" }),
      launch: trackedLaunch(tasks),
      ...overrides,
    },
    options
  );
  await Promise.all(tasks);
  return processed;
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
  addRun();
});

afterEach(async () => {
  for (const unblock of unblockOutstanding) unblock();
  unblockOutstanding.clear();
  await Promise.allSettled([...outstanding]);
  expect(fleetVerificationInFlightCount()).toBe(0);
  db.close();
});

describe("Fleet verification command contract", () => {
  it("canonicalizes direct-argv steps and rejects shell syntax", () => {
    const parsed = parseFleetVerificationSpec(VERIFY_COMMAND);
    const spaced = parseFleetVerificationSpec(
      "  npm   test&&npx tsc --noEmit  "
    );
    expect(parsed).toMatchObject({
      ok: true,
      spec: {
        command: VERIFY_COMMAND,
        steps: [
          ["npm", "test"],
          ["npx", "tsc", "--noEmit"],
        ],
      },
    });
    expect(spaced.ok && parsed.ok && spaced.spec.specHash).toBe(
      parsed.ok ? parsed.spec.specHash : ""
    );
    for (const command of ["npm test | tee out", "npm test\nnode next.js"]) {
      expect(parseFleetVerificationSpec(command)).toMatchObject({ ok: false });
    }
  });

  it("rejects credential-shaped commands without duplicating the credential", () => {
    const canary = "sk-VERIFYCOMMANDCANARY012345";
    const parsed = parseFleetVerificationSpec(
      `node scripts/check.js --token ${canary}`
    );
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining("credential-shaped"),
    });
    expect(JSON.stringify(parsed)).not.toContain(canary);
    expect(JSON.stringify(parsed)).toContain("[REDACTED]");
  });

  it("uses the shared Windows command-shim direct argv seam", () => {
    expect(spawnArgs("C:\\tools\\npm.cmd", ["test"], true)).toEqual({
      file: process.env.ComSpec || "cmd.exe",
      args: ["/c", "C:\\tools\\npm.cmd", "test"],
    });
    expect(spawnArgs("/usr/bin/npm", ["test"], false)).toEqual({
      file: "/usr/bin/npm",
      args: ["test"],
    });
  });
});

describe("Fleet verification outcomes", () => {
  it("persists bounded evidence and advances an exact passing SHA to review", async () => {
    const { taskId, workerId, worktree } = addTask();
    db.prepare(
      `INSERT INTO fleet_resource_leases
       (id, fleet_run_id, worker_id, resource_type, resource_key, status)
       VALUES ('lease-1', 'run-1', ?, 'worktree', ?, 'reserved')`
    ).run(workerId, worktree);
    const run = vi.fn(async (): Promise<VerifyResult> => ({
      status: "pass",
      output: "verification passed",
    }));
    const readHead = vi.fn(async () => HEAD);
    const readStatus = vi.fn(async () => "");

    expect(await reconcileAndWait({ run, readHead, readStatus })).toBe(1);
    expect(run).toHaveBeenCalledWith(worktree, VERIFY_COMMAND);
    expect(readHead).toHaveBeenCalledTimes(2);
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(
      db
        .prepare(
          `SELECT status, failure_code, verification_status, verified_head_sha,
                  verification_artifact_id
           FROM fleet_tasks WHERE id = ?`
        )
        .get(taskId)
    ).toEqual({
      status: "reviewing",
      failure_code: null,
      verification_status: "pass",
      verified_head_sha: HEAD,
      verification_artifact_id: expect.any(String),
    });
    expect(
      db
        .prepare(
          `SELECT status, run_count, base_sha, head_sha, output_hash
           FROM fleet_verifications WHERE task_id = ?`
        )
        .get(taskId)
    ).toEqual({
      status: "pass",
      run_count: 1,
      base_sha: BASE,
      head_sha: HEAD,
      output_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(
      db
        .prepare(
          `SELECT status, released_at FROM fleet_resource_leases WHERE id = 'lease-1'`
        )
        .get()
    ).toEqual({ status: "reserved", released_at: null });
  });

  it.each([
    ["fail", "blocked", "verification_failed"],
    ["error", "needs_inspection", "verification_error"],
  ] as const)(
    "maps runner %s without ever making a task merge-ready",
    async (verificationStatus, taskStatus, failureCode) => {
      const { taskId } = addTask();
      await reconcileAndWait({
        run: async () => ({
          status: verificationStatus,
          output: `${verificationStatus} output`,
        }),
      });
      expect(
        db
          .prepare(
            `SELECT status, failure_code, verification_status, verified_head_sha
             FROM fleet_tasks WHERE id = ?`
          )
          .get(taskId)
      ).toEqual({
        status: taskStatus,
        failure_code: failureCode,
        verification_status: verificationStatus,
        verified_head_sha: null,
      });
    }
  );

  it("redacts verification errors and evidence before durable hashing", async () => {
    const canary = "sk-VERIFYOUTPUTCANARY012345";
    const { taskId } = addTask();
    await reconcileAndWait({
      run: async () => ({
        status: "error",
        output: `verification failed password=${canary}`,
      }),
    });

    const verification = db
      .prepare(
        `SELECT error, output_hash, output_artifact_id
         FROM fleet_verifications WHERE task_id = ?`
      )
      .get(taskId) as {
      error: string;
      output_hash: string;
      output_artifact_id: string;
    };
    const artifact = db
      .prepare(
        `SELECT title, body, content_hash FROM fleet_artifacts WHERE id = ?`
      )
      .get(verification.output_artifact_id) as {
      title: string;
      body: string;
      content_hash: string;
    };
    const events = db.prepare(`SELECT payload FROM fleet_events`).all();
    expect(JSON.stringify({ verification, artifact, events })).not.toContain(
      canary
    );
    expect(JSON.stringify({ verification, artifact })).toContain("[REDACTED]");
    expect(verification.output_hash).toBe(artifact.content_hash);
  });

  it.each([
    [null, "verification_command_required"],
    ["npm test | tee output.txt", "verification_command_invalid"],
  ] as const)(
    "fails closed for missing or unsafe command %s",
    async (verifyCommand, failureCode) => {
      const { taskId } = addTask(1, { verifyCommand });
      const run = vi.fn(async () => ({
        status: "pass" as const,
        output: "should not run",
      }));
      const readHead = vi.fn(async () => HEAD);

      expect(await reconcileAndWait({ run, readHead })).toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(readHead).not.toHaveBeenCalled();
      expect(
        db
          .prepare(
            `SELECT status, failure_code, verification_status
             FROM fleet_tasks WHERE id = ?`
          )
          .get(taskId)
      ).toEqual({
        status: "needs_inspection",
        failure_code: failureCode,
        verification_status: "error",
      });
      expect(
        db
          .prepare(
            `SELECT status, run_count FROM fleet_verifications WHERE task_id = ?`
          )
          .get(taskId)
      ).toEqual({ status: "error", run_count: 1 });
    }
  );

  it("requires an accepted successful report before running", async () => {
    const { taskId } = addTask(1, {
      reportState: "invalid",
      reportStatus: "failed",
    });
    const run = vi.fn(async () => ({
      status: "pass" as const,
      output: "should not run",
    }));

    expect(await reconcileAndWait({ run })).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(
      db
        .prepare(`SELECT status, failure_code FROM fleet_tasks WHERE id = ?`)
        .get(taskId)
    ).toEqual({
      status: "needs_inspection",
      failure_code: "verification_report_required",
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_verifications WHERE task_id = ?`
        )
        .get(taskId)
    ).toEqual({ n: 0 });
  });

  it.each(["before", "after"] as const)(
    "rejects HEAD drift %s verification",
    async (when) => {
      const { taskId } = addTask();
      const readHead = vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce(when === "before" ? DRIFTED_HEAD : HEAD);
      if (when === "after") readHead.mockResolvedValueOnce(DRIFTED_HEAD);
      const run = vi.fn(async () => ({
        status: "pass" as const,
        output: "",
      }));

      await reconcileAndWait({ readHead, run });
      expect(run).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
      expect(
        db
          .prepare(
            `SELECT status, failure_code, verification_status, verified_head_sha
             FROM fleet_tasks WHERE id = ?`
          )
          .get(taskId)
      ).toEqual({
        status: "needs_inspection",
        failure_code: "verification_head_drift",
        verification_status: "error",
        verified_head_sha: null,
      });
    }
  );

  it.each(["before", "after"] as const)(
    "rejects tracked or untracked worktree mutation %s verification",
    async (when) => {
      const { taskId } = addTask();
      const readStatus = vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce(when === "before" ? " M lib/a.ts\0" : "");
      if (when === "after") {
        readStatus.mockResolvedValueOnce("?? generated.txt\0");
      }
      const run = vi.fn(async () => ({
        status: "pass" as const,
        output: "",
      }));

      await reconcileAndWait({ readStatus, run });
      expect(run).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
      expect(
        db
          .prepare(
            `SELECT status, failure_code, verification_status
             FROM fleet_tasks WHERE id = ?`
          )
          .get(taskId)
      ).toEqual({
        status: "needs_inspection",
        failure_code:
          when === "before"
            ? "verification_worktree_dirty"
            : "verification_worktree_drift",
        verification_status: "error",
      });
    }
  );
});

describe("Fleet verification durability and bounds", () => {
  it("rolls back terminal replay when its required audit event is rejected", async () => {
    const { taskId } = addTask();
    const attempt = addPendingAttempt(taskId);
    db.prepare(
      `UPDATE fleet_verifications
       SET status = 'pass', started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), attempt.id);
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = 'run-1'`
    ).run(JSON.stringify({ eventBytesTotal: 1 }));

    await expect(
      reconcileFleetVerifications(
        {
          db,
          now: () => NOW,
          run: async () => ({ status: "pass", output: "" }),
          readHead: async () => HEAD,
          readStatus: async () => "",
          launch: () => undefined,
        },
        { owner: "replay-owner" }
      )
    ).rejects.toThrow(/event_bytes_total/);
    expect(
      db
        .prepare(
          `SELECT status, verification_id, verification_status
           FROM fleet_tasks WHERE id = ?`
        )
        .get(taskId)
    ).toEqual({
      status: "verifying",
      verification_id: null,
      verification_status: null,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fleet_events`).get()).toEqual({
      n: 0,
    });
  });

  it("prevents duplicate execution while a claimed attempt is in flight", async () => {
    const { taskId } = addTask();
    let resolveRun: ((result: VerifyResult) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<VerifyResult>((resolve) => {
          const unblock = () => resolve({ status: "error", output: "cleanup" });
          unblockOutstanding.add(unblock);
          resolveRun = (result) => {
            unblockOutstanding.delete(unblock);
            resolve(result);
          };
        })
    );
    const tasks: Promise<void>[] = [];
    const runtime = {
      db,
      now: () => NOW,
      readHead: async () => HEAD,
      readStatus: async () => "",
      run,
      launch: trackedLaunch(tasks),
    };

    expect(
      await reconcileFleetVerifications(runtime, {
        owner: "process-a",
        maxConcurrent: 2,
      })
    ).toBe(1);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(
      db
        .prepare(
          `SELECT resource_type FROM fleet_runtime_leases
           WHERE owner_type = 'verification' AND status = 'reserved'
           ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "git_operation" },
      { resource_type: "verifier" },
    ]);
    expect(
      await reconcileFleetVerifications(runtime, {
        owner: "process-b",
        maxConcurrent: 2,
      })
    ).toBe(0);
    expect(
      db
        .prepare(
          `SELECT status, run_count FROM fleet_verifications WHERE task_id = ?`
        )
        .get(taskId)
    ).toEqual({ status: "running", run_count: 1 });

    resolveRun?.({ status: "pass", output: "" });
    await Promise.all(tasks);
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_runtime_leases
           WHERE owner_type = 'verification' AND status = 'reserved'`
        )
        .get()
    ).toEqual({ n: 0 });
  });

  it("uses compare-and-swap leases and recovers an expired running attempt", async () => {
    addTask();
    const attempt = addPendingAttempt();
    expect(
      claimFleetVerificationAttempt({
        db,
        verificationId: attempt.id,
        taskId: "task-1",
        attempt: 1,
        headSha: HEAD,
        specHash: attempt.specHash,
        owner: "process-a",
        now: NOW,
        leaseMs: 1_000,
      })
    ).toBe(true);
    expect(
      claimFleetVerificationAttempt({
        db,
        verificationId: attempt.id,
        taskId: "task-1",
        attempt: 1,
        headSha: HEAD,
        specHash: attempt.specHash,
        owner: "process-b",
        now: NOW,
        leaseMs: 1_000,
      })
    ).toBe(false);

    const restartedAt = new Date(NOW.getTime() + 1_001);
    const run = vi.fn(async () => ({ status: "pass" as const, output: "" }));
    expect(
      await reconcileAndWait(
        { now: () => restartedAt, run },
        { owner: "process-b" }
      )
    ).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT status, run_count, lease_owner FROM fleet_verifications
           WHERE id = ?`
        )
        .get(attempt.id)
    ).toEqual({ status: "pass", run_count: 2, lease_owner: null });
  });

  it("limits launched work across a larger fleet", async () => {
    for (let index = 1; index <= 12; index += 1) addTask(index);
    const resolvers: Array<(result: VerifyResult) => void> = [];
    const run = vi.fn(
      () =>
        new Promise<VerifyResult>((resolve) => {
          const unblock = () => resolve({ status: "error", output: "cleanup" });
          unblockOutstanding.add(unblock);
          resolvers.push((result) => {
            unblockOutstanding.delete(unblock);
            resolve(result);
          });
        })
    );
    const tasks: Promise<void>[] = [];

    const processed = await reconcileFleetVerifications(
      {
        db,
        now: () => NOW,
        readHead: async () => HEAD,
        readStatus: async () => "",
        run,
        launch: trackedLaunch(tasks),
      },
      { maxPerTick: 5, maxConcurrent: 2, owner: "bounded-process" }
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(processed).toBe(2);
    expect(fleetVerificationInFlightCount()).toBe(2);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_verifications WHERE status = 'running'`
        )
        .get()
    ).toEqual({ n: 2 });

    for (const resolve of resolvers) resolve({ status: "pass", output: "" });
    await Promise.all(tasks);
  });

  it("scopes an operator-triggered reconciliation to the exact run and task", async () => {
    addTask(1);
    addTask(2);

    expect(
      await reconcileAndWait({}, { runId: "run-1", taskId: "task-2" })
    ).toBe(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_verifications WHERE task_id = 'task-1'`
        )
        .get()
    ).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = 'task-1'`).get()
    ).toEqual({ status: "verifying" });
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = 'task-2'`).get()
    ).toEqual({ status: "reviewing" });
  });
});
