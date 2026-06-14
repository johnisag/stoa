import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks for the autoMergePass integration test ──────────────────────────────
// getPrReadiness shells out to gh (mock child_process), and the pass reads the db
// + calls mergePR (mock both). promisify(execFile) resolves with the {stdout}
// object the callback receives.
const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as Array<Record<string, unknown>>,
    repo: { review_gate: 0, repo_path: "/repo", repo_slug: "owner/repo" } as
      | {
          review_gate: number;
          repo_path: string;
          repo_slug: string;
          verify_gate?: number;
          verify_command?: string;
        }
      | undefined,
    ghJson: "{}",
    mergeThrows: false,
    mergeCalls: [] as Array<{
      cwd: string;
      prNumber: number;
      repoSlug?: string;
    }>,
    statusUpdates: [] as Array<unknown[]>,
    cleanupLabels: [] as string[],
  },
}));

vi.mock("child_process", () => ({
  execFileSync: () => "", // resolveBinary("gh") → null → bare "gh"
  execFile: (
    _file: string,
    _args: string[],
    optsOrCb: unknown,
    cb?: unknown
  ) => {
    const callback = (typeof optsOrCb === "function" ? optsOrCb : cb) as (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void;
    callback(null, { stdout: state.ghJson, stderr: "" });
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    listPrOpen: () => ({ all: () => state.rows }),
    getDispatchRepo: () => ({ get: () => state.repo }),
    updateDispatchStatus: () => ({
      run: (...args: unknown[]) => state.statusUpdates.push(args),
    }),
  },
}));

vi.mock("@/lib/dispatch/merge", () => ({
  mergePR: async (opts: {
    cwd: string;
    prNumber: number;
    repoSlug?: string;
    matchHeadCommit?: string | null;
  }) => {
    state.mergeCalls.push(opts);
    if (state.mergeThrows) throw new Error("Pull request is not mergeable");
  },
}));

// Capture the post-merge cleanup without actually running it (real deleteWorktree
// would shell out to git on a fake path). Record the label so we can assert it.
vi.mock("@/lib/async-operations", () => ({
  runInBackground: (_fn: () => unknown, label: string) =>
    state.cleanupLabels.push(label),
}));
vi.mock("@/lib/worktrees", () => ({
  deleteWorktree: async () => {},
}));

import {
  summarizePrChecks,
  nextAutoMergeAction,
  autoMergePass,
  buildPrViewArgs,
} from "@/lib/dispatch/auto-merge";

describe("buildPrViewArgs — repo-explicit PR-state read (worktree-independent)", () => {
  it("appends --repo <slug> only when given", () => {
    expect(buildPrViewArgs(7)).toEqual([
      "pr",
      "view",
      "7",
      "--json",
      "mergeable,statusCheckRollup,headRefOid,state",
    ]);
    expect(buildPrViewArgs(7, "owner/repo")).toEqual([
      "pr",
      "view",
      "7",
      "--json",
      "mergeable,statusCheckRollup,headRefOid,state",
      "--repo",
      "owner/repo",
    ]);
  });
});

describe("summarizePrChecks", () => {
  it("returns 'none' for an empty/absent rollup", () => {
    expect(summarizePrChecks([])).toBe("none");
    expect(summarizePrChecks(null)).toBe("none");
    expect(summarizePrChecks(undefined)).toBe("none");
  });

  it("'passing' when every check succeeded/neutral/skipped", () => {
    expect(
      summarizePrChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
        { state: "SUCCESS" },
      ])
    ).toBe("passing");
  });

  it("'pending' when a check is still running/queued (and none failing)", () => {
    expect(
      summarizePrChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: null },
      ])
    ).toBe("pending");
    expect(summarizePrChecks([{ state: "PENDING" }])).toBe("pending");
  });

  it("'failing' if any check failed — failure beats pending", () => {
    expect(
      summarizePrChecks([{ status: "COMPLETED", conclusion: "FAILURE" }])
    ).toBe("failing");
    expect(summarizePrChecks([{ state: "ERROR" }])).toBe("failing");
    expect(
      summarizePrChecks([
        { status: "IN_PROGRESS", conclusion: null },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ])
    ).toBe("failing");
  });

  it("'failing' for every non-success terminal conclusion", () => {
    for (const conclusion of [
      "CANCELLED",
      "TIMED_OUT",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
    ]) {
      expect(summarizePrChecks([{ status: "COMPLETED", conclusion }])).toBe(
        "failing"
      );
    }
  });

  it("'pending' when a check is COMPLETED but has no conclusion yet", () => {
    expect(summarizePrChecks([{ status: "COMPLETED", conclusion: null }])).toBe(
      "pending"
    );
  });

  it("never reads an unknown-shape entry as passing (→ pending)", () => {
    // No state, status, or conclusion — must not slip through as a success.
    expect(summarizePrChecks([{ name: "weird" }])).toBe("pending");
  });
});

describe("nextAutoMergeAction", () => {
  const ready = {
    autoMerge: true,
    status: "pr_open",
    prNumber: 1,
    reviewGate: false,
    reviewDecision: null,
    reviewSha: null as string | null,
    mergeable: "MERGEABLE",
    checks: "passing" as const,
    verifyGate: false,
    verifyStatus: null as string | null,
  };

  it("merges when ready (mergeable + checks pass, not gated)", () => {
    expect(nextAutoMergeAction(ready)).toBe("merge");
    expect(nextAutoMergeAction({ ...ready, checks: "none" })).toBe("merge");
  });

  it("requires a local verify PASS when the repo is verify-gated", () => {
    const v = { ...ready, verifyGate: true };
    expect(nextAutoMergeAction({ ...v, verifyStatus: "pass" })).toBe("merge");
    for (const s of [null, "running", "fail", "error"]) {
      expect(nextAutoMergeAction({ ...v, verifyStatus: s })).toBe("wait");
    }
    // Inert when the repo didn't arm verify (zero behavior change).
    expect(nextAutoMergeAction({ ...ready, verifyStatus: "fail" })).toBe(
      "merge"
    );
  });

  it("skips when not an auto-merge candidate", () => {
    expect(nextAutoMergeAction({ ...ready, autoMerge: false })).toBe("skip");
    expect(nextAutoMergeAction({ ...ready, status: "dispatched" })).toBe(
      "skip"
    );
    expect(nextAutoMergeAction({ ...ready, prNumber: null })).toBe("skip");
  });

  it("waits on conflicts / unknown mergeability", () => {
    expect(nextAutoMergeAction({ ...ready, mergeable: "CONFLICTING" })).toBe(
      "wait"
    );
    expect(nextAutoMergeAction({ ...ready, mergeable: "UNKNOWN" })).toBe(
      "wait"
    );
    expect(nextAutoMergeAction({ ...ready, mergeable: null })).toBe("wait");
  });

  it("waits on red or pending checks", () => {
    expect(nextAutoMergeAction({ ...ready, checks: "failing" })).toBe("wait");
    expect(nextAutoMergeAction({ ...ready, checks: "pending" })).toBe("wait");
  });

  it("requires critic APPROVED when the repo is review-gated", () => {
    const gated = { ...ready, reviewGate: true };
    expect(nextAutoMergeAction({ ...gated, reviewDecision: null })).toBe(
      "wait"
    );
    expect(
      nextAutoMergeAction({ ...gated, reviewDecision: "CHANGES_REQUESTED" })
    ).toBe("wait");
    expect(
      nextAutoMergeAction({
        ...gated,
        reviewDecision: "APPROVED",
        reviewSha: "abc",
      })
    ).toBe("merge");
  });

  it("waits when review-gated and APPROVED but the SHA pin is missing", () => {
    const gated = { ...ready, reviewGate: true, reviewDecision: "APPROVED" };
    expect(nextAutoMergeAction({ ...gated, reviewSha: null })).toBe("wait");
    expect(nextAutoMergeAction({ ...gated, reviewSha: "abc123" })).toBe(
      "merge"
    );
  });
});

describe("autoMergePass", () => {
  beforeEach(() => {
    state.rows = [];
    state.repo = {
      review_gate: 0,
      repo_path: "/repo",
      repo_slug: "owner/repo",
    };
    state.ghJson = JSON.stringify({
      mergeable: "MERGEABLE",
      reviewDecision: null,
      statusCheckRollup: [],
      headRefOid: "head000",
    });
    state.mergeThrows = false;
    state.mergeCalls = [];
    state.statusUpdates = [];
    state.cleanupLabels = [];
  });

  const row = (over: Record<string, unknown> = {}) => ({
    id: "d1",
    repo_id: "r1",
    auto_merge: 1,
    status: "pr_open",
    pr_number: 7,
    worktree_path: "/wt",
    ...over,
  });

  it("merges a ready opted-in PR, marks it merged, and reclaims the worktree", async () => {
    state.rows = [row()];
    await autoMergePass();
    // Armored: gh runs from the STABLE main checkout (/repo) + --repo, not the
    // worktree (/wt) — so a reclaimed worktree can't ENOENT the merge.
    expect(state.mergeCalls).toEqual([
      {
        cwd: "/repo",
        prNumber: 7,
        repoSlug: "owner/repo",
        // Ungated auto-merge still pins to the head we just read mergeable/checks
        // on, so a push between the readiness read and the merge can't slip in.
        matchHeadCommit: "head000",
      },
    ]);
    expect(state.statusUpdates).toContainEqual(["merged", "d1"]);
    expect(state.cleanupLabels).toContain("automerge-cleanup-d1");
  });

  it("SHA-pins a VERIFY-gated (review-off) merge to verify_sha, not null", async () => {
    // Regression: review_sha is null on a verify-only repo, so the merge was
    // running UNPINNED — a push after the verify pass could merge unverified.
    state.repo = {
      review_gate: 0,
      verify_gate: 1,
      verify_command: "npm test",
      repo_path: "/repo",
      repo_slug: "owner/repo",
    };
    state.ghJson = JSON.stringify({
      mergeable: "MERGEABLE",
      reviewDecision: null,
      statusCheckRollup: [],
      headRefOid: "verified-head",
    });
    state.rows = [row({ verify_status: "pass", verify_sha: "verified-head" })];
    await autoMergePass();
    expect(state.mergeCalls).toEqual([
      {
        cwd: "/repo",
        prNumber: 7,
        repoSlug: "owner/repo",
        matchHeadCommit: "verified-head",
      },
    ]);
  });

  it("ignores rows that didn't opt in (auto_merge=0)", async () => {
    state.rows = [row({ auto_merge: 0 })];
    await autoMergePass();
    expect(state.mergeCalls).toHaveLength(0);
    expect(state.statusUpdates).toHaveLength(0);
  });

  it("does not merge a PR that isn't ready (conflicting)", async () => {
    state.rows = [row()];
    state.ghJson = JSON.stringify({
      mergeable: "CONFLICTING",
      reviewDecision: null,
      statusCheckRollup: [],
    });
    await autoMergePass();
    expect(state.mergeCalls).toHaveLength(0);
    expect(state.statusUpdates).toHaveLength(0);
  });

  it("treats a merge failure as non-fatal (no 'merged' write, no throw)", async () => {
    state.rows = [row()];
    state.mergeThrows = true;
    await expect(autoMergePass()).resolves.toBeUndefined();
    expect(state.mergeCalls).toHaveLength(1);
    expect(state.statusUpdates).toHaveLength(0);
  });

  // On a review-gated repo, the gate uses Stoa's OWN cached panel verdict
  // (d.review_decision), NOT GitHub's reviewDecision — the panel posts comments,
  // so GitHub's field is null and would otherwise wedge a gated PR forever.
  it("waits on a gated PR until the cached panel verdict is APPROVED", async () => {
    state.repo = {
      review_gate: 1,
      repo_path: "/repo",
      repo_slug: "owner/repo",
    };
    state.rows = [row({ review_decision: null })];
    await autoMergePass();
    expect(state.mergeCalls).toHaveLength(0);
  });

  it("merges a gated PR once the cached panel verdict is APPROVED", async () => {
    state.repo = {
      review_gate: 1,
      repo_path: "/repo",
      repo_slug: "owner/repo",
    };
    state.rows = [row({ review_decision: "APPROVED", review_sha: "abc" })];
    await autoMergePass();
    // Armored: gh runs from the STABLE main checkout (/repo) + --repo, not the
    // worktree (/wt) — so a reclaimed worktree can't ENOENT the merge.
    expect(state.mergeCalls).toEqual([
      {
        cwd: "/repo",
        prNumber: 7,
        repoSlug: "owner/repo",
        matchHeadCommit: "abc",
      },
    ]);
  });

  it("SHA-pins the merge to the cached review_sha", async () => {
    state.rows = [row({ review_sha: "abc123".repeat(4) })];
    await autoMergePass();
    expect(state.mergeCalls).toHaveLength(1);
    expect(state.mergeCalls[0]).toMatchObject({
      cwd: "/repo",
      prNumber: 7,
      repoSlug: "owner/repo",
      matchHeadCommit: "abc123".repeat(4),
    });
  });
});
