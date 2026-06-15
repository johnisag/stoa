import { describe, it, expect } from "vitest";
import { describeStepWorktree } from "@/lib/pipeline/worktree-display";

describe("describeStepWorktree", () => {
  it("describes an owned worktree with its branch", () => {
    expect(
      describeStepWorktree({
        worktreePath: "/home/u/.stoa/worktrees/proj-issue-12",
        branchName: "feature/issue-12",
        worktreePolicy: "new",
      })
    ).toEqual({
      kind: "own",
      branch: "feature/issue-12",
      path: "/home/u/.stoa/worktrees/proj-issue-12",
    });
  });

  it("keeps an owned worktree even when the branch is unknown", () => {
    expect(
      describeStepWorktree({
        worktreePath: "C:\\Users\\u\\.stoa\\worktrees\\proj-task-ab",
        branchName: null,
      })
    ).toEqual({
      kind: "own",
      branch: null,
      path: "C:\\Users\\u\\.stoa\\worktrees\\proj-task-ab",
    });
  });

  it("treats a blank branch as unknown (not an empty string)", () => {
    const info = describeStepWorktree({
      worktreePath: "/wt/x",
      branchName: "   ",
    });
    expect(info).toEqual({ kind: "own", branch: null, path: "/wt/x" });
  });

  it("reports a shared-policy step with no own path as shared", () => {
    expect(
      describeStepWorktree({
        worktreePath: null,
        branchName: null,
        worktreePolicy: "shared",
      })
    ).toEqual({ kind: "shared" });
  });

  it("prefers the OWN path even for a shared-policy step (the worktree owner)", () => {
    // The first shared step actually created the worktree, so it has a path;
    // it should render as the concrete owner, not the generic "shared" pill.
    expect(
      describeStepWorktree({
        worktreePath: "/wt/shared",
        branchName: "feature/wf",
        worktreePolicy: "shared",
      })
    ).toEqual({ kind: "own", branch: "feature/wf", path: "/wt/shared" });
  });

  it("returns null when there's nothing to show (no path, not shared)", () => {
    expect(
      describeStepWorktree({ worktreePath: null, branchName: null })
    ).toBeNull();
    expect(
      describeStepWorktree({
        worktreePath: "   ",
        branchName: "x",
        worktreePolicy: "new",
      })
    ).toBeNull();
    expect(
      describeStepWorktree({ worktreePath: undefined, branchName: undefined })
    ).toBeNull();
  });
});
