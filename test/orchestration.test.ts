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

const state = vi.hoisted(() => ({
  db: null as unknown,
  sandboxPath: null as string | null,
}));

// Backend: record create/kill calls; capture() returns a ready banner so the
// spawn poll loop exits fast.
const backendCreate = vi.hoisted(() => vi.fn(async () => {}));
const backendKill = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    create: backendCreate,
    kill: backendKill,
    // Capture returns Claude's ready banner so the spawn poll loop matches on
    // its first 2s tick instead of waiting out the full 30s timeout.
    capture: vi.fn(async () => "? for shortcuts"),
    sendKeysLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sendKeysInterpreted: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/sandbox/detect", () => ({
  detectSandboxTool: () =>
    state.sandboxPath ? { tool: "bwrap", path: state.sandboxPath } : null,
}));
vi.mock("@/lib/worktrees", () => ({
  createWorktree: vi.fn(async () => ({ worktreePath: "/tmp/wt" })),
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
import { readFileSync } from "fs";

import {
  spawnWorker,
  getWorkers,
  getWorkersSummary,
  killWorker,
} from "@/lib/orchestration";

function db() {
  return state.db as InstanceType<typeof Database>;
}

/** Insert a normal (conductor) session row directly. */
function addSession(over: Partial<Record<string, unknown>> = {}): string {
  const id = (over.id as string) || randomUUID();
  db()
    .prepare(
      `INSERT INTO sessions (id, name, tmux_name, agent_type, model, status, working_directory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(
      id,
      (over.name as string) || "conductor",
      (over.tmux_name as string) || `claude-${id}`,
      (over.agent_type as string) || "claude",
      (over.model as string) || "sonnet",
      (over.status as string) || "running",
      (over.working_directory as string) || "/repo"
    );
  return id;
}

beforeEach(() => {
  backendCreate.mockClear();
  backendKill.mockClear();
  state.sandboxPath = null;
  delete process.env.STOA_SANDBOX;
  db().prepare("DELETE FROM sessions").run();
});

describe("spawnWorker — conductor FK guard", () => {
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
