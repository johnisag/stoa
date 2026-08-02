import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  entries: [] as Array<{ name: string; isDirectory: () => boolean }>,
  deleteWorktree: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => state.entries),
  };
});

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: { getAllSessions: () => ({ all: () => state.sessions }) },
}));

vi.mock("@/lib/git", () => ({
  getCurrentBranch: vi.fn(async (path: string) => path.split(/[\\/]/).pop()),
  getGitStatus: vi.fn(async () => ({
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
  })),
}));

vi.mock("@/lib/worktrees", () => ({
  getWorktreesDir: () => "/stoa/worktrees",
  normalizeWorktreePath: (path: string) =>
    path.replaceAll("\\", "/").toLowerCase(),
  isStoaWorktree: (path: string) =>
    path.replaceAll("\\", "/").startsWith("/stoa/worktrees/"),
  getMainRepoPath: vi.fn(async () => "/repo"),
  deleteWorktree: state.deleteWorktree,
}));

import { DELETE, GET } from "@/app/api/worktrees/route";

describe("internal session worktree isolation", () => {
  beforeEach(() => {
    state.deleteWorktree.mockReset().mockResolvedValue(undefined);
    state.entries = ["visible", "internal"].map((name) => ({
      name,
      isDirectory: () => true,
    }));
    state.sessions = [
      {
        id: "visible-session",
        name: "Visible session",
        working_directory: "/stoa/worktrees/visible",
        session_role: "interactive",
      },
      {
        id: "internal-session",
        name: "Managed supervisor",
        working_directory: "/tmp/internal-runtime",
        worktree_path: "/stoa/worktrees/internal",
        session_role: "future_internal_role",
      },
    ];
  });

  it("omits an internal worktree instead of presenting it as attached or orphaned", async () => {
    const body = await (await GET()).json();

    expect(body.worktrees).toHaveLength(1);
    expect(body.worktrees[0]).toMatchObject({
      sessionId: "visible-session",
      sessionName: "Visible session",
      attached: true,
    });
    expect(JSON.stringify(body)).not.toContain("internal-session");
    expect(JSON.stringify(body)).not.toContain("Managed supervisor");
  });

  it("refuses generic deletion of an internal-owned worktree", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/stoa/worktrees/internal" }),
      }) as never
    );

    expect(response.status).toBe(409);
    expect(state.deleteWorktree).not.toHaveBeenCalled();
  });
});
