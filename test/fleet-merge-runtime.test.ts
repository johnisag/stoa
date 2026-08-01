import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import {
  __fleetMergeTesting,
  fleetIntegrationIdentity,
  getFleetMergeStatus,
  inspectFleetMergeReadiness,
  parseFleetPrStatus,
  reconcileFleetMerges,
  requestFleetMerge,
} from "@/lib/fleet/merge-runtime";
import {
  DEFAULT_FLEET_AUTOMATION_POLICY,
  fleetAutomationPolicyJson,
} from "@/lib/fleet/automation-policy";
import { hashFleetAutomationPolicy, hashFleetTaskRows } from "@/lib/fleet/hash";
import type { FleetTaskDependencyRow, FleetTaskRow } from "@/lib/fleet/types";

const BASE = "a".repeat(40);
const TASK = "b".repeat(40);
const INTEGRATED = "c".repeat(40);
const MERGED = "d".repeat(40);
const STALE = "e".repeat(40);
const RUN_ID = "merge-run";
const TASK_ID = "task-one";
const POLICY_HASH = hashFleetAutomationPolicy(DEFAULT_FLEET_AUTOMATION_POLICY);

interface FakeGitOptions {
  conflict?: boolean;
  dirtyLocal?: boolean;
  taskHead?: string;
  prHead?: string;
  github?: boolean;
}

function seed(db: Database.Database, secondTask = false): void {
  db.prepare(
    `INSERT INTO dispatch_repos
     (id, repo_path, repo_slug, agent_type, daily_quota, max_concurrency,
      base_branch, mode, enabled)
     VALUES ('repo', '/repo', 'owner/repo', 'codex', 10, 4, 'main', 'auto', 1)`
  ).run();
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, repo_id, status, approval_state, plan_hash,
      approved_plan_hash, automation_policy_json, automation_policy_hash,
      automation_base_sha, settings_json)
     VALUES (?, 'Merge run', 'Ship it', 'repo', 'running', 'approved',
             'plan-hash', 'plan-hash', ?, ?, ?, ?)`
  ).run(
    RUN_ID,
    fleetAutomationPolicyJson(DEFAULT_FLEET_AUTOMATION_POLICY),
    POLICY_HASH,
    BASE,
    JSON.stringify({ approvedExecutionHash: "execution-hash" })
  );
  insertReadyTask(db, TASK_ID, 0, TASK, "/task-one", "npm test");
  if (secondTask) {
    insertReadyTask(db, "task-two", 1, STALE, "/task-two", "npm test");
    db.prepare(
      `DELETE FROM fleet_task_reviews WHERE task_id = 'task-two'`
    ).run();
    db.prepare(
      `DELETE FROM fleet_verifications WHERE task_id = 'task-two'`
    ).run();
    db.prepare(`DELETE FROM fleet_workers WHERE task_id = 'task-two'`).run();
    db.prepare(`DELETE FROM fleet_artifacts WHERE task_id = 'task-two'`).run();
    db.prepare(
      `UPDATE fleet_tasks SET status = 'ready', head_sha = NULL, base_sha = NULL,
       verification_id = NULL, verification_status = NULL,
       verified_head_sha = NULL, review_status = NULL, review_head_sha = NULL,
       review_verification_hash = NULL, report_artifact_id = NULL,
       diff_artifact_id = NULL WHERE id = 'task-two'`
    ).run();
    db.prepare(
      `INSERT INTO fleet_task_dependencies
       (id, fleet_run_id, task_id, depends_on_task_id, dependency_type)
       VALUES ('dep', ?, 'task-two', ?, 'blocks')`
    ).run(RUN_ID, TASK_ID);
  }
}

function insertReadyTask(
  db: Database.Database,
  id: string,
  sortOrder: number,
  head: string,
  worktree: string,
  command: string
): void {
  const verificationId = `verification-${id}`;
  const reportId = `report-${id}`;
  const diffId = `diff-${id}`;
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, status, task_type, sort_order, file_claims_json,
      actual_file_claims_json, working_directory, base_branch, worktree_path,
      base_sha, head_sha, current_attempt, verification_id, verification_status,
      verified_head_sha, review_status, review_head_sha,
      review_verification_hash, report_artifact_id, diff_artifact_id,
      approval_state, approved_task_hash)
     VALUES (?, ?, ?, 'ready_to_merge', 'implementation', ?, '["src/file.ts"]',
      '["src/file.ts"]', '/repo', 'main', ?, ?, ?, 1, ?, 'pass', ?, 'clean', ?,
      ?, ?, ?, 'approved', 'task-hash')`
  ).run(
    id,
    RUN_ID,
    id,
    sortOrder,
    worktree,
    BASE,
    head,
    verificationId,
    head,
    head,
    `evidence-${id}`,
    reportId,
    diffId
  );
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, status, attempt, worktree_path, base_sha,
      head_sha, report_state, report_status, report_collected_at)
     VALUES (?, ?, ?, 'completed', 1, ?, ?, ?, 'accepted', 'succeeded', ?)`
  ).run(
    `worker-${id}`,
    RUN_ID,
    id,
    worktree,
    BASE,
    head,
    new Date().toISOString()
  );
  db.prepare(
    `INSERT INTO fleet_verifications
     (id, fleet_run_id, task_id, worker_id, attempt, base_sha, head_sha,
      spec_hash, command, status, output_hash)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'spec', ?, 'pass', 'output-hash')`
  ).run(verificationId, RUN_ID, id, `worker-${id}`, BASE, head, command);
  const lenses = [
    "correctness_security",
    "conventions_cross_platform",
    "simplicity_ux",
    "adversarial_red_team",
  ];
  for (const [index, lens] of lenses.entries()) {
    db.prepare(
      `INSERT INTO fleet_task_reviews
       (id, fleet_run_id, task_id, worker_id, attempt, base_sha, head_sha,
        verification_id, verification_spec_hash, verification_evidence_hash,
        policy_hash, lens, reviewer_session_id, verdict, state)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'spec', ?, ?, ?, ?, 'clean', 'clean')`
    ).run(
      `review-${id}-${index}`,
      RUN_ID,
      id,
      `worker-${id}`,
      BASE,
      head,
      verificationId,
      `evidence-${id}`,
      POLICY_HASH,
      lens,
      `reviewer-${id}-${index}`
    );
  }
  db.prepare(
    `INSERT INTO fleet_artifacts
     (id, fleet_run_id, task_id, plan_hash, base_sha, head_sha, artifact_type,
      title, body, severity, actor)
     VALUES (?, ?, ?, 'plan-hash', ?, ?, 'worker_report', 'report', ?, 'info', 'worker')`
  ).run(reportId, RUN_ID, id, BASE, head, JSON.stringify({ followUps: [] }));
  db.prepare(
    `INSERT INTO fleet_artifacts
     (id, fleet_run_id, task_id, plan_hash, base_sha, head_sha, metadata_json,
      artifact_type, title, body, severity, actor)
     VALUES (?, ?, ?, 'plan-hash', ?, ?, ?, 'worker_git_state', 'diff', '{}', 'info', 'scheduler')`
  ).run(
    diffId,
    RUN_ID,
    id,
    BASE,
    head,
    JSON.stringify({ claimDrift: { hasDrift: false } })
  );
}

function fakeRuntime(options: FakeGitOptions = {}) {
  const integration = fleetIntegrationIdentity(RUN_ID);
  const heads = new Map<string, string>([
    ["/repo", BASE],
    ["/task-one", options.taskHead ?? TASK],
    ["/task-two", STALE],
  ]);
  const branches = new Map<string, string>([
    ["/repo", "main"],
    ["/task-one", "task-one"],
    ["/task-two", "task-two"],
  ]);
  const paths = new Set<string>(["/repo", "/task-one", "/task-two"]);
  const calls: string[][] = [];
  const verified: string[] = [];
  let remoteHead: string | null = null;
  let prMerged = false;
  let mergeCalls = 0;
  let ids = 0;

  const git = async (cwd: string, args: string[]) => {
    calls.push([cwd, ...args]);
    if (args[0] === "rev-parse") {
      const ref = args.at(-1) ?? "HEAD";
      if (ref.startsWith("stoa/fleet/integration-")) {
        if (!heads.has(integration.worktree)) throw new Error("missing ref");
        return { stdout: `${heads.get(integration.worktree)}\n`, stderr: "" };
      }
      return { stdout: `${heads.get(cwd) ?? BASE}\n`, stderr: "" };
    }
    if (args[0] === "branch" && args[1] === "--show-current") {
      return {
        stdout: `${branches.get(cwd) ?? (cwd === integration.worktree ? integration.branch : "")}\n`,
        stderr: "",
      };
    }
    if (args[0] === "status") {
      return {
        stdout: cwd === "/repo" && options.dirtyLocal ? " M dirty.ts\n" : "",
        stderr: "",
      };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      paths.add(integration.worktree);
      heads.set(integration.worktree, BASE);
      branches.set(integration.worktree, integration.branch);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge-base") {
      const ancestor = args[2];
      const descendant = args[3];
      const known =
        ancestor === descendant ||
        (ancestor === BASE && [TASK, STALE, INTEGRATED].includes(descendant)) ||
        ([TASK, STALE].includes(ancestor) && descendant === INTEGRATED);
      if (!known) throw new Error("not ancestor");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--no-ff") {
      if (options.conflict) throw new Error("CONFLICT");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "-c" && args.includes("commit")) {
      heads.set(integration.worktree, INTEGRATED);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--ff-only") {
      heads.set(cwd, args[2]);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--abort") {
      heads.set(cwd, BASE);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "reset") {
      heads.set(cwd, args[2]);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "ls-remote") {
      return {
        stdout: remoteHead
          ? `${remoteHead}\trefs/heads/${integration.branch}\n`
          : "",
        stderr: "",
      };
    }
    if (args[0] === "push") {
      remoteHead = heads.get(integration.worktree) ?? INTEGRATED;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected git: ${cwd} ${args.join(" ")}`);
  };

  const prJson = () =>
    JSON.stringify({
      number: 17,
      url: "https://github.com/owner/repo/pull/17",
      state: prMerged ? "MERGED" : "OPEN",
      headRefOid: options.prHead ?? INTEGRATED,
      mergeCommit: prMerged ? { oid: MERGED } : null,
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });

  return {
    integration,
    heads,
    calls,
    verified,
    get mergeCalls() {
      return mergeCalls;
    },
    overrides: {
      now: () => new Date("2026-08-01T12:00:00.000Z"),
      id: () => `generated-${++ids}`,
      leaseOwner: "test-merge-runtime",
      pathExists: async (path: string) => paths.has(path) || heads.has(path),
      ensureDirectory: async () => undefined,
      git,
      verify: async (_cwd: string, command: string) => {
        verified.push(command);
        return { status: "pass" as const, output: "" };
      },
      gh: async (_cwd: string, args: string[]) => {
        if (args[1] === "create") return { stdout: "created\n", stderr: "" };
        return { stdout: prJson(), stderr: "" };
      },
      mergePullRequest: async () => {
        mergeCalls++;
        prMerged = true;
      },
      removeWorktree: async (worktree: string) => {
        paths.delete(worktree);
      },
    },
  };
}

describe("Fleet exact-SHA merge runtime", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createSchema(db);
  });

  it("ignores historical blockers while requiring four exact clean lanes", () => {
    seed(db);
    db.prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, task_id, head_sha, artifact_type, title, body, severity, actor)
       VALUES ('old-blocker', ?, ?, ?, 'task_review_finding', 'old', 'old', 'blocker', 'critic')`
    ).run(RUN_ID, TASK_ID, STALE);
    expect(inspectFleetMergeReadiness(db, RUN_ID)?.readyTaskIds).toEqual([
      TASK_ID,
    ]);
    db.prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, task_id, head_sha, artifact_type, title, body, severity, actor)
       VALUES ('current-blocker', ?, ?, ?, 'task_review_finding', 'new', 'new', 'blocker', 'critic')`
    ).run(RUN_ID, TASK_ID, TASK);
    expect(inspectFleetMergeReadiness(db, RUN_ID)?.blockers[0]).toContain(
      "unresolved blocker"
    );
  });

  it("binds a manual merge request to exact plan, base, and integration-head preconditions", async () => {
    seed(db);
    const fake = fakeRuntime();
    await expect(
      requestFleetMerge(
        RUN_ID,
        "local",
        "admin",
        { db, ...fake.overrides },
        {
          planHash: "stale-plan",
          baseSha: BASE,
          integrationHeadSha: null,
        }
      )
    ).resolves.toEqual({ error: "Fleet merge request preconditions changed" });
    expect(
      db
        .prepare(`SELECT merge_requested_at FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID)
    ).toEqual({ merge_requested_at: null });

    await expect(
      requestFleetMerge(
        RUN_ID,
        "local",
        "admin",
        { db, ...fake.overrides },
        {
          planHash: "plan-hash",
          baseSha: BASE,
          integrationHeadSha: null,
        }
      )
    ).resolves.toMatchObject({ readiness: { requested: true } });
  });

  it("integrates in dependency order, reverifies the combined head, and fast-forwards a clean local checkout", async () => {
    seed(db, true);
    // The dependent is not eligible before its upstream is integrated.
    expect(inspectFleetMergeReadiness(db, RUN_ID)?.readyTaskIds).toEqual([
      TASK_ID,
    ]);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    const upstream = db
      .prepare(`SELECT status FROM fleet_tasks WHERE id = ?`)
      .get(TASK_ID) as { status: string };
    const dependent = db
      .prepare(
        `SELECT base_sha, base_branch FROM fleet_tasks WHERE id = 'task-two'`
      )
      .get() as { base_sha: string; base_branch: string };
    expect(upstream.status).toBe("merged");
    expect(dependent).toEqual({
      base_sha: INTEGRATED,
      base_branch: fake.integration.branch,
    });

    // Simulate the dependent completing at a new exact head from the propagated base.
    db.prepare(
      `UPDATE fleet_tasks SET base_sha = ?, status = 'merged',
       integration_state = 'merged', integrated_head_sha = ?, integrated_at = ?
       WHERE id = 'task-two'`
    ).run(INTEGRATED, INTEGRATED, new Date().toISOString());
    db.prepare(
      `UPDATE fleet_runs SET integration_head_sha = ? WHERE id = ?`
    ).run(INTEGRATED, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      fake.verified.filter((command) => command === "npm test")
    ).toHaveLength(2); // upstream apply + one deduplicated final command
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(fake.heads.get("/repo")).toBe(INTEGRATED);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
    );
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "cleanup_complete"
    );
  });

  it("consumes an explicit exact-contract authorization before automatic merge", async () => {
    seed(db);
    const automaticPolicy = {
      ...DEFAULT_FLEET_AUTOMATION_POLICY,
      automaticPlanning: true,
      automaticPlanApproval: true,
      automaticStart: true,
      automaticFixes: true,
      maxAutomaticFixRounds: 2,
      automaticMerge: true,
      mergeTarget: "local" as const,
    };
    const policyHash = hashFleetAutomationPolicy(automaticPolicy);
    const tasks = db
      .prepare(
        `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
      )
      .all(RUN_ID) as FleetTaskRow[];
    const dependencies = db
      .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
      .all(RUN_ID) as FleetTaskDependencyRow[];
    const planHash = hashFleetTaskRows(tasks, dependencies);
    db.prepare(
      `UPDATE fleet_runs SET plan_hash = ?, approved_plan_hash = ?,
       automation_policy_json = ?, automation_policy_hash = ?,
       settings_json = ? WHERE id = ?`
    ).run(
      planHash,
      planHash,
      fleetAutomationPolicyJson(automaticPolicy),
      policyHash,
      JSON.stringify({ approvedExecutionHash: "approved-execution" }),
      RUN_ID
    );
    db.prepare(
      `UPDATE fleet_task_reviews SET policy_hash = ? WHERE fleet_run_id = ?`
    ).run(policyHash, RUN_ID);
    db.prepare(
      `INSERT INTO fleet_action_authorizations
       (id, fleet_run_id, action, status, policy_hash, granted_by, granted_at, updated_at)
       VALUES ('merge-auth', ?, 'merge', 'authorized', ?, 'admin', ?, ?)`
    ).run(
      RUN_ID,
      policyHash,
      new Date().toISOString(),
      new Date().toISOString()
    );
    const fake = fakeRuntime();
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    const requested = db
      .prepare(
        `SELECT merge_request_kind, merge_target FROM fleet_runs WHERE id = ?`
      )
      .get(RUN_ID) as { merge_request_kind: string; merge_target: string };
    const auth = db
      .prepare(
        `SELECT status, execution_hash, base_sha FROM fleet_action_authorizations WHERE id = 'merge-auth'`
      )
      .get() as { status: string; execution_hash: string; base_sha: string };
    expect(requested).toEqual({
      merge_request_kind: "automatic",
      merge_target: "local",
    });
    expect(auth).toEqual({
      status: "consumed",
      execution_hash: "approved-execution",
      base_sha: BASE,
    });
  });

  it("fails closed on a stale task worktree head and on merge conflicts", async () => {
    for (const options of [{ taskHead: STALE }, { conflict: true }]) {
      db.close();
      db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      createSchema(db);
      seed(db);
      const fake = fakeRuntime(options);
      await requestFleetMerge(RUN_ID, "local", "admin", {
        db,
        ...fake.overrides,
      });
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      const state = getFleetMergeStatus(RUN_ID, db);
      expect(state?.integration.state).toBe("awaiting_operator");
      expect(
        (
          db
            .prepare(`SELECT status FROM fleet_tasks WHERE id = ?`)
            .get(TASK_ID) as { status: string }
        ).status
      ).toBe("needs_inspection");
    }
  });

  it("recovers an expired post-commit operation without applying the merge twice", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    const identity = fake.integration;
    fake.heads.set(identity.worktree, INTEGRATED);
    db.prepare(
      `UPDATE fleet_runs SET integration_state = 'integrating',
       integration_branch = ?, integration_worktree = ?, integration_base_sha = ?,
       integration_head_sha = ? WHERE id = ?`
    ).run(identity.branch, identity.worktree, BASE, BASE, RUN_ID);
    const deps = __fleetMergeTesting.runtimeDeps({ db, ...fake.overrides });
    const operation = __fleetMergeTesting.ensureOperation(deps, {
      runId: RUN_ID,
      taskId: TASK_ID,
      type: "task_merge",
      baseSha: BASE,
      taskHeadSha: TASK,
      commands: ["npm test"],
    });
    __fleetMergeTesting.claimOperation(deps, operation.id);
    db.prepare(
      `UPDATE fleet_merge_operations SET lease_expires_at = '2020-01-01T00:00:00.000Z'
       WHERE id = ?`
    ).run(operation.id);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      fake.calls.filter((call) => call[1] === "merge" && call[2] === "--no-ff")
    ).toHaveLength(0);
    expect(fake.calls.filter((call) => call.includes("commit"))).toHaveLength(
      0
    );
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_tasks WHERE id = ?`)
          .get(TASK_ID) as { status: string }
      ).status
    ).toBe("merged");
  });

  it("refuses a dirty local source checkout without moving its head", async () => {
    seed(db);
    const fake = fakeRuntime({ dirtyLocal: true });
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(fake.heads.get("/repo")).toBe(BASE);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "awaiting_operator"
    );
  });

  it("recovers a crash after an exact local fast-forward without replaying it", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    const deps = __fleetMergeTesting.runtimeDeps({ db, ...fake.overrides });
    const operation = __fleetMergeTesting.ensureOperation(deps, {
      runId: RUN_ID,
      taskId: null,
      type: "local_finalize",
      target: "local",
      baseSha: INTEGRATED,
    });
    __fleetMergeTesting.claimOperation(deps, operation.id);
    db.prepare(
      `UPDATE fleet_merge_operations SET lease_expires_at = '2020-01-01T00:00:00.000Z'
       WHERE id = ?`
    ).run(operation.id);
    fake.heads.set("/repo", INTEGRATED);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      fake.calls.filter(
        (call) => call[1] === "merge" && call[2] === "--ff-only"
      )
    ).toHaveLength(0);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
    );
  });

  it("pushes without force, creates one PR, and merges only the green exact PR head", async () => {
    seed(db);
    const fake = fakeRuntime({ github: true });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 6; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    }
    const push = fake.calls.find((call) => call[1] === "push");
    expect(push).toEqual([
      fake.integration.worktree,
      "push",
      "--set-upstream",
      "origin",
      fake.integration.branch,
    ]);
    expect(push).not.toContain("--force");
    expect(fake.mergeCalls).toBe(1);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.mergeSha).toBe(MERGED);
  });

  it("refuses a changed GitHub PR head even when checks are green", async () => {
    seed(db);
    const fake = fakeRuntime({ github: true, prHead: STALE });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 5; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    }
    expect(fake.mergeCalls).toBe(0);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "awaiting_operator"
    );
  });

  it("parses bounded GitHub readiness metadata defensively", () => {
    expect(parseFleetPrStatus("not-json")).toBeNull();
    expect(
      parseFleetPrStatus(
        JSON.stringify({ number: 2, url: "javascript:alert(1)" })
      )
    ).toBeNull();
    expect(
      parseFleetPrStatus(
        JSON.stringify({
          number: 2,
          url: "https://github.com/o/r/pull/2",
          state: "OPEN",
          headRefOid: TASK,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ status: "IN_PROGRESS" }],
        })
      )?.checks
    ).toBe("pending");
  });
});
