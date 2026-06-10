import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DispatchRepo, IssueDispatch } from "../lib/dispatch/types";

// ── Mocks for the ciFixPass integration test ──────────────────────────────────
const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as Array<Record<string, unknown>>,
    repo: { ci_autofix: 1, repo_slug: "o/r" } as
      | Record<string, unknown>
      | undefined,
    checks: "failing" as string,
    live: [] as string[],
    sessions: {} as Record<string, { tmux_name: string }>,
    spawns: [] as string[],
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    listPrOpen: () => ({ all: () => state.rows }),
    getDispatchRepo: () => ({ get: () => state.repo }),
    getSession: () => ({ get: (id: string) => state.sessions[id] }),
    startCiFixRound: () => ({ run: () => {} }),
  },
}));
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ list: async () => state.live }),
}));
vi.mock("@/lib/dispatch/auto-merge", () => ({
  getPrReadiness: async () => ({
    mergeable: "MERGEABLE",
    reviewDecision: null,
    checks: state.checks,
  }),
}));
vi.mock("@/lib/dispatch/reviewer", () => ({
  spawnInWorktree: async (_repo: unknown, _d: unknown, label: string) => {
    state.spawns.push(label);
    return "sid-new";
  },
}));

import {
  nextCiFixAction,
  buildCiFixPrompt,
  ciFixPass,
} from "../lib/dispatch/ci-fix";

describe("nextCiFixAction", () => {
  const red = {
    ciAutofix: true,
    status: "pr_open",
    prNumber: 7,
    checks: "failing" as const,
    ciFixerAlive: false,
    reviewFixerAlive: false,
    ciFixRounds: 0,
    maxCiFixRounds: 2,
  };

  it("spawns a CI fixer when checks are red, no fixer live, under the cap", () => {
    expect(nextCiFixAction(red)).toBe("spawn_ci_fixer");
  });

  it("idle when not an armed live-PR candidate", () => {
    expect(nextCiFixAction({ ...red, ciAutofix: false })).toBe("idle");
    expect(nextCiFixAction({ ...red, status: "dispatched" })).toBe("idle");
    expect(nextCiFixAction({ ...red, prNumber: null })).toBe("idle");
  });

  it("idle when checks aren't failing (green path is auto-merge's job)", () => {
    for (const checks of ["passing", "pending", "none"] as const) {
      expect(nextCiFixAction({ ...red, checks })).toBe("idle");
    }
  });

  it("waits when a CI or review fixer is already working on it", () => {
    expect(nextCiFixAction({ ...red, ciFixerAlive: true })).toBe("wait");
    expect(nextCiFixAction({ ...red, reviewFixerAlive: true })).toBe("wait");
  });

  it("stuck when red at/over the round cap (needs a human)", () => {
    expect(nextCiFixAction({ ...red, ciFixRounds: 2 })).toBe("stuck");
    expect(nextCiFixAction({ ...red, ciFixRounds: 9 })).toBe("stuck");
  });

  it("stuck immediately when the cap is 0 (STOA_MAX_CI_FIX_ROUNDS=0 disables)", () => {
    expect(nextCiFixAction({ ...red, ciFixRounds: 0, maxCiFixRounds: 0 })).toBe(
      "stuck"
    );
  });
});

describe("buildCiFixPrompt", () => {
  it("names the PR/issue/branch and says push the same branch, no new PR", () => {
    const repo = { repo_slug: "octo/app" } as unknown as DispatchRepo;
    const d = {
      pr_number: 12,
      issue_number: 7,
      issue_title: "Fix X",
      branch_name: "feature/fix-x",
    } as unknown as IssueDispatch;
    const p = buildCiFixPrompt(repo, d);
    expect(p).toContain("#12");
    expect(p).toContain("octo/app");
    expect(p).toContain("feature/fix-x");
    expect(p).toContain("gh pr checks 12");
    expect(p).toMatch(/push/i);
    expect(p).toMatch(/do NOT open a new PR/i);
  });
});

describe("ciFixPass", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "d1",
    repo_id: "r1",
    status: "pr_open",
    pr_number: 7,
    worktree_path: "/wt",
    branch_name: "feature/x",
    ci_fix_rounds: 0,
    ci_fixer_session_id: null,
    fixer_session_id: null,
    ...over,
  });

  beforeEach(() => {
    state.rows = [row()];
    state.repo = { ci_autofix: 1, repo_slug: "o/r" };
    state.checks = "failing";
    state.live = [];
    state.sessions = {};
    state.spawns = [];
  });

  it("spawns a CI fixer for an armed repo's red PR", async () => {
    await ciFixPass();
    expect(state.spawns).toEqual(["ci-fix #7"]);
  });

  it("does nothing when the repo didn't arm ci_autofix", async () => {
    state.repo = { ci_autofix: 0, repo_slug: "o/r" };
    await ciFixPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("does nothing when checks are green", async () => {
    state.checks = "passing";
    await ciFixPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("skips while a review fixer is already live on the PR", async () => {
    state.rows = [row({ fixer_session_id: "rev" })];
    state.sessions = { rev: { tmux_name: "tmux-rev" } };
    state.live = ["tmux-rev"];
    await ciFixPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("skips while a CI fixer is already live (its own spawn-once guard)", async () => {
    state.rows = [row({ ci_fixer_session_id: "ci" })];
    state.sessions = { ci: { tmux_name: "tmux-ci" } };
    state.live = ["tmux-ci"];
    await ciFixPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("skips while a rebase fixer is live (don't race the merge train's worktree)", async () => {
    state.rows = [row({ rebase_fixer_session_id: "rb" })];
    state.sessions = { rb: { tmux_name: "tmux-rb" } };
    state.live = ["tmux-rb"];
    await ciFixPass();
    expect(state.spawns).toHaveLength(0);
  });
});
