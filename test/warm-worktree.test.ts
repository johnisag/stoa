/**
 * Tests for the warm worktree pool (lib/dispatch/warm-pool.ts).
 *
 * All git and filesystem operations are mocked — the tests only verify the DB
 * state transitions and the conditional logic (use warm vs fall-through to
 * on-demand creation).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import type { AgentType } from "@/lib/providers";
import type { DispatchMode } from "@/lib/dispatch/types";

// ── Module-level mock state ──────────────────────────────────────────────────
// Must be at module scope so the vi.mock() factory closures (hoisted to module
// level by vitest's SWC transformer) can read mutable values set inside tests.

let _db: InstanceType<typeof Database>;
let _branchExistsResult = false;
let _addWorktreeShouldFail = false;
let _setupWorktreeShouldFail = false;
let _runGitShouldFail = false;

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return { ...actual, getDb: () => _db };
});

vi.mock("@/lib/git", async () => {
  const actual = await vi.importActual<typeof import("@/lib/git")>("@/lib/git");
  return {
    ...actual,
    branchExists: () => Promise.resolve(_branchExistsResult),
    runGit: (_path: string, args: string[]) => {
      if (_runGitShouldFail) return Promise.reject(new Error("git error"));
      return Promise.resolve({ stdout: args.join(" "), stderr: "" });
    },
  };
});

vi.mock("@/lib/worktrees", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/worktrees")>("@/lib/worktrees");
  return {
    ...actual,
    addWorktreeWithBranch: () => {
      if (_addWorktreeShouldFail)
        return Promise.reject(new Error("addWorktree failed"));
      return Promise.resolve();
    },
    deleteWorktree: () => Promise.resolve(),
    getWorktreesDir: () => "test-worktrees",
  };
});

vi.mock("@/lib/env-setup", () => ({
  setupWorktree: () => {
    if (_setupWorktreeShouldFail)
      return Promise.reject(new Error("setup failed"));
    return Promise.resolve({ success: true, steps: [], envFilesCopied: [] });
  },
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: () => false,
    promises: {
      ...actual.promises,
      mkdir: () => Promise.resolve(),
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    repo_path: "~/my-repo",
    repo_slug: "owner/my-repo",
    agent_type: "claude" as AgentType,
    base_branch: "main",
    daily_quota: 5,
    max_concurrency: 2,
    label_filter: null,
    mode: "auto" as DispatchMode,
    enabled: 1,
    review_gate: 0,
    ci_autofix: 0,
    merge_train: 0,
    verify_gate: 0,
    verify_command: null,
    maintainer_survey_enabled: 0,
    maintainer_survey_goal: null,
    maintainer_survey_cadence: null,
    maintainer_survey_last_at: null,
    project_id: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _db = new Database(":memory:");
  createSchema(_db);
  _branchExistsResult = false;
  _addWorktreeShouldFail = false;
  _setupWorktreeShouldFail = false;
  _runGitShouldFail = false;
});

afterEach(() => {
  _db.close();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("warm-pool: replenish()", () => {
  beforeEach(() => {
    // warm_worktrees has a FK on repo_id → dispatch_repos
    _db
      .prepare(
        "INSERT INTO dispatch_repos (id, repo_path, repo_slug, base_branch) VALUES ('repo-1', '~/my-repo', 'owner/my-repo', 'main')"
      )
      .run();
  });

  it("inserts a ready row when everything succeeds", async () => {
    const { replenish } = await import("@/lib/dispatch/warm-pool");
    await replenish(makeRepo());

    const rows = _db
      .prepare("SELECT * FROM warm_worktrees WHERE repo_id = 'repo-1'")
      .all() as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ready");
  });

  it("marks ready even when setupWorktree fails (non-fatal)", async () => {
    _setupWorktreeShouldFail = true;
    const { replenish } = await import("@/lib/dispatch/warm-pool");
    await replenish(makeRepo());

    const rows = _db
      .prepare("SELECT status FROM warm_worktrees WHERE repo_id = 'repo-1'")
      .all() as Array<{ status: string }>;
    expect(rows[0].status).toBe("ready");
  });

  it("cleans up the DB row when addWorktreeWithBranch fails", async () => {
    _addWorktreeShouldFail = true;
    const { replenish } = await import("@/lib/dispatch/warm-pool");
    await replenish(makeRepo());

    const rows = _db
      .prepare("SELECT * FROM warm_worktrees WHERE repo_id = 'repo-1'")
      .all();
    expect(rows).toHaveLength(0);
  });

  it("skips replenish when pool already at capacity", async () => {
    // dispatch_repos row already seeded by the describe-level beforeEach; just
    // add the warm_worktrees row to simulate an existing pool entry.
    _db
      .prepare(
        "INSERT INTO warm_worktrees (id, repo_id, worktree_path, branch_name, status) VALUES ('warm-1', 'repo-1', '/wt/path', 'warm/12345678', 'ready')"
      )
      .run();

    const { replenish } = await import("@/lib/dispatch/warm-pool");
    await replenish(makeRepo());

    const count = (
      _db
        .prepare(
          "SELECT COUNT(*) as n FROM warm_worktrees WHERE repo_id = 'repo-1'"
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(1); // no new entry added
  });

  it("skips when placeholder branch already exists", async () => {
    _branchExistsResult = true;
    const { replenish } = await import("@/lib/dispatch/warm-pool");
    await replenish(makeRepo());

    const rows = _db
      .prepare("SELECT * FROM warm_worktrees WHERE repo_id = 'repo-1'")
      .all();
    expect(rows).toHaveLength(0);
  });
});

describe("warm-pool: claimWarm()", () => {
  function insertReadyWarm(repoId = "repo-1") {
    _db
      .prepare(
        "INSERT INTO dispatch_repos (id, repo_path, repo_slug, base_branch) VALUES (?, '~/r', 'owner/r', 'main')"
      )
      .run(repoId);
    _db
      .prepare(
        "INSERT INTO warm_worktrees (id, repo_id, worktree_path, branch_name, status) VALUES ('ww-1', ?, '/wt/ready', 'warm/12345678', 'ready')"
      )
      .run(repoId);
  }

  it("returns worktreePath + new branchName on successful claim", async () => {
    insertReadyWarm();
    const { claimWarm } = await import("@/lib/dispatch/warm-pool");
    const result = await claimWarm("repo-1", "~/my-repo", "feature/issue-42");

    expect(result).not.toBeNull();
    expect(result!.worktreePath).toBe("/wt/ready");
    expect(result!.branchName).toBe("feature/issue-42");
  });

  it("deletes the DB row after claiming", async () => {
    insertReadyWarm();
    const { claimWarm } = await import("@/lib/dispatch/warm-pool");
    await claimWarm("repo-1", "~/my-repo", "feature/issue-42");

    const rows = _db
      .prepare("SELECT * FROM warm_worktrees WHERE id = 'ww-1'")
      .all();
    expect(rows).toHaveLength(0);
  });

  it("returns null when no ready entry exists", async () => {
    const { claimWarm } = await import("@/lib/dispatch/warm-pool");
    const result = await claimWarm("repo-1", "~/my-repo", "feature/issue-42");
    expect(result).toBeNull();
  });

  it("returns null when target branch already exists", async () => {
    insertReadyWarm();
    _branchExistsResult = true;
    const { claimWarm } = await import("@/lib/dispatch/warm-pool");
    const result = await claimWarm("repo-1", "~/my-repo", "feature/issue-42");
    expect(result).toBeNull();
  });

  it("returns null and cleans up when branch rename fails", async () => {
    insertReadyWarm();
    _runGitShouldFail = true;
    const { claimWarm } = await import("@/lib/dispatch/warm-pool");
    const result = await claimWarm("repo-1", "~/my-repo", "feature/issue-42");

    expect(result).toBeNull();
    // Row should already be gone (claimed by the RETURNING DELETE)
    const rows = _db
      .prepare("SELECT * FROM warm_worktrees WHERE id = 'ww-1'")
      .all();
    expect(rows).toHaveLength(0);
  });
});

describe("warm-pool: evictStale()", () => {
  it("deletes warming rows from the DB on startup", async () => {
    _db
      .prepare(
        "INSERT INTO dispatch_repos (id, repo_path, repo_slug, base_branch) VALUES ('repo-1', '~/r', 'owner/r', 'main')"
      )
      .run();
    // Insert two: one warming (stale), one ready (should survive)
    _db
      .prepare(
        "INSERT INTO warm_worktrees (id, repo_id, worktree_path, branch_name, status) VALUES ('ww-stale', 'repo-1', '/wt/stale', 'warm/stale', 'warming')"
      )
      .run();
    _db
      .prepare(
        "INSERT INTO warm_worktrees (id, repo_id, worktree_path, branch_name, status) VALUES ('ww-ready', 'repo-1', '/wt/ready', 'warm/ready', 'ready')"
      )
      .run();

    const { evictStale } = await import("@/lib/dispatch/warm-pool");
    await evictStale();

    const stale = _db
      .prepare("SELECT * FROM warm_worktrees WHERE id = 'ww-stale'")
      .all();
    const ready = _db
      .prepare("SELECT * FROM warm_worktrees WHERE id = 'ww-ready'")
      .all();

    expect(stale).toHaveLength(0);
    expect(ready).toHaveLength(1);
  });

  it("is a no-op when there are no warming rows", async () => {
    const { evictStale } = await import("@/lib/dispatch/warm-pool");
    await expect(evictStale()).resolves.not.toThrow();
  });
});
