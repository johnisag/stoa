import { createHash, randomUUID } from "crypto";
import { basename } from "path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSchema } from "@/lib/db/schema";
import { generateBranchName } from "@/lib/git";
import { DEFAULT_FLEET_AUTOMATION_POLICY } from "@/lib/fleet/automation-policy";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "@/lib/fleet/hash";
import {
  FLEET_PLAN_REVIEW_LENSES,
  fleetPlanReviewerApprovalMode,
  parseFleetPlanReviewResult,
  reconcileFleetPlanReviews,
  type FleetPlanReviewContract,
  type FleetPlanReviewExpectedResult,
} from "@/lib/fleet/plan-review";
import type {
  FleetAutomationPolicy,
  FleetPlanReviewLens,
  FleetRunRow,
  FleetTaskRow,
} from "@/lib/fleet/types";

const BASE_SHA = "a".repeat(40);
const PLAN_HASH = "b".repeat(64);
const EXECUTION_HASH = "c".repeat(64);
const NONCE = "n".repeat(64);
const NOW = new Date("2026-08-01T12:00:00.000Z");

function nonceHash(value = NONCE): string {
  return createHash("sha256").update(value).digest("hex");
}

function expected(
  overrides: Partial<FleetPlanReviewExpectedResult> = {}
): FleetPlanReviewExpectedResult {
  return {
    nonceHash: nonceHash(),
    runId: "run-review",
    planHash: PLAN_HASH,
    policyHash: "d".repeat(64),
    executionHash: EXECUTION_HASH,
    baseSha: BASE_SHA,
    lens: "correctness_security",
    ...overrides,
  };
}

function result(
  overrides: Record<string, unknown> = {},
  identity = expected()
): string {
  return JSON.stringify({
    schemaVersion: 1,
    nonce: NONCE,
    runId: identity.runId,
    planHash: identity.planHash,
    policyHash: identity.policyHash,
    executionHash: identity.executionHash,
    baseSha: identity.baseSha,
    lens: identity.lens,
    verdict: "clean",
    findings: [],
    ...overrides,
  });
}

describe("Fleet plan review result parser", () => {
  it("never selects an unconfined bypass without persisted consent", () => {
    const safePolicy = { ...DEFAULT_FLEET_AUTOMATION_POLICY };
    expect(
      fleetPlanReviewerApprovalMode(safePolicy, {
        sandboxEnabled: false,
        confinementAvailable: false,
      })
    ).toBe("prompt");
    expect(
      fleetPlanReviewerApprovalMode(safePolicy, {
        sandboxEnabled: true,
        confinementAvailable: true,
      })
    ).toBe("sandboxed-auto");
    expect(
      fleetPlanReviewerApprovalMode(
        { ...safePolicy, allowUnconfinedAgents: true },
        { sandboxEnabled: false, confinementAvailable: false }
      )
    ).toBe("full-bypass");
  });

  it("accepts a clean result bound to the exact nonce and execution contract", () => {
    expect(parseFleetPlanReviewResult(result(), expected())).toEqual({
      ok: true,
      verdict: "clean",
      findings: [],
    });
  });

  it.each([
    ["runId", "another-run"],
    ["planHash", "e".repeat(64)],
    ["policyHash", "e".repeat(64)],
    ["executionHash", "e".repeat(64)],
    ["baseSha", "e".repeat(40)],
    ["lens", "simplicity_ux"],
  ])("rejects a mismatched %s binding", (field, value) => {
    expect(
      parseFleetPlanReviewResult(result({ [field]: value }), expected())
    ).toMatchObject({ ok: false, error: expect.stringContaining(field) });
  });

  it("rejects replay nonces, contradictory verdicts, and unbounded results", () => {
    expect(
      parseFleetPlanReviewResult(result({ nonce: "wrong" }), expected())
    ).toMatchObject({ ok: false, error: expect.stringContaining("nonce") });
    expect(
      parseFleetPlanReviewResult(
        result({
          verdict: "changes_requested",
          findings: [{ severity: "warning", title: "Risk", body: "Fix it" }],
        }),
        expected()
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining("blocker") });
    expect(
      parseFleetPlanReviewResult(
        result({
          findings: [
            { severity: "blocker", title: "Broken", body: "Cannot pass" },
          ],
        }),
        expected()
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining("clean") });
    expect(
      parseFleetPlanReviewResult(
        JSON.stringify({ padding: "x".repeat(70 * 1024) }),
        expected()
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining("safety") });
  });
});

interface SpawnCapture {
  lens: FleetPlanReviewLens;
  prompt: string;
  worktree: string;
  resultFilename: string;
  sessionId: string;
}

describe("Fleet plan review runtime", () => {
  let db: InstanceType<typeof Database>;
  let policy: FleetAutomationPolicy;
  let contract: FleetPlanReviewContract;
  let captures: SpawnCapture[];
  let removed: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    policy = {
      ...DEFAULT_FLEET_AUTOMATION_POLICY,
      automaticPlanning: true,
      automaticPlanApproval: true,
    };
    const policyHash = hashFleetAutomationPolicy(policy);
    const task = {
      id: "task-1",
      fleet_run_id: "run-review",
      parent_task_id: null,
      title: "Implement runtime",
      description: "Add restart-safe automation",
      status: "draft",
      task_type: "implementation",
      sort_order: 0,
      file_claims_json: JSON.stringify(["lib/fleet/"]),
      agent_type: "codex",
      acceptance_criteria: "All gates pass",
      verify_command: "npm test",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    } satisfies FleetTaskRow;
    const planHash = hashFleetTaskRows([task], []);
    db.prepare(
      `INSERT INTO fleet_runs (
         id, name, goal, status, provider, review_policy, approval_state,
         plan_hash, desired_state, automation_policy_json,
         automation_policy_hash, automation_base_sha, settings_json
       ) VALUES (?, ?, ?, 'draft', 'codex', 'four_agent', 'needs_approval',
         ?, 'planned', ?, ?, ?, ?)`
    ).run(
      "run-review",
      "Review run",
      "Deliver the epic safely",
      planHash,
      JSON.stringify(policy),
      policyHash,
      BASE_SHA,
      JSON.stringify({ planText: "1. Implement the safe runtime" })
    );
    const run = db
      .prepare(`SELECT * FROM fleet_runs WHERE id = 'run-review'`)
      .get() as FleetRunRow;
    const claims = [
      {
        id: "claim-1",
        fleet_run_id: run.id,
        task_id: task.id,
        path: "lib/fleet/",
        claim_type: "exclusive" as const,
        confidence: 1,
      },
    ];
    const executionHash = hashFleetExecutionContract({
      run,
      tasks: [task],
      dependencies: [],
      claims,
    });
    contract = {
      run,
      policy,
      planHash,
      policyHash,
      executionHash,
      baseSha: BASE_SHA,
      workingDirectory: "C:\\repo",
      planText: "1. Implement the safe runtime",
      tasks: [task],
      dependencies: [],
      claims,
    };
    captures = [];
    removed = [];
  });

  function runtimeDeps(
    options: {
      results?: boolean;
      changesLens?: FleetPlanReviewLens;
      now?: Date;
    } = {}
  ) {
    return {
      db,
      now: () => options.now ?? NOW,
      randomId: () => randomUUID(),
      randomNonce: () => NONCE,
      spawn: vi.fn(
        async ({
          lens,
          prompt,
          branchFeature,
        }: {
          lens: FleetPlanReviewLens;
          prompt: string;
          branchFeature: string;
        }) => {
          const resultFilename = prompt.match(
            /STOA_FLEET_REVIEW_[a-f0-9]+\.json/
          )?.[0];
          if (!resultFilename) throw new Error("prompt omitted result file");
          const capture = {
            lens,
            prompt,
            worktree: `C:\\reviews\\${lens}`,
            resultFilename,
            sessionId: `session-${lens}`,
          };
          captures.push(capture);
          return {
            id: capture.sessionId,
            worktree_path: capture.worktree,
            branch_name: generateBranchName(branchFeature),
          };
        }
      ),
      readResult: vi.fn(async (path: string) => {
        if (!options.results) {
          return { ok: false as const, error: "missing", missing: true };
        }
        const capture = captures.find(
          (candidate) => basename(path) === candidate.resultFilename
        );
        if (!capture) {
          return { ok: false as const, error: "unknown result", missing: true };
        }
        const changes = capture.lens === options.changesLens;
        const text = result(
          changes
            ? {
                verdict: "changes_requested",
                findings: [
                  {
                    severity: "blocker",
                    title: "Unsafe plan",
                    body: "The plan needs an explicit restart test.",
                  },
                ],
              }
            : {},
          expected({
            policyHash: contract.policyHash,
            planHash: contract.planHash,
            executionHash: contract.executionHash,
            lens: capture.lens,
          })
        );
        return { ok: true as const, text, bytes: Buffer.byteLength(text) };
      }),
      sessionExists: vi.fn(async () => true),
      stopSession: vi.fn(async () => true),
      removeWorktree: vi.fn(async (path: string) => {
        removed.push(path);
      }),
      git: vi.fn(async (cwd: string, args: string[]) => {
        if (args[0] === "rev-parse")
          return { stdout: `${BASE_SHA}\n`, stderr: "" };
        if (args[0] === "diff") return { stdout: "", stderr: "" };
        const capture = captures.find(
          (candidate) => candidate.worktree === cwd
        );
        return {
          stdout: capture ? `${capture.resultFilename}\0` : "",
          stderr: "",
        };
      }),
    };
  }

  it("spawns four distinct exact-SHA critics with all review context", async () => {
    await reconcileFleetPlanReviews(contract, runtimeDeps());

    const rows = db
      .prepare(`SELECT * FROM fleet_reviews ORDER BY lens`)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.reviewer_session_id)).size).toBe(4);
    expect(rows.every((row) => row.state === "running")).toBe(true);
    expect(rows.every((row) => row.base_sha === BASE_SHA)).toBe(true);
    expect(rows.every((row) => row.nonce_hash === nonceHash())).toBe(true);
    expect(captures.map((capture) => capture.lens).sort()).toEqual(
      [...FLEET_PLAN_REVIEW_LENSES].sort()
    );
    for (const capture of captures) {
      expect(capture.prompt).toContain(contract.planHash);
      expect(capture.prompt).toContain(contract.policyHash);
      expect(capture.prompt).toContain(contract.executionHash);
      expect(capture.prompt).toContain(BASE_SHA);
      expect(capture.prompt).toContain("npm test");
      expect(capture.prompt).toContain("lib/fleet/");
      expect(capture.prompt).toContain("Do not approve or start");
    }
  });

  it("publishes clean evidence only after stopping, read-only validation, and cleanup", async () => {
    const deps = runtimeDeps({ results: true });
    await reconcileFleetPlanReviews(contract, deps);
    await reconcileFleetPlanReviews(contract, deps);

    const rows = db
      .prepare(`SELECT * FROM fleet_reviews ORDER BY lens`)
      .all() as Array<Record<string, unknown>>;
    expect(rows.every((row) => row.state === "clean")).toBe(true);
    expect(rows.every((row) => row.verdict === "clean")).toBe(true);
    expect(new Set(rows.map((row) => row.reviewer_session_id)).size).toBe(4);
    expect(removed).toHaveLength(4);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM fleet_artifacts`).get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  });

  it("persists changes_requested and attaches a blocker that closes approval", async () => {
    const deps = runtimeDeps({
      results: true,
      changesLens: "adversarial_red_team",
    });
    await reconcileFleetPlanReviews(contract, deps);
    await reconcileFleetPlanReviews(contract, deps);

    const changed = db
      .prepare(
        `SELECT * FROM fleet_reviews WHERE lens = 'adversarial_red_team'`
      )
      .get() as Record<string, unknown>;
    expect(changed).toMatchObject({
      state: "changes_requested",
      verdict: "changes_requested",
    });
    const blocker = db
      .prepare(`SELECT * FROM fleet_artifacts WHERE severity = 'blocker'`)
      .get() as Record<string, unknown>;
    expect(blocker).toMatchObject({
      plan_hash: contract.planHash,
      artifact_type: "plan_review_finding",
      actor: "fleet-plan-review:adversarial_red_team",
    });
  });

  it("recovers a partially persisted spawn by its durable branch and request", async () => {
    const deps = runtimeDeps();
    await reconcileFleetPlanReviews(contract, deps);
    const row = db
      .prepare(
        `SELECT * FROM fleet_reviews WHERE lens = 'correctness_security'`
      )
      .get() as Record<string, string>;
    db.prepare(
      `UPDATE fleet_reviews
       SET state = 'spawning', reviewer_session_id = '', worktree_path = NULL
       WHERE id = ?`
    ).run(row.id);
    db.prepare(
      `INSERT INTO sessions (
         id, name, tmux_name, working_directory, group_path, agent_type,
         worker_task, worker_status, worktree_path, branch_name
       ) VALUES (?, 'Recovered reviewer', 'recovered-reviewer', ?, 'sessions',
         'codex', ?, 'running', ?, ?)`
    ).run(
      "session-recovered",
      "C:\\reviews\\recovered",
      `Write ${row.result_filename}`,
      "C:\\reviews\\recovered",
      row.branch_name
    );

    await reconcileFleetPlanReviews(contract, {
      ...deps,
      spawn: vi.fn(async () => {
        throw new Error("must not respawn a durable request");
      }),
    });

    expect(
      db
        .prepare(
          `SELECT state, reviewer_session_id FROM fleet_reviews WHERE id = ?`
        )
        .get(row.id)
    ).toMatchObject({
      state: "running",
      reviewer_session_id: "session-recovered",
    });
  });
});
