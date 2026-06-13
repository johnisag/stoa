/**
 * Multi-repo "workspace" sessions.
 *
 * A session can point at a root that ISN'T a git repo but holds several sibling
 * repos (e.g. `C:\my-projects\pocs` with etl-engine/, gridops-cop/, …). On
 * creation the user picks N of those; we build ONE workspace directory under
 * `~/.stoa/worktrees/` and add a git worktree per repo as a NAMED SUBFOLDER:
 *
 *   ~/.stoa/worktrees/pocs-migrate-etl/
 *     etl-engine/    (worktree of …/pocs/etl-engine on feature/migrate-etl)
 *     gridops-cop/   (worktree of …/pocs/gridops-cop on feature/migrate-etl)
 *
 * The session's working_directory is the workspace dir, so the agent sees each
 * repo as a subfolder it can cd into, commit, and raise a PR for — one branch/PR
 * per repo (a PR can't span two git repos anyway). The child worktree paths are
 * recorded on the session so deleting the session tears down EVERY worktree it
 * created (unregistering each from its parent repo, not just rm-ing the folder).
 *
 * createWorkspace/removeWorkspace do the git I/O; workspaceDirName is pure.
 */

import * as path from "path";
import * as fs from "fs";
import { homeDir, expandHome } from "./platform";
import {
  getDefaultBranch,
  generateBranchName,
  slugify,
  getRepoName,
} from "./git";
import {
  addWorktreeWithBranch,
  deleteWorktree,
  getMainRepoPath,
} from "./worktrees";

const WORKTREES_DIR = path.join(homeDir(), ".stoa", "worktrees");

export interface WorkspaceRepoInput {
  /** Absolute path to the source git repo (a sub-repo of the chosen root). */
  path: string;
  /** Leaf name — becomes the worktree's subfolder name in the workspace. */
  name: string;
}

export interface WorkspaceWorktree {
  repoPath: string;
  repoName: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
}

export interface WorkspaceResult {
  /** The workspace directory (the session's working_directory). */
  workspacePath: string;
  /** Successfully created worktrees, one per repo. */
  worktrees: WorkspaceWorktree[];
  /** Repos that failed (recorded, not fatal unless ALL fail). */
  errors: { repoName: string; message: string }[];
}

/**
 * Pure: the workspace directory name `<root-leaf>-<feature-slug>`
 * (e.g. root `…/pocs` + "Migrate ETL" → "pocs-migrate-etl").
 */
export function workspaceDirName(
  rootPath: string,
  featureName: string
): string {
  const base = getRepoName(expandHome(rootPath)) || "workspace";
  return `${base}-${slugify(featureName)}`;
}

/**
 * Build a multi-repo workspace: one worktree per repo, all on the SAME feature
 * branch name, off each repo's OWN default branch (main/master/symbolic-ref). A
 * single repo's failure is recorded and skipped; only if EVERY repo fails do we
 * tear the empty workspace down and throw.
 */
export async function createWorkspace(opts: {
  rootPath: string;
  repos: WorkspaceRepoInput[];
  featureName: string;
}): Promise<WorkspaceResult> {
  const workspacePath = path.join(
    WORKTREES_DIR,
    workspaceDirName(opts.rootPath, opts.featureName)
  );
  if (fs.existsSync(workspacePath)) {
    throw new Error(`Workspace already exists: ${workspacePath}`);
  }
  await fs.promises.mkdir(workspacePath, { recursive: true });

  // One branch name shared across the repos (different repos, same name is fine).
  const branchName = generateBranchName(opts.featureName);
  const worktrees: WorkspaceWorktree[] = [];
  const errors: { repoName: string; message: string }[] = [];

  for (const repo of opts.repos) {
    // The worktree subfolder name must be a SINGLE safe path segment. The client
    // sends discovered leaf names, but a crafted request must not escape the
    // workspace dir via a separator or "..".
    if (
      !repo.name ||
      repo.name.includes("/") ||
      repo.name.includes("\\") ||
      repo.name.includes("\0") ||
      repo.name === "." ||
      repo.name === ".."
    ) {
      errors.push({
        repoName: String(repo.name),
        message: "invalid repo name — must be a single path segment",
      });
      continue;
    }
    const repoPath = expandHome(repo.path);
    try {
      const baseBranch = await getDefaultBranch(repoPath);
      const worktreePath = path.join(workspacePath, repo.name);
      await addWorktreeWithBranch(
        repoPath,
        worktreePath,
        branchName,
        baseBranch
      );
      worktrees.push({
        repoPath,
        repoName: repo.name,
        worktreePath,
        branchName,
        baseBranch,
      });
    } catch (e) {
      errors.push({
        repoName: repo.name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (worktrees.length === 0) {
    // Nothing landed — don't leak an empty workspace dir.
    try {
      await fs.promises.rm(workspacePath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw new Error(
      `Failed to create any worktree: ${errors
        .map((e) => `${e.repoName}: ${e.message}`)
        .join("; ")}`
    );
  }

  return { workspacePath, worktrees, errors };
}

/**
 * Tear down a workspace session's worktrees: remove EACH child worktree from its
 * parent repo (so git's worktree registration is cleared, not just the folder),
 * then remove the workspace dir itself. Best-effort per child — one stuck worktree
 * never blocks the rest. `deleteBranch` stays false (the per-repo feature branches
 * may have open PRs).
 */
export async function removeWorkspace(
  workspacePath: string,
  childWorktreePaths: string[]
): Promise<void> {
  for (const childPath of childWorktreePaths) {
    try {
      const mainRepoPath = await getMainRepoPath(childPath);
      await deleteWorktree(
        childPath,
        mainRepoPath ?? path.dirname(childPath),
        false
      );
    } catch (e) {
      console.error(
        `workspace cleanup: failed to remove worktree ${childPath}:`,
        e instanceof Error ? e.message : e
      );
    }
  }
  // Remove the (now-empty) workspace dir.
  try {
    await fs.promises.rm(expandHome(workspacePath), {
      recursive: true,
      force: true,
    });
  } catch (e) {
    console.error(
      `workspace cleanup: failed to remove workspace dir ${workspacePath}:`,
      e instanceof Error ? e.message : e
    );
  }
}
