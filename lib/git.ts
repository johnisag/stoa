/**
 * Git utilities for worktree management
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import { expandHome } from "./platform";

const execFileAsync = promisify(execFile);

/**
 * Run a git command via execFile (no shell) with an argument array.
 * Avoids shell quoting/redirection so it behaves identically across platforms.
 */
function git(
  cwd: string,
  args: string[],
  timeout: number,
  maxBuffer?: number,
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    timeout,
    ...(maxBuffer != null ? { maxBuffer } : {}),
    // Merge onto process.env so extra vars (e.g. GIT_INDEX_FILE for a throwaway
    // index) don't drop PATH/HOME and break the git invocation.
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

// Shared shell-free git runner for other modules (e.g. lib/worktrees.ts) so all
// git invocation goes through one execFile seam — no shell quoting/redirects.
export { git as runGit };

/**
 * Check if a directory is a git repository
 */
export async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const resolvedPath = expandHome(dirPath);
    await git(resolvedPath, ["rev-parse", "--git-dir"], 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(dirPath: string): Promise<string> {
  const resolvedPath = expandHome(dirPath);
  const { stdout } = await git(
    resolvedPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    5000
  );
  return stdout.trim();
}

/**
 * Get the default branch (main or master)
 */
export async function getDefaultBranch(dirPath: string): Promise<string> {
  const resolvedPath = expandHome(dirPath);
  try {
    // Try to get the default branch from remote
    const { stdout } = await git(
      resolvedPath,
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      5000
    );
    const branch = stdout.trim().replace(/^refs\/remotes\/origin\//, "");
    if (branch) {
      return branch;
    }
  } catch {
    // Ignore
  }

  // Fallback: check if main or master exists
  try {
    await git(resolvedPath, ["rev-parse", "--verify", "main"], 5000);
    return "main";
  } catch {
    try {
      await git(resolvedPath, ["rev-parse", "--verify", "master"], 5000);
      return "master";
    } catch {
      // Return current branch as fallback
      return getCurrentBranch(resolvedPath);
    }
  }
}

/**
 * Get list of local branches
 */
export async function getBranches(dirPath: string): Promise<string[]> {
  const resolvedPath = expandHome(dirPath);
  const { stdout } = await git(
    resolvedPath,
    ["branch", "--format=%(refname:short)"],
    5000
  );
  return stdout
    .trim()
    .split("\n")
    .filter((b) => b);
}

/**
 * Check if a branch exists
 */
export async function branchExists(
  dirPath: string,
  branchName: string
): Promise<boolean> {
  const resolvedPath = expandHome(dirPath);
  try {
    await git(resolvedPath, ["rev-parse", "--verify", branchName], 5000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the repository name from path
 */
export function getRepoName(dirPath: string): string {
  const resolvedPath = expandHome(dirPath);
  return path.basename(resolvedPath);
}

/**
 * Slugify a string for use in branch names
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Generate a branch name from a feature description
 */
export function generateBranchName(feature: string): string {
  const slug = slugify(feature);
  return `feature/${slug}`;
}

/**
 * Check if a branch exists on remote
 */
export async function remoteBranchExists(
  dirPath: string,
  branchName: string
): Promise<boolean> {
  const resolvedPath = expandHome(dirPath);
  try {
    const { stdout } = await git(
      resolvedPath,
      ["ls-remote", "--heads", "origin", branchName],
      10000
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Rename a branch locally and optionally on remote
 * Returns the new branch name or throws on error
 */
export async function renameBranch(
  dirPath: string,
  oldBranchName: string,
  newBranchName: string
): Promise<{ renamed: boolean; remoteRenamed: boolean }> {
  const resolvedPath = expandHome(dirPath);
  let renamed = false;
  let remoteRenamed = false;

  // Rename local branch
  try {
    await git(
      resolvedPath,
      ["branch", "-m", oldBranchName, newBranchName],
      10000
    );
    renamed = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to rename local branch: ${message}`);
  }

  // Check if old branch exists on remote and rename there too
  const hasRemote = await remoteBranchExists(dirPath, oldBranchName);
  if (hasRemote) {
    try {
      // Push new branch to remote
      await git(resolvedPath, ["push", "origin", newBranchName, "-u"], 30000);
      // Delete old branch from remote
      await git(
        resolvedPath,
        ["push", "origin", "--delete", oldBranchName],
        30000
      );
      remoteRenamed = true;
    } catch {
      // Remote rename failed but local succeeded - that's okay
      console.error(
        `Warning: Local branch renamed but remote rename failed for ${oldBranchName}`
      );
    }
  }

  return { renamed, remoteRenamed };
}

/**
 * Get git status summary (files changed, ahead/behind)
 */
export async function getGitStatus(dirPath: string): Promise<{
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}> {
  const resolvedPath = expandHome(dirPath);

  // Get file counts
  const { stdout: statusOutput } = await git(
    resolvedPath,
    ["status", "--porcelain"],
    5000
  );

  const lines = statusOutput.trim().split("\n").filter(Boolean);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of lines) {
    const index = line[0];
    const worktree = line[1];
    if (index === "?" && worktree === "?") {
      untracked++;
    } else {
      if (index !== " " && index !== "?") staged++;
      if (worktree !== " " && worktree !== "?") unstaged++;
    }
  }

  // Get ahead/behind counts
  let ahead = 0;
  let behind = 0;
  try {
    const { stdout: aheadBehind } = await git(
      resolvedPath,
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      5000
    );
    const [a, b] = aheadBehind.trim().split(/\s+/);
    ahead = parseInt(a, 10) || 0;
    behind = parseInt(b, 10) || 0;
  } catch {
    // No upstream, ignore — leaves ahead/behind at 0 (matching the old
    // `|| echo "0 0"` shell fallback)
  }

  return { staged, unstaged, untracked, ahead, behind };
}
