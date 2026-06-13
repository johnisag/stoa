/**
 * Multi-repo workspace orchestration. The git + fs leaves are mocked (no real git
 * binary), so this locks the LOGIC: one worktree per repo under one workspace dir,
 * per-repo failure isolation, all-fail teardown, and the delete-time teardown of
 * every child worktree. `workspaceDirName` is pure.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { basename, join } from "path";

const { state } = vi.hoisted(() => ({
  state: {
    addCalls: [] as Array<{ repoPath: string; worktreePath: string }>,
    failRepos: new Set<string>(),
    deleteCalls: [] as Array<{ wt: string; repo: string; delBranch: boolean }>,
    rmCalls: [] as string[],
    existsPaths: new Set<string>(),
  },
}));

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, homeDir: () => "/home/me" };
});

vi.mock("@/lib/git", () => ({
  getDefaultBranch: async () => "main",
  generateBranchName: (f: string) =>
    `feature/${f.toLowerCase().replace(/\s+/g, "-")}`,
  slugify: (s: string) => s.toLowerCase().replace(/\s+/g, "-"),
  getRepoName: (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? "",
}));

vi.mock("@/lib/worktrees", () => ({
  addWorktreeWithBranch: async (repoPath: string, worktreePath: string) => {
    if (state.failRepos.has(repoPath)) throw new Error("worktree add failed");
    state.addCalls.push({ repoPath, worktreePath });
  },
  deleteWorktree: async (wt: string, repo: string, delBranch: boolean) => {
    state.deleteCalls.push({ wt, repo, delBranch });
  },
  getMainRepoPath: async () => "/parent-repo",
}));

vi.mock("fs", () => ({
  existsSync: (p: string) => state.existsPaths.has(p),
  promises: {
    mkdir: async () => {},
    rm: async (p: string) => {
      state.rmCalls.push(p);
    },
  },
}));

import {
  workspaceDirName,
  createWorkspace,
  removeWorkspace,
} from "@/lib/multi-repo-worktree";

beforeEach(() => {
  state.addCalls = [];
  state.failRepos = new Set();
  state.deleteCalls = [];
  state.rmCalls = [];
  state.existsPaths = new Set();
});

describe("workspaceDirName (pure)", () => {
  it("is <root-leaf>-<feature-slug>", () => {
    expect(workspaceDirName("/x/pocs", "Migrate ETL")).toBe("pocs-migrate-etl");
    expect(workspaceDirName("/x/pocs/", "fix bug")).toBe("pocs-fix-bug");
  });
});

describe("createWorkspace", () => {
  const repos = [
    { path: "/x/pocs/etl-engine", name: "etl-engine" },
    { path: "/x/pocs/gridops-cop", name: "gridops-cop" },
  ];

  it("creates one worktree per repo under one workspace, on a shared branch", async () => {
    const res = await createWorkspace({
      rootPath: "/x/pocs",
      repos,
      featureName: "Migrate ETL",
    });
    expect(res.worktrees.map((w) => w.repoName)).toEqual([
      "etl-engine",
      "gridops-cop",
    ]);
    // Each worktree is a subfolder of the workspace named after its repo.
    expect(basename(res.workspacePath)).toBe("pocs-migrate-etl");
    for (const w of res.worktrees) {
      expect(basename(w.worktreePath)).toBe(w.repoName);
      expect(w.branchName).toBe("feature/migrate-etl");
      expect(w.baseBranch).toBe("main");
    }
    expect(state.addCalls).toHaveLength(2);
    expect(res.errors).toHaveLength(0);
  });

  it("isolates a single repo's failure — records it, keeps the rest", async () => {
    state.failRepos.add("/x/pocs/gridops-cop");
    const res = await createWorkspace({
      rootPath: "/x/pocs",
      repos,
      featureName: "Migrate ETL",
    });
    expect(res.worktrees.map((w) => w.repoName)).toEqual(["etl-engine"]);
    expect(res.errors.map((e) => e.repoName)).toEqual(["gridops-cop"]);
  });

  it("tears down the empty workspace and throws when EVERY repo fails", async () => {
    state.failRepos.add("/x/pocs/etl-engine");
    state.failRepos.add("/x/pocs/gridops-cop");
    await expect(
      createWorkspace({ rootPath: "/x/pocs", repos, featureName: "x" })
    ).rejects.toThrow(/Failed to create any worktree/);
    expect(state.rmCalls).toHaveLength(1); // the empty workspace dir was removed
  });

  it("rejects a path-traversal repo name (can't escape the workspace dir)", async () => {
    const res = await createWorkspace({
      rootPath: "/x/pocs",
      repos: [
        { path: "/x/pocs/etl-engine", name: "etl-engine" },
        { path: "/evil", name: "../../../etc" },
      ],
      featureName: "x",
    });
    expect(res.worktrees.map((w) => w.repoName)).toEqual(["etl-engine"]);
    expect(res.errors[0].message).toMatch(/single path segment/);
    // The unsafe repo never reached the worktree-add.
    expect(state.addCalls).toHaveLength(1);
  });

  it("refuses to clobber an existing workspace dir", async () => {
    // Match how createWorkspace builds the path (path.join → backslashes on Windows).
    state.existsPaths.add(join("/home/me", ".stoa", "worktrees", "pocs-x"));
    await expect(
      createWorkspace({ rootPath: "/x/pocs", repos, featureName: "x" })
    ).rejects.toThrow(/already exists/);
  });
});

describe("removeWorkspace — the delete-time teardown", () => {
  it("removes EVERY child worktree (unregistering each), then the workspace dir", async () => {
    await removeWorkspace("/home/me/.stoa/worktrees/pocs-x", [
      "/home/me/.stoa/worktrees/pocs-x/etl-engine",
      "/home/me/.stoa/worktrees/pocs-x/gridops-cop",
    ]);
    expect(state.deleteCalls.map((c) => basename(c.wt))).toEqual([
      "etl-engine",
      "gridops-cop",
    ]);
    // deleteWorktree was given the resolved parent repo, branch kept (delBranch=false).
    for (const c of state.deleteCalls) {
      expect(c.repo).toBe("/parent-repo");
      expect(c.delBranch).toBe(false);
    }
    // The workspace dir itself is removed last.
    expect(state.rmCalls).toContain("/home/me/.stoa/worktrees/pocs-x");
  });
});
