import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  liveKeys: new Set<string>(),
  sql: [] as Array<{ query: string; args: unknown[] }>,
  rename: vi.fn<(oldKey: string, newKey: string) => Promise<void>>(),
  exists: vi.fn<(key: string) => Promise<boolean>>(),
  kill: vi.fn<(key: string) => Promise<void>>(),
  deletionFenced: vi.fn<(sessionId: string) => boolean>(),
  backendKeyFenced: vi.fn<(backendKey: string) => boolean>(),
  failNextRun: false,
}));

const fakeDb = {
  prepare(query: string) {
    return {
      run(...args: unknown[]) {
        if (state.failNextRun) {
          state.failNextRun = false;
          throw new Error("session deletion is in progress");
        }
        state.sql.push({ query, args });
        return { changes: 1 };
      },
    };
  },
  transaction<T>(callback: () => T) {
    return () => callback();
  },
};

vi.mock("@/lib/db", () => ({
  getDb: () => fakeDb,
  queries: {
    getAllSessions: () => ({ all: () => state.sessions }),
    getSession: () => ({
      get: (id: string) => state.sessions.find((session) => session.id === id),
    }),
  },
}));

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    rename: state.rename,
    exists: state.exists,
    kill: state.kill,
  }),
}));

vi.mock("@/lib/session-deletion", () => ({
  isSessionDeletionBoundaryFenced: (
    _db: unknown,
    sessionId: string,
    backendKeys: readonly string[]
  ) =>
    state.deletionFenced(sessionId) ||
    backendKeys.some((backendKey) => state.backendKeyFenced(backendKey)),
}));

vi.mock("@/lib/projects", () => ({ getProject: () => null }));
vi.mock("@/lib/worktrees", () => ({
  deleteWorktree: vi.fn(),
  isStoaWorktree: () => false,
  getMainRepoPath: vi.fn(),
}));
vi.mock("@/lib/multi-repo-worktree", () => ({ removeWorkspace: vi.fn() }));
vi.mock("@/lib/ports", () => ({ releasePort: vi.fn() }));
vi.mock("@/lib/orchestration", () => ({ killWorker: vi.fn() }));
vi.mock("@/lib/git", () => ({
  generateBranchName: vi.fn(() => "renamed"),
  getCurrentBranch: vi.fn(),
  renameBranch: vi.fn(),
}));
vi.mock("@/lib/async-operations", () => ({ runInBackground: vi.fn() }));
vi.mock("@/lib/mcp-config", () => ({ removeConductorMarker: vi.fn() }));
vi.mock("@/lib/prompt-queue", () => ({ clearQueue: vi.fn() }));
vi.mock("@/lib/channels", () => ({
  deleteChannelMessagesForSession: vi.fn(),
}));
vi.mock("@/lib/scheduler", () => ({ deleteSchedulesForSession: vi.fn() }));

import { PATCH as patchSession } from "@/app/api/sessions/[id]/route";
import { POST as renameSession } from "@/app/api/tmux/rename/route";
import {
  backendKeyOwners,
  genericBackendKeyAccessFailure,
} from "@/lib/session-route-access";

const VISIBLE_ID = "11111111-1111-4111-8111-111111111111";
const INTERNAL_ID = "22222222-2222-4222-8222-222222222222";
const VISIBLE_KEY = `claude-${VISIBLE_ID}`;
const INTERNAL_KEY = `claude-${INTERNAL_ID}`;
const RENAMED_KEY = "codex-33333333-3333-4333-8333-333333333333";

function session(
  id: string,
  key: string | null,
  role: string,
  agentType = "claude"
) {
  return {
    id,
    name: id,
    tmux_name: key,
    working_directory: "~",
    worktree_path: null,
    worktree_paths: null,
    agent_type: agentType,
    session_role: role,
    project_id: null,
  };
}

function request(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3011",
    },
    body: JSON.stringify(body),
  });
}

describe("backend-key ownership boundary", () => {
  beforeEach(() => {
    state.sessions = [
      session(VISIBLE_ID, VISIBLE_KEY, "interactive"),
      session(INTERNAL_ID, INTERNAL_KEY, "fleet_supervisor"),
    ];
    state.liveKeys = new Set([VISIBLE_KEY, INTERNAL_KEY]);
    state.sql = [];
    state.failNextRun = false;
    state.exists
      .mockReset()
      .mockImplementation(async (key) => state.liveKeys.has(key));
    state.rename.mockReset().mockImplementation(async (oldKey, newKey) => {
      if (!state.liveKeys.has(oldKey) || state.liveKeys.has(newKey)) {
        throw new Error("rename rejected");
      }
      state.liveKeys.delete(oldKey);
      state.liveKeys.add(newKey);
    });
    state.kill.mockReset().mockImplementation(async (key) => {
      state.liveKeys.delete(key);
    });
    state.deletionFenced.mockReset().mockReturnValue(false);
    state.backendKeyFenced.mockReset().mockReturnValue(false);
  });

  it("uses the canonical fallback for unknown-provider internal rows", () => {
    const unknown = session("unknown", null, "future_internal", "invalid");
    expect(backendKeyOwners([unknown] as never, "claude-unknown")).toEqual([
      unknown,
    ]);
    expect(
      genericBackendKeyAccessFailure([unknown] as never, "claude-unknown")
    ).toMatch(/internal sessions/i);
  });

  it("rejects direct rename of an internal source or onto its reserved key", async () => {
    const internal = await renameSession(
      request("http://localhost/api/tmux/rename", {
        oldName: INTERNAL_KEY,
        newName: RENAMED_KEY,
      }) as never
    );
    const collision = await renameSession(
      request("http://localhost/api/tmux/rename", {
        oldName: VISIBLE_KEY,
        newName: INTERNAL_KEY,
      }) as never
    );

    expect(internal.status).toBe(409);
    expect(collision.status).toBe(409);
    expect(state.rename).not.toHaveBeenCalled();
    expect(state.sql).toHaveLength(0);
  });

  it("persists a direct rename only after the live backend succeeds", async () => {
    const response = await renameSession(
      request("http://localhost/api/tmux/rename", {
        oldName: VISIBLE_KEY,
        newName: RENAMED_KEY,
      }) as never
    );

    expect(response.status).toBe(200);
    expect(state.rename).toHaveBeenCalledWith(VISIBLE_KEY, RENAMED_KEY);
    expect(state.sql).toHaveLength(1);
    expect(state.sql[0].args).toEqual([RENAMED_KEY, VISIBLE_ID]);
  });

  it("rejects direct reuse of a completed backend-key tombstone", async () => {
    state.backendKeyFenced.mockImplementation(
      (backendKey) => backendKey === RENAMED_KEY
    );

    const response = await renameSession(
      request("http://localhost/api/tmux/rename", {
        oldName: VISIBLE_KEY,
        newName: RENAMED_KEY,
      }) as never
    );

    expect(response.status).toBe(409);
    expect(state.exists).not.toHaveBeenCalled();
    expect(state.rename).not.toHaveBeenCalled();
    expect(state.sql).toHaveLength(0);
  });

  it("kills both direct-rename identities when deletion fences the source during rename", async () => {
    state.rename.mockImplementationOnce(async (oldKey, newKey) => {
      state.liveKeys.delete(oldKey);
      state.liveKeys.add(newKey);
      state.backendKeyFenced.mockImplementation(
        (backendKey) => backendKey === oldKey
      );
    });

    const response = await renameSession(
      request("http://localhost/api/tmux/rename", {
        oldName: VISIBLE_KEY,
        newName: RENAMED_KEY,
      }) as never
    );

    expect(response.status).toBe(409);
    expect(state.kill).toHaveBeenCalledWith(RENAMED_KEY);
    expect(state.kill).toHaveBeenCalledWith(VISIBLE_KEY);
    expect(state.liveKeys.has(VISIBLE_KEY)).toBe(false);
    expect(state.liveKeys.has(RENAMED_KEY)).toBe(false);
    expect(state.sql).toHaveLength(0);
  });

  it("checks fences after a direct-rename rollback before preserving the source", async () => {
    state.failNextRun = true;
    let renameCount = 0;
    state.rename.mockImplementation(async (oldKey, newKey) => {
      renameCount += 1;
      state.liveKeys.delete(oldKey);
      state.liveKeys.add(newKey);
      if (renameCount === 2) {
        state.backendKeyFenced.mockImplementation(
          (backendKey) => backendKey === VISIBLE_KEY
        );
      }
    });

    const response = await renameSession(
      request("http://localhost/api/tmux/rename", {
        oldName: VISIBLE_KEY,
        newName: RENAMED_KEY,
      }) as never
    );

    expect(response.status).toBe(409);
    expect(state.rename).toHaveBeenNthCalledWith(2, RENAMED_KEY, VISIBLE_KEY);
    expect(state.kill).toHaveBeenCalledWith(RENAMED_KEY);
    expect(state.kill).toHaveBeenCalledWith(VISIBLE_KEY);
    expect(state.liveKeys.has(RENAMED_KEY)).toBe(false);
    expect(state.liveKeys.has(VISIBLE_KEY)).toBe(false);
  });

  it("session PATCH rejects an internal-key collision before backend effects", async () => {
    const response = await patchSession(
      request(`http://localhost/api/sessions/${VISIBLE_ID}`, {
        name: INTERNAL_KEY,
      }) as never,
      { params: Promise.resolve({ id: VISIBLE_ID }) }
    );

    expect(response.status).toBe(409);
    expect(state.rename).not.toHaveBeenCalled();
    expect(state.sql).toHaveLength(0);
  });

  it("session PATCH rejects reuse of a completed backend-key tombstone", async () => {
    state.backendKeyFenced.mockImplementation(
      (backendKey) => backendKey === "visible-renamed"
    );

    const response = await patchSession(
      request(`http://localhost/api/sessions/${VISIBLE_ID}`, {
        name: "Visible renamed",
      }) as never,
      { params: Promise.resolve({ id: VISIBLE_ID }) }
    );

    expect(response.status).toBe(409);
    expect(state.exists).not.toHaveBeenCalled();
    expect(state.rename).not.toHaveBeenCalled();
    expect(state.sql).toHaveLength(0);
  });

  it("session PATCH never stores a requested key after backend rename failure", async () => {
    state.rename.mockRejectedValueOnce(new Error("backend failure"));
    const response = await patchSession(
      request(`http://localhost/api/sessions/${VISIBLE_ID}`, {
        name: "Visible renamed",
      }) as never,
      { params: Promise.resolve({ id: VISIBLE_ID }) }
    );

    expect(response.status).toBe(200);
    expect(state.rename).toHaveBeenCalledWith(VISIBLE_KEY, "visible-renamed");
    expect(state.sql).toHaveLength(1);
    expect(state.sql[0].query).not.toContain("tmux_name = ?");
    expect(state.sql[0].args).toEqual(["Visible renamed", VISIBLE_ID]);
  });

  it("kills both rename identities when deletion wins before PATCH persistence", async () => {
    state.rename.mockImplementationOnce(async (oldKey, newKey) => {
      state.liveKeys.delete(oldKey);
      state.liveKeys.add(newKey);
      state.deletionFenced.mockReturnValue(true);
    });

    const response = await patchSession(
      request(`http://localhost/api/sessions/${VISIBLE_ID}`, {
        name: "Visible renamed",
      }) as never,
      { params: Promise.resolve({ id: VISIBLE_ID }) }
    );

    expect(response.status).toBe(409);
    expect(state.rename).toHaveBeenCalledTimes(1);
    expect(state.rename).toHaveBeenCalledWith(VISIBLE_KEY, "visible-renamed");
    expect(state.kill).toHaveBeenCalledWith("visible-renamed");
    expect(state.kill).toHaveBeenCalledWith(VISIBLE_KEY);
    expect(state.liveKeys.has(VISIBLE_KEY)).toBe(false);
    expect(state.liveKeys.has("visible-renamed")).toBe(false);
  });

  it("checks fences after PATCH rollback and kills both candidate keys", async () => {
    state.failNextRun = true;
    let renameCount = 0;
    state.rename.mockImplementation(async (oldKey, newKey) => {
      renameCount += 1;
      state.liveKeys.delete(oldKey);
      state.liveKeys.add(newKey);
      if (renameCount === 2) {
        state.backendKeyFenced.mockImplementation(
          (backendKey) => backendKey === VISIBLE_KEY
        );
      }
    });

    const response = await patchSession(
      request(`http://localhost/api/sessions/${VISIBLE_ID}`, {
        name: "Visible renamed",
      }) as never,
      { params: Promise.resolve({ id: VISIBLE_ID }) }
    );

    expect(response.status).toBe(409);
    expect(state.rename).toHaveBeenNthCalledWith(
      2,
      "visible-renamed",
      VISIBLE_KEY
    );
    expect(state.kill).toHaveBeenCalledWith("visible-renamed");
    expect(state.kill).toHaveBeenCalledWith(VISIBLE_KEY);
    expect(state.liveKeys.has("visible-renamed")).toBe(false);
    expect(state.liveKeys.has(VISIBLE_KEY)).toBe(false);
  });
});
