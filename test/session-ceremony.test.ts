/**
 * Session "go to auto" — the ceremony pass.
 *
 * The pass REUSES the dispatch ceremony's pure decisions (nextReviewAction /
 * nextCiFixAction / nextAutoMergeAction — already unit-tested in their own
 * suites); these tests lock the WIRING + the session-specific safety: the right
 * agent is spawned per state, the idle-guard holds off while the owner works, an
 * external merge/close is terminal, a list() failure skips the tick, and the
 * approval is pinned to the PR head SHA (a push after approval re-reviews instead
 * of auto-merging). Real pure functions (importOriginal), mocked I/O — mirrors
 * dispatch-ci-fix.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    ceremonies: [] as Array<Record<string, unknown>>,
    sessions: {} as Record<string, Record<string, unknown>>,
    ownerStatus: "idle" as string,
    live: [] as string[],
    listThrows: false,
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
    steps: {} as Record<string, string>,
    decisions: [] as string[],
    approvedShas: [] as Array<string | null>,
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
    setCeremonyReviewer: () => ({ run: () => {} }),
    setCeremonyReviewDecision: () => ({
      run: (dec: string) => {
        state.decisions.push(dec);
      },
    }),
    setCeremonyApprovedSha: () => ({
      run: (sha: string | null) => {
        state.approvedShas.push(sha);
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
      label: string
    ): Promise<string> => {
      state.spawns.push(label);
      return "sid-new";
    },
    aggregatePanelVerdict: async () => state.verdict,
  };
});
vi.mock("@/lib/dispatch/auto-merge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/dispatch/auto-merge")>();
  return { ...actual, getPrReadiness: async () => state.readiness };
});
vi.mock("@/lib/dispatch/merge", () => ({
  mergePR: async ({ prNumber }: { prNumber: number }) => {
    state.merges.push(prNumber);
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
  approved_sha: null,
  fix_rounds: 0,
  fixer_session_id: null,
  ci_fix_rounds: 0,
  ci_fixer_session_id: null,
  created_at: "2026-06-10 09:00:00",
  ...over,
});

const approved = (over: Record<string, unknown> = {}) =>
  ceremony({
    reviewer_session_id: "rev",
    review_decision: "APPROVED",
    approved_sha: "sha-1",
    ...over,
  });

describe("sessionCeremonyPass", () => {
  beforeEach(() => {
    state.ceremonies = [ceremony()];
    state.sessions = { "sess-1234abcd": session() };
    state.ownerStatus = "idle";
    state.live = [];
    state.listThrows = false;
    state.verdict = { complete: false, decision: null, byLens: {} };
    state.readiness = {
      mergeable: "MERGEABLE",
      checks: "passing",
      headRefOid: "sha-1",
      state: "OPEN",
    };
    state.spawns = [];
    state.merges = [];
    state.steps = {};
    state.decisions = [];
    state.approvedShas = [];
    state.rereviews = [];
    state.sessionPrUpdates = [];
  });

  it("spawns the 3-critic panel when no reviewer yet and the owner is idle", async () => {
    await sessionCeremonyPass();
    expect(state.spawns).toEqual([
      "review #7 · correctness",
      "review #7 · conventions",
      "review #7 · simplicity",
    ]);
    expect(state.steps["cer-1"]).toBe("reviewing");
  });

  it("WAITS (no spawns) while the owner session is still running/waiting", async () => {
    state.live = ["claude-sess"];
    state.ownerStatus = "running";
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
    expect(state.merges).toHaveLength(0);

    state.ownerStatus = "waiting";
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
  });

  it("proceeds once the owner has gone idle (even if still alive)", async () => {
    state.live = ["claude-sess"];
    state.ownerStatus = "idle";
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(3);
  });

  it("skips the whole tick when the backend can't list sessions", async () => {
    state.listThrows = true;
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
    expect(state.merges).toHaveLength(0);
    expect(Object.keys(state.steps)).toHaveLength(0);
  });

  it("spawns a fixer when the panel requested changes (under the cap)", async () => {
    state.ceremonies = [
      ceremony({
        reviewer_session_id: "rev",
        review_decision: "CHANGES_REQUESTED",
      }),
    ];
    await sessionCeremonyPass();
    expect(state.spawns).toEqual(["fix #7"]);
    expect(state.steps["cer-1"]).toBe("fixing");
  });

  it("is stuck at the fix-round cap (needs a human)", async () => {
    state.ceremonies = [
      ceremony({
        reviewer_session_id: "rev",
        review_decision: "CHANGES_REQUESTED",
        fix_rounds: 2, // MAX_FIX_ROUNDS default
      }),
    ];
    await sessionCeremonyPass();
    expect(state.spawns).toHaveLength(0);
    expect(state.steps["cer-1"]).toBe("stuck");
  });

  it("re-reviews (fresh panel) after a fixer finished", async () => {
    state.ceremonies = [
      ceremony({
        reviewer_session_id: "rev",
        review_decision: "CHANGES_REQUESTED",
        fixer_session_id: "fix-dead", // set but not in `live` → finished
        fix_rounds: 1,
      }),
    ];
    await sessionCeremonyPass();
    expect(state.rereviews).toEqual(["cer-1"]);
    expect(state.spawns).toHaveLength(0); // re-spawn happens next tick
    expect(state.steps["cer-1"]).toBe("reviewing");
  });

  it("merges when approved + green + mergeable, and flips the session PR badge", async () => {
    state.ceremonies = [approved()];
    await sessionCeremonyPass();
    expect(state.merges).toEqual([7]);
    expect(state.steps["cer-1"]).toBe("merged");
    expect(state.sessionPrUpdates).toEqual([["merged", 7]]);
  });

  it("RE-REVIEWS instead of merging when the head moved after approval", async () => {
    state.ceremonies = [approved({ approved_sha: "old-sha" })];
    state.readiness = { ...state.readiness, headRefOid: "new-sha" };
    await sessionCeremonyPass();
    expect(state.merges).toHaveLength(0);
    expect(state.rereviews).toEqual(["cer-1"]);
    expect(state.steps["cer-1"]).toBe("reviewing");
  });

  it("pins the head SHA when it first sees an approval with none recorded", async () => {
    state.ceremonies = [approved({ approved_sha: null })];
    await sessionCeremonyPass();
    expect(state.approvedShas).toContain("sha-1"); // current head pinned
    expect(state.merges).toEqual([7]); // sha matches → merges same tick
  });

  it("spawns a CI fixer when approved but checks are red", async () => {
    state.ceremonies = [approved()];
    state.readiness = { ...state.readiness, checks: "failing" };
    await sessionCeremonyPass();
    expect(state.spawns).toEqual(["ci-fix #7"]);
    expect(state.merges).toHaveLength(0);
    expect(state.steps["cer-1"]).toBe("ci_fixing");
  });

  it("waits (no merge) when approved but the PR isn't mergeable yet", async () => {
    state.ceremonies = [approved()];
    state.readiness = { ...state.readiness, mergeable: "CONFLICTING" };
    await sessionCeremonyPass();
    expect(state.merges).toHaveLength(0);
    expect(state.steps["cer-1"]).toBe("ready");
  });

  it("aggregates an APPROVED panel verdict, then merges the same tick", async () => {
    state.ceremonies = [ceremony({ reviewer_session_id: "rev" })]; // decision null
    state.verdict = { complete: true, decision: "APPROVED", byLens: {} };
    await sessionCeremonyPass();
    expect(state.decisions).toContain("APPROVED");
    expect(state.merges).toEqual([7]);
  });

  it("goes terminal when the PR was merged externally", async () => {
    state.ceremonies = [approved()];
    state.readiness = { ...state.readiness, state: "MERGED" };
    await sessionCeremonyPass();
    expect(state.steps["cer-1"]).toBe("merged");
    expect(state.merges).toHaveLength(0); // we didn't merge it; it already was
  });

  it("is stuck when the PR was closed externally", async () => {
    state.ceremonies = [approved()];
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
