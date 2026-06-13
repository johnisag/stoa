"use client";

import { FolderGit2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { SubRepo } from "./NewSessionDialog.types";

/**
 * Multi-repo workspace picker. Shown when the chosen working directory is NOT a
 * git repo but holds sibling repos (≤2 deep). Pick the repos to work on and a
 * feature name — each picked repo gets its own git worktree under one workspace
 * directory (the session's cwd), all on the same feature branch. One branch/PR per
 * repo. Mobile-first: a vertical, scrollable checklist.
 */
export function WorkspaceSection({
  subRepos,
  selectedSubRepos,
  onToggleRepo,
  allSelected,
  onToggleAll,
  featureName,
  onFeatureNameChange,
}: {
  subRepos: SubRepo[];
  selectedSubRepos: string[];
  onToggleRepo: (repoPath: string) => void;
  allSelected: boolean;
  onToggleAll: () => void;
  featureName: string;
  onFeatureNameChange: (value: string) => void;
}) {
  if (subRepos.length === 0) return null;
  const selectedCount = selectedSubRepos.length;

  return (
    <div className="border-primary/20 bg-primary/5 space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <FolderGit2 className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1 space-y-0.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {subRepos.length} git repos found here
            </p>
            <button
              type="button"
              onClick={onToggleAll}
              className="text-primary shrink-0 text-xs font-medium hover:underline"
            >
              {allSelected ? "Select none" : "Select all"}
            </button>
          </div>
          <p className="text-muted-foreground text-xs">
            This folder isn&apos;t a repo itself. Pick the ones to work on —
            each gets its own worktree under a single workspace the agent runs
            in (one branch &amp; PR per repo).
          </p>
        </div>
      </div>

      {selectedCount > 0 && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Feature name</label>
          <Input
            value={featureName}
            onChange={(e) => onFeatureNameChange(e.target.value)}
            placeholder="e.g. migrate-etl"
          />
          <p className="text-muted-foreground text-xs">
            Used for every repo&apos;s branch (feature/&lt;name&gt;).
          </p>
        </div>
      )}

      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {subRepos.map((repo) => {
          const checked = selectedSubRepos.includes(repo.path);
          return (
            <label
              key={repo.path}
              className="hover:bg-muted/50 flex min-h-[40px] cursor-pointer items-center gap-2 rounded px-2 py-1.5"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggleRepo(repo.path)}
                className="h-4 w-4 shrink-0"
              />
              <span className="truncate text-sm font-medium">{repo.name}</span>
              {repo.depth > 1 && (
                <span className="text-muted-foreground truncate text-xs">
                  {repo.path.replace(/\\/g, "/").split("/").slice(-2).join("/")}
                </span>
              )}
            </label>
          );
        })}
      </div>

      <p className="text-muted-foreground text-xs">
        {selectedCount === 0
          ? "Select at least one repo, or leave all unchecked to start a plain session at this folder."
          : `${selectedCount} selected — ${selectedCount} worktree${selectedCount > 1 ? "s" : ""} will be created.`}
      </p>
    </div>
  );
}
