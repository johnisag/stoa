import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { resolve } from "path";
import { createSchema } from "@/lib/db/schema";
import {
  __fleetMergeTesting,
  authorizeFleetManualLanding,
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
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "@/lib/fleet/hash";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
} from "@/lib/fleet/types";
import type { FleetMergeRunRow } from "@/lib/fleet/merge-readiness";

const BASE = "a".repeat(40);
const TASK = "b".repeat(40);
const INTEGRATED = "c".repeat(40);
const MERGED = "d".repeat(40);
const STALE = "e".repeat(40);
const MERGE_TREE = "f".repeat(40);
const RUN_ID = "merge-run";
const TASK_ID = "task-one";
const POLICY_HASH = hashFleetAutomationPolicy(DEFAULT_FLEET_AUTOMATION_POLICY);

function landingPreconditions(db: Database.Database) {
  const run = db
    .prepare(
      `SELECT plan_hash, settings_json, automation_base_sha, integration_head_sha
       FROM fleet_runs WHERE id = ?`
    )
    .get(RUN_ID) as {
    plan_hash: string;
    settings_json: string;
    automation_base_sha: string;
    integration_head_sha: string;
  };
  return {
    planHash: run.plan_hash,
    executionHash: (
      JSON.parse(run.settings_json) as {
        approvedExecutionHash: string;
      }
    ).approvedExecutionHash,
    baseSha: run.automation_base_sha,
    integrationHeadSha: run.integration_head_sha,
  };
}

async function authorizeLandingIfReady(
  db: Database.Database,
  target: "local" | "github_pr",
  overrides: Parameters<typeof reconcileFleetMerges>[0]
): Promise<boolean> {
  const status = getFleetMergeStatus(RUN_ID, db);
  if (
    status?.integration.state !== "ready_to_finalize" ||
    status.integration.requestedAt !== null
  ) {
    return false;
  }
  const authorized = await authorizeFleetManualLanding(
    RUN_ID,
    target,
    "operator",
    landingPreconditions(db),
    { db, ...overrides }
  );
  expect(authorized).toMatchObject({ readiness: { requested: true } });
  return true;
}

function authorizeIntegrationCleanup(
  db: Database.Database,
  worktreePath: string
): void {
  const row = db
    .prepare(
      `SELECT settings_json, integration_branch, integration_head_sha
       FROM fleet_runs WHERE id = ?`
    )
    .get(RUN_ID) as {
    settings_json: string;
    integration_branch: string;
    integration_head_sha: string;
  };
  const settings = JSON.parse(row.settings_json) as Record<string, unknown>;
  settings.destructiveCancellation = {
    integrationTarget: {
      worktreePath,
      projectPath: "/repo",
      branchName: row.integration_branch,
      expectedHeadSha: row.integration_head_sha,
    },
  };
  db.prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`).run(
    JSON.stringify(settings),
    RUN_ID
  );
}

interface FakeGitOptions {
  conflict?: boolean;
  dirtyLocal?: boolean;
  dirtyLocalAfterFastForward?: boolean;
  localBranchAfterFastForward?: string;
  symbolicLocalTarget?: string;
  onMergeAbort?: () => void | Promise<void>;
  onCommitTree?: () => void | Promise<void>;
  now?: () => Date;
  taskHead?: string;
  prHead?: string;
  prBase?: string;
  prBaseBranch?: string;
  prChecks?: unknown[];
  github?: boolean;
  mergeThrowsAfterCompletion?: boolean;
  retargetOnMerge?: string;
  advanceBaseOnLanding?: string;
  originUrl?: string;
}

type VerificationMutation = "tracked" | "staged" | "untracked" | "head";

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
      automation_base_sha, settings_json, desired_state)
     VALUES (?, 'Merge run', 'Ship it', 'repo', 'running', 'approved',
             'plan-hash', 'plan-hash', ?, ?, ?, ?, ?)`
  ).run(
    RUN_ID,
    fleetAutomationPolicyJson(DEFAULT_FLEET_AUTOMATION_POLICY),
    POLICY_HASH,
    BASE,
    JSON.stringify({ approvedExecutionHash: "execution-hash" }),
    "running"
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
  const tasks = db
    .prepare(
      `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
    )
    .all(RUN_ID) as FleetTaskRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskDependencyRow[];
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskClaimRow[];
  const planHash = hashFleetTaskRows(tasks, dependencies);
  db.prepare(
    `UPDATE fleet_runs SET plan_hash = ?, approved_plan_hash = ? WHERE id = ?`
  ).run(planHash, planHash, RUN_ID);
  db.prepare(
    `UPDATE fleet_tasks SET approved_task_hash = ? WHERE fleet_run_id = ?`
  ).run(planHash, RUN_ID);
  const run = db
    .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
    .get(RUN_ID) as FleetRunRow;
  const approvedTasks = db
    .prepare(
      `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
    )
    .all(RUN_ID) as FleetTaskRow[];
  const executionHash = hashFleetExecutionContract({
    run,
    tasks: approvedTasks,
    claims,
    dependencies,
  });
  db.prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`).run(
    JSON.stringify({ approvedExecutionHash: executionHash }),
    RUN_ID
  );
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

function rebindApprovedExecution(db: Database.Database): string {
  const run = db
    .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
    .get(RUN_ID) as FleetRunRow;
  const tasks = db
    .prepare(
      `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
    )
    .all(RUN_ID) as FleetTaskRow[];
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskClaimRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskDependencyRow[];
  const executionHash = hashFleetExecutionContract({
    run,
    tasks,
    claims,
    dependencies,
  });
  const settings = JSON.parse(run.settings_json) as Record<string, unknown>;
  db.prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`).run(
    JSON.stringify({ ...settings, approvedExecutionHash: executionHash }),
    RUN_ID
  );
  return executionHash;
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
  const repoBranchHeads = new Map<string, string>([
    ["main", BASE],
    ["release", BASE],
  ]);
  const paths = new Set<string>(["/repo", "/task-one", "/task-two"]);
  const calls: string[][] = [];
  const verified: string[] = [];
  let remoteIntegrationHead: string | null = null;
  const remoteBranchHeads = new Map<string, string>([
    ["main", BASE],
    ["release", BASE],
  ]);
  let prMerged = false;
  let prExists = false;
  let prBase = options.prBase ?? BASE;
  let prBaseBranch = options.prBaseBranch ?? "main";
  let localDirty = options.dirtyLocal ?? false;
  let landingPushCalls = 0;
  let landingUpdates = 0;
  let prCreateCalls = 0;
  let ids = 0;
  let integrationBranchDeleted = false;
  let mergeInProgress = false;
  let mergeChangesVisible = true;
  let integrationTrackedStatus = "";
  let integrationUntrackedStatus = "";

  const git = async (cwd: string, args: string[]) => {
    calls.push([cwd, ...args]);
    if (args[0] === "rev-parse") {
      if (args[1] === "--git-path" && args[2] === "MERGE_HEAD") {
        return { stdout: ".git/MERGE_HEAD\n", stderr: "" };
      }
      const rawRef = args.at(-1) ?? "HEAD";
      const ref = rawRef.replace(/\^\{commit\}$/, "");
      if (cwd === "/repo" && ref.startsWith("refs/heads/")) {
        const branch = ref.slice("refs/heads/".length);
        const head = repoBranchHeads.get(branch);
        if (!head) throw new Error("missing ref");
        return { stdout: `${head}\n`, stderr: "" };
      }
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
      const dirtyStatus =
        cwd === "/repo" && localDirty
          ? "1 .M N... 100644 100644 100644 a b dirty.ts\n"
          : cwd === integration.worktree
            ? mergeInProgress && mergeChangesVisible
              ? "1 M. N... 100644 100644 100644 a b src/file.ts\n"
              : `${integrationTrackedStatus}${integrationUntrackedStatus}`
            : "";
      if (args.includes("--porcelain=v2")) {
        return {
          stdout: [
            `# branch.oid ${heads.get(cwd) ?? BASE}`,
            `# branch.head ${branches.get(cwd) || "(detached)"}`,
            dirtyStatus.trimEnd(),
          ]
            .filter(Boolean)
            .join("\n")
            .concat("\n"),
          stderr: "",
        };
      }
      return {
        stdout:
          cwd === "/repo" && localDirty
            ? " M dirty.ts\n"
            : cwd === integration.worktree
              ? mergeInProgress && mergeChangesVisible
                ? "M  src/file.ts\n"
                : `${integrationTrackedStatus}${integrationUntrackedStatus}`
              : "",
        stderr: "",
      };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      paths.add(integration.worktree);
      heads.set(integration.worktree, BASE);
      branches.set(integration.worktree, integration.branch);
      integrationBranchDeleted = false;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "for-each-ref") {
      if (
        cwd === "/repo" &&
        args.includes("--format=%(symref)") &&
        args.at(-1) === "refs/heads/main"
      ) {
        return {
          stdout: options.symbolicLocalTarget
            ? `refs/heads/${options.symbolicLocalTarget}\n`
            : "\n",
          stderr: "",
        };
      }
      const head = heads.get(integration.worktree);
      return {
        stdout:
          !integrationBranchDeleted &&
          head &&
          args.at(-1)?.includes(integration.branch)
            ? `${head}\n`
            : "",
        stderr: "",
      };
    }
    if (args[0] === "branch" && args[1] === "-D") {
      integrationBranchDeleted = true;
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
      mergeInProgress = true;
      mergeChangesVisible = true;
      if (options.conflict) throw new Error("CONFLICT");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "write-tree") {
      if (!mergeInProgress) throw new Error("no merge result to write");
      return { stdout: `${MERGE_TREE}\n`, stderr: "" };
    }
    if (args[0] === "-c" && args.includes("commit-tree")) {
      if (
        !mergeInProgress ||
        !args.includes(MERGE_TREE) ||
        !args.includes(BASE) ||
        !args.includes(TASK)
      ) {
        throw new Error("invalid merge commit provenance");
      }
      await options.onCommitTree?.();
      return { stdout: `${INTEGRATED}\n`, stderr: "" };
    }
    if (args[0] === "update-ref") {
      const refIndex = args[1] === "--no-deref" ? 2 : 1;
      const branch = args[refIndex].slice("refs/heads/".length);
      const current = repoBranchHeads.get(branch);
      if (current !== args[refIndex + 2]) throw new Error("ref changed");
      repoBranchHeads.set(branch, args[refIndex + 1]);
      if (branches.get(cwd) === branch) {
        heads.set(cwd, args[refIndex + 1]);
        localDirty = true;
      }
      if (options.localBranchAfterFastForward) {
        branches.set(cwd, options.localBranchAfterFastForward);
        heads.set(
          cwd,
          repoBranchHeads.get(options.localBranchAfterFastForward) ?? BASE
        );
        localDirty = false;
      }
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "read-tree" && args[1] === "-u") {
      if (branches.get(cwd) !== "main") {
        throw new Error("checkout changed before worktree refresh");
      }
      heads.set(cwd, args.at(-1) ?? BASE);
      localDirty = false;
      if (options.dirtyLocalAfterFastForward) localDirty = true;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "merge" && args[1] === "--abort") {
      await options.onMergeAbort?.();
      if (!mergeInProgress) throw new Error("MERGE_HEAD does not exist");
      heads.set(cwd, BASE);
      mergeInProgress = false;
      mergeChangesVisible = true;
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "reset") {
      heads.set(cwd, args[2]);
      mergeInProgress = false;
      mergeChangesVisible = true;
      integrationTrackedStatus = "";
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "clean") {
      integrationUntrackedStatus = "";
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "remote" && args[1] === "get-url") {
      return {
        stdout: `${options.originUrl ?? "https://github.com/owner/repo.git"}\n`,
        stderr: "",
      };
    }
    if (args[0] === "ls-remote") {
      const ref = args.at(-1) ?? "";
      const branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : "";
      const remoteHead =
        branch === integration.branch
          ? remoteIntegrationHead
          : (remoteBranchHeads.get(branch) ?? null);
      return {
        stdout: remoteHead ? `${remoteHead}\trefs/heads/${branch}\n` : "",
        stderr: "",
      };
    }
    if (args[0] === "push") {
      const pushedRefspec = args.at(-1) ?? "";
      if (pushedRefspec.endsWith(`:refs/heads/${integration.branch}`)) {
        remoteIntegrationHead = pushedRefspec.slice(
          0,
          pushedRefspec.indexOf(":refs/heads/")
        );
        return { stdout: "", stderr: "" };
      }
      landingPushCalls++;
      if (options.retargetOnMerge) {
        prBaseBranch = options.retargetOnMerge;
      }
      if (options.advanceBaseOnLanding) {
        remoteBranchHeads.set("main", options.advanceBaseOnLanding);
      }
      const lease = args.find((arg) =>
        arg.startsWith("--force-with-lease=refs/heads/")
      );
      const refspec = args.at(-1) ?? "";
      const separator = refspec.indexOf(":refs/heads/");
      if (!lease || separator < 0) throw new Error("missing exact ref lease");
      const leaseValue = lease.slice("--force-with-lease=".length);
      const leaseSeparator = leaseValue.lastIndexOf(":");
      const targetRef = leaseValue.slice(0, leaseSeparator);
      const expectedOld = leaseValue.slice(leaseSeparator + 1);
      const branch = targetRef.slice("refs/heads/".length);
      if (remoteBranchHeads.get(branch) !== expectedOld) {
        throw new Error("stale remote target lease");
      }
      const newHead = refspec.slice(0, separator);
      remoteBranchHeads.set(branch, newHead);
      landingUpdates++;
      if (
        branch === prBaseBranch &&
        newHead === (options.prHead ?? INTEGRATED)
      ) {
        prMerged = true;
      }
      if (options.mergeThrowsAfterCompletion) {
        throw new Error("transport closed after Git accepted ref update");
      }
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected git: ${cwd} ${args.join(" ")}`);
  };

  const prJson = () =>
    JSON.stringify({
      number: 17,
      url: "https://github.com/owner/repo/pull/17",
      state: prMerged ? "MERGED" : "OPEN",
      baseRefOid: prBase,
      baseRefName: prBaseBranch,
      headRefOid: options.prHead ?? INTEGRATED,
      mergeCommit: prMerged ? { oid: MERGED } : null,
      mergeable: "MERGEABLE",
      statusCheckRollup: options.prChecks ?? [{ conclusion: "SUCCESS" }],
    });

  return {
    integration,
    heads,
    calls,
    verified,
    get landingPushCalls() {
      return landingPushCalls;
    },
    get landingUpdates() {
      return landingUpdates;
    },
    get prCreateCalls() {
      return prCreateCalls;
    },
    setPrBase(value: string) {
      prBase = value;
    },
    setPrBaseBranch(value: string) {
      prBaseBranch = value;
    },
    setRefHead(branch: string, value: string) {
      repoBranchHeads.set(branch, value);
      if (branches.get("/repo") === branch) {
        heads.set("/repo", value);
      }
    },
    refHead(branch: string) {
      return repoBranchHeads.get(branch) ?? null;
    },
    remoteRefHead(branch: string) {
      return remoteBranchHeads.get(branch) ?? null;
    },
    markPrMerged() {
      prMerged = true;
    },
    mutateIntegration(kind: VerificationMutation) {
      if (kind === "head") {
        heads.set(integration.worktree, STALE);
      } else if (kind === "untracked") {
        integrationUntrackedStatus = "?? verifier-output.tmp\n";
      } else {
        integrationTrackedStatus =
          kind === "staged"
            ? "M  src/verifier-staged.ts\n"
            : " M src/verifier-tracked.ts\n";
      }
    },
    startInterruptedMerge(input: { head?: string; clean?: boolean } = {}) {
      mergeInProgress = true;
      mergeChangesVisible = !input.clean;
      heads.set(integration.worktree, input.head ?? BASE);
    },
    integrationStatus() {
      return `${integrationTrackedStatus}${integrationUntrackedStatus}`;
    },
    overrides: {
      now: options.now ?? (() => new Date("2026-08-01T12:00:00.000Z")),
      id: () => `generated-${++ids}`,
      leaseOwner: "test-merge-runtime",
      pathExists: async (path: string) =>
        path === resolve(integration.worktree, ".git/MERGE_HEAD")
          ? mergeInProgress
          : paths.has(path) || heads.has(path),
      ensureDirectory: async () => undefined,
      git,
      verify: async (_cwd: string, command: string) => {
        verified.push(command);
        return { status: "pass" as const, output: "" };
      },
      gh: async (_cwd: string, args: string[]) => {
        if (args[1] === "create") {
          prExists = true;
          prCreateCalls++;
          return { stdout: "created\n", stderr: "" };
        }
        if (!prExists) throw new Error("PR not found");
        return { stdout: prJson(), stderr: "" };
      },
      removeWorktree: async (worktree: string) => {
        paths.delete(worktree);
      },
    },
  };
}

async function prepareClaimedTaskMerge(
  db: Database.Database,
  fake: ReturnType<typeof fakeRuntime>,
  leaseOwner = "crashed-reconciler"
) {
  await requestFleetMerge(RUN_ID, "local", "admin", {
    db,
    ...fake.overrides,
  });
  db.prepare(
    `UPDATE fleet_runs SET integration_state = 'integrating',
     integration_branch = ?, integration_worktree = ?, integration_base_sha = ?,
     integration_head_sha = ? WHERE id = ?`
  ).run(fake.integration.branch, fake.integration.worktree, BASE, BASE, RUN_ID);
  const deps = __fleetMergeTesting.runtimeDeps({
    db,
    ...fake.overrides,
    leaseOwner,
  });
  const operation = __fleetMergeTesting.ensureOperation(deps, {
    runId: RUN_ID,
    taskId: TASK_ID,
    type: "task_merge",
    baseSha: BASE,
    taskHeadSha: TASK,
    commands: ["npm test"],
  });
  const claimed = __fleetMergeTesting.claimOperation(deps, operation.id);
  if (!claimed) throw new Error("test failed to claim task merge operation");
  return { deps, operation: claimed };
}

async function prepareClaimedFinalVerification(
  db: Database.Database,
  fake: ReturnType<typeof fakeRuntime>,
  leaseOwner = "crashed-final-verifier"
) {
  await requestFleetMerge(RUN_ID, "local", "admin", {
    db,
    ...fake.overrides,
  });
  await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
  const run = db
    .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
    .get(RUN_ID) as FleetMergeRunRow;
  const deps = __fleetMergeTesting.runtimeDeps({
    db,
    ...fake.overrides,
    leaseOwner,
  });
  const operation = __fleetMergeTesting.ensureOperation(deps, {
    runId: RUN_ID,
    taskId: null,
    type: "final_verify",
    baseSha: INTEGRATED,
    commands: ["npm test"],
  });
  const claimed = __fleetMergeTesting.claimOperation(deps, operation.id);
  if (!claimed) throw new Error("test failed to claim final verification");
  return { deps, operation: claimed, run };
}

describe("Fleet exact-SHA merge runtime", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createSchema(db);
  });

  it("derives and bounds merge ownership from verifier timeout configuration", () => {
    expect(__fleetMergeTesting.fleetMergeLeaseDuration(600_000)).toBe(
      15 * 60_000
    );
    expect(__fleetMergeTesting.fleetMergeLeaseDuration(20 * 60_000)).toBe(
      21 * 60_000
    );
    expect(__fleetMergeTesting.fleetMergeLeaseDuration(48 * 60 * 60_000)).toBe(
      24 * 60 * 60_000
    );
  });

  it("holds and releases host merge, repository Git, and verifier capacity", () => {
    seed(db);
    const fake = fakeRuntime();
    const deps = __fleetMergeTesting.runtimeDeps({ db, ...fake.overrides });
    const taskOperation = __fleetMergeTesting.ensureOperation(deps, {
      runId: RUN_ID,
      taskId: TASK_ID,
      type: "task_merge",
      baseSha: BASE,
      taskHeadSha: TASK,
    });
    const claimedTask = __fleetMergeTesting.claimOperation(
      deps,
      taskOperation.id
    );
    expect(claimedTask).not.toBeNull();
    expect(
      db
        .prepare(
          `SELECT resource_type, resource_key FROM fleet_runtime_leases
           WHERE owner_type = 'merge_operation' AND status = 'reserved'
           ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "git_operation", resource_key: "repo" },
      { resource_type: "merge_operation", resource_key: "host" },
    ]);
    expect(
      __fleetMergeTesting.finishOperation(deps, claimedTask!, {
        state: "waiting",
      })
    ).toBe(true);

    const verifyOperation = __fleetMergeTesting.ensureOperation(deps, {
      runId: RUN_ID,
      taskId: null,
      type: "final_verify",
      baseSha: BASE,
    });
    expect(
      __fleetMergeTesting.claimOperation(deps, verifyOperation.id)
    ).not.toBeNull();
    expect(
      db
        .prepare(
          `SELECT resource_type, resource_key FROM fleet_runtime_leases
           WHERE owner_id = ? AND status = 'reserved' ORDER BY resource_type`
        )
        .all(verifyOperation.id)
    ).toEqual([
      { resource_type: "git_operation", resource_key: "repo" },
      { resource_type: "merge_operation", resource_key: "host" },
      { resource_type: "verifier", resource_key: "host" },
    ]);
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

  it("accepts exact automatic-fix report and Git evidence without weakening follow-up checks", () => {
    seed(db);
    db.prepare(
      `UPDATE fleet_artifacts
       SET artifact_type = 'automatic_fix_report', body = 'Scoped fix complete',
           metadata_json = '{"followUps":[]}', actor = 'fleet-task-fixer'
       WHERE id = 'report-task-one'`
    ).run();
    db.prepare(
      `UPDATE fleet_artifacts
       SET artifact_type = 'fix_git_state',
           metadata_json = '{"claimDrift":{"hasDrift":false}}',
           actor = 'fleet-task-fixer'
       WHERE id = 'diff-task-one'`
    ).run();

    expect(inspectFleetMergeReadiness(db, RUN_ID)?.readyTaskIds).toEqual([
      TASK_ID,
    ]);

    db.prepare(
      `UPDATE fleet_artifacts SET metadata_json = '{}'
       WHERE id = 'report-task-one'`
    ).run();
    expect(inspectFleetMergeReadiness(db, RUN_ID)?.blockers[0]).toContain(
      "unresolved follow-up"
    );
  });

  it("binds a manual merge request to exact plan, base, and integration-head preconditions", async () => {
    seed(db);
    const fake = fakeRuntime();
    const planHash = (
      db
        .prepare(`SELECT plan_hash FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID) as {
        plan_hash: string;
      }
    ).plan_hash;
    const executionHash = JSON.parse(
      (
        db
          .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
          .get(RUN_ID) as { settings_json: string }
      ).settings_json
    ).approvedExecutionHash as string;
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
          planHash,
          executionHash: "f".repeat(64),
          baseSha: BASE,
          integrationHeadSha: null,
        }
      )
    ).resolves.toEqual({ error: "Fleet merge request preconditions changed" });

    await expect(
      requestFleetMerge(
        RUN_ID,
        "local",
        "admin",
        { db, ...fake.overrides },
        {
          planHash,
          executionHash,
          baseSha: BASE,
          integrationHeadSha: null,
        }
      )
    ).resolves.toMatchObject({ readiness: { requested: false } });
    expect(
      db
        .prepare(
          `SELECT merge_requested_at, merge_request_kind, merge_target,
                  merge_requested_by FROM fleet_runs WHERE id = ?`
        )
        .get(RUN_ID)
    ).toEqual({
      merge_requested_at: null,
      merge_request_kind: "manual",
      merge_target: "local",
      merge_requested_by: "admin",
    });
    db.prepare(
      `UPDATE fleet_runs SET integration_head_sha = ? WHERE id = ?`
    ).run(INTEGRATED, RUN_ID);
    await expect(
      requestFleetMerge(
        RUN_ID,
        "local",
        "admin",
        { db, ...fake.overrides },
        {
          planHash,
          executionHash,
          baseSha: BASE,
          integrationHeadSha: null,
        }
      )
    ).resolves.toEqual({ error: "Fleet merge request preconditions changed" });
    await expect(
      requestFleetMerge(RUN_ID, "github_pr", "admin", {
        db,
        ...fake.overrides,
      })
    ).resolves.toEqual({
      error: "Fleet merge target is already durably bound",
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'manual_merge_requested'`
        )
        .get(RUN_ID)
    ).toEqual({ n: 1 });
  });

  it("stops pending manual staging while paused or recovering and resumes safely", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    db.prepare(
      `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused'
       WHERE id = ?`
    ).run(RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(fake.calls).toHaveLength(0);

    db.prepare(
      `UPDATE fleet_runs SET status = 'running', desired_state = 'running',
       recovery_required = 1 WHERE id = ?`
    ).run(RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(fake.calls).toHaveLength(0);

    db.prepare(`UPDATE fleet_runs SET recovery_required = 0 WHERE id = ?`).run(
      RUN_ID
    );
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "merged" });
  });

  it("requires a second exact operator action before a staged manual intent can land", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      db
        .prepare(`SELECT merge_requested_at FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID)
    ).toEqual({ merge_requested_at: null });
    const expected = landingPreconditions(db);
    await expect(
      authorizeFleetManualLanding(
        RUN_ID,
        "local",
        "operator",
        { ...expected, executionHash: "f".repeat(64) },
        { db, ...fake.overrides }
      )
    ).resolves.toMatchObject({
      error: "Fleet landing authorization preconditions changed",
    });

    db.prepare(
      `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused'
       WHERE id = ?`
    ).run(RUN_ID);
    await expect(
      authorizeFleetManualLanding(RUN_ID, "local", "operator", expected, {
        db,
        ...fake.overrides,
      })
    ).resolves.toMatchObject({ error: expect.any(String) });
    db.prepare(
      `UPDATE fleet_runs SET status = 'merging', desired_state = 'running',
       recovery_required = 1 WHERE id = ?`
    ).run(RUN_ID);
    await expect(
      authorizeFleetManualLanding(RUN_ID, "local", "operator", expected, {
        db,
        ...fake.overrides,
      })
    ).resolves.toMatchObject({ error: expect.any(String) });
    db.prepare(`UPDATE fleet_runs SET recovery_required = 0 WHERE id = ?`).run(
      RUN_ID
    );
    const evidence = db
      .prepare(
        `SELECT operation.output_artifact_id, operation.verification_output_hash
         FROM fleet_merge_operations operation
         WHERE operation.fleet_run_id = ? AND operation.operation_type = 'final_verify'`
      )
      .get(RUN_ID) as {
      output_artifact_id: string;
      verification_output_hash: string;
    };
    db.prepare(`UPDATE fleet_artifacts SET content_hash = ? WHERE id = ?`).run(
      "f".repeat(64),
      evidence.output_artifact_id
    );
    await expect(
      authorizeFleetManualLanding(RUN_ID, "local", "operator", expected, {
        db,
        ...fake.overrides,
      })
    ).resolves.toMatchObject({ error: expect.any(String) });
    db.prepare(`UPDATE fleet_artifacts SET content_hash = ? WHERE id = ?`).run(
      evidence.verification_output_hash,
      evidence.output_artifact_id
    );
    db.prepare(
      `INSERT INTO fleet_resource_usage_buckets
       (fleet_run_id, resource_type, resource_key, bucket_start_ms, units)
       VALUES (?, 'event_bytes_total', 'fleet', 0, ?)
       ON CONFLICT(fleet_run_id, resource_type, resource_key, bucket_start_ms)
       DO UPDATE SET units = excluded.units`
    ).run(RUN_ID, 256 * 1024 ** 2);
    await expect(
      authorizeFleetManualLanding(RUN_ID, "local", "operator", expected, {
        db,
        ...fake.overrides,
      })
    ).resolves.toMatchObject({ readiness: { requested: true } });
    expect(
      db
        .prepare(
          `SELECT merge_requested_at, merge_request_kind, merge_target
           FROM fleet_runs WHERE id = ?`
        )
        .get(RUN_ID)
    ).toMatchObject({
      merge_requested_at: "2026-08-01T12:00:00.000Z",
      merge_request_kind: "manual",
      merge_target: "local",
    });
  });

  it("never consumes a pending manual intent for canceled or failed runs", async () => {
    for (const status of ["canceled", "failed"] as const) {
      seed(db);
      const fake = fakeRuntime();
      await requestFleetMerge(RUN_ID, "local", "admin", {
        db,
        ...fake.overrides,
      });
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      db.prepare(
        `UPDATE fleet_runs SET status = ?, desired_state = ? WHERE id = ?`
      ).run(status, status === "canceled" ? "canceled" : "running", RUN_ID);
      await expect(
        authorizeFleetManualLanding(
          RUN_ID,
          "local",
          "operator",
          landingPreconditions(db),
          { db, ...fake.overrides }
        )
      ).resolves.toMatchObject({ error: expect.any(String) });
      expect(
        db
          .prepare(`SELECT merge_requested_at FROM fleet_runs WHERE id = ?`)
          .get(RUN_ID)
      ).toEqual({ merge_requested_at: null });
      db.close();
      db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      createSchema(db);
    }
  });

  it("retries a transient failed final verification on the exact manual intent after restart", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges(
      {
        db,
        ...fake.overrides,
        verify: async () => ({
          status: "fail" as const,
          output: "transient verifier dependency was unavailable",
        }),
      },
      RUN_ID
    );

    const failed = getFleetMergeStatus(RUN_ID, db);
    expect(failed?.integration).toMatchObject({
      state: "awaiting_operator",
      target: "local",
      requestedAt: null,
      requestKind: "manual",
    });
    expect(failed?.retry).toMatchObject({
      action: "retry_final_verification",
      state: "available",
      available: true,
      attemptCount: 1,
      maxAttempts: 3,
    });
    const preconditions = failed?.retry.preconditions;
    expect(preconditions).not.toBeNull();
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_artifacts
           WHERE fleet_run_id = ? AND artifact_type = 'fleet_final_verification'`
        )
        .get(RUN_ID)
    ).toEqual({ n: 1 });

    await expect(
      requestFleetMerge(
        RUN_ID,
        "local",
        "admin",
        { db, ...fake.overrides },
        {
          planHash: preconditions!.planHash,
          executionHash: preconditions!.executionHash,
          baseSha: preconditions!.baseSha,
          integrationHeadSha: preconditions!.integrationHeadSha,
        }
      )
    ).resolves.toHaveProperty("readiness");
    expect(
      db
        .prepare(
          `SELECT state, attempt_count, output_artifact_id
           FROM fleet_merge_operations WHERE operation_type = 'final_verify'`
        )
        .get()
    ).toEqual({ state: "waiting", attempt_count: 1, output_artifact_id: null });

    // A fresh lease owner simulates a process restart after the retry request.
    const restarted = {
      db,
      ...fake.overrides,
      leaseOwner: "restarted-final-verifier",
    };
    await reconcileFleetMerges(restarted, RUN_ID);
    await authorizeLandingIfReady(db, "local", restarted);
    await reconcileFleetMerges(restarted, RUN_ID);

    expect(
      db
        .prepare(
          `SELECT state, attempt_count FROM fleet_merge_operations
           WHERE operation_type = 'final_verify'`
        )
        .get()
    ).toEqual({ state: "completed", attempt_count: 2 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_artifacts
           WHERE fleet_run_id = ? AND artifact_type = 'fleet_final_verification'`
        )
        .get(RUN_ID)
    ).toEqual({ n: 2 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ?
             AND event_type = 'manual_final_verification_retry_requested'`
        )
        .get(RUN_ID)
    ).toEqual({ n: 1 });
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
    );
  });

  it("retries final verification after an approved artifact-quota remediation", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    const usedArtifactBytes = (
      db
        .prepare(
          `SELECT COALESCE(SUM(units), 0) AS units
           FROM fleet_resource_usage_buckets
           WHERE fleet_run_id = ? AND resource_type = 'artifact_bytes_total'`
        )
        .get(RUN_ID) as { units: number }
    ).units;
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = ?`
    ).run(JSON.stringify({ artifactBytesTotal: usedArtifactBytes }), RUN_ID);
    rebindApprovedExecution(db);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      db
        .prepare(
          `SELECT state, output_artifact_id, attempt_count
           FROM fleet_merge_operations WHERE operation_type = 'final_verify'`
        )
        .get()
    ).toEqual({ state: "failed", output_artifact_id: null, attempt_count: 1 });
    expect(getFleetMergeStatus(RUN_ID, db)?.retry.available).toBe(true);

    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = ?`
    ).run(
      JSON.stringify({ artifactBytesTotal: usedArtifactBytes + 1_000_000 }),
      RUN_ID
    );
    const remediatedExecutionHash = rebindApprovedExecution(db);
    const remediated = getFleetMergeStatus(RUN_ID, db)?.retry;
    expect(remediated).toMatchObject({
      state: "available",
      available: true,
      preconditions: { executionHash: remediatedExecutionHash },
    });

    await requestFleetMerge(
      RUN_ID,
      "local",
      "admin",
      { db, ...fake.overrides },
      {
        planHash: remediated!.preconditions!.planHash,
        executionHash: remediated!.preconditions!.executionHash,
        baseSha: remediated!.preconditions!.baseSha,
        integrationHeadSha: remediated!.preconditions!.integrationHeadSha,
      }
    );
    const remediatedRuntime = {
      db,
      ...fake.overrides,
      leaseOwner: "quota-remediated-verifier",
    };
    await reconcileFleetMerges(remediatedRuntime, RUN_ID);
    expect(
      db
        .prepare(
          `SELECT state, attempt_count FROM fleet_merge_operations
           WHERE operation_type = 'final_verify'`
        )
        .get()
    ).toEqual({ state: "completed", attempt_count: 2 });
    await authorizeLandingIfReady(db, "local", remediatedRuntime);
    await reconcileFleetMerges(remediatedRuntime, RUN_ID);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
    );
  });

  it("rejects stale or drifted final-verification retry bindings without reopening", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges(
      {
        db,
        ...fake.overrides,
        verify: async () => {
          throw new Error("transient verifier transport failure");
        },
      },
      RUN_ID
    );
    const retry = getFleetMergeStatus(RUN_ID, db)?.retry;
    expect(retry?.available).toBe(true);

    await expect(
      requestFleetMerge(
        RUN_ID,
        "local",
        "admin",
        { db, ...fake.overrides },
        {
          planHash: retry!.preconditions!.planHash,
          executionHash: retry!.preconditions!.executionHash,
          baseSha: retry!.preconditions!.baseSha,
          integrationHeadSha: STALE,
        }
      )
    ).resolves.toEqual({ error: "Fleet merge request preconditions changed" });
    expect(
      db
        .prepare(
          `SELECT state FROM fleet_merge_operations
           WHERE operation_type = 'final_verify'`
        )
        .get()
    ).toEqual({ state: "failed" });

    db.prepare(`UPDATE fleet_runs SET max_concurrency = 2 WHERE id = ?`).run(
      RUN_ID
    );
    expect(getFleetMergeStatus(RUN_ID, db)?.retry).toMatchObject({
      state: "blocked",
      available: false,
      reason: "The approved plan or execution contract changed",
    });
    await expect(
      requestFleetMerge(
        RUN_ID,
        "local",
        "admin",
        { db, ...fake.overrides },
        {
          planHash: retry!.preconditions!.planHash,
          executionHash: retry!.preconditions!.executionHash,
          baseSha: retry!.preconditions!.baseSha,
          integrationHeadSha: retry!.preconditions!.integrationHeadSha,
        }
      )
    ).resolves.toEqual({ error: "Fleet merge request preconditions changed" });

    db.prepare(`UPDATE fleet_runs SET max_concurrency = 3 WHERE id = ?`).run(
      RUN_ID
    );
    rebindApprovedExecution(db);
    db.prepare(
      `UPDATE fleet_runs SET integration_base_sha = ? WHERE id = ?`
    ).run(STALE, RUN_ID);
    expect(getFleetMergeStatus(RUN_ID, db)?.retry).toMatchObject({
      state: "blocked",
      available: false,
      reason: "The bound base or integration head changed",
    });
    db.prepare(
      `UPDATE fleet_runs SET integration_base_sha = ?, integration_head_sha = ?
       WHERE id = ?`
    ).run(BASE, STALE, RUN_ID);
    expect(getFleetMergeStatus(RUN_ID, db)?.retry).toMatchObject({
      state: "blocked",
      available: false,
      reason: "Failed final verification evidence is not retry-safe",
    });
  });

  it("keeps final-verification retry closed while paused, recovering, or exhausted", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges(
      {
        db,
        ...fake.overrides,
        verify: async () => {
          throw new Error("transient verifier transport failure");
        },
      },
      RUN_ID
    );

    db.prepare(
      `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused'
       WHERE id = ?`
    ).run(RUN_ID);
    expect(getFleetMergeStatus(RUN_ID, db)?.retry).toMatchObject({
      state: "blocked",
      available: false,
    });
    db.prepare(
      `UPDATE fleet_runs SET status = 'merging', desired_state = 'running',
       recovery_required = 1 WHERE id = ?`
    ).run(RUN_ID);
    expect(getFleetMergeStatus(RUN_ID, db)?.retry.reason).toContain("recovery");
    db.prepare(`UPDATE fleet_runs SET recovery_required = 0 WHERE id = ?`).run(
      RUN_ID
    );
    db.prepare(
      `UPDATE fleet_merge_operations SET attempt_count = 3
       WHERE operation_type = 'final_verify'`
    ).run();
    expect(getFleetMergeStatus(RUN_ID, db)?.retry).toMatchObject({
      state: "exhausted",
      available: false,
      attemptCount: 3,
      maxAttempts: 3,
    });
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
      base_branch: "main",
    });
    expect(
      db
        .prepare(
          `SELECT resource_type, resource_key, units
           FROM fleet_runtime_leases
           WHERE owner_type = 'integration_workspace' AND owner_id = ?
             AND status = 'reserved'
           ORDER BY resource_type`
        )
        .all(RUN_ID)
    ).toEqual([
      {
        resource_type: "disk_bytes",
        resource_key: "fleet",
        units: 512 * 1024 ** 2,
      },
      {
        resource_type: "repo_worktree",
        resource_key: "repo",
        units: 1,
      },
    ]);

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
    await authorizeLandingIfReady(db, "local", fake.overrides);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(fake.heads.get("/repo")).toBe(INTEGRATED);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
    );
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "cleanup_complete"
    );
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'integration_workspace' AND owner_id = ?
             AND status = 'reserved'`
        )
        .get(RUN_ID)
    ).toEqual({ count: 0 });
    expect(
      fake.calls.some(
        (call) =>
          call[1] === "branch" &&
          call[2] === "-D" &&
          call[3] === "--" &&
          call[4] === fake.integration.branch
      )
    ).toBe(true);
  });

  it("consumes an automatic merge authorization only for the exact approved execution", async () => {
    seed(db);
    const automaticPolicy = {
      ...DEFAULT_FLEET_AUTOMATION_POLICY,
      automaticPlanning: true,
      automaticPlanApproval: true,
      automaticStart: true,
      automaticFixes: false,
      maxAutomaticFixRounds: 0,
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
      `UPDATE fleet_runs SET status = 'draft', approval_state = 'needs_approval',
       plan_hash = ?, approved_plan_hash = NULL,
       automation_policy_json = ?, automation_policy_hash = ?,
       settings_json = ? WHERE id = ?`
    ).run(
      planHash,
      fleetAutomationPolicyJson(automaticPolicy),
      policyHash,
      "{}",
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

    // Granting the policy before plan approval must not authorize whichever
    // execution happens to exist later.
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      db
        .prepare(`SELECT merge_requested_at FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID)
    ).toEqual({ merge_requested_at: null });
    expect(
      db
        .prepare(
          `SELECT status FROM fleet_action_authorizations WHERE id = 'merge-auth'`
        )
        .get()
    ).toEqual({ status: "authorized" });

    db.prepare(
      `UPDATE fleet_runs SET status = 'running', desired_state = 'running',
       approval_state = 'approved',
       approved_plan_hash = ?, max_concurrency = 2 WHERE id = ?`
    ).run(planHash, RUN_ID);
    const approvedRun = db
      .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
      .get(RUN_ID) as FleetRunRow;
    const claims = db
      .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
      .all(RUN_ID) as FleetTaskClaimRow[];
    const executionHash = hashFleetExecutionContract({
      run: approvedRun,
      tasks,
      claims,
      dependencies,
    });
    db.prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`).run(
      JSON.stringify({ approvedExecutionHash: executionHash }),
      RUN_ID
    );

    // A post-approval execution-contract change must fail closed without
    // consuming the one-shot merge authorization.
    db.prepare(`UPDATE fleet_runs SET max_concurrency = 3 WHERE id = ?`).run(
      RUN_ID
    );
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      db
        .prepare(`SELECT merge_requested_at FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID)
    ).toEqual({ merge_requested_at: null });
    expect(
      db
        .prepare(
          `SELECT status FROM fleet_action_authorizations WHERE id = 'merge-auth'`
        )
        .get()
    ).toEqual({ status: "authorized" });

    db.prepare(`UPDATE fleet_runs SET max_concurrency = 2 WHERE id = ?`).run(
      RUN_ID
    );
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      db
        .prepare(
          `SELECT merge_requested_at, integration_head_sha
           FROM fleet_runs WHERE id = ?`
        )
        .get(RUN_ID)
    ).toEqual({ merge_requested_at: null, integration_head_sha: INTEGRATED });
    expect(
      db
        .prepare(
          `SELECT status FROM fleet_action_authorizations WHERE id = 'merge-auth'`
        )
        .get()
    ).toEqual({ status: "authorized" });

    // Final verification is also internal staging. Landing authorization is
    // consumed only on the following pass after that exact head is durable.
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    const staleActiveRun = db
      .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
      .get(RUN_ID) as FleetMergeRunRow;
    db.prepare(
      `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused'
       WHERE id = ?`
    ).run(RUN_ID);
    expect(
      __fleetMergeTesting.consumeAutomaticMergeAuthorization(
        __fleetMergeTesting.runtimeDeps({ db, ...fake.overrides }),
        staleActiveRun,
        "local",
        policyHash
      )
    ).toBe(false);
    db.prepare(
      `UPDATE fleet_runs SET status = 'merging', desired_state = 'running'
       WHERE id = ?`
    ).run(RUN_ID);
    db.prepare(`UPDATE fleet_runs SET max_concurrency = 3 WHERE id = ?`).run(
      RUN_ID
    );
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      db
        .prepare(`SELECT merge_requested_at FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID)
    ).toEqual({ merge_requested_at: null });
    expect(
      db
        .prepare(
          `SELECT status FROM fleet_action_authorizations WHERE id = 'merge-auth'`
        )
        .get()
    ).toEqual({ status: "authorized" });
    db.prepare(`UPDATE fleet_runs SET max_concurrency = 2 WHERE id = ?`).run(
      RUN_ID
    );
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
      execution_hash: executionHash,
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

  it.each<VerificationMutation>(["tracked", "staged", "untracked", "head"])(
    "rejects and removes %s verifier mutation from a task integration head",
    async (mutation) => {
      seed(db);
      const fake = fakeRuntime();
      await requestFleetMerge(RUN_ID, "local", "admin", {
        db,
        ...fake.overrides,
      });

      await reconcileFleetMerges(
        {
          db,
          ...fake.overrides,
          verify: async () => {
            fake.mutateIntegration(mutation);
            return { status: "pass" as const, output: "verifier passed" };
          },
        },
        RUN_ID
      );

      expect(fake.heads.get(fake.integration.worktree)).toBe(BASE);
      expect(fake.integrationStatus()).toBe("");
      expect(
        fake.calls.filter((call) => call.includes("commit-tree"))
      ).toHaveLength(1);
      expect(
        fake.calls
          .filter((call) => call[1] === "reset" && call[2] === "--hard")
          .map((call) => call[3])
      ).toEqual(expect.arrayContaining([INTEGRATED, BASE]));
      expect(
        db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
      ).toEqual({ status: "needs_inspection" });
      expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
        "awaiting_operator"
      );
      const artifact = db
        .prepare(
          `SELECT head_sha, severity, metadata_json
           FROM fleet_artifacts
           WHERE fleet_run_id = ? AND artifact_type = 'fleet_integration_verification'`
        )
        .get(RUN_ID) as {
        head_sha: string;
        severity: string;
        metadata_json: string;
      };
      expect(artifact).toMatchObject({
        head_sha: INTEGRATED,
        severity: "blocker",
      });
      expect(JSON.parse(artifact.metadata_json)).toMatchObject({
        integrationHeadSha: INTEGRATED,
        status: "error",
      });
    }
  );

  it.each<VerificationMutation>(["tracked", "staged", "untracked", "head"])(
    "rejects and removes %s verifier mutation from the final integration head",
    async (mutation) => {
      seed(db);
      const fake = fakeRuntime();
      let verificationCount = 0;
      const overrides = {
        db,
        ...fake.overrides,
        verify: async () => {
          verificationCount += 1;
          if (verificationCount === 2) fake.mutateIntegration(mutation);
          return { status: "pass" as const, output: "verifier passed" };
        },
      };
      await requestFleetMerge(RUN_ID, "local", "admin", overrides);
      await reconcileFleetMerges(overrides, RUN_ID);
      expect(fake.heads.get(fake.integration.worktree)).toBe(INTEGRATED);

      await reconcileFleetMerges(overrides, RUN_ID);

      expect(fake.heads.get(fake.integration.worktree)).toBe(INTEGRATED);
      expect(fake.integrationStatus()).toBe("");
      expect(fake.heads.get("/repo")).toBe(BASE);
      expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
        "awaiting_operator"
      );
      expect(
        db
          .prepare(
            `SELECT state FROM fleet_merge_operations
             WHERE operation_type = 'final_verify'`
          )
          .get()
      ).toEqual({ state: "failed" });
      const artifact = db
        .prepare(
          `SELECT head_sha, severity, metadata_json
           FROM fleet_artifacts
           WHERE fleet_run_id = ? AND artifact_type = 'fleet_final_verification'`
        )
        .get(RUN_ID) as {
        head_sha: string;
        severity: string;
        metadata_json: string;
      };
      expect(artifact).toMatchObject({
        head_sha: INTEGRATED,
        severity: "blocker",
      });
      expect(JSON.parse(artifact.metadata_json)).toMatchObject({
        passed: false,
      });
    }
  );

  it("aborts a no-commit merge when the verification artifact quota is exhausted", async () => {
    seed(db);
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = ?`
    ).run(JSON.stringify({ artifactBytesTotal: 1 }), RUN_ID);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(
      fake.calls.some((call) => call[1] === "merge" && call[2] === "--abort")
    ).toBe(true);
    expect(fake.heads.get(fake.integration.worktree)).toBe(BASE);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "awaiting_operator"
    );
    expect(
      db
        .prepare(
          `SELECT state FROM fleet_merge_operations
           WHERE operation_type = 'task_merge'`
        )
        .get()
    ).toEqual({ state: "failed" });
  });

  it("restores the exact integration base when a post-commit audit write fails", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    db.exec(`
      CREATE TRIGGER reject_task_integrated_audit
      BEFORE INSERT ON fleet_events
      WHEN NEW.event_type = 'task_integrated'
      BEGIN
        SELECT RAISE(ABORT, 'rejected task integration audit');
      END
    `);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(fake.calls.some((call) => call.includes("commit-tree"))).toBe(true);
    expect(
      fake.calls.some(
        (call) =>
          call[1] === "reset" && call[2] === "--hard" && call[3] === BASE
      )
    ).toBe(true);
    expect(fake.heads.get(fake.integration.worktree)).toBe(BASE);
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "needs_inspection" });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_artifacts
           WHERE fleet_run_id = ?
             AND artifact_type = 'fleet_integration_verification'`
        )
        .get(RUN_ID)
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `SELECT COALESCE(SUM(units), 0) AS units
           FROM fleet_resource_usage_buckets
           WHERE fleet_run_id = ? AND resource_type = 'artifact_bytes_total'`
        )
        .get(RUN_ID)
    ).toEqual({ units: 0 });
  });

  it("recovers only the durably bound task merge result without constructing it twice", async () => {
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
      `UPDATE fleet_merge_operations
       SET expected_result_head_sha = ?,
           lease_expires_at = '2020-01-01T00:00:00.000Z'
       WHERE id = ?`
    ).run(INTEGRATED, operation.id);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(
      fake.calls.filter((call) => call[1] === "merge" && call[2] === "--no-ff")
    ).toHaveLength(0);
    expect(
      fake.calls.filter((call) => call.includes("commit-tree"))
    ).toHaveLength(0);
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_tasks WHERE id = ?`)
          .get(TASK_ID) as { status: string }
      ).status
    ).toBe("merged");
  });

  it("rejects an unbound descendant that merely contains the task head", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    fake.heads.set(fake.integration.worktree, INTEGRATED);
    db.prepare(
      `UPDATE fleet_runs SET integration_state = 'integrating',
       integration_branch = ?, integration_worktree = ?, integration_base_sha = ?,
       integration_head_sha = ? WHERE id = ?`
    ).run(
      fake.integration.branch,
      fake.integration.worktree,
      BASE,
      BASE,
      RUN_ID
    );
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
      `UPDATE fleet_merge_operations
       SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    ).run(operation.id);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(fake.heads.get(fake.integration.worktree)).toBe(BASE);
    expect(fake.calls.some((call) => call.includes("commit-tree"))).toBe(false);
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "needs_inspection" });
    expect(
      db
        .prepare(
          `SELECT state, expected_result_head_sha
           FROM fleet_merge_operations WHERE id = ?`
        )
        .get(operation.id)
    ).toEqual({ state: "failed", expected_result_head_sha: null });
  });

  it("restores an interrupted unbound no-commit merge before reconstructing it", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    db.prepare(
      `UPDATE fleet_runs SET integration_state = 'integrating',
       integration_branch = ?, integration_worktree = ?, integration_base_sha = ?,
       integration_head_sha = ? WHERE id = ?`
    ).run(
      fake.integration.branch,
      fake.integration.worktree,
      BASE,
      BASE,
      RUN_ID
    );
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
      `UPDATE fleet_merge_operations
       SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    ).run(operation.id);
    fake.startInterruptedMerge();

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(
      fake.calls.some((call) => call[1] === "merge" && call[2] === "--abort")
    ).toBe(true);
    expect(fake.heads.get(fake.integration.worktree)).toBe(INTEGRATED);
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "merged" });
    expect(
      db
        .prepare(
          `SELECT state, expected_result_head_sha, result_head_sha
           FROM fleet_merge_operations WHERE id = ?`
        )
        .get(operation.id)
    ).toEqual({
      state: "completed",
      expected_result_head_sha: INTEGRATED,
      result_head_sha: INTEGRATED,
    });
  });

  it("fences an expired dirty-merge recovery before another reconciler can claim it", async () => {
    seed(db);
    let operationId = "";
    let competingClaim:
      ReturnType<typeof __fleetMergeTesting.claimOperation> | undefined;
    let competingDeps: ReturnType<
      typeof __fleetMergeTesting.runtimeDeps
    > | null = null;
    const fake = fakeRuntime({
      onMergeAbort: () => {
        if (!competingDeps || !operationId) {
          throw new Error("competing recovery test was not initialized");
        }
        competingClaim = __fleetMergeTesting.claimOperation(
          competingDeps,
          operationId
        );
      },
    });
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    db.prepare(
      `UPDATE fleet_runs SET integration_state = 'integrating',
       integration_branch = ?, integration_worktree = ?, integration_base_sha = ?,
       integration_head_sha = ? WHERE id = ?`
    ).run(
      fake.integration.branch,
      fake.integration.worktree,
      BASE,
      BASE,
      RUN_ID
    );
    const crashedDeps = __fleetMergeTesting.runtimeDeps({
      db,
      ...fake.overrides,
      leaseOwner: "crashed-reconciler",
    });
    const operation = __fleetMergeTesting.ensureOperation(crashedDeps, {
      runId: RUN_ID,
      taskId: TASK_ID,
      type: "task_merge",
      baseSha: BASE,
      taskHeadSha: TASK,
      commands: ["npm test"],
    });
    operationId = operation.id;
    __fleetMergeTesting.claimOperation(crashedDeps, operation.id);
    db.prepare(
      `UPDATE fleet_merge_operations
       SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    ).run(operation.id);
    competingDeps = __fleetMergeTesting.runtimeDeps({
      db,
      ...fake.overrides,
      leaseOwner: "competing-reconciler",
    });
    fake.startInterruptedMerge();

    await reconcileFleetMerges(
      {
        db,
        ...fake.overrides,
        leaseOwner: "recovery-reconciler",
      },
      RUN_ID
    );

    expect(competingClaim).toBeNull();
    expect(
      db
        .prepare(
          `SELECT state, lease_owner, expected_result_head_sha
           FROM fleet_merge_operations WHERE id = ?`
        )
        .get(operation.id)
    ).toEqual({
      state: "completed",
      lease_owner: null,
      expected_result_head_sha: INTEGRATED,
    });
  });

  it("recovers a legacy NULL lease with a clean-index MERGE_HEAD before retrying", async () => {
    seed(db);
    const fake = fakeRuntime();
    const { operation } = await prepareClaimedTaskMerge(db, fake);
    db.prepare(
      `UPDATE fleet_merge_operations SET lease_expires_at = NULL WHERE id = ?`
    ).run(operation.id);
    fake.startInterruptedMerge({ clean: true });

    await reconcileFleetMerges(
      { db, ...fake.overrides, leaseOwner: "recovery-reconciler" },
      RUN_ID
    );

    expect(
      fake.calls.some((call) => call[1] === "merge" && call[2] === "--abort")
    ).toBe(true);
    expect(fake.heads.get(fake.integration.worktree)).toBe(INTEGRATED);
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "merged" });
  });

  it.each(["tracked", "staged", "untracked"] as const)(
    "restores a %s verifier mutation at only the durably bound task result",
    async (mutation) => {
      seed(db);
      const fake = fakeRuntime();
      const { operation } = await prepareClaimedTaskMerge(db, fake);
      db.prepare(
        `UPDATE fleet_merge_operations
         SET expected_result_head_sha = ?,
             lease_expires_at = '2020-01-01T00:00:00.000Z'
         WHERE id = ?`
      ).run(INTEGRATED, operation.id);
      fake.heads.set(fake.integration.worktree, INTEGRATED);
      fake.mutateIntegration(mutation);

      await reconcileFleetMerges(
        { db, ...fake.overrides, leaseOwner: "recovery-reconciler" },
        RUN_ID
      );

      expect(fake.integrationStatus()).toBe("");
      expect(fake.heads.get(fake.integration.worktree)).toBe(INTEGRATED);
      expect(
        fake.calls.some(
          (call) =>
            call[1] === "reset" &&
            call[2] === "--hard" &&
            call[3] === INTEGRATED
        )
      ).toBe(true);
      expect(
        db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
      ).toEqual({ status: "merged" });
    }
  );

  it("yields to an unexpired live operation without raising operator attention", async () => {
    seed(db);
    const fake = fakeRuntime();
    const { operation } = await prepareClaimedTaskMerge(db, fake);
    fake.startInterruptedMerge();

    await reconcileFleetMerges(
      { db, ...fake.overrides, leaseOwner: "second-reconciler" },
      RUN_ID
    );

    expect(
      fake.calls.some((call) => call[1] === "merge" && call[2] === "--abort")
    ).toBe(false);
    expect(
      db
        .prepare(
          `SELECT state, lease_owner FROM fleet_merge_operations WHERE id = ?`
        )
        .get(operation.id)
    ).toEqual({ state: "running", lease_owner: "crashed-reconciler" });
    expect(
      db
        .prepare(
          `SELECT integration_state, integration_error
           FROM fleet_runs WHERE id = ?`
        )
        .get(RUN_ID)
    ).toEqual({ integration_state: "initializing", integration_error: null });
  });

  it("does not mutate Git when expired recovery cannot reacquire repository capacity", async () => {
    seed(db);
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = ?`
    ).run(JSON.stringify({ gitOperation: 1 }), RUN_ID);
    rebindApprovedExecution(db);
    const fake = fakeRuntime();
    const { operation } = await prepareClaimedTaskMerge(db, fake);
    db.prepare(
      `UPDATE fleet_merge_operations
       SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    ).run(operation.id);
    db.prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key,
        units, status, lease_expires_at)
       VALUES ('foreign-git-lease', ?, 'merge_operation', 'foreign-operation',
               'git_operation', 'repo', 1, 'reserved',
               '2030-01-01T00:00:00.000Z')`
    ).run(RUN_ID);
    fake.startInterruptedMerge();

    await reconcileFleetMerges(
      { db, ...fake.overrides, leaseOwner: "recovery-reconciler" },
      RUN_ID
    );

    expect(
      fake.calls.some((call) => call[1] === "merge" && call[2] === "--abort")
    ).toBe(false);
    expect(fake.heads.get(fake.integration.worktree)).toBe(BASE);
    expect(
      db
        .prepare(`SELECT lease_owner FROM fleet_merge_operations WHERE id = ?`)
        .get(operation.id)
    ).toEqual({ lease_owner: "crashed-reconciler" });
  });

  it("renews the task operation before verification can outlive its original lease", async () => {
    seed(db);
    const startedAt = Date.parse("2026-08-01T12:00:00.000Z");
    let clock = startedAt;
    let competingClaim: ReturnType<
      typeof __fleetMergeTesting.claimOperation
    > | null = null;
    const fake = fakeRuntime({
      now: () => new Date(clock),
      onCommitTree: () => {
        clock = startedAt + 14 * 60_000;
      },
    });
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });

    await reconcileFleetMerges(
      {
        db,
        ...fake.overrides,
        verify: async () => {
          clock = startedAt + 16 * 60_000;
          const operation = db
            .prepare(
              `SELECT id FROM fleet_merge_operations
               WHERE fleet_run_id = ? AND operation_type = 'task_merge'`
            )
            .get(RUN_ID) as { id: string };
          competingClaim = __fleetMergeTesting.claimOperation(
            __fleetMergeTesting.runtimeDeps({
              db,
              ...fake.overrides,
              leaseOwner: "late-competing-reconciler",
            }),
            operation.id
          );
          return { status: "pass" as const, output: "" };
        },
      },
      RUN_ID
    );

    expect(competingClaim).toBeNull();
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "merged" });
  });

  it("recovers an expired final-verifier mutation at the exact combined head", async () => {
    seed(db);
    const fake = fakeRuntime();
    const { operation } = await prepareClaimedFinalVerification(db, fake);
    db.prepare(
      `UPDATE fleet_merge_operations
       SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`
    ).run(operation.id);
    fake.mutateIntegration("staged");

    await reconcileFleetMerges(
      { db, ...fake.overrides, leaseOwner: "final-recovery-reconciler" },
      RUN_ID
    );

    expect(fake.integrationStatus()).toBe("");
    expect(fake.heads.get(fake.integration.worktree)).toBe(INTEGRATED);
    expect(
      db
        .prepare(
          `SELECT state FROM fleet_merge_operations
           WHERE id = ? AND operation_type = 'final_verify'`
        )
        .get(operation.id)
    ).toEqual({ state: "completed" });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_artifacts
           WHERE fleet_run_id = ? AND artifact_type = 'fleet_final_verification'`
        )
        .get(RUN_ID)
    ).toEqual({ count: 1 });
  });

  it.each([
    ["canceled", "canceled", "canceled", "failed"],
    ["paused", "paused", "ready_to_merge", "waiting"],
  ] as const)(
    "preserves a %s run that wins the task-verifier race",
    async (status, desiredState, expectedTaskStatus, operationState) => {
      seed(db);
      const fake = fakeRuntime();
      await requestFleetMerge(RUN_ID, "local", "admin", {
        db,
        ...fake.overrides,
      });

      await reconcileFleetMerges(
        {
          db,
          ...fake.overrides,
          verify: async () => {
            db.prepare(
              `UPDATE fleet_runs SET status = ?, desired_state = ? WHERE id = ?`
            ).run(status, desiredState, RUN_ID);
            if (status === "canceled") {
              db.prepare(
                `UPDATE fleet_tasks SET status = 'canceled' WHERE id = ?`
              ).run(TASK_ID);
            }
            return { status: "pass" as const, output: "" };
          },
        },
        RUN_ID
      );

      expect(
        db
          .prepare(
            `SELECT status, desired_state, integration_state
             FROM fleet_runs WHERE id = ?`
          )
          .get(RUN_ID)
      ).toEqual({
        status,
        desired_state: desiredState,
        integration_state: "integrating",
      });
      expect(
        db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
      ).toEqual({ status: expectedTaskStatus });
      expect(
        db
          .prepare(
            `SELECT state FROM fleet_merge_operations
             WHERE operation_type = 'task_merge'`
          )
          .get()
      ).toEqual({ state: operationState });
      expect(fake.heads.get(fake.integration.worktree)).toBe(BASE);
    }
  );

  it.each([
    ["canceled", "canceled", "failed"],
    ["paused", "paused", "waiting"],
  ] as const)(
    "preserves a %s run that wins the final-verifier race",
    async (status, desiredState, operationState) => {
      seed(db);
      const fake = fakeRuntime();
      await requestFleetMerge(RUN_ID, "local", "admin", {
        db,
        ...fake.overrides,
      });
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

      await reconcileFleetMerges(
        {
          db,
          ...fake.overrides,
          verify: async () => {
            db.prepare(
              `UPDATE fleet_runs SET status = ?, desired_state = ? WHERE id = ?`
            ).run(status, desiredState, RUN_ID);
            return { status: "pass" as const, output: "" };
          },
        },
        RUN_ID
      );

      expect(
        db
          .prepare(
            `SELECT status, desired_state, integration_state,
                    integration_head_sha
             FROM fleet_runs WHERE id = ?`
          )
          .get(RUN_ID)
      ).toEqual({
        status,
        desired_state: desiredState,
        integration_state: "final_verifying",
        integration_head_sha: INTEGRATED,
      });
      expect(
        db
          .prepare(
            `SELECT state FROM fleet_merge_operations
             WHERE operation_type = 'final_verify'`
          )
          .get()
      ).toEqual({ state: operationState });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM fleet_artifacts
             WHERE artifact_type = 'fleet_final_verification'`
          )
          .get()
      ).toEqual({ count: 0 });
    }
  );

  it("refuses a dirty local source checkout without moving its head", async () => {
    seed(db);
    const fake = fakeRuntime({ dirtyLocal: true });
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await authorizeLandingIfReady(db, "local", fake.overrides);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(fake.heads.get("/repo")).toBe(BASE);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "awaiting_operator"
    );
  });

  it("rejects a symbolic local target ref instead of following it", async () => {
    seed(db);
    const fake = fakeRuntime({ symbolicLocalTarget: "release" });
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await authorizeLandingIfReady(db, "local", fake.overrides);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(fake.refHead("main")).toBe(BASE);
    expect(fake.refHead("release")).toBe(BASE);
    expect(fake.calls.some((call) => call[1] === "update-ref")).toBe(false);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "awaiting_operator",
      error: expect.stringContaining("symbolic"),
    });
  });

  it("advances only the target ref when the checkout switches branches during landing", async () => {
    seed(db);
    const fake = fakeRuntime({ localBranchAfterFastForward: "release" });
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await authorizeLandingIfReady(db, "local", fake.overrides);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(fake.refHead("main")).toBe(INTEGRATED);
    expect(fake.refHead("release")).toBe(BASE);
    expect(fake.heads.get("/repo")).toBe(BASE);
    expect(
      fake.calls.filter(
        (call) => call[1] === "merge" && call[2] === "--ff-only"
      )
    ).toHaveLength(0);
    expect(fake.calls.some((call) => call[1] === "read-tree")).toBe(false);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
    );
  });

  it("certifies the exact target ref without refreshing the ambient checkout", async () => {
    seed(db);
    const fake = fakeRuntime({ dirtyLocalAfterFastForward: true });
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await authorizeLandingIfReady(db, "local", fake.overrides);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(fake.refHead("main")).toBe(INTEGRATED);
    expect(fake.calls.some((call) => call[1] === "read-tree")).toBe(false);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
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
    await authorizeLandingIfReady(db, "local", fake.overrides);
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
    fake.setRefHead("main", INTEGRATED);
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

  it("repairs a legacy failed operation when the exact local fast-forward is authoritative", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await authorizeLandingIfReady(db, "local", fake.overrides);
    const deps = __fleetMergeTesting.runtimeDeps({ db, ...fake.overrides });
    const operation = __fleetMergeTesting.ensureOperation(deps, {
      runId: RUN_ID,
      taskId: null,
      type: "local_finalize",
      target: "local",
      baseSha: INTEGRATED,
    });
    db.prepare(
      `UPDATE fleet_merge_operations SET state = 'failed',
       error = 'legacy false failure', completed_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), operation.id);
    fake.setRefHead("main", INTEGRATED);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(
      fake.calls.filter(
        (call) => call[1] === "merge" && call[2] === "--ff-only"
      )
    ).toHaveLength(0);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
    );
    expect(
      db
        .prepare(
          `SELECT state, result_head_sha FROM fleet_merge_operations
           WHERE id = ?`
        )
        .get(operation.id)
    ).toEqual({ state: "completed", result_head_sha: INTEGRATED });
  });

  it("keeps an externally completed local fast-forward recoverable when its audit transaction fails", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await authorizeLandingIfReady(db, "local", fake.overrides);
    db.exec(`
      CREATE TRIGGER reject_local_merge_audit
      BEFORE INSERT ON fleet_events
      WHEN NEW.event_type = 'fleet_merge_completed'
      BEGIN
        SELECT RAISE(ABORT, 'rejected local merge audit');
      END
    `);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(fake.heads.get("/repo")).toBe(INTEGRATED);
    expect(
      db
        .prepare(
          `SELECT state FROM fleet_merge_operations
           WHERE operation_type = 'local_finalize'`
        )
        .get()
    ).toEqual({ state: "waiting" });
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).not.toBe(
      "failed"
    );
    db.exec(`DROP TRIGGER reject_local_merge_audit`);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(
      fake.calls.filter(
        (call) => call[1] === "update-ref" && call[3] === "refs/heads/main"
      )
    ).toHaveLength(1);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
    );
  });

  it("refuses to delete an integration branch whose head changed before cleanup", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    await authorizeLandingIfReady(db, "local", fake.overrides);
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "completed"
    );
    fake.heads.set(fake.integration.worktree, STALE);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "cleanup_pending",
      error: expect.stringContaining("unexpected head"),
    });
    expect(
      fake.calls.some((call) => call[1] === "branch" && call[2] === "-D")
    ).toBe(false);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'integration_workspace' AND owner_id = ?
             AND status = 'reserved'`
        )
        .get(RUN_ID)
    ).toEqual({ count: 2 });
  });

  it("aborts a canceled landing and replay-safely cleans only its exact Fleet workspace", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    authorizeIntegrationCleanup(db, fake.integration.worktree);
    db.prepare(
      `UPDATE fleet_runs SET status = 'canceled', desired_state = 'canceled',
       cancel_mode = 'cancel-and-clean-owned-worktrees' WHERE id = ?`
    ).run(RUN_ID);

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(
      fake.calls.some((call) => call[1] === "merge" && call[2] === "--ff-only")
    ).toBe(false);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "cleanup_complete"
    );
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'integration_workspace' AND owner_id = ?
             AND status = 'reserved'`
        )
        .get(RUN_ID)
    ).toEqual({ count: 0 });
    const cleanupCalls = () =>
      fake.calls.filter(
        (call) =>
          (call[1] === "branch" && call[2] === "-D") ||
          (call[1] === "for-each-ref" && call.includes(fake.integration.branch))
      ).length;
    const completedCleanupCalls = cleanupCalls();

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(cleanupCalls()).toBe(completedCleanupCalls);
  });

  it("preserves failed-run integration evidence while releasing runtime capacity", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    db.prepare(`UPDATE fleet_runs SET status = 'failed' WHERE id = ?`).run(
      RUN_ID
    );
    const callsBeforeTerminalReconcile = fake.calls.length;

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(fake.calls).toHaveLength(callsBeforeTerminalReconcile);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "integrating",
      branch: fake.integration.branch,
      worktree: fake.integration.worktree,
      headSha: INTEGRATED,
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_artifacts
           WHERE fleet_run_id = ?
             AND artifact_type = 'fleet_integration_verification'`
        )
        .get(RUN_ID)
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'integration_workspace' AND owner_id = ?
             AND status = 'reserved'`
        )
        .get(RUN_ID)
    ).toEqual({ count: 0 });
  });

  it("fails closed instead of deleting a mismatched canceled workspace", async () => {
    seed(db);
    const fake = fakeRuntime();
    await requestFleetMerge(RUN_ID, "local", "admin", {
      db,
      ...fake.overrides,
    });
    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    db.prepare(
      `UPDATE fleet_runs SET status = 'canceled', desired_state = 'canceled',
       cancel_mode = 'cancel-and-clean-owned-worktrees',
       integration_worktree = '/not-fleet-owned' WHERE id = ?`
    ).run(RUN_ID);
    authorizeIntegrationCleanup(db, "/not-fleet-owned");

    await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);

    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "cleanup_pending",
      error: expect.stringContaining("non-Fleet"),
    });
    expect(
      fake.calls.some((call) => call[1] === "branch" && call[2] === "-D")
    ).toBe(false);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'integration_workspace' AND owner_id = ?
             AND status = 'reserved'`
        )
        .get(RUN_ID)
    ).toEqual({ count: 0 });
  });

  it("creates one PR and atomically fast-forwards only the exact target ref", async () => {
    seed(db);
    const fake = fakeRuntime({ github: true });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 6; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
    }
    const integrationPush = fake.calls.find(
      (call) =>
        call[1] === "push" &&
        call.at(-1)?.endsWith(`:refs/heads/${fake.integration.branch}`)
    );
    expect(integrationPush).toEqual([
      fake.integration.worktree,
      "push",
      "https://github.com/owner/repo.git",
      `${INTEGRATED}:refs/heads/${fake.integration.branch}`,
    ]);
    expect(integrationPush).not.toContain("--force");
    const landingPush = fake.calls.find(
      (call) =>
        call[1] === "push" &&
        call.some((arg) => arg.startsWith("--force-with-lease="))
    );
    expect(landingPush).toEqual([
      fake.integration.worktree,
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/main:${BASE}`,
      "https://github.com/owner/repo.git",
      `${INTEGRATED}:refs/heads/main`,
    ]);
    expect(landingPush).not.toContain("--force");
    expect(fake.prCreateCalls).toBe(1);
    expect(fake.landingUpdates).toBe(1);
    expect(fake.remoteRefHead("main")).toBe(INTEGRATED);
    expect(fake.remoteRefHead("release")).toBe(BASE);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.mergeSha).toBe(
      INTEGRATED
    );
  });

  it("refuses to publish when the checkout origin differs from the registered GitHub repository", async () => {
    seed(db);
    const fake = fakeRuntime({
      github: true,
      originUrl: "https://github.com/other/repository.git",
    });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 6; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
    }

    expect(fake.calls.some((call) => call[1] === "push")).toBe(false);
    expect(fake.prCreateCalls).toBe(0);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "awaiting_operator",
      error: expect.stringContaining("repository identity differs"),
    });
  });

  it("recovers a GitHub merge that completed before the client reported failure", async () => {
    seed(db);
    const fake = fakeRuntime({
      github: true,
      mergeThrowsAfterCompletion: true,
    });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 7; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
    }

    expect(fake.landingPushCalls).toBe(1);
    expect(fake.landingUpdates).toBe(1);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "cleanup_complete",
      mergeSha: INTEGRATED,
    });
    expect(
      db
        .prepare(
          `SELECT state, result_head_sha FROM fleet_merge_operations
           WHERE operation_type = 'github_merge'`
        )
        .get()
    ).toEqual({ state: "completed", result_head_sha: INTEGRATED });
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
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
    }
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "awaiting_operator"
    );
  });

  it("fails closed when GitHub reports an unsafe check conclusion", async () => {
    seed(db);
    const fake = fakeRuntime({
      github: true,
      prChecks: [{ conclusion: "STALE", status: "COMPLETED" }],
    });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 7; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
    }

    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "waiting_ci",
      error: "GitHub checks are failing",
    });
  });

  it("refuses a GitHub PR whose base moved after integration", async () => {
    seed(db);
    const fake = fakeRuntime({ github: true, prBase: STALE });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 7; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
    }

    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "awaiting_operator",
      error: expect.stringContaining("base changed"),
    });
  });

  it("rechecks the pinned GitHub base immediately before merge", async () => {
    seed(db);
    const fake = fakeRuntime({ github: true });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 7; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
      const current = db
        .prepare(`SELECT integration_pr_number FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID) as { integration_pr_number: number | null };
      if (current.integration_pr_number != null) break;
    }
    expect(fake.prCreateCalls).toBe(1);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration.state).toBe(
      "waiting_ci"
    );

    fake.setPrBase(STALE);
    for (let tick = 0; tick < 3; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    }

    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "awaiting_operator",
      error: expect.stringContaining("base changed"),
    });
  });

  it("refuses a GitHub PR retargeted to another branch at the same base SHA", async () => {
    seed(db);
    const fake = fakeRuntime({ github: true });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 7; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
      const current = db
        .prepare(`SELECT integration_pr_number FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID) as { integration_pr_number: number | null };
      if (current.integration_pr_number != null) break;
    }
    fake.setPrBaseBranch("release");

    for (let tick = 0; tick < 3; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    }

    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "awaiting_operator",
      error: expect.stringContaining("target branch changed"),
    });
  });

  it("cannot redirect an exact-ref landing when the PR is retargeted concurrently", async () => {
    seed(db);
    const fake = fakeRuntime({
      github: true,
      retargetOnMerge: "release",
      mergeThrowsAfterCompletion: true,
    });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 9; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
    }

    expect(fake.landingUpdates).toBe(1);
    expect(fake.remoteRefHead("main")).toBe(INTEGRATED);
    expect(fake.remoteRefHead("release")).toBe(BASE);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "cleanup_complete",
      mergeSha: INTEGRATED,
    });
  });

  it("performs no Fleet update when the target base advances during landing", async () => {
    seed(db);
    const fake = fakeRuntime({
      github: true,
      advanceBaseOnLanding: STALE,
    });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 9; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
    }

    expect(fake.landingPushCalls).toBe(1);
    expect(fake.landingUpdates).toBe(0);
    expect(fake.remoteRefHead("main")).toBe(STALE);
    expect(fake.remoteRefHead("release")).toBe(BASE);
    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "awaiting_operator",
      mergeSha: null,
      error: expect.stringContaining("stale remote target lease"),
    });
  });

  it("does not recover an already-merged GitHub PR on the wrong target branch", async () => {
    seed(db);
    const fake = fakeRuntime({ github: true });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 7; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
      const current = db
        .prepare(`SELECT integration_pr_number FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID) as { integration_pr_number: number | null };
      if (current.integration_pr_number != null) break;
    }
    fake.setPrBaseBranch("release");
    fake.markPrMerged();

    for (let tick = 0; tick < 3; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
    }

    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "awaiting_operator",
      error: expect.stringContaining("target branch changed"),
    });
  });

  it("does not merge while GitHub has not registered any checks", async () => {
    seed(db);
    const fake = fakeRuntime({ github: true, prChecks: [] });
    await requestFleetMerge(RUN_ID, "github_pr", "admin", {
      db,
      ...fake.overrides,
    });
    for (let tick = 0; tick < 8; tick++) {
      await reconcileFleetMerges({ db, ...fake.overrides }, RUN_ID);
      await authorizeLandingIfReady(db, "github_pr", fake.overrides);
    }

    expect(getFleetMergeStatus(RUN_ID, db)?.integration).toMatchObject({
      state: "waiting_ci",
      error: expect.stringContaining("not reported any checks"),
      mergeSha: null,
    });
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

    const checks = (statusCheckRollup: unknown[]) =>
      parseFleetPrStatus(
        JSON.stringify({
          number: 2,
          url: "https://github.com/o/r/pull/2",
          state: "OPEN",
          baseRefOid: BASE,
          headRefOid: TASK,
          mergeable: "MERGEABLE",
          statusCheckRollup,
        })
      )?.checks;
    expect(checks([{ conclusion: "SUCCESS" }])).toBe("passing");
    expect(checks([{ conclusion: "NEUTRAL" }])).toBe("passing");
    expect(checks([{ conclusion: "SKIPPED" }])).toBe("passing");
    expect(checks([{ status: "QUEUED" }])).toBe("pending");
    expect(checks([{ conclusion: "STALE", status: "COMPLETED" }])).toBe(
      "failing"
    );
    expect(checks([{ conclusion: "STARTUP_FAILURE" }])).toBe("failing");
    expect(checks([{ conclusion: "A_FUTURE_TERMINAL_VALUE" }])).toBe("failing");
    expect(checks([{ status: "COMPLETED" }])).toBe("failing");
    expect(checks([{ status: "A_FUTURE_TERMINAL_STATE" }])).toBe("failing");
    expect(checks([])).toBe("none");
  });
});
