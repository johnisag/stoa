/**
 * Session "go to auto" — the ceremony pass.
 *
 * The pass REUSES the dispatch ceremony's pure decisions; these tests lock the
 * WIRING + the session-specific safety: the right agent per state, the idle-guard,
 * external merge/close terminal, list()-failure skip, the SPAWN-TIME review pin
 * (sha + round-seeded generation), re-review when the head moves after approval,
 * the opt-in auto-merge (off → awaiting_merge for the human), and the merge being
 * pinned (--match-head-commit). Real pure functions (importOriginal), mocked I/O.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    ceremonies: [] as Array<Record<string, unknown>>,
    sessions: {} as Record<string, Record<string, unknown>>,
    ownerStatus: "idle" as string,
    live: [] as string[],
    listThrows: false,
    maxRound: -1,
    verdict: { complete: false, decision: null, byLens: {} } as {
      complete: boolean;
      decision: string | null;
      byLens: Record<string, string>;
    },
    readiness: {
      mergeable: "MERGEABLE",
      checks: "passing",
      headRefOid: "sha-1",
      state: "OPEN",
    } as {
      mergeable: string | null;
      checks: string;
      headRefOid: string | null;
      state: string | null;
    },
    spawns: [] as string[],
    merges: [] as number[],
    mergePins: [] as Array<string | null | undefined>,
    steps: {} as Record<string, string>,
    decisions: [] as string[],
    reviews: [] as Array<{ sha: unknown; round: unknown }>,
    rereviews: [] as string[],
    sessionPrUpdates: [] as Array<[string, number]>,
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    listActiveCeremonies: () => ({ all: () => state.ceremonies }),
    getSession: () => ({ get: (id: string) => state.sessions[id] }),
    setCeremonyStep: () => ({
      run: (step: string, id: string) => {
        state.steps[id] = step;
      },
    }),
    setCeremonyReview: () => ({
      run: (_reviewerId: string, sha: unknown, round: unknown) => {
        state.reviews.push({ sha, round });
      },
    }),
    setCeremonyReviewDecision: () => ({
      run: (dec: string) => {
        state.decisions.push(dec);
      },
    }),
    startCeremonyFixRound: () => ({ run: () => {} }),
    startCeremonyCiFixRound: () => ({ run: () => {} }),
    resetCeremonyForReReview: () => ({
      run: (id: string) => {
        state.rereviews.push(id);
      },
    }),
    updateCeremonyPR: () => ({ run: () => {} }),
    updateSessionPR: () => ({
      run: (_url: string, prNumber: number, prStatus: string) => {
        state.sessionPrUpdates.push([prStatus, prNumber]);
      },
    }),
  },
}));
vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    list: async () => {
      if (state.listThrows) throw new Error("backend down");
      return state.live;
    },
  }),
}));
vi.mock("@/lib/status-detector", () => ({
  statusDetector: {
    getStatusDetail: async () => ({
      status: state.ownerStatus,
      lastLine: "",
      rateLimit: null,
    }),
  },
}));
vi.mock("@/lib/dispatch/reviewer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/dispatch/reviewer")>();
  return {
    ...actual,
    spawnWorktreeWorker: async (
      _target: unknown,
      label: string,
      _prompt: string,
      onSpawn: (id: string) => void
    ): Promise<string> => {
      state.spawns.push(label);
      if (typeof onSpawn === "function") onSpawn("sid-new");
      return "sid-new";
    },
    aggregatePanelVerdict: async () => state.verdict,
    maxStoaReviewRound: async () => state.maxRound,
  };
});
vi.mock("@/lib/dispatch/auto-merge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/dispatch/auto-merge")>();
  return { ...actual, getPrReadiness: async () => state.readiness };
});
vi.mock("@/lib/dispatch/merge", () => ({
  mergePR: async ({
    prNumber,
    matchHeadCommit,
  }: {
    prNumber: number;
    matchHeadCommit?: string | null;
  }) => {
    state.merges.push(prNumber);
    state.mergePins.push(matchHeadCommit);
  },
}));

import { sessionCeremonyPass } from "../lib/dispatch/session-ceremony";

const session = (over: Record<string, unknown> = {}) => ({
  id: "sess-1234abcd",
  tmux_name: "claude-sess",
  agent_type: "claude",
  project_id: "p1",
  base_branch: "main",
  worktree_path: "/wt",
  branch_name: "feature/x",
  pr_number: 7,
  pr_url: "https://gh/pr/7",
  status: "idle",
  ...over,
});

const ceremony = (over: Record<string, unknown> = {}) => ({
  id: "cer-1",
  session_id: "sess-1234abcd",
  step: "queued",
  pr_number: 7,
  pr_url: "https://gh/pr/7",
  reviewer_session_id: null,
  review_decision: null,
  review_sha: null,
  review_round: 0,
  auto_merge: 0,
  fix_rounds: 0,
  fixer_session_id: null,
  ci_fix_rounds: 0,
  ci_fixer_session_id: null,
  created_at: "2026-06-10 09:00:00",
  ...over,
});

// An approved ceremony whose panel reviewed the CURRENT head (sha-1).
const approved = (over: Record<string, unknown> = {}) =>
  ceremony({
    reviewer_session_id: "rev",
    review_decision: "APPROVED",
    review_sha: "sha-1",
    ...over,
  });

describe("sessionCeremonyPass", () => {
  beforeEach(() => {
    state.ceremonies = [ceremony()];
    state.sessions = { "sess-1234abcd": session() };
    state.ownerStatus = "idle";
    state.live = [];
    state.listThrows = false;
    state.maxRound = -1;
    state.verdict = { complete: false, decision: null, byLens: {} };
    state.readiness = {
      mergeable: "MERGEABLE",
      checks: "passing",
      headRefOid: "sha-1",
      state: "OPEN",
    };
    state.spawns = [];
    state.merges = [];
    state.mergePins = [];
    state.steps = {};
    state.decisions = [];
    state.reviews = [];
    state.rereviews = [];
    state.sessionPrUpdates = [];
  });

  it("spawns the 3-critic panel and pins the reviewed SHA + seeded round", async () => {
    state.maxRound = 2; // existing markers up to round 2
    await sessionCeremonyPass();
    expect(state.spawns).toEqual([
      "review #7 · correctness",
      "review #7 · conventions",
      "review #7 · simplicity",
    ]);
    expect(state.steps["cer-1"]).toBe("reviewing");
    // round seeded ABOVE the max existing marker; sha = current head.
    expect(state.reviews).toEqual([{ sha: "sha-1", round: 3 }]);
  });

  it("WAITS while the owner session is still running/waiting", async () => {
    state.live = ["claude-sess"];
    state.ownerStatus = "running";
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
    state.ownerStatus = "waiting";
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("skips the whole tick when the backend can't list sessions", async () => {
    state.listThrows = true;
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
    expect(Object.keys(state.steps)).toHaveLength(0);
  });

  it("spawns a fixer when the panel requested changes (under the cap)", async () => {
    state.ceremonies = [approved({ review_decision: "CHANGES_REQUESTED" })];
    await sessionCeremonyPass();
    expect(state.spawns).toEqual(["fix #7"]);
    expect(state.steps["cer-1"]).toBe("fixing");
  });

  it("is stuck at the fix-round cap", async () => {
    state.ceremonies = [
      approved({ review_decision: "CHANGES_REQUESTED", fix_rounds: 2 }),
    ];
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
    expect(state.steps["cer-1"]).toBe("stuck");
  });

  it("re-reviews (fresh panel) after a fixer finished", async () => {
    state.ceremonies = [
      approved({
        review_decision: "CHANGES_REQUESTED",
        fixer_session_id: "fix-dead",
        fix_rounds: 1,
      }),
    ];
    await sessionCeremonyPass();
    expect(state.rereviews).toEqual(["cer-1"]);
    expect(state.steps["cer-1"]).toBe("reviewing");
  });

  it("AUTO-MERGES (opt-in) when approved + green + mergeable, pinned to the reviewed SHA", async () => {
    state.ceremonies = [approved({ auto_merge: 1 })];
    await sessionCeremonyPass();
    expect(state.merges).toEqual([7]);
    expect(state.mergePins).toEqual(["sha-1"]); // --match-head-commit pin
    expect(state.steps["cer-1"]).toBe("merged");
    expect(state.sessionPrUpdates).toEqual([["merged", 7]]);
  });

  it("stops at awaiting_merge (no merge) when auto_merge is OFF — the human merges", async () => {
    state.ceremonies = [approved({ auto_merge: 0 })];
    await sessionCeremonyPass();
    expect(state.merges).toHaveLength(0);
    expect(state.steps["cer-1"]).toBe("awaiting_merge");
  });

  it("RE-REVIEWS instead of merging when the head moved after approval", async () => {
    state.ceremonies = [approved({ auto_merge: 1, review_sha: "old-sha" })];
    state.readiness = { ...state.readiness, headRefOid: "new-sha" };
    await sessionCeremonyPass();
    expect(state.merges).toHaveLength(0);
    expect(state.rereviews).toEqual(["cer-1"]);
    expect(state.steps["cer-1"]).toBe("reviewing");
  });

  it("spawns a CI fixer when approved but checks are red", async () => {
    state.ceremonies = [approved({ auto_merge: 1 })];
    state.readiness = { ...state.readiness, checks: "failing" };
    await sessionCeremonyPass();
    expect(state.spawns).toEqual(["ci-fix #7"]);
    expect(state.merges).toHaveLength(0);
    expect(state.steps["cer-1"]).toBe("ci_fixing");
  });

  it("waits (ready) when approved but the PR isn't mergeable yet", async () => {
    state.ceremonies = [approved({ auto_merge: 1 })];
    state.readiness = { ...state.readiness, mergeable: "CONFLICTING" };
    await sessionCeremonyPass();
    expect(state.merges).toHaveLength(0);
    expect(state.steps["cer-1"]).toBe("ready");
  });

  it("aggregates an APPROVED verdict, then auto-merges the same tick (opt-in)", async () => {
    state.ceremonies = [
      ceremony({
        reviewer_session_id: "rev",
        review_sha: "sha-1",
        auto_merge: 1,
      }),
    ];
    state.verdict = { complete: true, decision: "APPROVED", byLens: {} };
    await sessionCeremonyPass();
    expect(state.decisions).toContain("APPROVED");
    expect(state.merges).toEqual([7]);
  });

  it("goes terminal when the PR was merged externally", async () => {
    state.ceremonies = [approved({ auto_merge: 1 })];
    state.readiness = { ...state.readiness, state: "MERGED" };
    await sessionCeremonyPass();
    expect(state.steps["cer-1"]).toBe("merged");
    expect(state.merges).toHaveLength(0);
  });

  it("is stuck when the PR was closed externally", async () => {
    state.ceremonies = [approved({ auto_merge: 1 })];
    state.readiness = { ...state.readiness, state: "CLOSED" };
    await sessionCeremonyPass();
    expect(state.steps["cer-1"]).toBe("stuck");
  });

  it("is stuck when the session lost its worktree/branch", async () => {
    state.sessions = {
      "sess-1234abcd": session({ worktree_path: null, branch_name: null }),
    };
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
    expect(state.steps["cer-1"]).toBe("stuck");
  });

  it("is a no-op when there are no enrolled ceremonies", async () => {
    state.ceremonies = [];
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
    expect(state.merges).toHaveLength(0);
  });
});
