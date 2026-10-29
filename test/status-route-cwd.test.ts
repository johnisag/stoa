import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "path";
import type { Session } from "@/lib/db";
import { homeDir } from "@/lib/platform";

const state = {
  sessions: [] as Array<string | { name: string; activity: number | null }>,
  dbSessions: new Map<string, Session>(),
  panePath: null as string | null,
  panePathThrows: false,
  panePathCalls: 0,
  sandboxAllowed: true,
  sandboxResolved: null as string | null,
  sandboxCalls: 0,
  roots: ["/w/proj"] as string[],
  rootsReads: 0,
};

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: () => {},
      get: (id: string) =>
        sql.includes("SELECT * FROM sessions")
          ? state.dbSessions.get(id)
          : undefined,
    }),
  }),
  queries: {
    getSession: (db: { prepare: (sql: string) => unknown }) =>
      db.prepare("SELECT * FROM sessions WHERE id = ?"),
  },
}));

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    list: async () =>
      state.sessions.map((s) => (typeof s === "string" ? s : s.name)),
    listWithActivity: async () =>
      state.sessions.map((s) =>
        typeof s === "string" ? { name: s, activity: null } : s
      ),
    getPanePath: async () => {
      if (state.panePathThrows) throw new Error("backend unavailable");
      state.panePathCalls++;
      return state.panePath;
    },
    getEnv: async () => null,
  }),
}));

vi.mock("@/lib/status-detector", () => ({
  statusDetector: {
    getStatusDetail: async () => ({
      status: "idle",
      lastLine: "",
      rateLimit: null,
      prompt: null,
    }),
    cleanup: () => {},
    getKimiSessionId: () => null,
  },
}));

vi.mock("@/lib/codex-usage", () => ({
  resolveCodexThreadIdForSession: vi.fn(() => null),
  markCodexThreadVerified: vi.fn(),
  clearCodexThreadVerification: vi.fn(),
}));

vi.mock("@/lib/api-security", () => ({
  getAllowedPathRoots: () => {
    state.rootsReads++;
    return state.roots;
  },
  resolveRealSandboxedPath: vi.fn(
    async (inputPath: string, _roots: string[]) => {
      state.sandboxCalls++;
      return state.sandboxAllowed
        ? { allowed: true, resolved: state.sandboxResolved ?? inputPath }
        : { allowed: false, resolved: inputPath };
    }
  ),
}));

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  // Force the macOS fold branch regardless of the host running the suite —
  // the route only reads isWindows/isMac for sameDirectory().
  return { ...actual, isWindows: false, isMac: true };
});

import { GET } from "@/app/api/sessions/status/route";

const ID = "12345678-1234-1234-1234-123456789abc";
const NAME = `kimi-${ID}`;
const STORED = "/w/proj";

function seedSession(workingDirectory: string = STORED) {
  state.dbSessions.set(ID, {
    id: ID,
    name: "live-cwd fixture",
    tmux_name: NAME,
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
    status: "idle",
    working_directory: workingDirectory,
    parent_session_id: null,
    claude_session_id: null,
    model: "",
    system_prompt: null,
    group_path: "",
    project_id: null,
    agent_type: "kimi",
    auto_approve: false,
    worktree_path: null,
    branch_name: null,
    base_branch: null,
    dev_server_port: null,
    pr_url: null,
    pr_number: null,
    pr_status: null,
    conductor_session_id: null,
    worker_task: null,
    worker_status: null,
  } as unknown as Session);
}

async function getBody(res: Response) {
  return (await res.json()) as {
    statuses: Record<string, { cwd?: string | null }>;
  };
}

describe("/api/sessions/status — live cwd for the Files view", () => {
  beforeEach(() => {
    state.sessions = [NAME];
    state.dbSessions.clear();
    state.panePath = null;
    state.panePathThrows = false;
    state.panePathCalls = 0;
    state.sandboxAllowed = true;
    state.sandboxResolved = null;
    state.sandboxCalls = 0;
    state.roots = [STORED];
    seedSession();
  });

  it("reports the sandbox-resolved pane cwd when it drifted from the stored directory", async () => {
    const worktree = `${STORED}/.stoa/worktrees/feat-x`;
    const resolved = `${STORED}/.stoa/worktrees/feat-x`; // realpath target
    state.panePath = worktree;
    state.sandboxResolved = resolved;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await getBody(res);
    expect(body.statuses[ID].cwd).toBe(resolved);
  });

  it("reports null when the pane path equals the stored working_directory", async () => {
    state.panePath = STORED;
    const body = await getBody(await GET());
    expect(body.statuses[ID].cwd).toBeNull();
    expect(state.sandboxCalls).toBe(0);
  });

  it("reports null when the backend has no pane path", async () => {
    state.panePath = null;
    const body = await getBody(await GET());
    expect(body.statuses[ID].cwd).toBeNull();
  });

  it("reports null (client keeps the stored root) when the pane path is outside the sandbox", async () => {
    state.panePath = "/etc";
    state.sandboxAllowed = false;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await getBody(res);
    expect(body.statuses[ID].cwd).toBeNull();
  });

  it("reports null when the backend pane-path call fails", async () => {
    state.panePathThrows = true;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await getBody(res);
    expect(body.statuses[ID].cwd).toBeNull();
  });

  it("re-checks a path on every poll after it was disallowed (roots can change at runtime)", async () => {
    state.panePath = "/opt/other";
    state.sandboxAllowed = false;
    await GET();
    await GET();
    expect(state.sandboxCalls).toBe(2);
  });

  it("issues exactly one backend getPanePath per session per poll", async () => {
    state.panePath = `${STORED}/worktree-a`;
    await GET();
    expect(state.panePathCalls).toBe(1);
    await GET();
    expect(state.panePathCalls).toBe(2);
  });

  it("treats a pane path that differs only by trailing separator as unchanged", async () => {
    // The DB may store a trailing separator (or different casing on Windows)
    // than the backend reports — the fast path must still settle, not run the
    // sandbox check on every poll forever.
    state.panePath = `${STORED}/`;
    const body = await getBody(await GET());
    expect(body.statuses[ID].cwd).toBeNull();
    expect(state.sandboxCalls).toBe(0);
  });

  it("folds casing on case-insensitive filesystems (macOS-style)", async () => {
    state.panePath = "/w/Proj";
    seedSession("/w/proj");
    const body = await getBody(await GET());
    expect(body.statuses[ID].cwd).toBeNull();
    expect(state.sandboxCalls).toBe(0);
  });

  it("treats a ~-stored directory as unchanged when the pane reports it expanded", async () => {
    // "~" is the new-session default; the backend always reports the expanded
    // path. Without expansion this reported a bogus cwd on EVERY poll.
    seedSession("~/proj");
    state.panePath = join(homeDir(), "proj");
    const body = await getBody(await GET());
    expect(body.statuses[ID].cwd).toBeNull();
    expect(state.sandboxCalls).toBe(0);
  });

  it("does not read the allowed roots on a poll where no session drifted", async () => {
    state.panePath = STORED;
    state.rootsReads = 0;
    await GET();
    expect(state.rootsReads).toBe(0);
  });
});
