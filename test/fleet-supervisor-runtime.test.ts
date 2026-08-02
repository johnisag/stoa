import { resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/db";
import { createSchema } from "@/lib/db/schema";
import { resolveSessionLaunchOptions } from "@/lib/session-launch";
import { setFleetSchedulerReady } from "@/lib/fleet/recovery-gate";
import {
  _managedSupervisorResultFrameForTests,
  managedSupervisorClaudeArgs,
  MANAGED_SUPERVISOR_READY,
  MANAGED_SUPERVISOR_STARTED,
} from "@/lib/fleet/supervisor-broker";
import {
  cancelManagedFleetSupervisor,
  getManagedFleetSupervisorStatus,
  launchManagedSupervisorBrokerWithBackend,
  reconcileManagedFleetSupervisors,
  startManagedFleetSupervisor,
  type ManagedFleetSupervisorDeps,
  type ManagedFleetSupervisorRuntimeDeps,
  type ManagedFleetSupervisorState,
  type ManagedSupervisorBrokerLaunch,
} from "@/lib/fleet/supervisor-runtime";

const RUN_ID = "managed-supervisor-run";
const REQUEST_ID = "managed-supervisor-request";
const SESSION_ID = "managed-supervisor-session";
const NONCE = "ephemeral-supervisor-nonce";
const PLAN_HASH = "1".repeat(64);
const POLICY_HASH = "2".repeat(64);
const BASE_SHA = "a".repeat(40);
const FAKE_PROVIDER = resolve("test/fixtures/fleet-supervisor-provider.cjs");

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO sessions
     (id, name, tmux_name, status, working_directory, model, group_path,
      agent_type)
     VALUES ('fleet-conductor', 'Conductor', 'codex-conductor', 'running',
      'C:\\repo', 'gpt-5.4', 'sessions', 'codex')`
  ).run();
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, desired_state, approval_state, plan_hash,
      approved_plan_hash, automation_policy_json, automation_policy_hash,
      automation_base_sha, provider, model, conductor_session_id, settings_json)
     VALUES (?, 'Fleet', 'Deliver the bounded epic', 'running', 'running',
      'approved', ?, ?, '{}', ?, ?, 'codex', 'gpt-5.4', 'fleet-conductor', '{}')`
  ).run(RUN_ID, PLAN_HASH, PLAN_HASH, POLICY_HASH, BASE_SHA);
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, description, status, task_type, sort_order,
      file_claims_json, priority, working_directory, base_branch, base_sha,
      head_sha, provider_state, max_attempts, current_attempt,
      verification_status, review_status, integration_state)
     VALUES ('task-a', ?, 'Task A', 'First bounded task', 'ready',
      'implementation', 0, '["lib/a.ts"]', 1, 'C:\\repo', 'main', ?, ?,
      'ready', 3, 0, NULL, NULL, 'pending'),
     ('task-b', ?, 'Task B', 'Second bounded task', 'blocked',
      'implementation', 1, '["lib/b.ts"]', 1, 'C:\\repo', 'main', ?, ?,
      'ready', 3, 0, NULL, NULL, 'pending')`
  ).run(RUN_ID, BASE_SHA, "b".repeat(40), RUN_ID, BASE_SHA, "c".repeat(40));
}

function state(db: Database.Database): ManagedFleetSupervisorState {
  const row = db
    .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
    .get(RUN_ID) as { settings_json: string };
  return JSON.parse(row.settings_json).managedSupervisor;
}

function patchState(
  db: Database.Database,
  patch: Partial<ManagedFleetSupervisorState>
): ManagedFleetSupervisorState {
  const current = state(db);
  const next = { ...current, ...patch };
  const row = db
    .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
    .get(RUN_ID) as { settings_json: string };
  const settings = JSON.parse(row.settings_json);
  settings.managedSupervisor = next;
  db.prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`).run(
    JSON.stringify(settings),
    RUN_ID
  );
  return next;
}

function resultObject(
  current: ManagedFleetSupervisorState,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    nonce: NONCE,
    runId: RUN_ID,
    requestId: current.requestId,
    attempt: current.attempt,
    expectedSnapshotHash: current.snapshotHash,
    expectedPlanHash: current.planHash,
    expectedPolicyHash: current.policyHash,
    expectedExecutionHash: current.executionHash,
    expectedBaseSha: current.baseSha,
    summary: "Inspect the blocked task before changing the plan.",
    actions: [
      {
        kind: "inspect",
        taskId: "task-b",
        rationale: "The task remains blocked in durable Fleet truth.",
      },
    ],
    ...overrides,
  };
}

function decodedPrompt(launch: ManagedSupervisorBrokerLaunch): string {
  const encoded = launch.promptFrame.replace(
    /^STOA_FLEET_SUPERVISOR_PROMPT_V1 /,
    ""
  );
  return Buffer.from(encoded, "base64url").toString("utf8");
}

describe("managed Fleet supervisor captured-output runtime", () => {
  let db: Database.Database;
  let now: Date;
  let live: boolean;
  let capture: string;
  let launched: ManagedSupervisorBrokerLaunch | null;
  let launchSession: ManagedFleetSupervisorRuntimeDeps["launchSession"];
  let stopSession: ManagedFleetSupervisorRuntimeDeps["stopSession"];
  let deps: ManagedFleetSupervisorDeps;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(() => {
    previousEnv = {
      STOA_TOKEN: process.env.STOA_TOKEN,
      STOA_SESSION_ID: process.env.STOA_SESSION_ID,
      DB_PATH: process.env.DB_PATH,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      STOA_CONTAINER: process.env.STOA_CONTAINER,
      STOA_CONTAINER_IMAGE: process.env.STOA_CONTAINER_IMAGE,
    };
    process.env.STOA_TOKEN = "stoa-authority";
    process.env.STOA_SESSION_ID = "session-authority";
    process.env.DB_PATH = "C:\\authority\\stoa.db";
    process.env.GITHUB_TOKEN = "github-authority";
    process.env.ANTHROPIC_API_KEY = "anthropic-inference";
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.STOA_CONTAINER;
    delete process.env.STOA_CONTAINER_IMAGE;

    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    seed(db);
    setFleetSchedulerReady(true);
    now = new Date("2026-08-02T10:00:00.000Z");
    live = false;
    capture = "";
    launched = null;
    launchSession = vi.fn(async (launch: ManagedSupervisorBrokerLaunch) => {
      // The durable row and starting state must exist before any async process
      // creation, closing cancel/restart/late-spawn identity races.
      expect(
        db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(launch.sessionId)
      ).toEqual({ id: launch.sessionId });
      expect(state(db)).toMatchObject({
        state: "starting",
        sessionId: launch.sessionId,
        launchProfileHash: launch.profileHash,
      });
      launched = launch;
      live = true;
    });
    stopSession = vi.fn(async () => {
      live = false;
      return true;
    });
    deps = {
      db,
      now: () => new Date(now),
      randomId: () => REQUEST_ID,
      randomSessionId: () => SESSION_ID,
      randomNonce: () => NONCE,
      availableProviders: () => ["claude", "codex"],
      resolveClaudeSpawn: () => ({
        binary: process.execPath,
        argsPrefix: [FAKE_PROVIDER],
      }),
      launchSession,
      captureSession: vi.fn(async () => capture),
      sessionExists: vi.fn(async () => live),
      stopSession,
    };
  });

  afterEach(() => {
    setFleetSchedulerReady(false);
    db.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function start(): Promise<ManagedFleetSupervisorState> {
    const result = await startManagedFleetSupervisor(RUN_ID, {}, deps);
    expect(result).toEqual({
      status: expect.objectContaining({
        state: "running",
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        provider: "claude",
        model: "sonnet",
        advisoryOnly: true,
      }),
    });
    return state(db);
  }

  it("preallocates one immutable Claude-only broker identity with no tools, MCP, conductor, worktree, bypass, or inherited authority", async () => {
    const current = await start();
    expect(launched).not.toBeNull();
    const launch = launched!;
    expect(launch.envMode).toBe("replace");
    expect(launch.environment).toMatchObject({
      ANTHROPIC_API_KEY: "anthropic-inference",
    });
    expect(launch.environment).not.toHaveProperty("STOA_TOKEN");
    expect(launch.environment).not.toHaveProperty("STOA_SESSION_ID");
    expect(launch.environment).not.toHaveProperty("DB_PATH");
    expect(launch.environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(launch.args.join(" ")).not.toContain(NONCE);
    expect(launch.promptFrame).not.toContain(NONCE);
    expect(decodedPrompt(launch)).toContain(NONCE);
    expect(decodedPrompt(launch)).toContain(
      "Return exactly one UTF-8 JSON object on stdout"
    );
    expect(decodedPrompt(launch)).not.toMatch(/write exactly one.*path/i);

    const session = db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(SESSION_ID) as Session;
    expect(session).toMatchObject({
      agent_type: "claude",
      model: "sonnet",
      session_role: "fleet_supervisor",
      conductor_session_id: null,
      parent_session_id: null,
      claude_session_id: null,
      worktree_path: null,
      mcp_launch_args: null,
      approval_mode: "prompt",
    });
    expect(Boolean(session.auto_approve)).toBe(false);
    expect(session.launch_profile_hash).toBe(current.launchProfileHash);
    const profile = JSON.parse(session.launch_profile_json!);
    expect(profile).toMatchObject({
      role: "fleet_supervisor",
      provider: "claude",
      tools: "none",
      mcp: "none",
      approvalMode: "prompt",
      sessionPersistence: false,
    });
    expect(profile.providerArgs).toEqual([
      FAKE_PROVIDER,
      ...managedSupervisorClaudeArgs("sonnet"),
    ]);
    expect(
      db
        .prepare(
          `SELECT resource_type FROM fleet_runtime_leases
           WHERE owner_type = 'supervisor' ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "provider" },
      { resource_type: "pty" },
      { resource_type: "transport_host" },
    ]);

    const durable = [
      (
        db
          .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
          .get(RUN_ID) as { settings_json: string }
      ).settings_json,
      session.worker_task ?? "",
      session.launch_profile_json ?? "",
      ...(
        db
          .prepare(`SELECT payload FROM fleet_events WHERE fleet_run_id = ?`)
          .all(RUN_ID) as Array<{ payload: string | null }>
      ).map((row) => row.payload ?? ""),
    ].join("\n");
    expect(durable).not.toContain(NONCE);
  });

  it("waits for broker READY before input and for STARTED before launch settles", async () => {
    await start();
    const launch = launched!;
    const calls: string[] = [];
    let captures = 0;
    const backend = {
      create: vi.fn(async () => {
        calls.push("create");
      }),
      capture: vi.fn(async () => {
        captures += 1;
        calls.push(`capture-${captures}`);
        return captures === 1
          ? `${MANAGED_SUPERVISOR_READY}\n`
          : `${MANAGED_SUPERVISOR_READY}\n${MANAGED_SUPERVISOR_STARTED}\n`;
      }),
      exists: vi.fn(async () => true),
      sendKeysLiteral: vi.fn(async () => {
        calls.push("prompt");
      }),
      sendEnter: vi.fn(async () => {
        calls.push("enter");
      }),
    };
    await launchManagedSupervisorBrokerWithBackend(launch, backend as never);
    expect(calls[0]).toBe("create");
    expect(calls[1]).toBe("capture-1");
    expect(calls.filter((call) => call === "prompt").length).toBeGreaterThan(0);
    expect(calls.indexOf("prompt")).toBeGreaterThan(calls.indexOf("capture-1"));
    expect(calls.indexOf("enter")).toBeGreaterThan(calls.lastIndexOf("prompt"));
    expect(calls.at(-1)).toBe("capture-2");
  });

  it("accepts one bound captured recommendation without mutating run or task truth", async () => {
    const current = await start();
    capture = _managedSupervisorResultFrameForTests(
      JSON.stringify(resultObject(current))
    );
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db)).toMatchObject({
      state: "completed",
      artifactId: expect.stringMatching(/^managed-supervisor-/),
      resultBytes: expect.any(Number),
    });
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID, "completed");
    const artifact = db
      .prepare(
        `SELECT artifact_type, body FROM fleet_artifacts
         WHERE fleet_run_id = ?`
      )
      .get(RUN_ID) as { artifact_type: string; body: string };
    expect(artifact.artifact_type).toBe("fleet_supervisor_recommendation");
    expect(artifact.body).toContain("task-b");
    expect(
      db
        .prepare(`SELECT status, desired_state FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID)
    ).toEqual({ status: "running", desired_state: "running" });
    expect(
      db.prepare(`SELECT id, status FROM fleet_tasks ORDER BY id`).all()
    ).toEqual([
      { id: "task-a", status: "ready" },
      { id: "task-b", status: "blocked" },
    ]);
  });

  it("recovers the exact durable running session after restart without relaunching it", async () => {
    const current = await start();
    vi.mocked(launchSession).mockClear();
    capture = _managedSupervisorResultFrameForTests(
      JSON.stringify(resultObject(current))
    );
    await reconcileManagedFleetSupervisors(40, deps);
    expect(launchSession).not.toHaveBeenCalled();
    expect(state(db).state).toBe("completed");
  });

  it("rotates bounded polling to a later healthy supervisor", async () => {
    await start();
    const blockerRunId = "aaa-managed-supervisor-blocker";
    const blockerRequestId = "aaa-supervisor-request";
    const blockerSessionId = "aaa-supervisor-session";
    db.prepare(
      `INSERT INTO fleet_runs
       (id, name, goal, status, desired_state, approval_state, plan_hash,
        approved_plan_hash, automation_policy_json, automation_policy_hash,
        automation_base_sha, provider, model, conductor_session_id, settings_json)
       VALUES (?, 'Blocker', 'Keep one healthy supervisor pending', 'running',
        'running', 'approved', ?, ?, '{}', ?, ?, 'codex', 'gpt-5.4',
        'fleet-conductor', '{}')`
    ).run(blockerRunId, PLAN_HASH, PLAN_HASH, POLICY_HASH, BASE_SHA);
    db.prepare(
      `INSERT INTO fleet_tasks
       (id, fleet_run_id, title, description, status, task_type, sort_order,
        file_claims_json, priority, working_directory, base_branch, base_sha,
        head_sha, provider_state, max_attempts, current_attempt,
        verification_status, review_status, integration_state)
       VALUES ('blocker-task-a', ?, 'Task A', 'First task', 'ready',
        'implementation', 0, '["lib/blocker-a.ts"]', 1, 'C:\\repo', 'main',
        ?, ?, 'ready', 3, 0, NULL, NULL, 'pending'),
       ('blocker-task-b', ?, 'Task B', 'Second task', 'blocked',
        'implementation', 1, '["lib/blocker-b.ts"]', 1, 'C:\\repo', 'main',
        ?, ?, 'ready', 3, 0, NULL, NULL, 'pending')`
    ).run(
      blockerRunId,
      BASE_SHA,
      "d".repeat(40),
      blockerRunId,
      BASE_SHA,
      "e".repeat(40)
    );
    const blockerLaunch = vi.fn(async () => {});
    await expect(
      startManagedFleetSupervisor(
        blockerRunId,
        {},
        {
          ...deps,
          randomId: () => blockerRequestId,
          randomSessionId: () => blockerSessionId,
          randomNonce: () => "blocker-ephemeral-nonce",
          launchSession: blockerLaunch,
          sessionExists: vi.fn(async () => true),
        }
      )
    ).resolves.toEqual({
      status: expect.objectContaining({
        state: "running",
        sessionId: blockerSessionId,
      }),
    });
    db.prepare(
      `UPDATE fleet_runs SET managed_supervisor_poll_cursor = 1 WHERE id = ?`
    ).run(RUN_ID);

    const polled: string[] = [];
    const pollDeps: ManagedFleetSupervisorDeps = {
      ...deps,
      captureSession: vi.fn(async (_database, sessionId) => {
        polled.push(sessionId);
        return `${MANAGED_SUPERVISOR_READY}\n${MANAGED_SUPERVISOR_STARTED}\n`;
      }),
      sessionExists: vi.fn(async () => true),
    };
    await reconcileManagedFleetSupervisors(1, pollDeps);
    await reconcileManagedFleetSupervisors(1, pollDeps);

    expect(polled).toEqual([blockerSessionId, SESSION_ID]);
    expect(blockerLaunch).toHaveBeenCalledTimes(1);
  });

  it("reattaches a preallocated starting identity but never respawns a lost one", async () => {
    await start();
    vi.mocked(launchSession).mockClear();
    patchState(db, {
      state: "starting",
      launchSettled: false,
      backendCreated: false,
    });
    capture = `${MANAGED_SUPERVISOR_READY}\n${MANAGED_SUPERVISOR_STARTED}\n`;
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db)).toMatchObject({
      state: "running",
      launchSettled: true,
      backendCreated: true,
    });
    expect(launchSession).not.toHaveBeenCalled();

    patchState(db, {
      state: "starting",
      launchSettled: false,
      backendCreated: false,
      startedAt: "2026-08-02T09:00:00.000Z",
    });
    live = false;
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db)).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/will not be respawned/),
    });
    expect(launchSession).not.toHaveBeenCalled();
  });

  it("fails and settles a live starting broker whose capture stays unavailable beyond launch grace", async () => {
    await start();
    patchState(db, {
      state: "starting",
      launchSettled: false,
      backendCreated: true,
      startedAt: "2026-08-02T09:00:00.000Z",
    });
    deps.captureSession = vi.fn(async () => {
      throw new Error("capture transport unavailable");
    });
    live = true;

    await reconcileManagedFleetSupervisors(40, deps);

    expect(state(db)).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/capture remained unavailable/i),
    });
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID, "failed");
    expect(
      db
        .prepare(
          `SELECT terminal_at, reservation_released_at
           FROM fleet_cost_accounts
           WHERE owner_type = 'supervisor' AND owner_id = ?`
        )
        .get(REQUEST_ID)
    ).toMatchObject({
      terminal_at: expect.any(String),
      reservation_released_at: expect.any(String),
    });
  });

  it("charges conservatively when process launch may have reached the provider before handshake failure", async () => {
    launchSession = vi.fn(async () => {
      // Model a successful process create followed by a failed READY/STARTED
      // handshake and an inconclusive liveness probe.
      live = false;
      throw new Error("post-create handshake failed");
    });
    deps.launchSession = launchSession;

    const result = await startManagedFleetSupervisor(RUN_ID, {}, deps);
    expect(result).toMatchObject({
      error: expect.stringMatching(/post-create handshake failed/),
      statusCode: 500,
    });
    expect(state(db)).toMatchObject({
      state: "failed",
      launchAttempted: true,
      backendCreated: false,
    });
    const account = db
      .prepare(
        `SELECT reservation_usd, terminal_at, reservation_released_at
         FROM fleet_cost_accounts
         WHERE owner_type = 'supervisor' AND owner_id = ?`
      )
      .get(REQUEST_ID) as {
      reservation_usd: number;
      terminal_at: string | null;
      reservation_released_at: string | null;
    };
    const run = db
      .prepare(`SELECT spent_budget_usd FROM fleet_runs WHERE id = ?`)
      .get(RUN_ID) as { spent_budget_usd: number };
    expect(account.terminal_at).toEqual(expect.any(String));
    expect(account.reservation_released_at).toEqual(expect.any(String));
    expect(run.spent_budget_usd).toBe(account.reservation_usd);
  });

  it("rejects every provider without a verified no-tools mode", async () => {
    await expect(
      startManagedFleetSupervisor(RUN_ID, { provider: "codex" }, deps)
    ).resolves.toEqual({
      error:
        "managed supervision currently requires Claude's verified no-tools mode",
      statusCode: 400,
    });
    expect(launchSession).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get()).toEqual({
      count: 1,
    });
  });

  it("fails before admission when --bare has no explicit environment-token authentication", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await expect(
      startManagedFleetSupervisor(RUN_ID, {}, deps)
    ).resolves.toEqual({
      error: expect.stringMatching(
        /requires a nonblank ANTHROPIC_API_KEY.*--bare/
      ),
      statusCode: 409,
    });
    expect(launchSession).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get()).toEqual({
      count: 1,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM fleet_cost_accounts`).get()
    ).toEqual({ count: 0 });
  });

  it("blocks launch before row creation while global recovery is closed", async () => {
    setFleetSchedulerReady(false);
    const result = await startManagedFleetSupervisor(RUN_ID, {}, deps);
    expect(result).toMatchObject({ statusCode: 503 });
    expect(launchSession).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get()).toEqual({
      count: 1,
    });
  });

  it("rejects a failed run before reserving or launching a supervisor", async () => {
    db.prepare(`UPDATE fleet_runs SET status = 'failed' WHERE id = ?`).run(
      RUN_ID
    );

    await expect(
      startManagedFleetSupervisor(RUN_ID, {}, deps)
    ).resolves.toEqual({
      error: "Fleet run is not available for managed supervision",
      statusCode: 409,
    });
    expect(launchSession).not.toHaveBeenCalled();
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM fleet_cost_accounts`).get()
    ).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get()).toEqual({
      count: 1,
    });
  });

  it("stops and settles a supervisor when its Fleet run fails", async () => {
    await start();
    db.prepare(`UPDATE fleet_runs SET status = 'failed' WHERE id = ?`).run(
      RUN_ID
    );

    await reconcileManagedFleetSupervisors(40, deps);

    expect(state(db)).toMatchObject({
      state: "failed",
      finalState: "failed",
      error: expect.stringMatching(/Fleet run failed/),
    });
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID, "failed");
    expect(
      db
        .prepare(
          `SELECT terminal_at, reservation_released_at
           FROM fleet_cost_accounts
           WHERE owner_type = 'supervisor' AND owner_id = ?`
        )
        .get(REQUEST_ID)
    ).toMatchObject({
      terminal_at: expect.any(String),
      reservation_released_at: expect.any(String),
    });
  });

  it("never reactivates a starting supervisor after its Fleet run fails", async () => {
    await start();
    patchState(db, {
      state: "starting",
      launchSettled: false,
      backendCreated: true,
    });
    capture = `${MANAGED_SUPERVISOR_READY}\n${MANAGED_SUPERVISOR_STARTED}\n`;
    db.prepare(`UPDATE fleet_runs SET status = 'failed' WHERE id = ?`).run(
      RUN_ID
    );

    await reconcileManagedFleetSupervisors(40, deps);

    expect(state(db)).toMatchObject({
      state: "failed",
      finalState: "failed",
      error: expect.stringMatching(/Fleet run failed/),
    });
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID, "failed");
  });

  it("keeps an incomplete frame pending while the exact broker is live", async () => {
    await start();
    capture = "STOA_FLEET_SUPERVISOR_V1_BEGIN\nOK\n0\n100";
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db).state).toBe("running");
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("fails closed on stale, malformed, or authority-shaped captured output", async () => {
    const current = await start();
    capture = _managedSupervisorResultFrameForTests(
      JSON.stringify(
        resultObject(current, {
          capability: "fleet.merge.execute",
        })
      )
    );
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db)).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/unsupported fields/),
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM fleet_artifacts`).get()
    ).toEqual({ count: 0 });
  });

  it("fails a dead broker, times out a silent broker, and settles admission", async () => {
    await start();
    live = false;
    capture = "";
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db).state).toBe("failed");
    expect(
      db
        .prepare(
          `SELECT terminal_at, reservation_released_at FROM fleet_cost_accounts
           WHERE owner_type = 'supervisor' AND owner_id = ?`
        )
        .get(REQUEST_ID)
    ).toMatchObject({
      terminal_at: expect.any(String),
      reservation_released_at: expect.any(String),
    });

    // A new request may start only after the prior one is terminal.
    now = new Date("2026-08-02T11:00:00.000Z");
    deps.randomId = () => "second-request";
    deps.randomSessionId = () => "second-session";
    await startManagedFleetSupervisor(RUN_ID, {}, deps);
    capture = "";
    now = new Date("2026-08-02T11:11:00.000Z");
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db)).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/timed out/),
    });
  });

  it("cancels and pause-interrupts through the same exact tree cleanup path", async () => {
    await start();
    const canceled = await cancelManagedFleetSupervisor(RUN_ID, deps);
    expect(canceled).toEqual({
      status: expect.objectContaining({ state: "canceled" }),
    });
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID, "failed");

    now = new Date("2026-08-02T10:10:00.000Z");
    deps.randomId = () => "pause-request";
    deps.randomSessionId = () => "pause-session";
    await startManagedFleetSupervisor(RUN_ID, {}, deps);
    db.prepare(
      `UPDATE fleet_runs SET desired_state = 'paused', pause_mode = 'pause-and-interrupt'
       WHERE id = ?`
    ).run(RUN_ID);
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db).state).toBe("canceled");
    expect(stopSession).toHaveBeenCalledWith("pause-session", "failed");
  });

  it("keeps cancellation dominant when cleanup races a completed result", async () => {
    const current = await start();
    capture = _managedSupervisorResultFrameForTests(
      JSON.stringify(resultObject(current))
    );
    let releaseFirstStop!: (value: boolean) => void;
    const firstStop = new Promise<boolean>((resolveStop) => {
      releaseFirstStop = resolveStop;
    });
    stopSession = vi
      .fn()
      .mockImplementationOnce(async () => firstStop)
      .mockImplementation(async () => {
        live = false;
        return true;
      });
    deps.stopSession = stopSession;

    const completing = reconcileManagedFleetSupervisors(40, deps);
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledTimes(1));
    const canceled = await cancelManagedFleetSupervisor(RUN_ID, deps);
    releaseFirstStop(true);
    await completing;

    expect(canceled).toEqual({
      status: expect.objectContaining({ state: "canceled" }),
    });
    expect(state(db)).toMatchObject({
      state: "canceled",
      finalState: "canceled",
      artifactId: expect.stringMatching(/^managed-supervisor-/),
    });
  });

  it("keeps sweeping a terminal preallocation and reaps a broker that appears late", async () => {
    await start();
    patchState(db, {
      state: "cleanup_pending",
      finalState: "canceled",
      launchSettled: false,
      backendCreated: false,
      startedAt: "2026-08-02T09:00:00.000Z",
      deadlineAt: "2026-08-02T10:10:00.000Z",
    });
    live = false;
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db)).toMatchObject({
      state: "canceled",
      orphanSweepComplete: false,
    });

    deps.randomId = () => "blocked-request";
    deps.randomSessionId = () => "blocked-session";
    await expect(
      startManagedFleetSupervisor(RUN_ID, {}, deps)
    ).resolves.toEqual({
      error: "the prior managed supervisor is still in its orphan-safety sweep",
      statusCode: 409,
    });

    live = true;
    await reconcileManagedFleetSupervisors(40, deps);
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID, "failed");
    expect(state(db)).toMatchObject({
      state: "canceled",
      orphanSweepComplete: true,
    });

    deps.randomId = () => "replacement-request";
    deps.randomSessionId = () => "replacement-session";
    await expect(
      startManagedFleetSupervisor(RUN_ID, {}, deps)
    ).resolves.toEqual({
      status: expect.objectContaining({
        requestId: "replacement-request",
        sessionId: "replacement-session",
        state: "running",
      }),
    });
  });

  it("does not stop a session whose cost identity is owned by another account", async () => {
    await start();
    db.prepare(
      `UPDATE fleet_cost_accounts SET owner_id = 'foreign-owner'
       WHERE owner_type = 'supervisor' AND owner_id = ?`
    ).run(REQUEST_ID);
    capture = _managedSupervisorResultFrameForTests(
      JSON.stringify(resultObject(state(db)))
    );
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db)).toMatchObject({
      state: "cleanup_pending",
      ambiguousOwnership: true,
      error: expect.stringMatching(/foreign owner/),
    });
    expect(stopSession).not.toHaveBeenCalled();
    expect(
      db
        .prepare(`SELECT recovery_required FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID)
    ).toEqual({ recovery_required: 1 });
    expect(
      db
        .prepare(
          `SELECT terminal_at, reservation_released_at
           FROM fleet_cost_accounts
           WHERE session_id = ?`
        )
        .get(SESSION_ID)
    ).toEqual({ terminal_at: null, reservation_released_at: null });
  });

  it("enforces immutable profile columns and rejects generic recreation", async () => {
    await start();
    expect(() =>
      db
        .prepare(`UPDATE sessions SET launch_profile_hash = ? WHERE id = ?`)
        .run("f".repeat(64), SESSION_ID)
    ).toThrow(/launch profile is immutable/);
    const session = db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(SESSION_ID) as Session;
    expect(() => resolveSessionLaunchOptions(session)).toThrow(
      /cannot be recreated, resumed, or forked generically/
    );
  });

  it("blocks internal launch-field mutation and still detects tampering if the database guard is removed", async () => {
    const current = await start();
    expect(() =>
      db
        .prepare(
          `UPDATE sessions SET tmux_name = 'foreign-session' WHERE id = ?`
        )
        .run(SESSION_ID)
    ).toThrow(/launch profile is immutable/);

    db.exec(`DROP TRIGGER trg_sessions_launch_profile_immutable`);
    db.prepare(
      `UPDATE sessions SET tmux_name = 'foreign-session' WHERE id = ?`
    ).run(SESSION_ID);
    capture = _managedSupervisorResultFrameForTests(
      JSON.stringify(resultObject(current))
    );
    await reconcileManagedFleetSupervisors(40, deps);
    expect(state(db)).toMatchObject({
      state: "cleanup_pending",
      ambiguousOwnership: true,
      error: expect.stringMatching(/immutable session profile/),
    });
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("reports idle and active status without exposing a capability surface", async () => {
    expect(getManagedFleetSupervisorStatus(RUN_ID, deps)).toEqual({
      status: expect.objectContaining({ state: "idle", advisoryOnly: true }),
    });
    await start();
    expect(getManagedFleetSupervisorStatus(RUN_ID, deps)).toEqual({
      status: expect.objectContaining({
        state: "running",
        provider: "claude",
        sessionId: SESSION_ID,
        advisoryOnly: true,
      }),
    });
  });
});
