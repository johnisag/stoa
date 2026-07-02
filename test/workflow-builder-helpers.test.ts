/**
 * builder-helpers — pure helper tests.
 *
 * Locks the small I/O-free functions extracted from WorkflowBuilder:
 * worktree labelling, the same-repo worktree filter, and the timestamp
 * formatter's garbage fallback.
 */
import { describe, it, expect } from "vitest";
import {
  worktreeLabel,
  availableWorktrees,
  formatSnapshotTime,
} from "@/components/views/WorkflowsView/builder-helpers";
import type { BuilderDoc } from "@/lib/pipeline/builder-model";
import type { StoaWorktree } from "@/data/worktrees/queries";

function wt(over: Partial<StoaWorktree> & { path: string }): StoaWorktree {
  return {
    branch: "",
    projectId: "",
    projectName: "",
    attached: false,
    sessionId: null,
    sessionName: null,
    dirty: false,
    ahead: 0,
    behind: 0,
    ...over,
  };
}

function doc(over: Partial<BuilderDoc> = {}): BuilderDoc {
  return {
    name: "wf",
    workingDirectory: "/repo",
    nodes: [],
    notes: [],
    ...over,
  };
}

describe("worktreeLabel", () => {
  it("prefers the branch name", () => {
    expect(
      worktreeLabel(wt({ path: "/x/feature-a", branch: "feature-a" }))
    ).toBe("feature-a");
  });

  it("falls back to the path base name when there is no branch", () => {
    expect(worktreeLabel(wt({ path: "/repos/my-app/wt-1" }))).toBe("wt-1");
    // Windows-style separators are handled too.
    expect(worktreeLabel(wt({ path: "C:\\repos\\my-app\\wt-2" }))).toBe("wt-2");
  });

  it('appends " (in use)" for an attached worktree', () => {
    expect(
      worktreeLabel(wt({ path: "/x/b", branch: "b", attached: true }))
    ).toBe("b (in use)");
  });
});

describe("availableWorktrees", () => {
  const trees = [
    wt({ path: "/a", projectId: "/repo-a" }),
    wt({ path: "/b", projectId: "/repo-b" }),
  ];

  it("returns every worktree when no project is selected", () => {
    expect(availableWorktrees(doc(), trees)).toEqual(trees);
  });

  it("filters to the selected project's repo (by projectDir override)", () => {
    const d = doc({ projectId: "p1", workingDirectory: "/repo-a" });
    expect(availableWorktrees(d, trees, "/repo-b")).toEqual([trees[1]]);
  });

  it("filters by the working directory when no projectDir is given", () => {
    const d = doc({ projectId: "p1", workingDirectory: "/repo-a" });
    expect(availableWorktrees(d, trees)).toEqual([trees[0]]);
  });
});

describe("formatSnapshotTime", () => {
  it("formats a valid ISO timestamp (locale-dependent, non-empty)", () => {
    const out = formatSnapshotTime("2026-07-01T12:00:00.000Z");
    expect(out).not.toBe("2026-07-01T12:00:00.000Z");
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns the raw string for un-parseable garbage instead of Invalid Date", () => {
    expect(formatSnapshotTime("not-a-date")).toBe("not-a-date");
  });
});
