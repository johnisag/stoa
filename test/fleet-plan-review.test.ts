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
import type { FleetAgentProviderId } from "@/lib/fleet/auxiliary-provider";

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

  it("redacts credential-shaped finding prose after binding validation", () => {
    const canary = "sk-PLANREVIEWCANARY012345";
    const parsed = parseFleetPlanReviewResult(
      result({
        verdict: "changes_requested",
        findings: [
          {
            severity: "blocker",
            title: `Unsafe ${canary}`,
            body: `Remove ${canary} before approval`,
          },
        ],
      }),
      expected()
    );
    expect(parsed).toMatchObject({ ok: true, verdict: "changes_requested" });
    expect(JSON.stringify(parsed)).not.toContain(canary);
    expect(JSON.stringify(parsed)).toContain("[REDACTED]");
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
  persistedPrompt: string;
  worktree: string;
  resultFilename: string;
  sessionId: string;
  provider: FleetAgentProviderId;
  model: string | null;
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
      allowUnconfinedAgents: true,
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
      findingCanary?: string;
      now?: Date;
    } = {}
  ) {
    return {
      db,
      now: () => options.now ?? NOW,
      randomId: () => randomUUID(),
      randomNonce: () => NONCE,
      installedProviders: () => ["codex" as const],
      spawn: vi.fn(
        async ({
          lens,
          prompt,
          persistedPrompt,
          branchFeature,
          provider,
          model,
        }: {
          lens: FleetPlanReviewLens;
          prompt: string;
          persistedPrompt: string;
          branchFeature: string;
          provider: FleetAgentProviderId;
          model: string | null;
        }) => {
          const resultFilename = prompt.match(
            /STOA_FLEET_REVIEW_[a-f0-9]+\.json/
          )?.[0];
          if (!resultFilename) throw new Error("prompt omitted result file");
          const capture = {
            lens,
            prompt,
            persistedPrompt,
            worktree: `C:\\reviews\\${lens}`,
            resultFilename,
            sessionId: `session-${lens}`,
            provider,
            model,
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
                    title: options.findingCanary
                      ? `Unsafe ${options.findingCanary}`
                      : "Unsafe plan",
                    body: options.findingCanary
                      ? `Remove ${options.findingCanary} before approval.`
                      : "The plan needs an explicit restart test.",
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
      expect(capture.persistedPrompt).not.toContain(NONCE);
      expect(capture.persistedPrompt).toContain("[redacted ephemeral nonce]");
    }
  });

  it("retries a transient reviewer launch after restart without spinning", async () => {
    const deps = runtimeDeps();
    const successfulSpawn = deps.spawn.getMockImplementation()!;
    deps.spawn
      .mockRejectedValueOnce(new Error("429 too many requests"))
      .mockImplementation(successfulSpawn);

    await reconcileFleetPlanReviews(contract, deps);
    let retry = db
      .prepare(
        `SELECT * FROM fleet_reviews
         WHERE state = 'pending' AND launch_failure_count = 1`
      )
      .get() as Record<string, unknown>;
    expect(retry).toMatchObject({
      retry_not_before: "2026-08-01T12:00:05.000Z",
      findings_json: "[]",
    });
    expect(deps.spawn).toHaveBeenCalledTimes(1);

    await reconcileFleetPlanReviews(contract, deps);
    expect(deps.spawn).toHaveBeenCalledTimes(1);

    const restarted = runtimeDeps({
      now: new Date("2026-08-01T12:00:05.000Z"),
    });
    await reconcileFleetPlanReviews(contract, restarted);
    retry = db
      .prepare(`SELECT * FROM fleet_reviews WHERE id = ?`)
      .get(retry.id) as Record<string, unknown>;
    expect(retry).toMatchObject({
      state: "running",
      launch_failure_count: 0,
      retry_not_before: null,
    });
    expect(restarted.spawn).toHaveBeenCalledTimes(4);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_artifacts`).get()
    ).toEqual({ n: 0 });
  });

  it("uses an installed fallback for all four lanes without leaking the run model", async () => {
    const fallbackRun = {
      ...contract.run,
      provider: "hermes",
      model: "kimi-k3",
    };
    contract = {
      ...contract,
      run: fallbackRun,
      executionHash: hashFleetExecutionContract({
        run: fallbackRun,
        tasks: contract.tasks,
        dependencies: contract.dependencies,
        claims: contract.claims,
      }),
    };
    db.prepare(
      `UPDATE fleet_runs SET provider = ?, model = ? WHERE id = ?`
    ).run("hermes", "kimi-k3", contract.run.id);

    await reconcileFleetPlanReviews(contract, runtimeDeps());

    expect(captures).toHaveLength(4);
    expect(captures.every((capture) => capture.provider === "codex")).toBe(
      true
    );
    expect(captures.every((capture) => capture.model === null)).toBe(true);
    expect(
      db
        .prepare(
          `SELECT provider, model, COUNT(*) AS count
           FROM fleet_reviews GROUP BY provider, model`
        )
        .all()
    ).toEqual([{ provider: "codex", model: null, count: 4 }]);
    expect(
      db
        .prepare(
          `SELECT provider, model, COUNT(*) AS count
           FROM fleet_cost_accounts WHERE owner_type = 'plan_review'
           GROUP BY provider, model`
        )
        .all()
    ).toEqual([{ provider: "codex", model: null, count: 4 }]);
    expect(new Set(captures.map((capture) => capture.sessionId)).size).toBe(4);
  });

  it("runs four review lanes in retryable waves when provider capacity is two", async () => {
    const limitedRun = {
      ...contract.run,
      provider_caps_json: JSON.stringify({ codex: 2 }),
    };
    contract = {
      ...contract,
      run: limitedRun,
      executionHash: hashFleetExecutionContract({
        run: limitedRun,
        tasks: contract.tasks,
        dependencies: contract.dependencies,
        claims: contract.claims,
      }),
    };
    db.prepare(`UPDATE fleet_runs SET provider_caps_json = ? WHERE id = ?`).run(
      limitedRun.provider_caps_json,
      contract.run.id
    );
    const deps = runtimeDeps({ results: true });

    await reconcileFleetPlanReviews(contract, deps);
    expect(captures).toHaveLength(2);
    expect(
      db
        .prepare(
          `SELECT state, COUNT(*) AS count FROM fleet_reviews
           GROUP BY state ORDER BY state`
        )
        .all()
    ).toEqual([
      { state: "pending", count: 2 },
      { state: "running", count: 2 },
    ]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_reviews
           WHERE state = 'pending' AND error LIKE '%waiting for runtime capacity%'`
        )
        .get()
    ).toEqual({ count: 2 });

    await reconcileFleetPlanReviews(contract, deps);
    expect(captures).toHaveLength(4);
    expect(
      db
        .prepare(
          `SELECT state, COUNT(*) AS count FROM fleet_reviews
           GROUP BY state ORDER BY state`
        )
        .all()
    ).toEqual([
      { state: "clean", count: 2 },
      { state: "running", count: 2 },
    ]);

    await reconcileFleetPlanReviews(contract, deps);
    expect(
      db
        .prepare(
          `SELECT state, COUNT(*) AS count FROM fleet_reviews GROUP BY state`
        )
        .all()
    ).toEqual([{ state: "clean", count: 4 }]);
  });

  it("rolls back all review slots when their required audit event is rejected", async () => {
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = ?`
    ).run(JSON.stringify({ eventBytesTotal: 1 }), contract.run.id);

    await expect(
      reconcileFleetPlanReviews(contract, runtimeDeps())
    ).rejects.toThrow(/event_bytes_total/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fleet_reviews`).get()).toEqual(
      {
        n: 0,
      }
    );
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fleet_events`).get()).toEqual({
      n: 0,
    });
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

  it("redacts review findings consistently across rows, artifacts, and hashes", async () => {
    const canary = "sk-REVIEWRESULTCANARY012345";
    const deps = runtimeDeps({
      results: true,
      changesLens: "adversarial_red_team",
      findingCanary: canary,
    });
    await reconcileFleetPlanReviews(contract, deps);
    await reconcileFleetPlanReviews(contract, deps);

    const review = db
      .prepare(
        `SELECT findings_json, error FROM fleet_reviews
         WHERE lens = 'adversarial_red_team'`
      )
      .get();
    const artifact = db
      .prepare(
        `SELECT title, body, content_hash FROM fleet_artifacts
         WHERE severity = 'blocker'`
      )
      .get() as { title: string; body: string; content_hash: string };
    const events = db.prepare(`SELECT payload FROM fleet_events`).all();
    expect(JSON.stringify({ review, artifact, events })).not.toContain(canary);
    expect(JSON.stringify({ review, artifact })).toContain("[REDACTED]");
    expect(artifact.content_hash).toBe(
      createHash("sha256").update(artifact.body, "utf8").digest("hex")
    );
  });

  it("rolls back a received result when its audit event exceeds quota", async () => {
    const deps = runtimeDeps({ results: true });
    await reconcileFleetPlanReviews(contract, deps);
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = ?`
    ).run(JSON.stringify({ eventBytesTotal: 1 }), contract.run.id);

    await expect(reconcileFleetPlanReviews(contract, deps)).rejects.toThrow(
      /event_bytes_total/
    );
    expect(
      db
        .prepare(
          `SELECT DISTINCT state, findings_json, error FROM fleet_reviews`
        )
        .all()
    ).toEqual([{ state: "running", findings_json: "[]", error: null }]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_artifacts`).get()
    ).toEqual({
      n: 0,
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

  it("fails closed when restart recovery finds a Kilo plan critic", async () => {
    const deps = runtimeDeps();
    await reconcileFleetPlanReviews(contract, deps);
    const row = db
      .prepare(
        `SELECT * FROM fleet_reviews WHERE lens = 'correctness_security'`
      )
      .get() as Record<string, string>;
    db.prepare(
      `UPDATE fleet_reviews
       SET state = 'spawning', provider = 'kilo', reviewer_session_id = '',
           worktree_path = NULL
       WHERE id = ?`
    ).run(row.id);
    db.prepare(
      `UPDATE fleet_cost_accounts SET provider = 'kilo'
       WHERE fleet_run_id = ? AND owner_type = 'plan_review' AND owner_id = ?`
    ).run(contract.run.id, row.request_id);
    db.prepare(
      `UPDATE fleet_runtime_leases SET resource_key = 'kilo'
       WHERE fleet_run_id = ? AND owner_type = 'plan_review' AND owner_id = ?
         AND resource_type = 'provider'`
    ).run(contract.run.id, row.request_id);
    db.prepare(
      `INSERT INTO sessions (
         id, name, tmux_name, working_directory, group_path, agent_type,
         worker_task, worker_status, worktree_path, branch_name
       ) VALUES (?, 'Recovered Kilo critic', 'recovered-kilo-critic', ?,
         'sessions', 'kilo', ?, 'running', ?, ?)`
    ).run(
      "session-recovered-kilo",
      "C:\\reviews\\recovered-kilo",
      `Write ${row.result_filename}`,
      "C:\\reviews\\recovered-kilo",
      row.branch_name
    );
    const stopSession = vi.fn(async () => true);

    await reconcileFleetPlanReviews(contract, {
      ...deps,
      stopSession,
      spawn: vi.fn(async () => {
        throw new Error("must not activate or respawn a Kilo critic");
      }),
    });

    expect(stopSession).toHaveBeenCalledWith(
      "session-recovered-kilo",
      "failed"
    );
    expect(removed).toContain("C:\\reviews\\recovered-kilo");
    expect(
      db
        .prepare(
          `SELECT state, reviewer_session_id, error,
                  completed_at IS NOT NULL AS completed
           FROM fleet_reviews WHERE id = ?`
        )
        .get(row.id)
    ).toEqual({
      state: "changes_requested",
      reviewer_session_id: "session-recovered-kilo",
      error: "persisted plan reviewer provider cannot run unattended",
      completed: 1,
    });
    expect(
      db
        .prepare(
          `SELECT session_id,
                  reservation_released_at IS NOT NULL AS released,
                  terminal_at IS NOT NULL AS terminal
           FROM fleet_cost_accounts
           WHERE fleet_run_id = ? AND owner_type = 'plan_review'
             AND owner_id = ?`
        )
        .get(contract.run.id, row.request_id)
    ).toEqual({ session_id: null, released: 1, terminal: 1 });
  });
});
