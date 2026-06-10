/**
 * Verdict Inbox read model — `listInboxItems` unifies dispatch worker PRs + session
 * "go to auto" ceremonies into one review queue. Mocks the db (like the ceremony
 * tests); the per-lens findings reader is tested separately (dispatch-reviewer).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    dispatches: [] as Array<Record<string, unknown>>,
    repos: {} as Record<string, Record<string, unknown>>,
    ceremonies: [] as Array<Record<string, unknown>>,
    sessions: {} as Record<string, Record<string, unknown>>,
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  queries: {
    listDispatchesForBoard: () => ({ all: () => state.dispatches }),
    getDispatchRepo: () => ({ get: (id: string) => state.repos[id] }),
    listActiveCeremonies: () => ({ all: () => state.ceremonies }),
    getSession: () => ({ get: (id: string) => state.sessions[id] }),
  },
}));
vi.mock("@/lib/platform", () => ({ expandHome: (p: string) => p }));

import { listInboxItems } from "../lib/verdict-inbox";

const dispatch = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  repo_id: "r1",
  issue_number: 42,
  issue_title: "Add auth",
  status: "pr_open",
  pr_number: 7,
  pr_url: "https://gh/pr/7",
  branch_name: "feature/auth",
  worktree_path: "/wt/d1",
  review_decision: "CHANGES_REQUESTED",
  fix_rounds: 1,
  auto_merge: 0,
  updated_at: "2026-06-10 10:00:00",
  ...over,
});

const ceremony = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  session_id: "s1",
  step: "reviewing",
  pr_number: 9,
  pr_url: "https://gh/pr/9",
  review_decision: null,
  fix_rounds: 0,
  auto_merge: 1,
  updated_at: "2026-06-10 11:00:00",
  ...over,
});

describe("listInboxItems", () => {
  beforeEach(() => {
    state.dispatches = [dispatch()];
    state.repos = { r1: { repo_slug: "octo/app" } };
    state.ceremonies = [ceremony()];
    state.sessions = {
      s1: {
        id: "s1",
        name: "auth work",
        branch_name: "feat/x",
        worktree_path: "/wt/s1",
      },
    };
  });

  it("unifies dispatch PRs + session ceremonies, newest first", () => {
    const items = listInboxItems();
    expect(items.map((i) => i.type)).toEqual(["ceremony", "dispatch"]); // 11:00 > 10:00
    const d = items.find((i) => i.type === "dispatch")!;
    expect(d).toMatchObject({
      id: "d1",
      sessionId: null,
      prNumber: 7,
      title: "Add auth (#42)",
      subtitle: "octo/app",
      branch: "feature/auth",
      reviewDecision: "CHANGES_REQUESTED",
      state: "pr_open",
      cwd: "/wt/d1",
      fixRounds: 1,
      autoMerge: false,
    });
    const c = items.find((i) => i.type === "ceremony")!;
    expect(c).toMatchObject({
      id: "c1",
      sessionId: "s1",
      prNumber: 9,
      title: "feat/x", // the session's branch
      subtitle: "auth work",
      state: "reviewing",
      cwd: "/wt/s1",
      autoMerge: true,
    });
  });

  it("includes only pr_open / failed dispatches (drops dispatched / merged)", () => {
    state.dispatches = [
      dispatch({ id: "a", status: "pr_open" }),
      dispatch({ id: "b", status: "failed" }),
      dispatch({ id: "c", status: "dispatched" }),
      dispatch({ id: "e", status: "merged" }),
    ];
    state.ceremonies = [];
    const ids = listInboxItems().map((i) => i.id);
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("skips a ceremony whose session is gone", () => {
    state.dispatches = [];
    state.sessions = {};
    expect(listInboxItems()).toHaveLength(0);
  });

  it("falls back to the session name when the branch is null", () => {
    state.dispatches = [];
    state.sessions = {
      s1: {
        id: "s1",
        name: "my session",
        branch_name: null,
        worktree_path: null,
      },
    };
    const c = listInboxItems()[0];
    expect(c.title).toBe("my session");
    expect(c.cwd).toBeNull();
  });
});
