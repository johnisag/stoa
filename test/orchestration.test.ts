/**
 * Orchestration regression tests — first coverage of lib/orchestration.ts.
 *
 * Uses a real in-memory SQLite (real schema + queries) with the side-effecting
 * collaborators mocked (session backend, worktrees, env-setup, status-detector,
 * async-operations). Locks the contracts most likely to silently regress:
 *   - spawnWorker rejects an unknown conductor BEFORE touching the backend
 *     (the FOREIGN KEY guard added to avoid a raw SqliteError).
 *   - a valid conductor produces a worker row linked to it, surfaced by
 *     getWorkers / getWorkersSummary.
 *   - killWorker flips status without throwing when the backend kill is a no-op.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_A = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({
  db: null as unknown,
  sandboxPath: null as string | null,
  worktreeShouldFail: false,
  worktreeActive: 0,
  worktreeMaxActive: 0,
  worktreeGate: null as Promise<void> | null,
}));

// Backend: record create/kill calls; capture() returns a ready banner so the
// spawn poll loop exits fast.
const backendCreate = vi.hoisted(() => vi.fn(async () => {}));
const backendKill = vi.hoisted(() => vi.fn(async () => {}));
const backendCapture = vi.hoisted(() => vi.fn(async () => "? for shortcuts"));
const backendSendLiteral = vi.hoisted(() => vi.fn(async () => {}));
const backendSendInterpreted = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/session-backend", () => ({
  useContainer: () => false,
  getSessionBackend: () => ({
    create: backendCreate,
    kill: backendKill,
    // Capture returns Claude's ready banner so the spawn poll loop matches on
    // its first 2s tick instead of waiting out the full 30s timeout.
    capture: backendCapture,
    sendKeysLiteral: backendSendLiteral,
    sendEnter: vi.fn(async () => {}),
    sendKeysInterpreted: backendSendInterpreted,
  }),
}));
vi.mock("@/lib/sandbox/detect", () => ({
  detectSandboxTool: () =>
    state.sandboxPath ? { tool: "bwrap", path: state.sandboxPath } : null,
}));
vi.mock("@/lib/worktrees", () => ({
  createWorktree: vi.fn(async () => {
    if (state.worktreeShouldFail) throw new Error("git worktree failed");
    state.worktreeActive += 1;
    state.worktreeMaxActive = Math.max(
      state.worktreeMaxActive,
      state.worktreeActive
    );
    if (state.worktreeGate) await state.worktreeGate;
    else await new Promise((resolve) => setTimeout(resolve, 10));
    state.worktreeActive -= 1;
    return {
      worktreePath: "/tmp/wt",
      branchName: "mock-branch",
      baseBranch: "main",
    };
  }),
  deleteWorktree: vi.fn(async () => {}),
}));
vi.mock("@/lib/env-setup", () => ({
  setupWorktree: vi.fn(async () => ({
    envFilesCopied: 0,
    steps: [],
    success: true,
  })),
}));
vi.mock("@/lib/async-operations", () => ({
  runInBackground: vi.fn(),
  runManyInBackground: vi.fn(),
}));
vi.mock("@/lib/status-detector", () => ({
  statusDetector: { getStatus: vi.fn(async () => "running") },
}));
// Build the in-memory DB inside the (async) mock factory using dynamic imports
// (which resolve the @/ alias, unlike require). vitest resolves this mock
// before orchestration.ts is imported, so its bound `db` is this in-memory one.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { default: DB } = await import("better-sqlite3");
  const { createSchema } = await import("@/lib/db/schema");
  const { runMigrations } = await import("@/lib/db/migrations");
  const d = new DB(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
  return { ...actual, db: d };
});

import { randomUUID } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

import {
  spawnWorker,
  getWorkers,
  getWorkersSummary,
  getWorkerOutput,
  sendToWorker,
  completeWorker,
  failWorker,
  killWorker,
  validateFleetSandboxWritableRoots,
} from "@/lib/orchestration";
import {
  DELETE as deleteWorker,
  GET as getWorker,
  POST as updateWorker,
} from "@/app/api/orchestrate/workers/[id]/route";
import { GET as listWorkers } from "@/app/api/orchestrate/workers/route";
import { stoaHomeDir } from "@/lib/platform";
import { internalSessionProfile } from "./internal-session-fixture";
import {
  commitConductorSessionDeletion,
  planConductorSessionDeletion,
} from "@/lib/session-deletion";

function db() {
  return state.db as InstanceType<typeof Database>;
}

/** Insert a normal (conductor) session row directly. */
function addSession(over: Partial<Record<string, unknown>> = {}): string {
  const id = (over.id as string) || randomUUID();
  const role = (over.session_role as string) || "interactive";
  const profile = role === "interactive" ? null : internalSessionProfile(role);
  db()
    .prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, agent_type, model, status, working_directory,
        session_role, launch_profile_json, launch_profile_hash,
        conductor_session_id, worker_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(
      id,
      (over.name as string) || "conductor",
      (over.tmux_name as string) || `claude-${id}`,
      (over.agent_type as string) || "claude",
      (over.model as string) || "sonnet",
      (over.status as string) || "running",
      (over.working_directory as string) || "/repo",
      role,
      profile?.profileJson ?? null,
      profile?.profileHash ?? null,
      (over.conductor_session_id as string) || null,
      (over.worker_status as string) || null
    );
  return id;
}

beforeEach(() => {
  backendCreate.mockClear();
  backendKill.mockClear();
  backendCapture.mockReset();
  backendCapture.mockResolvedValue("? for shortcuts");
  backendSendLiteral.mockReset();
  backendSendLiteral.mockResolvedValue(undefined);
  backendSendInterpreted.mockReset();
  backendSendInterpreted.mockResolvedValue(undefined);
  state.sandboxPath = null;
  state.worktreeShouldFail = false;
  state.worktreeActive = 0;
  state.worktreeMaxActive = 0;
  state.worktreeGate = null;
  delete process.env.STOA_SANDBOX;
  delete process.env.STOA_AUTH;
  delete process.env.STOA_REQUIRE_AUTH;
  delete process.env.STOA_TOKEN;
  delete process.env.STOA_SESSION_ID;
  delete process.env.STOA_MCP_TOKEN;
  delete process.env.CONDUCTOR_SESSION_ID;
  delete process.env.MCP_SESSION_ID;
  delete process.env.DB_PATH;
  delete process.env.CUSTOM_MCP_SECRET;
  delete process.env.ANTHROPIC_API_KEY;
  db().prepare("DELETE FROM sessions").run();
});

describe("spawnWorker — conductor FK guard", () => {
  it("fails closed for fleet worktrees while preserving generic fallback", async () => {
    const conductor = addSession();
    state.worktreeShouldFail = true;
    await expect(
      spawnWorker({
        conductorSessionId: conductor,
        task: "fleet write",
        workingDirectory: "/repo",
        useWorktree: true,
        requireWorktree: true,
      })
    ).rejects.toThrow(/requires an isolated worktree/);
    expect(backendCreate).not.toHaveBeenCalled();

    await expect(
      spawnWorker({
        conductorSessionId: conductor,
        task: "legacy write",
        workingDirectory: "/repo",
        useWorktree: true,
      })
    ).resolves.toBeTruthy();
    expect(backendCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects strict fleet launch when task delivery fails", async () => {
    const conductor = addSession();
    backendSendLiteral.mockRejectedValueOnce(new Error("paste failed"));
    await expect(
      spawnWorker({
        conductorSessionId: conductor,
        task: "deliver this",
        workingDirectory: "/repo",
        useWorktree: true,
        requireWorktree: true,
        requireTaskDelivery: true,
      })
    ).rejects.toMatchObject({
      name: "WorkerSpawnError",
      worktreePath: "/tmp/wt",
    });
  });

  it("preserves worktree identity when session persistence fails", async () => {
    const conductor = addSession();
    let releaseWorktree!: () => void;
    state.worktreeGate = new Promise<void>((resolve) => {
      releaseWorktree = resolve;
    });
    const spawning = spawnWorker({
      conductorSessionId: conductor,
      task: "fleet write",
      workingDirectory: "/repo",
      useWorktree: true,
      requireWorktree: true,
      requireTaskDelivery: true,
    });
    await vi.waitFor(() => expect(state.worktreeActive).toBe(1));
    db().prepare(`DELETE FROM sessions WHERE id = ?`).run(conductor);
    releaseWorktree();

    await expect(spawning).rejects.toMatchObject({
      name: "WorkerSpawnError",
      sessionId: null,
      worktreePath: "/tmp/wt",
    });
    expect(backendCreate).not.toHaveBeenCalled();
  });

  it("serializes concurrent git worktree creation", async () => {
    const conductor = addSession();
    await Promise.all([
      spawnWorker({
        conductorSessionId: conductor,
        task: "first",
        workingDirectory: "/repo",
        branchName: "fleet-first",
      }),
      spawnWorker({
        conductorSessionId: conductor,
        task: "second",
        workingDirectory: "/repo",
        branchName: "fleet-second",
      }),
    ]);
    expect(state.worktreeMaxActive).toBe(1);
  });

  it("throws on an unknown conductor and never touches the backend", async () => {
    await expect(
      spawnWorker({
        conductorSessionId: "does-not-exist",
        task: "build a thing",
        workingDirectory: "/repo",
        useWorktree: false,
      })
    ).rejects.toThrow(/Unknown conductor session/);
    expect(backendCreate).not.toHaveBeenCalled();
  });

  it("rejects an internal or future-role conductor before launch", async () => {
    for (const session_role of ["fleet_supervisor", "future_internal_role"]) {
      const conductorSessionId = addSession({ session_role });
      await expect(
        spawnWorker({
          conductorSessionId,
          task: "must not launch",
          workingDirectory: "/repo",
          useWorktree: false,
        })
      ).rejects.toThrow(/Unknown conductor session/);
    }
    expect(backendCreate).not.toHaveBeenCalled();
  });

  it("creates a worker row linked to a valid conductor", async () => {
    const conductor = addSession();
    const worker = await spawnWorker({
      conductorSessionId: conductor,
      task: "implement the feature",
      workingDirectory: "/repo",
      useWorktree: false,
    });
    expect(worker.id).toBeTruthy();
    expect(backendCreate).toHaveBeenCalledTimes(1);

    const workers = await getWorkers(conductor);
    expect(workers).toHaveLength(1);
    expect(workers[0].task).toBe("implement the feature");
  });

  it("persists Fleet agents with an immutable owner-specific launch profile", async () => {
    const conductor = addSession();
    const worker = await spawnWorker({
      conductorSessionId: conductor,
      task: "review the approved plan",
      workingDirectory: "/repo",
      useWorktree: false,
      approvalMode: "full-bypass",
      fleetOwner: {
        runId: RUN_A,
        ownerType: "plan_review",
        ownerId: REQUEST_A,
      },
    });
    const profile = JSON.parse(worker.launch_profile_json!);
    expect(worker.session_role).toBe("fleet_plan_reviewer");
    expect(profile).toMatchObject({
      version: 1,
      role: "fleet_plan_reviewer",
      fleetRunId: RUN_A,
      ownerType: "plan_review",
      ownerId: REQUEST_A,
      sessionId: worker.id,
    });
    expect(worker.launch_profile_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      db()
        .prepare(`UPDATE sessions SET model = 'generic-mutation' WHERE id = ?`)
        .run(worker.id)
    ).toThrow(/immutable/i);
  });

  it("keeps Fleet children out of generic conductor cascades", () => {
    const conductor = addSession();
    const ordinary = addSession({ conductor_session_id: conductor });
    const fleetChild = addSession({
      conductor_session_id: conductor,
      session_role: "fleet_task_reviewer",
    });

    const plan = planConductorSessionDeletion(db(), conductor);
    expect(plan.interactiveWorkers.map((row) => row.id)).toEqual([ordinary]);
    commitConductorSessionDeletion(db(), plan);
    expect(
      db()
        .prepare(
          `SELECT id, session_role, conductor_session_id
           FROM sessions WHERE id = ?`
        )
        .get(fleetChild)
    ).toEqual({
      id: fleetChild,
      session_role: "fleet_task_reviewer",
      conductor_session_id: null,
    });
  });

  it("delivers an ephemeral task without persisting its secret payload", async () => {
    const conductor = addSession();
    const worker = await spawnWorker({
      conductorSessionId: conductor,
      task: "redacted Fleet task",
      deliveryTask: "Fleet task with one-use secret nonce-123",
      workingDirectory: "/repo",
      useWorktree: false,
    });

    expect(backendSendLiteral).toHaveBeenCalledWith(
      expect.any(String),
      "Fleet task with one-use secret nonce-123"
    );
    expect(
      db()
        .prepare(`SELECT worker_task FROM sessions WHERE id = ?`)
        .get(worker.id)
    ).toEqual({ worker_task: "redacted Fleet task" });
  });
  it("wraps the tmux command string when STOA_SANDBOX detects bwrap", async () => {
    process.env.STOA_SANDBOX = "1";
    state.sandboxPath = "/usr/bin/bwrap";
    const conductor = addSession();
    const hostileWorkingDir = String.raw`/tmp/repo with space; touch /tmp/pwn $(whoami)`;

    await spawnWorker({
      conductorSessionId: conductor,
      task: "sandboxed task",
      workingDirectory: hostileWorkingDir,
      useWorktree: false,
      agentType: "claude",
      model: "sonnet",
    });

    const createArg = (backendCreate.mock.calls as unknown[][])[0]?.[0] as
      { binary: string; args: string[]; command: string } | undefined;
    expect(createArg!.binary).toBe("/usr/bin/bwrap");
    expect(createArg!.args).toContain("claude");
    expect(createArg!.args).toContain("--dangerously-skip-permissions");
    expect(createArg!.command).toMatch(/^bash /);
    const scriptPath = createArg!.command.slice("bash ".length);
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("exec /usr/bin/bwrap");
    expect(script).toContain("--ro-bind / /");
    expect(script).toContain(
      `--bind '${hostileWorkingDir}' '${hostileWorkingDir}'`
    );
    expect(script).toContain("-- claude");
    expect(script).toContain("--dangerously-skip-permissions");
  });

  it("hides Stoa authority while exposing only an exact Fleet result directory", async () => {
    process.env.STOA_SANDBOX = "1";
    state.sandboxPath = "/usr/bin/bwrap";
    const conductor = addSession();
    const reviewerWorktree = "/tmp/read-only-reviewer";
    const resultDirectory = join(
      stoaHomeDir(),
      "fleet-task-runtime",
      RUN_A,
      TASK_A,
      "1",
      "reviews"
    );

    await spawnWorker({
      conductorSessionId: conductor,
      task: "review exact commit",
      workingDirectory: reviewerWorktree,
      useWorktree: false,
      readOnlyWorktree: true,
      fleetWritableRoots: [resultDirectory],
      agentType: "claude",
    });

    const createArg = (backendCreate.mock.calls as unknown[][])[0]?.[0] as
      { command: string; fleetWritableRoots?: string[] } | undefined;
    expect(createArg?.fleetWritableRoots).toEqual([resolve(resultDirectory)]);
    const scriptPath = createArg!.command.slice("bash ".length);
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("--ro-bind / /");
    expect(script).not.toContain(
      `--bind '${reviewerWorktree}' '${reviewerWorktree}'`
    );
    expect(script).toContain(`--tmpfs '${stoaHomeDir()}'`);
    expect(script).not.toContain(
      `--bind '${stoaHomeDir()}' '${stoaHomeDir()}'`
    );
    expect(script).toContain(
      `--bind '${resultDirectory}' '${resultDirectory}'`
    );
    expect(script).toContain("--unsetenv STOA_TOKEN");
  });

  it("rejects broad or foreign Fleet sandbox writable roots", () => {
    const authorityRoot = join(tmpdir(), "stoa-authority-test");
    expect(() =>
      validateFleetSandboxWritableRoots([authorityRoot], authorityRoot)
    ).toThrow(/exact server-owned attempt directory/);
    expect(() =>
      validateFleetSandboxWritableRoots(
        [join(authorityRoot, "fleet", "run-only")],
        authorityRoot
      )
    ).toThrow(/exact server-owned attempt directory/);
    expect(() =>
      validateFleetSandboxWritableRoots(
        [join(tmpdir(), "foreign", "run", "task", "1")],
        authorityRoot
      )
    ).toThrow(/exact server-owned attempt directory/);
    expect(
      validateFleetSandboxWritableRoots(
        [join(authorityRoot, "fleet", RUN_A, TASK_A, "1")],
        authorityRoot
      )
    ).toEqual([join(authorityRoot, "fleet", RUN_A, TASK_A, "1")]);
  });

  it("rejects a lexically valid Fleet root that escapes through an ancestor link", () => {
    const scratch = mkdtempSync(join(tmpdir(), "stoa-fleet-root-link-"));
    const authorityRoot = join(scratch, "authority");
    const fleetRoot = join(authorityRoot, "fleet");
    const outside = join(scratch, "outside");
    const linkedRun = join(fleetRoot, RUN_A);
    const candidate = join(linkedRun, "planner", REQUEST_A);
    mkdirSync(fleetRoot, { recursive: true });
    mkdirSync(join(outside, "planner", REQUEST_A), { recursive: true });
    try {
      symlinkSync(
        outside,
        linkedRun,
        process.platform === "win32" ? "junction" : "dir"
      );
      expect(() =>
        validateFleetSandboxWritableRoots([candidate], authorityRoot)
      ).toThrow(/escapes Stoa authority/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a valid-looking Fleet root linked to an unauthorized Stoa child", () => {
    const scratch = mkdtempSync(join(tmpdir(), "stoa-fleet-root-inner-link-"));
    const authorityRoot = join(scratch, "authority");
    const taskParent = join(authorityRoot, "fleet", RUN_A, TASK_A);
    const secrets = join(authorityRoot, "secrets");
    const linkedAttempt = join(taskParent, "1");
    mkdirSync(taskParent, { recursive: true });
    mkdirSync(secrets, { recursive: true });
    symlinkSync(
      secrets,
      linkedAttempt,
      process.platform === "win32" ? "junction" : "dir"
    );
    try {
      expect(() =>
        validateFleetSandboxWritableRoots([linkedAttempt], authorityRoot)
      ).toThrow(/exact server-owned attempt directory/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a Fleet sandbox root redirected to another valid run", () => {
    const scratch = mkdtempSync(join(tmpdir(), "stoa-fleet-cross-run-link-"));
    const authorityRoot = join(scratch, "authority");
    const linkedParent = join(authorityRoot, "fleet", RUN_A, TASK_A);
    const linkedAttempt = join(linkedParent, "1");
    const otherAttempt = join(authorityRoot, "fleet", RUN_B, TASK_B, "1");
    mkdirSync(linkedParent, { recursive: true });
    mkdirSync(otherAttempt, { recursive: true });
    symlinkSync(
      otherAttempt,
      linkedAttempt,
      process.platform === "win32" ? "junction" : "dir"
    );
    try {
      expect(() =>
        validateFleetSandboxWritableRoots([linkedAttempt], authorityRoot)
      ).toThrow(/same server-owned attempt directory/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("withholds prompt bypass when Fleet asks for unavailable strong isolation", async () => {
    process.env.STOA_SANDBOX = "1";
    state.sandboxPath = "/usr/bin/bwrap";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const conductor = addSession();

    await spawnWorker({
      conductorSessionId: conductor,
      task: "strongly isolated Fleet task",
      workingDirectory: "/repo",
      useWorktree: false,
      approvalMode: "sandboxed-auto",
      requireStrongIsolation: true,
      agentType: "claude",
    });

    const createArg = (backendCreate.mock.calls as unknown[][])[0]?.[0] as
      { binary: string; args: string[] } | undefined;
    expect(createArg!.binary).toBe("claude");
    expect(createArg!.args).not.toContain("--dangerously-skip-permissions");
    expect(warn).toHaveBeenCalledWith(
      "[sandbox] Fleet strong isolation is unavailable; running without prompt bypass"
    );
    warn.mockRestore();
  });

  it("warns when STOA_SANDBOX is requested but no primitive is available", async () => {
    process.env.STOA_SANDBOX = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const conductor = addSession();

    await spawnWorker({
      conductorSessionId: conductor,
      task: "unsandboxed task",
      workingDirectory: "/repo",
      useWorktree: false,
      agentType: "claude",
      model: "sonnet",
    });

    expect(warn).toHaveBeenCalledWith(
      "[sandbox] STOA_SANDBOX=1 but no Linux/bwrap primitive found; running unconfined with full-bypass"
    );
    const createArg = (backendCreate.mock.calls as unknown[][])[0]?.[0] as
      { args: string[] } | undefined;
    expect(createArg!.args).toContain("--dangerously-skip-permissions");
    warn.mockRestore();
  });
});

describe("getWorkersSummary", () => {
  it("counts a conductor's workers by status", async () => {
    const conductor = addSession();
    await spawnWorker({
      conductorSessionId: conductor,
      task: "task one",
      workingDirectory: "/repo",
      useWorktree: false,
    });
    const summary = await getWorkersSummary(conductor);
    expect(summary.total).toBe(1);
  });

  it("reports zero for a conductor with no workers", async () => {
    const conductor = addSession();
    const summary = await getWorkersSummary(conductor);
    expect(summary.total).toBe(0);
  });
});

describe("killWorker", () => {
  it("flips a worker to failed and calls the backend kill", async () => {
    const conductor = addSession();
    const worker = await spawnWorker({
      conductorSessionId: conductor,
      task: "doomed task",
      workingDirectory: "/repo",
      useWorktree: false,
    });
    await killWorker(worker.id, false);
    expect(backendKill).toHaveBeenCalled();
    const row = db()
      .prepare("SELECT worker_status FROM sessions WHERE id = ?")
      .get(worker.id) as { worker_status: string };
    expect(row.worker_status).toBe("failed");
  });

  it("is a no-op for an unknown worker id", async () => {
    await expect(killWorker("nope", false)).resolves.toBeUndefined();
  });

  it("records the given final status (completed) instead of always failed", async () => {
    const conductor = addSession();
    const worker = await spawnWorker({
      conductorSessionId: conductor,
      task: "successful task",
      workingDirectory: "/repo",
      useWorktree: false,
    });
    // The pipeline reaper kills a SUCCEEDED step's worker — its row must read
    // "completed", not the default "failed" (else success is mislabeled).
    await killWorker(worker.id, false, "completed");
    expect(backendKill).toHaveBeenCalled();
    const row = db()
      .prepare("SELECT worker_status FROM sessions WHERE id = ?")
      .get(worker.id) as { worker_status: string };
    expect(row.worker_status).toBe("completed");
  });
});

describe("orchestration worker role boundary", () => {
  it.each(["fleet_supervisor", "future_internal_role"])(
    "blocks every direct worker operation for %s rows before side effects",
    async (sessionRole) => {
      const workerId = addSession({ session_role: sessionRole });

      await expect(getWorkerOutput(workerId)).rejects.toThrow(
        /Internal sessions are managed only by their owning subsystem/
      );
      await expect(sendToWorker(workerId, "hostile input")).rejects.toThrow(
        /Internal sessions are managed only by their owning subsystem/
      );
      expect(() => completeWorker(workerId)).toThrow(
        /Internal sessions are managed only by their owning subsystem/
      );
      expect(() => failWorker(workerId)).toThrow(
        /Internal sessions are managed only by their owning subsystem/
      );
      await expect(killWorker(workerId, false)).rejects.toThrow(
        /Internal sessions are managed only by their owning subsystem/
      );

      expect(backendCapture).not.toHaveBeenCalled();
      expect(backendSendInterpreted).not.toHaveBeenCalled();
      expect(backendKill).not.toHaveBeenCalled();
      expect(
        db()
          .prepare("SELECT worker_status FROM sessions WHERE id = ?")
          .get(workerId)
      ).toEqual({ worker_status: null });
    }
  );

  it.each(["fleet_supervisor", "future_internal_role"])(
    "blocks internal conductors and internal child rows in sibling lookups for %s",
    async (sessionRole) => {
      const internalConductor = addSession({ session_role: sessionRole });
      await expect(getWorkers(internalConductor)).rejects.toThrow(
        /Internal sessions are managed only by their owning subsystem/
      );

      const interactiveConductor = addSession();
      addSession({
        conductor_session_id: interactiveConductor,
        session_role: sessionRole,
        worker_status: "running",
      });
      await expect(getWorkers(interactiveConductor)).rejects.toThrow(
        /Internal sessions are managed only by their owning subsystem/
      );
    }
  );
});

describe("orchestration worker route role boundary", () => {
  it.each(["fleet_supervisor", "future_internal_role"])(
    "returns conflict and performs no operation for %s rows",
    async (sessionRole) => {
      const workerId = addSession({ session_role: sessionRole });
      const context = { params: Promise.resolve({ id: workerId }) };
      const post = (body: Record<string, unknown>) =>
        new Request(`http://localhost/api/orchestrate/workers/${workerId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      const responses = [
        await getWorker(
          new Request(
            `http://localhost/api/orchestrate/workers/${workerId}?lines=20`
          ),
          context
        ),
        await updateWorker(
          post({ action: "send", message: "hostile input" }),
          context
        ),
        await updateWorker(post({ action: "complete" }), context),
        await updateWorker(post({ action: "fail" }), context),
        await deleteWorker(
          new Request(`http://localhost/api/orchestrate/workers/${workerId}`, {
            method: "DELETE",
          }),
          context
        ),
      ];

      expect(responses.map((response) => response.status)).toEqual([
        409, 409, 409, 409, 409,
      ]);
      expect(backendCapture).not.toHaveBeenCalled();
      expect(backendSendInterpreted).not.toHaveBeenCalled();
      expect(backendKill).not.toHaveBeenCalled();
      expect(
        db()
          .prepare("SELECT worker_status FROM sessions WHERE id = ?")
          .get(workerId)
      ).toEqual({ worker_status: null });
    }
  );

  it.each(["fleet_supervisor", "future_internal_role"])(
    "returns conflict for internal list ownership for %s",
    async (sessionRole) => {
      const conductorId = addSession({ session_role: sessionRole });
      const response = await listWorkers(
        new Request(
          `http://localhost/api/orchestrate/workers?conductorId=${conductorId}`
        )
      );
      expect(response.status).toBe(409);
    }
  );
});
