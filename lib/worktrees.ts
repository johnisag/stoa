/**
 * Git Worktree management for isolated feature development
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  isGitRepo,
  branchExists,
  getRepoName,
  slugify,
  generateBranchName,
  runGit,
} from "./git";

// Base directory for all worktrees
const WORKTREES_DIR = path.join(os.homedir(), ".stoa", "worktrees");

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  projectPath: string;
  projectName: string;
}

export interface CreateWorktreeOptions {
  projectPath: string;
  featureName: string;
  baseBranch?: string;
}

/**
 * Ensure the worktrees directory exists
 */
async function ensureWorktreesDir(): Promise<void> {
  await fs.promises.mkdir(WORKTREES_DIR, { recursive: true });
}

/**
 * Resolve a path, expanding ~ to home directory
 */
function resolvePath(p: string): string {
  return p.replace(/^~/, os.homedir());
}

/**
 * Generate a unique worktree directory name
 */
function generateWorktreeDirName(
  projectName: string,
  featureName: string
): string {
  const featureSlug = slugify(featureName);
  return `${projectName}-${featureSlug}`;
}

/**
 * Create a new worktree for a feature branch
 */
export async function createWorktree(
  options: CreateWorktreeOptions
): Promise<WorktreeInfo> {
  const { projectPath, featureName, baseBranch = "main" } = options;

  const resolvedProjectPath = resolvePath(projectPath);

  // Validate project is a git repo
  if (!(await isGitRepo(resolvedProjectPath))) {
    throw new Error(`Not a git repository: ${projectPath}`);
  }

  // Generate branch name
  const branchName = generateBranchName(featureName);

  // Check if branch already exists
  if (await branchExists(resolvedProjectPath, branchName)) {
    throw new Error(`Branch already exists: ${branchName}`);
  }

  // Generate worktree path
  const projectName = getRepoName(resolvedProjectPath);
  const worktreeDirName = generateWorktreeDirName(projectName, featureName);
  const worktreePath = path.join(WORKTREES_DIR, worktreeDirName);

  // Check if worktree path already exists
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  // Ensure worktrees directory exists
  await ensureWorktreesDir();

  // Create the worktree with a new branch
  // Try multiple ref formats to avoid "ambiguous refname" errors
  const refFormats = [
    `origin/${baseBranch}`, // Try remote first (most explicit)
    `refs/heads/${baseBranch}`, // Then local branch
    baseBranch, // Finally, bare name as fallback
  ];

  let lastError: Error | null = null;
  for (const ref of refFormats) {
    try {
      await runGit(
        resolvedProjectPath,
        ["worktree", "add", "-b", branchName, worktreePath, ref],
        30000
      );
      lastError = null;
      break; // Success!
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Continue to next ref format
    }
  }

  if (lastError) {
    throw new Error(`Failed to create worktree: ${lastError.message}`);
  }

  return {
    worktreePath,
    branchName,
    baseBranch,
    projectPath: resolvedProjectPath,
    projectName,
  };
}

/**
 * Delete a worktree and optionally its branch
 */
export async function deleteWorktree(
  worktreePath: string,
  projectPath: string,
  deleteBranch = false
): Promise<void> {
  const resolvedProjectPath = resolvePath(projectPath);
  const resolvedWorktreePath = resolvePath(worktreePath);

  // Get the branch name before removing (for optional deletion)
  let branchName: string | null = null;
  if (deleteBranch) {
    try {
      const { stdout } = await runGit(
        resolvedWorktreePath,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        5000
      );
      branchName = stdout.trim();
    } catch {
      // Ignore - worktree might already be gone
    }
  }

  // Remove the worktree
  try {
    await runGit(
      resolvedProjectPath,
      ["worktree", "remove", resolvedWorktreePath, "--force"],
      30000
    );
  } catch {
    // If git worktree remove fails, try manual cleanup
    if (fs.existsSync(resolvedWorktreePath)) {
      await fs.promises.rm(resolvedWorktreePath, {
        recursive: true,
        force: true,
      });
    }
    // Prune worktree references
    try {
      await runGit(resolvedProjectPath, ["worktree", "prune"], 10000);
    } catch {
      // Ignore prune errors
    }
  }

  // Optionally delete the branch
  if (
    deleteBranch &&
    branchName &&
    branchName !== "main" &&
    branchName !== "master"
  ) {
    try {
      await runGit(resolvedProjectPath, ["branch", "-D", branchName], 10000);
    } catch {
      // Ignore branch deletion errors (might be merged or checked out elsewhere)
    }
  }
}

/**
 * Resolve the MAIN repo path that owns a (possibly linked) worktree, via the
 * git common dir. Returns null when it can't be determined. Uses execFile (no
 * shell) and path-aware `.git` stripping so it works on Windows too — the old
 * `… 2>/dev/null || echo ""` + `/\/.git$/` approach silently no-op'd on cmd.exe,
 * orphaning worktrees.
 */
export async function getMainRepoPath(
  worktreePath: string
): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      resolvePath(worktreePath),
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      5000
    );
    const commonDir = stdout.trim();
    if (!commonDir) return null;
    return path.basename(commonDir) === ".git"
      ? path.dirname(commonDir)
      : commonDir;
  } catch {
    return null;
  }
}

/**
 * List all worktrees for a project
 */
export async function listWorktrees(projectPath: string): Promise<
  Array<{
    path: string;
    branch: string;
    head: string;
  }>
> {
  const resolvedProjectPath = resolvePath(projectPath);

  try {
    const { stdout } = await runGit(
      resolvedProjectPath,
      ["worktree", "list", "--porcelain"],
      10000
    );

    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    const entries = stdout.split("\n\n").filter(Boolean);

    for (const entry of entries) {
      const lines = entry.split("\n");
      let worktreePath = "";
      let branch = "";
      let head = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.slice(9);
        } else if (line.startsWith("branch ")) {
          branch = line.slice(7).replace("refs/heads/", "");
        } else if (line.startsWith("HEAD ")) {
          head = line.slice(5);
        }
      }

      if (worktreePath) {
        worktrees.push({ path: worktreePath, branch, head });
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Check if a path is inside an Stoa worktree. Normalizes both sides first —
 * git emits forward-slash paths even on Windows, while WORKTREES_DIR uses
 * path.join backslashes, so a raw startsWith would never match on Windows
 * (silently hiding every worktree from the attach picker + delete gate).
 */
export function isStoaWorktree(worktreePath: string): boolean {
  const base = normalizeWorktreePath(WORKTREES_DIR);
  return normalizeWorktreePath(worktreePath).startsWith(base);
}

export interface AnnotatedWorktree {
  path: string;
  branch: string;
  head: string;
  /** Lives under Stoa's worktrees dir (created/managed by Stoa). */
  isStoa: boolean;
  /** A live session already points here (so it's NOT an orphan to attach to). */
  attached: boolean;
}

/** Normalize a path for comparison (expand ~, resolve, case-fold on Windows). */
export function normalizeWorktreePath(p: string): string {
  const resolved = path.resolve(resolvePath(p));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Annotate raw worktree entries with `isStoa` and whether a live session already
 * owns each (`attached`) — given the set of session working directories. Pure
 * (no git/db), so the join logic is unit-testable. Drives the New Session
 * "attach to existing worktree" picker (offer the orphaned Stoa worktrees).
 */
export function annotateWorktrees(
  worktrees: Array<{ path: string; branch: string; head: string }>,
  sessionWorkingDirs: Iterable<string>
): AnnotatedWorktree[] {
  const attachedDirs = new Set<string>();
  for (const dir of sessionWorkingDirs)
    attachedDirs.add(normalizeWorktreePath(dir));
  return worktrees.map((w) => ({
    ...w,
    isStoa: isStoaWorktree(w.path),
    attached: attachedDirs.has(normalizeWorktreePath(w.path)),
  }));
}

/**
 * Get the worktrees base directory
 */
export function getWorktreesDir(): string {
  return WORKTREES_DIR;
}
