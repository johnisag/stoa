import { describe, expect, it } from "vitest";
import type { GitInfo } from "@/components/NewSessionDialog/NewSessionDialog.types";
import { isNewSessionWorktreeSelectionValid } from "@/components/NewSessionDialog/worktree-validation";

const gitInfo: GitInfo = {
  isGitRepo: true,
  branches: ["main"],
  defaultBranch: "main",
  currentBranch: "main",
  worktrees: [
    {
      path: "C:\\repo\\available",
      branch: "feature/available",
      head: "a".repeat(40),
      isStoa: true,
      attached: false,
    },
    {
      path: "C:\\repo\\attached",
      branch: "feature/attached",
      head: "b".repeat(40),
      isStoa: true,
      attached: true,
    },
  ],
};

function valid(
  overrides: Partial<Parameters<typeof isNewSessionWorktreeSelectionValid>[0]>
) {
  return isNewSessionWorktreeSelectionValid({
    useWorktree: true,
    worktreeMode: "new",
    featureName: "feature",
    existingWorktreePath: "",
    gitInfo,
    isWorkspace: false,
    ...overrides,
  });
}

describe("new-session worktree selection", () => {
  it("accepts an unattached existing worktree without a feature name", () => {
    expect(
      valid({
        worktreeMode: "existing",
        featureName: "",
        existingWorktreePath: "C:\\repo\\available",
      })
    ).toBe(true);
  });

  it("rejects missing, stale, and already-attached existing choices", () => {
    expect(valid({ worktreeMode: "existing", existingWorktreePath: "" })).toBe(
      false
    );
    expect(
      valid({
        worktreeMode: "existing",
        existingWorktreePath: "C:\\repo\\stale",
      })
    ).toBe(false);
    expect(
      valid({
        worktreeMode: "existing",
        existingWorktreePath: "C:\\repo\\attached",
      })
    ).toBe(false);
  });

  it("still requires a feature name for new and workspace worktrees", () => {
    expect(valid({ featureName: "" })).toBe(false);
    expect(
      valid({ useWorktree: false, isWorkspace: true, featureName: "" })
    ).toBe(false);
    expect(
      valid({ useWorktree: false, isWorkspace: true, featureName: "workspace" })
    ).toBe(true);
  });
});
