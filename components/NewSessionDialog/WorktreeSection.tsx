import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { GitInfo } from "./NewSessionDialog.types";

export type WorktreeMode = "new" | "existing";

interface WorktreeSectionProps {
  gitInfo: GitInfo;
  useWorktree: boolean;
  onUseWorktreeChange: (checked: boolean) => void;
  featureName: string;
  onFeatureNameChange: (value: string) => void;
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
  worktreeMode: WorktreeMode;
  onWorktreeModeChange: (mode: WorktreeMode) => void;
  existingWorktreePath: string;
  onExistingWorktreeChange: (path: string, branch: string) => void;
}

const baseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p;

export function WorktreeSection({
  gitInfo,
  useWorktree,
  onUseWorktreeChange,
  featureName,
  onFeatureNameChange,
  baseBranch,
  onBaseBranchChange,
  worktreeMode,
  onWorktreeModeChange,
  existingWorktreePath,
  onExistingWorktreeChange,
}: WorktreeSectionProps) {
  if (!gitInfo.isGitRepo) return null;

  // Orphans first (a dead session's worktree is the common "attach" target).
  const worktrees = [...(gitInfo.worktrees ?? [])].sort(
    (a, b) => Number(a.attached) - Number(b.attached)
  );
  const hasExisting = worktrees.length > 0;

  return (
    <div className="bg-accent/40 space-y-3 rounded-lg p-3">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="useWorktree"
          checked={useWorktree}
          onChange={(e) => onUseWorktreeChange(e.target.checked)}
          className="border-border bg-background accent-primary h-4 w-4 rounded"
        />
        <label
          htmlFor="useWorktree"
          className="cursor-pointer text-sm font-medium"
        >
          Use a git worktree
        </label>
      </div>

      {useWorktree && (
        <div className="space-y-3 pl-6">
          {/* New-branch vs attach-existing toggle (only when worktrees exist) */}
          {hasExisting && (
            <div className="bg-background inline-flex rounded-md border p-0.5 text-xs">
              {(["new", "existing"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onWorktreeModeChange(m)}
                  className={cn(
                    "rounded px-2.5 py-1 transition-colors",
                    worktreeMode === m
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {m === "new" ? "New branch" : "Attach existing"}
                </button>
              ))}
            </div>
          )}

          {worktreeMode === "existing" && hasExisting ? (
            <div className="space-y-1">
              <label className="text-muted-foreground text-xs">
                Existing worktree
              </label>
              <Select
                value={existingWorktreePath}
                onValueChange={(p) =>
                  onExistingWorktreeChange(
                    p,
                    worktrees.find((w) => w.path === p)?.branch ?? ""
                  )
                }
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Pick a worktree to attach…" />
                </SelectTrigger>
                <SelectContent>
                  {worktrees.map((w) => (
                    <SelectItem
                      key={w.path}
                      value={w.path}
                      disabled={w.attached}
                    >
                      {w.branch || baseName(w.path)}
                      {w.attached ? " (in use)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                Re-attach a session to an existing worktree (e.g. one whose
                session was deleted). Its files and branch are preserved.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">
                  Feature Name
                </label>
                <Input
                  value={featureName}
                  onChange={(e) => onFeatureNameChange(e.target.value)}
                  placeholder="add-dark-mode"
                  className="h-8 text-sm"
                />
                {featureName && (
                  <p className="text-muted-foreground text-xs">
                    Branch: feature/
                    {featureName
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-+|-+$/g, "")
                      .slice(0, 50)}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">
                  Base Branch
                </label>
                <Select value={baseBranch} onValueChange={onBaseBranchChange}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {gitInfo.branches.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
