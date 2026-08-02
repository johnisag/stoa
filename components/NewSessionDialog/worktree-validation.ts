import type { GitInfo } from "./NewSessionDialog.types";
import type { WorktreeMode } from "./WorktreeSection";

export interface NewSessionWorktreeSelection {
  useWorktree: boolean;
  worktreeMode: WorktreeMode;
  featureName: string;
  existingWorktreePath: string;
  gitInfo: GitInfo | null;
  isWorkspace: boolean;
}

/** One predicate shared by the submit handler and its disabled state. */
export function isNewSessionWorktreeSelectionValid(
  input: NewSessionWorktreeSelection
): boolean {
  if (input.isWorkspace) return input.featureName.trim().length > 0;
  if (!input.useWorktree) return true;
  if (!input.gitInfo?.isGitRepo) return false;
  if (input.worktreeMode === "new") {
    return input.featureName.trim().length > 0;
  }
  return Boolean(
    input.existingWorktreePath &&
    input.gitInfo.worktrees?.some(
      (worktree) =>
        worktree.path === input.existingWorktreePath && !worktree.attached
    )
  );
}
