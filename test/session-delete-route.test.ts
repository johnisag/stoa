import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { internalSessionProfile } from "./internal-session-fixture";

const state = vi.hoisted(() => ({
  db: null as unknown,
  backendKill: vi.fn(async (_key: string) => {}),
  workerKill: vi.fn(async (_id: string) => {}),
  clearQueue: vi.fn((_id: string) => {}),
  deleteChannels: vi.fn((_id: string) => 0),
  deleteSchedules: vi.fn((_id: string) => 0),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ kill: state.backendKill }),
}));
vi.mock("@/lib/orchestration", () => ({ killWorker: state.workerKill }));
vi.mock("@/lib/projects", () => ({ getProject: () => null }));
vi.mock("@/lib/worktrees", () => ({
  deleteWorktree: vi.fn(),
  isStoaWorktree: () => false,
  getMainRepoPath: vi.fn(),
}));
vi.mock("@/lib/multi-repo-worktree", () => ({ removeWorkspace: vi.fn() }));
vi.mock("@/lib/ports", () => ({ releasePort: vi.fn() }));
vi.mock("@/lib/git", () => ({
  generateBranchName: vi.fn(),
  getCurrentBranch: vi.fn(),
  renameBranch: vi.fn(),
}));
vi.mock("@/lib/async-operations", () => ({ runInBackground: vi.fn() }));
vi.mock("@/lib/mcp-config", () => ({ removeConductorMarker: vi.fn() }));
vi.mock("@/lib/prompt-queue", () => ({ clearQueue: state.clearQueue }));
vi.mock("@/lib/channels", () => ({
  deleteChannelMessagesForSession: state.deleteChannels,
}));
vi.mock("@/lib/scheduler", () => ({
  deleteSchedulesForSession: state.deleteSchedules,
}));

import DatabaseConstructor from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { DELETE as deleteSession } from "@/app/api/sessions/[id]/route";

function db(): InstanceType<typeof DatabaseConstructor> {
  return state.db as InstanceType<typeof DatabaseConstructor>;
}

function addSession(input: {
  id: string;
  role?: string;
  conductorId?: string | null;
}): void {
  const role = input.role ?? "interactive";
  const profile = role === "interactive" ? null : internalSessionProfile(role);
  db()
    .prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, agent_type, session_role, launch_profile_json,
        launch_profile_hash, conductor_session_id)
       VALUES (?, ?, ?, 'claude', ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.id,
      `claude-${input.id}`,
      role,
      profile?.profileJson ?? null,
      profile?.profileHash ?? null,
      input.conductorId ?? null
    );
}

async function remove(id: string) {
  return deleteSession(
    new Request(`http://localhost/api/sessions/${id}`) as never,
    {
      params: Promise.resolve({ id }),
    }
  );
}

beforeAll(() => {
  const database = new DatabaseConstructor(":memory:");
  database.pragma("foreign_keys = ON");
  createSchema(database);
  runMigrations(database);
  state.db = database;
});

afterAll(() => db().close());

beforeEach(() => {
  db().exec(`
    DROP TABLE IF EXISTS test_session_delete_blocker;
    DELETE FROM session_deletion_claims;
    DELETE FROM sessions;
  `);
  state.backendKill.mockReset();
  state.backendKill.mockResolvedValue(undefined);
  state.workerKill.mockReset();
  state.workerKill.mockResolvedValue(undefined);
  state.clearQueue.mockClear();
  state.deleteChannels.mockClear();
  state.deleteSchedules.mockClear();
});

describe("DELETE /api/sessions/[id] conductor boundary", () => {
  it("atomically deletes ordinary sessions and preserves Fleet evidence", async () => {
    addSession({ id: "conductor" });
    addSession({ id: "ordinary", conductorId: "conductor" });
    addSession({
      id: "reviewer",
      role: "fleet_task_reviewer",
      conductorId: "conductor",
    });

    const response = await remove("conductor");

    expect(response.status).toBe(200);
    expect(state.workerKill).toHaveBeenCalledWith("ordinary", false, "failed", {
      failOnBackendError: true,
    });
    expect(state.backendKill).toHaveBeenCalledWith("claude-conductor");
    expect(
      db()
        .prepare(`SELECT id, conductor_session_id FROM sessions ORDER BY id`)
        .all()
    ).toEqual([{ id: "reviewer", conductor_session_id: null }]);
    expect(
      db()
        .prepare(
          `SELECT session_id FROM session_deletion_claim_members ORDER BY session_id`
        )
        .all()
    ).toEqual([{ session_id: "conductor" }, { session_id: "ordinary" }]);
  });

  it("rejects a child attached during the backend-stop window", async () => {
    addSession({ id: "conductor" });
    addSession({ id: "ordinary", conductorId: "conductor" });
    state.workerKill.mockImplementationOnce(async () => {
      expect(() =>
        addSession({ id: "late-child", conductorId: "conductor" })
      ).toThrow(/session deletion is in progress/i);
    });

    const response = await remove("conductor");

    expect(response.status).toBe(200);
    expect(db().prepare(`SELECT id FROM sessions ORDER BY id`).all()).toEqual(
      []
    );
  });

  it("keeps a failed backend stop claimed across a retry", async () => {
    addSession({ id: "conductor" });
    addSession({ id: "ordinary", conductorId: "conductor" });
    state.backendKill.mockRejectedValueOnce(new Error("daemon unavailable"));

    const failed = await remove("conductor");

    expect(failed.status).toBe(503);
    expect(
      db()
        .prepare(
          `SELECT conductor_session_id, state FROM session_deletion_claims`
        )
        .get()
    ).toEqual({ conductor_session_id: "conductor", state: "claimed" });
    expect(() =>
      addSession({ id: "late-child", conductorId: "conductor" })
    ).toThrow(/session deletion is in progress/i);

    const retried = await remove("conductor");

    expect(retried.status).toBe(200);
    expect(db().prepare(`SELECT id FROM sessions`).all()).toEqual([]);
    expect(
      db()
        .prepare(
          `SELECT conductor_session_id, state FROM session_deletion_claims`
        )
        .get()
    ).toEqual({ conductor_session_id: "conductor", state: "deleted" });
  });

  it("rejects an unknown internal child before any backend process is killed", async () => {
    addSession({ id: "conductor" });
    addSession({
      id: "future-child",
      role: "future_internal_role",
      conductorId: "conductor",
    });

    const response = await remove("conductor");

    expect(response.status).toBe(409);
    expect(state.workerKill).not.toHaveBeenCalled();
    expect(state.backendKill).not.toHaveBeenCalled();
    expect(
      db()
        .prepare(`SELECT conductor_session_id FROM sessions WHERE id = ?`)
        .get("future-child")
    ).toEqual({ conductor_session_id: "conductor" });
  });

  it("rejects a restrictive foreign-key blocker before any backend stop", async () => {
    addSession({ id: "conductor" });
    db().exec(`
      CREATE TABLE test_session_delete_blocker (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id)
      );
      INSERT INTO test_session_delete_blocker (id, session_id)
      VALUES ('blocker', 'conductor');
    `);

    const response = await remove("conductor");

    expect(response.status).toBe(409);
    expect(state.workerKill).not.toHaveBeenCalled();
    expect(state.backendKill).not.toHaveBeenCalled();
    expect(db().prepare(`SELECT id FROM sessions`).all()).toEqual([
      { id: "conductor" },
    ]);
  });
});
