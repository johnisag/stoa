/**
 * Regression — planner spawn failure must be TERMINAL, not an eternal "running".
 *
 * spawnWorktreeWorker swallows its own errors and returns null on failure (never
 * throws), and only fires its onSpawn(sessionId) callback on success. So a spawn
 * that fails leaves the plan run's sessionId null forever; readPlanRun's mid-spawn
 * guard (`if (!run.sessionId) return running`) would then spin the planning UI
 * indefinitely AND leak the worktree. spawnPlanner must mirror maintainer.spawnSurvey:
 * detect the null return, record a terminal failure, and reclaim the worktree —
 * here surfaced through the poll (a planId is already promised to the UI) rather
 * than a throw. The pure-helper parsing is covered by dispatch-planner.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/worktrees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktrees")>();
  return {
    ...actual,
    createWorktree: vi.fn(),
    deleteWorktree: vi.fn(),
  };
});
vi.mock("@/lib/dispatch/reviewer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/dispatch/reviewer")>();
  return { ...actual, spawnWorktreeWorker: vi.fn() };
});

import { spawnPlanner, readPlanRun, getPlanRun } from "@/lib/dispatch/planner";
import * as worktrees from "@/lib/worktrees";
import * as reviewer from "@/lib/dispatch/reviewer";
import type { DispatchRepo } from "@/lib/dispatch/types";

const repo = {
  id: "r1",
  repo_path: "/main/repo",
  repo_slug: "o/r",
  agent_type: "claude",
  base_branch: "main",
  project_id: null,
} as unknown as DispatchRepo;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(worktrees.createWorktree).mockResolvedValue({
    worktreePath: "/wt/plan",
    branchName: "feature/plan-x",
    baseBranch: "main",
    projectPath: "/main/repo",
    projectName: "repo",
  });
  vi.mocked(worktrees.deleteWorktree).mockResolvedValue(undefined);
});

describe("spawnPlanner — worker spawn failure", () => {
  it("records a TERMINAL failure and reclaims the worktree (no eternal running)", async () => {
    // spawnWorktreeWorker fails: returns null and never calls onSpawn.
    vi.mocked(reviewer.spawnWorktreeWorker).mockResolvedValue(null);

    const planId = await spawnPlanner(repo, "Build X", 8);

    // The run is still tracked (so the polling UI's GET 404 guard passes)…
    expect(getPlanRun(planId)).toBeDefined();
    // …but readPlanRun reports a terminal failure instead of spinning on the null
    // sessionId (the bug: the mid-spawn guard would return "running" forever).
    const status = await readPlanRun(planId);
    expect(status.status).toBe("failed");
    if (status.status === "failed") {
      expect(status.error).toMatch(/fail/i);
    }
    // The worktree the planner reserved is reclaimed, not leaked.
    expect(vi.mocked(worktrees.deleteWorktree)).toHaveBeenCalledWith(
      "/wt/plan",
      "/main/repo",
      true
    );
  });

  it("does NOT reclaim the worktree on a successful spawn (no false-positive failure)", async () => {
    // A successful spawn records the session id via onSpawn and returns it — so the
    // failure path must NOT fire: the worktree is kept (it's reclaimed later by
    // approve/cancel), and no terminal failure flag is set.
    vi.mocked(reviewer.spawnWorktreeWorker).mockImplementation(
      async (_t, _n, _p, onSpawn) => {
        onSpawn("live-session-id");
        return "live-session-id";
      }
    );

    const planId = await spawnPlanner(repo, "Build X", 8);
    expect(getPlanRun(planId)).toBeDefined();
    // The reserved worktree is NOT torn down on a healthy spawn.
    expect(vi.mocked(worktrees.deleteWorktree)).not.toHaveBeenCalled();
  });
});
