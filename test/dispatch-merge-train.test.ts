import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DispatchRepo, IssueDispatch } from "../lib/dispatch/types";

// ── Mocks for the mergeTrainPass integration test ─────────────────────────────
const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as Array<Record<string, unknown>>,
    repo: {
      merge_train: 1,
      review_gate: 0,
      repo_slug: "o/r",
      base_branch: "main",
    } as Record<string, unknown> | undefined,
    mergeable: "CONFLICTING" as string,
    checks: "passing" as string,
    live: [] as string[],
    sessions: {} as Record<string, { tmux_name: string }>,
    spawns: [] as string[],
    dbCalls: [] as string[],
  },
}));

const track = (name: string) => ({ run: () => state.dbCalls.push(name) });

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    listPrOpen: () => ({ all: () => state.rows }),
    getDispatchRepo: () => ({ get: () => state.repo }),
    getSession: () => ({ get: (id: string) => state.sessions[id] }),
    startRebaseRound: () => track("startRebaseRound"),
    clearRebaseFixer: () => track("clearRebaseFixer"),
    resetReviewAfterRebase: () => track("resetReviewAfterRebase"),
    resetRebaseRounds: () => track("resetRebaseRounds"),
  },
}));
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({ list: async () => state.live }),
}));
vi.mock("@/lib/dispatch/auto-merge", () => ({
  getPrReadiness: async () => ({
    mergeable: state.mergeable,
    checks: state.checks,
  }),
}));
vi.mock("@/lib/dispatch/reviewer", () => ({
  spawnInWorktree: async (
    _repo: unknown,
    _d: unknown,
    label: string,
    _prompt: string,
    onSpawn: (sid: string) => void
  ) => {
    state.spawns.push(label);
    onSpawn("sid-new"); // records the round (startRebaseRound), as the real recipe does
    return "sid-new";
  },
}));

import {
  nextMergeTrainAction,
  buildRebaseFixPrompt,
  mergeTrainPass,
} from "../lib/dispatch/merge-train";

describe("nextMergeTrainAction", () => {
  // A PR that's ready to land but the base moved under it (CONFLICTING).
  const ready = {
    mergeTrain: true,
    status: "pr_open",
    prNumber: 7,
    reviewGate: false,
    reviewDecision: null,
    mergeable: "CONFLICTING" as string,
    checks: "passing" as const,
    rebaseFixerAlive: false,
    otherFixerAlive: false,
    rebaseRounds: 0,
    maxRebaseRounds: 2,
  };

  it("rebases a conflicting, green, ungated PR under the cap", () => {
    expect(nextMergeTrainAction(ready)).toBe("rebase");
  });

  it("rebases a gated PR only once the critic has APPROVED", () => {
    const gated = { ...ready, reviewGate: true };
    expect(nextMergeTrainAction({ ...gated, reviewDecision: null })).toBe(
      "idle"
    );
    expect(
      nextMergeTrainAction({ ...gated, reviewDecision: "CHANGES_REQUESTED" })
    ).toBe("idle");
    expect(nextMergeTrainAction({ ...gated, reviewDecision: "APPROVED" })).toBe(
      "rebase"
    );
  });

  it("idle when not an armed live-PR candidate", () => {
    expect(nextMergeTrainAction({ ...ready, mergeTrain: false })).toBe("idle");
    expect(nextMergeTrainAction({ ...ready, status: "dispatched" })).toBe(
      "idle"
    );
    expect(nextMergeTrainAction({ ...ready, prNumber: null })).toBe("idle");
  });

  it("idle when the PR isn't actually conflicting (MERGEABLE → auto-merge's job)", () => {
    expect(nextMergeTrainAction({ ...ready, mergeable: "MERGEABLE" })).toBe(
      "idle"
    );
    // UNKNOWN: GitHub still computing — wait for it to resolve, don't rebase blind.
    expect(nextMergeTrainAction({ ...ready, mergeable: "UNKNOWN" })).toBe(
      "idle"
    );
    expect(nextMergeTrainAction({ ...ready, mergeable: null })).toBe("idle");
  });

  it("idle when checks are red (CI-fixer's job) or pending (let them finish)", () => {
    expect(nextMergeTrainAction({ ...ready, checks: "failing" })).toBe("idle");
    expect(nextMergeTrainAction({ ...ready, checks: "pending" })).toBe("idle");
  });

  it("rebases when checks are green or absent", () => {
    expect(nextMergeTrainAction({ ...ready, checks: "passing" })).toBe(
      "rebase"
    );
    expect(nextMergeTrainAction({ ...ready, checks: "none" })).toBe("rebase");
  });

  it("waits when a rebase or other fixer is already working it", () => {
    expect(nextMergeTrainAction({ ...ready, rebaseFixerAlive: true })).toBe(
      "wait"
    );
    expect(nextMergeTrainAction({ ...ready, otherFixerAlive: true })).toBe(
      "wait"
    );
  });

  it("stuck when conflicting at/over the round cap (needs a human)", () => {
    expect(nextMergeTrainAction({ ...ready, rebaseRounds: 2 })).toBe("stuck");
    expect(nextMergeTrainAction({ ...ready, rebaseRounds: 9 })).toBe("stuck");
  });

  it("stuck immediately when the cap is 0 (STOA_MAX_REBASE_ROUNDS=0 disables)", () => {
    expect(
      nextMergeTrainAction({ ...ready, rebaseRounds: 0, maxRebaseRounds: 0 })
    ).toBe("stuck");
  });
});

describe("buildRebaseFixPrompt", () => {
  it("names the PR/base/branch and says rebase + force-with-lease, no new PR", () => {
    const repo = {
      repo_slug: "octo/app",
      base_branch: "develop",
    } as unknown as DispatchRepo;
    const d = {
      pr_number: 12,
      issue_number: 7,
      issue_title: "Fix X",
      branch_name: "feature/fix-x",
    } as unknown as IssueDispatch;
    const p = buildRebaseFixPrompt(repo, d);
    expect(p).toContain("#12");
    expect(p).toContain("octo/app");
    expect(p).toContain("feature/fix-x");
    expect(p).toContain("develop");
    expect(p).toMatch(/rebase/i);
    expect(p).toContain("--force-with-lease");
    expect(p).toMatch(/never a new PR/i);
  });

  it("defaults the base to main when the repo's base is empty", () => {
    const repo = {
      repo_slug: "o/r",
      base_branch: "",
    } as unknown as DispatchRepo;
    const d = {
      pr_number: 1,
      issue_number: 2,
      branch_name: "b",
    } as unknown as IssueDispatch;
    expect(buildRebaseFixPrompt(repo, d)).toContain("origin/main");
  });
});

describe("mergeTrainPass", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "d1",
    repo_id: "r1",
    status: "pr_open",
    pr_number: 7,
    worktree_path: "/wt",
    branch_name: "feature/x",
    review_decision: null,
    rebase_rounds: 0,
    rebase_fixer_session_id: null,
    ci_fixer_session_id: null,
    fixer_session_id: null,
    ...over,
  });

  beforeEach(() => {
    state.rows = [row()];
    state.repo = {
      merge_train: 1,
      review_gate: 0,
      repo_slug: "o/r",
      base_branch: "main",
    };
    state.mergeable = "CONFLICTING";
    state.checks = "passing";
    state.live = [];
    state.sessions = {};
    state.spawns = [];
    state.dbCalls = [];
  });

  it("spawns a rebase fixer for an armed repo's conflicting, green PR", async () => {
    await mergeTrainPass();
    expect(state.spawns).toEqual(["rebase #7"]);
    expect(state.dbCalls).toEqual(["startRebaseRound"]);
  });

  it("does nothing when the repo didn't arm merge_train", async () => {
    state.repo = { merge_train: 0, review_gate: 0, repo_slug: "o/r" };
    await mergeTrainPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("does nothing when the PR is already MERGEABLE (auto-merge handles it)", async () => {
    state.mergeable = "MERGEABLE";
    await mergeTrainPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("does nothing when checks are red (the CI-fixer's lane)", async () => {
    state.checks = "failing";
    await mergeTrainPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("does nothing on a gated repo until the critic approved", async () => {
    state.repo = {
      merge_train: 1,
      review_gate: 1,
      repo_slug: "o/r",
      base_branch: "main",
    };
    await mergeTrainPass();
    expect(state.spawns).toHaveLength(0);
    state.rows = [row({ review_decision: "APPROVED" })];
    await mergeTrainPass();
    expect(state.spawns).toEqual(["rebase #7"]);
  });

  it("skips while a rebase fixer is already live (its own spawn-once guard)", async () => {
    state.rows = [row({ rebase_fixer_session_id: "rb" })];
    state.sessions = { rb: { tmux_name: "tmux-rb" } };
    state.live = ["tmux-rb"];
    await mergeTrainPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("skips while a CI or review fixer is already live on the PR", async () => {
    state.rows = [row({ ci_fixer_session_id: "ci" })];
    state.sessions = { ci: { tmux_name: "tmux-ci" } };
    state.live = ["tmux-ci"];
    await mergeTrainPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("clears the rebase fixer when it finishes on an ungated repo (no re-review)", async () => {
    // fixer id set, but its session is no longer live → finished.
    state.rows = [row({ rebase_fixer_session_id: "rb" })];
    state.sessions = {};
    state.live = [];
    await mergeTrainPass();
    expect(state.dbCalls).toEqual(["clearRebaseFixer"]);
    expect(state.spawns).toHaveLength(0);
  });

  it("re-reviews the rebased head when a rebase finishes on a GATED repo", async () => {
    state.repo = {
      merge_train: 1,
      review_gate: 1,
      repo_slug: "o/r",
      base_branch: "main",
    };
    state.rows = [
      row({ rebase_fixer_session_id: "rb", review_decision: "APPROVED" }),
    ];
    state.sessions = {};
    state.live = [];
    await mergeTrainPass();
    // Wipes the stale approval so a fresh panel re-reviews the rewritten head.
    expect(state.dbCalls).toEqual(["resetReviewAfterRebase"]);
    expect(state.spawns).toHaveLength(0);
  });

  it("resets the round counter once the PR is mergeable again (consecutive cap)", async () => {
    state.rows = [row({ rebase_rounds: 2 })];
    state.mergeable = "MERGEABLE";
    await mergeTrainPass();
    expect(state.dbCalls).toEqual(["resetRebaseRounds"]);
    expect(state.spawns).toHaveLength(0);
  });
});
